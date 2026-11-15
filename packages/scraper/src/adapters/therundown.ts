import type { ScrapeFixtureStatus, ScrapeResultStatus } from '@vamos/core';
import { z } from 'zod';
import type {
  FetchPlanItem,
  ParseOutcome,
  RawDocument,
  SourceAdapter,
  SourceDescriptor,
} from '../types';
import {
  allowedHostsSchema,
  cleanName,
  draftsFor,
  parseIsoInstant,
  parseScoreInt,
  requestAuthSchema,
  sportSchema,
  startParse,
  urlProblem,
  type MarketOddsDraft,
  type ParseCollector,
  type RecordParts,
} from './common';
import { exactDecimal, priceToMilli, type PriceProblem } from './odds-price';

/**
 * Adapter for TheRundown's sports-data API (https://therundown.io, a paid, licensed odds /
 * fixtures / scores API). It reads one URL per sport (league) per UTC date and yields the three
 * things the document says about each event:
 *   - a fixture (scheduled / postponed / cancelled),
 *   - a result (final score, or postponed / cancelled / abandoned),
 *   - `market_odds`: what each bookmaker (affiliate) offers for the 1X2 and the over/under,
 *     as integer milli decimal odds, rounded down, with the price's own `updated_at`.
 *
 * Built from the provider's documented shape (its open-source MCP client); every assumption that
 * has not been confirmed with a real response is a config field or is listed in docs/scraper.md
 * (section 3.1): price format, soccer sport ids, the 3-way market id, the full-game period id and
 * whether a final score is a regular-time score. Scraped data never cancels, voids or abandons
 * anything: a status we do not know is a warning and the event is dropped.
 */

export const THERUNDOWN_HOST = 'therundown.io';
/** The only header the key travels in (never also Authorization). */
export const THERUNDOWN_AUTH_HEADER = 'X-TheRundown-Key';
/** The provider's retired affiliate: its prices are never read (as its own client). */
export const RETIRED_AFFILIATE_ID = '27';
/** The most requests one run may make (each is metered). */
export const THERUNDOWN_MAX_REQUESTS = 40;

const intId = (max: number) => z.number().int().min(0).max(max);

export const TheRundownConfigSchema = z
  .strictObject({
    /** Must cover therundown.io (rule S3). */
    allowedHosts: allowedHostsSchema,
    /** The NAME of the environment variable that holds the key (SCRAPER_SECRET_*), never the key. */
    secret: requestAuthSchema.shape.secret,
    sport: sportSchema,
    /** One entry per sport id of the provider (a league for soccer) and the label we call its competition. */
    sports: z
      .array(
        z.strictObject({
          sportId: intId(9999).min(1),
          competition: z.string().trim().min(1).max(120),
        }),
      )
      .min(1)
      .max(10),
    /** UTC days before today that are requested (for results). */
    daysBack: intId(7).default(1),
    /** UTC days after today that are requested (fixtures and prices). */
    daysAhead: intId(14).default(3),
    /** `market_ids` of the request. 1 = moneyline, 2 = spread, 3 = total by default. */
    marketIds: z.array(intId(999).min(1)).min(1).max(10).default([1, 3]),
    /** `affiliate_ids` of the request and a filter on what is read; omitted: the provider's default set. */
    affiliateIds: z.array(intId(99_999).min(1)).min(1).max(40).optional(),
    /** The `period_id` of the full match (markets of other periods, e.g. a half, are ignored). UNCONFIRMED: 0. */
    periodId: intId(99).default(0),
    /** The format of `price`. UNCONFIRMED; a wrong choice is detected and fails the page (see parse). */
    priceFormat: z.enum(['american', 'decimal']).default('american'),
    /** The market that holds the 1X2 (home / draw / away). UNCONFIRMED for soccer. */
    moneylineMarketId: intId(999).min(1).default(1),
    /** The market that holds the over/under total. */
    totalsMarketId: intId(999).min(1).default(3),
    /** Participant names that mean the draw. */
    drawNames: z.array(z.string().trim().min(1).max(40)).min(1).max(5).default(['Draw', 'Tie']),
    /**
     * A final score is a score at the end of regular time. When false (a competition with extra
     * time) it gets the score basis `unknown`, which can never settle anything.
     */
    finalIsRegularTime: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    const problem = urlProblem(`https://${THERUNDOWN_HOST}/`, c.allowedHosts);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        message: `allowedHosts must cover ${THERUNDOWN_HOST}`,
        path: ['allowedHosts'],
      });
    }
    const dup = (values: readonly number[]) => new Set(values).size !== values.length;
    if (dup(c.sports.map((s) => s.sportId))) {
      ctx.addIssue({ code: 'custom', message: 'a sport id is listed twice', path: ['sports'] });
    }
    if (dup(c.marketIds)) {
      ctx.addIssue({ code: 'custom', message: 'a market id is listed twice', path: ['marketIds'] });
    }
    if (c.affiliateIds && dup(c.affiliateIds)) {
      ctx.addIssue({
        code: 'custom',
        message: 'an affiliate id is listed twice',
        path: ['affiliateIds'],
      });
    }
    if (c.affiliateIds?.includes(Number(RETIRED_AFFILIATE_ID))) {
      ctx.addIssue({
        code: 'custom',
        message: `affiliate ${RETIRED_AFFILIATE_ID} is retired and is never read`,
        path: ['affiliateIds'],
      });
    }
    if (c.moneylineMarketId === c.totalsMarketId) {
      ctx.addIssue({
        code: 'custom',
        message: 'the moneyline and the totals market must differ',
        path: ['totalsMarketId'],
      });
    }
    if (!c.marketIds.includes(c.moneylineMarketId) && !c.marketIds.includes(c.totalsMarketId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'marketIds must include the moneyline or the totals market',
        path: ['marketIds'],
      });
    }
    const requests = c.sports.length * (c.daysBack + 1 + c.daysAhead);
    if (requests > THERUNDOWN_MAX_REQUESTS) {
      ctx.addIssue({
        code: 'custom',
        message: `${requests} requests per run; at most ${THERUNDOWN_MAX_REQUESTS} (each is metered)`,
        path: ['sports'],
      });
    }
  });
export type TheRundownConfig = z.infer<typeof TheRundownConfigSchema>;

const DAY = 24 * 3_600_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The request URLs of one run: one per sport per UTC date in [today - daysBack, today + daysAhead]. */
export function therundownUrls(config: TheRundownConfig, now: Date): string[] {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const query = [
    `market_ids=${config.marketIds.join(',')}`,
    ...(config.affiliateIds ? [`affiliate_ids=${config.affiliateIds.join(',')}`] : []),
    'main_line=true',
    'hide_closed=true',
  ].join('&');
  const urls: string[] = [];
  for (const sport of config.sports) {
    for (let offset = -config.daysBack; offset <= config.daysAhead; offset += 1) {
      urls.push(
        `https://${THERUNDOWN_HOST}/api/v2/sports/${sport.sportId}/events/${isoDay(start + offset * DAY)}?${query}`,
      );
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Statuses

const SCHEDULED = 'STATUS_SCHEDULED';
const STATUSES: Readonly<Record<string, ScrapeFixtureStatus | ScrapeResultStatus>> = {
  [SCHEDULED]: 'scheduled',
  STATUS_FINAL: 'finished',
  STATUS_FULL_TIME: 'finished',
  STATUS_POSTPONED: 'postponed',
  STATUS_CANCELED: 'cancelled',
  STATUS_CANCELLED: 'cancelled',
  STATUS_ABANDONED: 'abandoned',
};
/** A match being played: it says nothing we record, and its (live) prices are never read. */
const IN_PLAY = new Set(['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD']);

// ---------------------------------------------------------------------------
// Reading the document

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null;
const sameName = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The sport id a request URL asks for. */
function sportIdOfUrl(url: string): number | null {
  try {
    const m = /^\/api\/v2\/sports\/([0-9]{1,4})\/events\/[0-9-]{10}$/.exec(new URL(url).pathname);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface Team {
  id: string | null;
  name: string;
}

function teamsOf(event: Json): { home: Team; away: Team } | string {
  const list = asArray(event.teams).length > 0 ? event.teams : event.teams_normalized;
  const teams = asArray(list).filter(isObject);
  const homes = teams.filter((t) => t.is_home === true);
  const aways = teams.filter((t) => t.is_away === true);
  if (homes.length !== 1 || aways.length !== 1 || homes[0] === aways[0]) {
    return 'an event needs exactly one home and one away team';
  }
  const make = (t: Json): Team | null => {
    const name = cleanName(t.name);
    return name === null ? null : { id: idText(t.team_id), name };
  };
  const home = make(homes[0] as Json);
  const away = make(aways[0] as Json);
  if (!home || !away) return 'a team has no name';
  return { home, away };
}

type OddsSelection = '1' | 'X' | '2' | 'over' | 'under';
const SELECTION_ORDER: readonly OddsSelection[] = ['1', 'X', '2', 'over', 'under'];

interface Candidate {
  market: '1x2' | 'ou';
  line: string | null;
  selection: OddsSelection;
  bookmaker: string;
  milli: number;
  updatedAt: Date;
}

/** What was left out of one document's prices, for one summary issue. */
interface Tally {
  checked: number;
  failed: number;
  failures: Partial<Record<PriceProblem, number>>;
  firstFailure: { problem: PriceProblem; value: unknown } | null;
  skipped: Record<'retired' | 'affiliate_not_listed' | 'zero' | 'closed' | 'not_main_line', number>;
  noSelection: number;
  badLine: number;
  notHalfLine: number;
  badUpdatedAt: number;
  otherPeriod: number;
  incompleteBooks: number;
  conflictingBooks: number;
  examples: string[];
}

const newTally = (): Tally => ({
  checked: 0,
  failed: 0,
  failures: {},
  firstFailure: null,
  skipped: { retired: 0, affiliate_not_listed: 0, zero: 0, closed: 0, not_main_line: 0 },
  noSelection: 0,
  badLine: 0,
  notHalfLine: 0,
  badUpdatedAt: 0,
  otherPeriod: 0,
  incompleteBooks: 0,
  conflictingBooks: 0,
  examples: [],
});

/** An over/under total as canonical text ('2.5'), or null. Only x.5 lines are kept (see readLine). */
function lineText(value: unknown): string | null {
  const x = exactDecimal(value);
  if (x === null || x.n < 0n) return null;
  const whole = x.n / x.d;
  const rest = x.n % x.d;
  if (rest === 0n) return whole.toString();
  const digits = (rest * 1_000_000n) / x.d;
  return `${whole}.${digits.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

export function createTheRundownAdapter(
  descriptor: SourceDescriptor,
  config: TheRundownConfig,
): SourceAdapter {
  const labelOf = new Map(config.sports.map((s) => [s.sportId, s.competition]));
  const allowedAffiliates = config.affiliateIds ? new Set(config.affiliateIds.map(String)) : null;
  const drawNames = config.drawNames;

  /** The prices of one market (1x2 or ou) of one event, read into candidates. */
  function readMarket(
    market: Json,
    kind: '1x2' | 'ou',
    teams: { home: Team; away: Team },
    tally: Tally,
    out: Candidate[],
  ): void {
    for (const participant of asArray(market.participants).filter(isObject)) {
      let selection: OddsSelection | null = null;
      if (kind === '1x2') {
        const id = idText(participant.id);
        if (id !== null && teams.home.id !== null && id === teams.home.id) selection = '1';
        else if (id !== null && teams.away.id !== null && id === teams.away.id) selection = '2';
        else if (drawNames.some((n) => sameName(participant.name, n))) selection = 'X';
        else if (sameName(participant.name, teams.home.name)) selection = '1';
        else if (sameName(participant.name, teams.away.name)) selection = '2';
      } else if (sameName(participant.name, 'over')) selection = 'over';
      else if (sameName(participant.name, 'under')) selection = 'under';
      if (selection === null) {
        tally.noSelection += 1;
        continue;
      }
      for (const lineObj of asArray(participant.lines).filter(isObject)) {
        let line: string | null = null;
        if (kind === 'ou') {
          line = lineText(lineObj.value);
          if (line === null) {
            tally.badLine += 1;
            continue;
          }
          // A whole or quarter line has a push or a half stake: not comparable to our over/under.
          if (!line.endsWith('.5')) {
            tally.notHalfLine += 1;
            continue;
          }
        }
        const prices = isObject(lineObj.prices) ? lineObj.prices : {};
        for (const [affiliate, raw] of Object.entries(prices)) {
          if (!isObject(raw) || !/^[0-9]{1,6}$/.test(affiliate)) continue;
          if (affiliate === RETIRED_AFFILIATE_ID) {
            tally.skipped.retired += 1;
            continue;
          }
          if (allowedAffiliates && !allowedAffiliates.has(affiliate)) {
            tally.skipped.affiliate_not_listed += 1;
            continue;
          }
          // The provider's own client skips these, so do we.
          const asNumber = Number(raw.price);
          if (asNumber === 0 || asNumber === 0.0001) {
            tally.skipped.zero += 1;
            continue;
          }
          if (raw.closed_at !== undefined && raw.closed_at !== null && raw.closed_at !== '') {
            tally.skipped.closed += 1;
            continue;
          }
          if (raw.is_main_line !== true) {
            tally.skipped.not_main_line += 1;
            continue;
          }
          tally.checked += 1;
          const converted = priceToMilli(raw.price, config.priceFormat);
          if (!converted.ok) {
            tally.failed += 1;
            tally.failures[converted.problem] = (tally.failures[converted.problem] ?? 0) + 1;
            tally.firstFailure ??= { problem: converted.problem, value: raw.price };
            continue;
          }
          const updatedAt =
            typeof raw.updated_at === 'string' ? parseIsoInstant(raw.updated_at) : null;
          if (updatedAt === null) {
            tally.badUpdatedAt += 1;
            continue;
          }
          out.push({
            market: kind,
            line,
            selection,
            bookmaker: affiliate,
            milli: converted.milli,
            updatedAt,
          });
        }
      }
    }
  }

  /** Candidates to complete books: a book is a bookmaker's whole 1x2, or both sides of one line. */
  function completeBooks(
    candidates: Candidate[],
    base: Omit<
      MarketOddsDraft,
      'kind' | 'market' | 'line' | 'selection' | 'bookmaker' | 'priceMilli' | 'priceUpdatedAt'
    >,
    tally: Tally,
    eventId: string,
  ): MarketOddsDraft[] {
    const books = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const key = `${c.market}\u0000${c.line ?? ''}\u0000${c.bookmaker}`;
      const list = books.get(key);
      if (list) list.push(c);
      else books.set(key, [c]);
    }
    const rows: MarketOddsDraft[] = [];
    for (const list of books.values()) {
      const first = list[0] as Candidate;
      const needed: readonly OddsSelection[] =
        first.market === '1x2' ? ['1', 'X', '2'] : ['over', 'under'];
      const picked: Candidate[] = [];
      let conflict = false;
      for (const selection of needed) {
        const same = list.filter((c) => c.selection === selection);
        if (same.length === 0) break;
        if (same.some((c) => c.milli !== (same[0] as Candidate).milli)) {
          conflict = true;
          break;
        }
        // The same price listed twice: keep the newest timestamp.
        picked.push(same.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)));
      }
      if (conflict) {
        tally.conflictingBooks += 1;
        if (tally.examples.length < 3)
          tally.examples.push(`${eventId}:${first.bookmaker}:conflict`);
        continue;
      }
      if (picked.length !== needed.length) {
        tally.incompleteBooks += 1;
        if (tally.examples.length < 3)
          tally.examples.push(`${eventId}:${first.bookmaker}:incomplete`);
        continue;
      }
      for (const c of picked) {
        rows.push({
          kind: 'market_odds',
          ...base,
          market: c.market,
          line: c.line,
          selection: c.selection,
          bookmaker: c.bookmaker,
          priceMilli: c.milli,
          priceUpdatedAt: c.updatedAt,
        });
      }
    }
    const rank = (r: MarketOddsDraft) => SELECTION_ORDER.indexOf(r.selection);
    return rows.sort(
      (a, b) =>
        a.market.localeCompare(b.market) ||
        (a.line ?? '').localeCompare(b.line ?? '', 'en', { numeric: true }) ||
        Number(a.bookmaker) - Number(b.bookmaker) ||
        rank(a) - rank(b),
    );
  }

  function summarize(collector: ParseCollector, tally: Tally): void {
    const skipped = Object.entries(tally.skipped).filter(([, n]) => n > 0);
    const dropped = {
      noSelection: tally.noSelection,
      badLine: tally.badLine,
      notHalfLine: tally.notHalfLine,
      badUpdatedAt: tally.badUpdatedAt,
      otherPeriod: tally.otherPeriod,
      incompleteBooks: tally.incompleteBooks,
      conflictingBooks: tally.conflictingBooks,
    };
    const droppedAny = Object.values(dropped).some((n) => n > 0);
    if (skipped.length === 0 && !droppedAny && tally.failed === 0) return;
    collector.issue(
      'warning',
      'prices_dropped',
      'some prices or books were left out (see context for the counts)',
      {
        ...Object.fromEntries(skipped.map(([reason, n]) => [`skipped_${reason}`, n])),
        ...dropped,
        formatFailures: tally.failed,
        examples: tally.examples,
      },
    );
  }

  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan(now: Date): FetchPlanItem[] {
      return therundownUrls(config, now).map((url) => ({
        url,
        purpose: 'both' as const,
        // A reference only: the fetcher reads the value when it fetches.
        auth: { header: THERUNDOWN_AUTH_HEADER, secret: config.secret },
      }));
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      const urlSport = sportIdOfUrl(doc.url);
      const competition = urlSport === null ? undefined : labelOf.get(urlSport);
      if (urlSport === null || competition === undefined) {
        collector.fatal('unknown_request', 'the document URL matches no configured sport', {
          url: doc.url.split('?')[0],
        });
        return collector.outcome();
      }
      let json: unknown;
      try {
        json = JSON.parse(doc.body);
      } catch {
        collector.fatal('bad_json', 'the document is not JSON');
        return collector.outcome();
      }
      const list = isObject(json) ? json.events : undefined;
      if (!Array.isArray(list)) {
        collector.fatal('bad_shape', 'expected an object with an "events" array');
        return collector.outcome();
      }
      const tally = newTally();
      list.forEach((raw: unknown, index) => {
        if (!collector.beginRecord()) return;
        const ctx: Record<string, unknown> = { index };
        if (!isObject(raw)) {
          collector.issue('error', 'bad_record', 'an event must be an object', ctx);
          return;
        }
        const eventId = idText(raw.event_id);
        if (eventId === null) {
          collector.issue('error', 'bad_record', 'an event needs an event_id', ctx);
          return;
        }
        ctx.eventId = eventId;
        if (
          raw.sport_id !== undefined &&
          raw.sport_id !== null &&
          Number(raw.sport_id) !== urlSport
        ) {
          collector.issue('error', 'sport_mismatch', 'the event belongs to another sport id', {
            ...ctx,
            sportId: raw.sport_id,
          });
          return;
        }
        const teams = teamsOf(raw);
        if (typeof teams === 'string') {
          collector.issue('error', 'bad_name', teams, ctx);
          return;
        }
        const named = { ...ctx, home: teams.home.name, away: teams.away.name };
        const kickoff = typeof raw.event_date === 'string' ? parseIsoInstant(raw.event_date) : null;
        if (kickoff === null) {
          collector.issue(
            'error',
            'bad_time',
            'event_date must be an ISO instant with its offset',
            {
              ...named,
              value: raw.event_date,
            },
          );
          return;
        }
        const score = isObject(raw.score) ? raw.score : null;
        const statusText =
          score && typeof score.event_status === 'string'
            ? score.event_status.trim().toUpperCase()
            : '';
        if (IN_PLAY.has(statusText)) return; // being played: nothing recorded, no live prices
        const status = STATUSES[statusText];
        if (status === undefined) {
          collector.issue(
            'warning',
            statusText === '' ? 'missing_status' : 'unknown_status',
            'the event status is not one we map; the event was left out (never a cancel or void)',
            { ...named, value: statusText === '' ? null : statusText },
          );
          return;
        }
        let points: RecordParts['score'] = null;
        if (status === 'finished') {
          const home = parseScoreInt(score?.score_home);
          const away = parseScoreInt(score?.score_away);
          if (home === null || away === null) {
            collector.issue(
              'error',
              'bad_score',
              'a final event needs two whole-number scores',
              named,
            );
            return;
          }
          // The provider has no half-time score in what we read: never invented.
          points = { home, away, htHome: null, htAway: null };
        }
        const drafts = draftsFor({
          home: teams.home.name,
          away: teams.away.name,
          competition,
          kickoff,
          externalRef: eventId.slice(0, 200),
          round: null,
          status,
          score: points,
          scoreBasis:
            status === 'finished' && config.finalIsRegularTime ? 'regular_time' : 'unknown',
        });
        if (!Array.isArray(drafts)) {
          collector.issue('error', drafts.code, drafts.message, named);
          return;
        }
        if (!collector.accept(drafts, named)) return;
        if (status !== 'scheduled') return; // prices are read for matches not yet played only

        const candidates: Candidate[] = [];
        for (const market of asArray(raw.markets).filter(isObject)) {
          const kind =
            market.market_id === config.moneylineMarketId
              ? '1x2'
              : market.market_id === config.totalsMarketId
                ? 'ou'
                : null;
          if (kind === null) continue;
          if (market.period_id !== config.periodId) {
            tally.otherPeriod += 1;
            continue;
          }
          readMarket(market, kind, teams, tally, candidates);
        }
        const rows = completeBooks(
          candidates,
          {
            externalRef: eventId.slice(0, 200),
            sport: 'football',
            competition,
            home: teams.home.name,
            away: teams.away.name,
            kickoff,
          },
          tally,
          eventId,
        );
        if (rows.length > 0) collector.acceptMarketOdds(rows, named);
      });
      // Every price failed the format check, or about half of many did: the format is wrong
      // (an American feed read as decimal passes for prices over +100 and fails for the rest).
      // Nothing from this page is stored: a wrong format is never worth garbage prices.
      if (
        tally.failed > 0 &&
        (tally.failed === tally.checked ||
          (tally.checked >= 10 && tally.failed * 2 >= tally.checked))
      ) {
        collector.fatal(
          'wrong_price_format',
          `${tally.failed} of ${tally.checked} prices are not valid ${config.priceFormat} prices; ` +
            'the priceFormat of the source is probably wrong',
          {
            priceFormat: config.priceFormat,
            failures: tally.failures,
            firstProblem: tally.firstFailure?.problem ?? null,
            firstValue: tally.firstFailure?.value ?? null,
          },
        );
      }
      summarize(collector, tally);
      return collector.outcome();
    },
  };
}
