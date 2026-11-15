import type { ScrapeScoreBasis } from '@vamos/core';
import { z } from 'zod';
import type {
  ApiUsage,
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
} from './common';
import { decimalToMilli, type PriceProblem } from './odds-price';

/**
 * Adapter for The Odds API (https://the-odds-api.com, a paid bookmaker-odds API), rules A1 to A8
 * of docs/theoddsapi-plan/README.md. One source is one league: one request per run to
 * `/v4/sports/{sportKey}/odds` for the 1X2 (`h2h`) and the over/under (`totals`) of up to ten
 * named bookmakers, which costs 2 credits however many matches come back.
 *
 * It yields price rows (`market_odds`) and, with `fixtures`, each upcoming match as a fixture
 * (its kickoff is the bookmakers' `commence_time`): a second upstream next to the fixture source,
 * so a kickoff both agree on moves by itself (rule F4a) and only a disagreement needs a person.
 * In `scores` mode it reads `/scores` instead and yields the final scores of finished matches: a
 * second upstream for results (rule R2) in a league; a cup's scores have basis `unknown` and never
 * settle anything by themselves (rule A10, `theOddsApiScoreBasis`). The key travels in the `x-api-key` header (proven in
 * Phase 0; the docs show only the query parameter, which this adapter never uses). Live matches
 * and matches beyond the horizon are skipped; a market whose `last_update` is stale or in the
 * future is dropped. Its fixtures and results do not count as records (`acceptCompanion`), so the
 * S1 shape check does not watch these pages. Scraped data never cancels, voids or abandons
 * anything; this adapter only ever says a match is scheduled or finished with a score.
 *
 * In `events` mode it reads the FREE fixture list `/v4/sports/{sportKey}/events` (no credits,
 * plan task 1.4): only fixtures, each kickoff being a second voice next to the API-Football spine,
 * so the kickoff of a match is confirmed (C1) without a person. The request is not metered
 * (`expectedCost` 0), never in the credit guard's or `sources budget`'s reads, and an answer that
 * reports a cost above 0 raises the unexpected-cost alarm.
 */

export const THEODDSAPI_HOST = 'api.the-odds-api.com';
export const THEODDSAPI_AUTH_HEADER = 'x-api-key';
/** Up to ten named bookmakers count as one region; an eleventh doubles the cost of every request. */
export const THEODDSAPI_MAX_BOOKMAKERS = 10;
/** The name The Odds API gives the draw in `h2h`. */
const DRAW = 'Draw';
/** A `last_update` this far in the future is a clock or feed error. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const keySchema = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,60}$/, `${what}: lower-case letters, digits and _ only`);

export const TheOddsApiConfigSchema = z
  .strictObject({
    /** Must cover api.the-odds-api.com (rule S3). */
    allowedHosts: allowedHostsSchema,
    /** The NAME of the environment variable that holds the key (SCRAPER_SECRET_*), never the key. */
    secret: requestAuthSchema.shape.secret,
    sport: sportSchema,
    /** The Odds API's sport key: one league, e.g. soccer_epl. */
    sportKey: keySchema('sportKey'),
    /** What we call this competition (resolved through competition aliases). */
    competition: z.string().trim().min(1).max(120),
    /**
     * `odds` (default): the bookmakers' prices of upcoming matches. `scores`: the final scores of
     * the last `daysFrom` days, read only after matches (apps/scraper scheduler). `events`: the free
     * fixture list (no credits), fixtures only, on the fixtures schedule.
     */
    mode: z.enum(['odds', 'scores', 'events']).default('odds'),
    /** Odds mode: also report each upcoming match as a fixture (kickoff = commence_time). */
    fixtures: z.boolean().default(false),
    /** Scores mode: days back (1 to 3); with it a request costs 2 credits. */
    daysFrom: z.number().int().min(1).max(3).default(1),
    /**
     * Scores mode: what the scores mean; the operator must say (league matches: regular_time).
     * For a knockout sport key (`theOddsApiMayGoToExtraTime`) `regular_time` is read as `unknown`
     * (rule A10, S-4): /scores never says whether a match went to extra time or penalties.
     */
    scoreBasis: z.enum(['regular_time', 'includes_extra_time', 'unknown']).optional(),
    /** Odds mode: the bookmakers read, each setting its own prices (plan 4.2). */
    bookmakers: z.array(keySchema('bookmaker')).min(2).max(THEODDSAPI_MAX_BOOKMAKERS).optional(),
    /** Markets requested: each one costs a credit per request. */
    markets: z
      .array(z.enum(['h2h', 'totals']))
      .min(1)
      .max(2)
      .default(['h2h', 'totals']),
    /** Matches further ahead than this are skipped. */
    horizonDays: z.number().int().min(1).max(30).default(15),
    /**
     * A market whose `last_update` is older than this at fetch time is dropped: their scraper has
     * stopped seeing that book (Phase 0: every book's median age was 0 to 2 minutes). Null: keep all.
     */
    maxBookAgeMinutes: z.number().int().min(1).max(1440).nullable().default(20),
  })
  .superRefine((c, ctx) => {
    if (urlProblem(`https://${THEODDSAPI_HOST}/`, c.allowedHosts)) {
      ctx.addIssue({
        code: 'custom',
        message: `allowedHosts must cover ${THEODDSAPI_HOST}`,
        path: ['allowedHosts'],
      });
    }
    if (c.mode === 'events' && c.bookmakers !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'events mode reads no prices: bookmakers is for odds mode',
        path: ['bookmakers'],
      });
    }
    if (c.mode === 'odds' && c.bookmakers === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'bookmakers are required in odds mode',
        path: ['bookmakers'],
      });
    }
    if (c.mode === 'scores' && c.scoreBasis === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'scoreBasis is required in scores mode',
        path: ['scoreBasis'],
      });
    }
    if (c.mode !== 'odds' && c.fixtures) {
      ctx.addIssue({ code: 'custom', message: 'fixtures is for odds mode', path: ['fixtures'] });
    }
    if (c.bookmakers !== undefined && new Set(c.bookmakers).size !== c.bookmakers.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'a bookmaker is listed twice',
        path: ['bookmakers'],
      });
    }
    if (new Set(c.markets).size !== c.markets.length) {
      ctx.addIssue({ code: 'custom', message: 'a market is listed twice', path: ['markets'] });
    }
  });
export type TheOddsApiConfig = z.infer<typeof TheOddsApiConfigSchema>;

/**
 * Words of a sport key that name a competition whose matches can go to extra time and penalties:
 * domestic cups (FA Cup, EFL Cup, Copa del Rey, DFB-Pokal, Coppa Italia, Coupe de France, KNVB
 * Beker, Taça), club cups (Champions, Europa and Conference League, Libertadores, Sudamericana) and
 * tournaments (World Cup, European Championship, Nations League). Matched against the key's
 * `_`-separated words, so `soccer_turkey_super_league` and `soccer_efl_champ` are leagues.
 */
const KNOCKOUT_WORDS: ReadonlySet<string> = new Set([
  'cup',
  'pokal',
  'copa',
  'coupe',
  'coppa',
  'beker',
  'taca',
  'trophy',
  'shield',
  'champs',
  'europa',
  'conference',
  'libertadores',
  'sudamericana',
  'championship',
  'nations',
  'playoff',
  'playoffs',
]);

/**
 * Rule A10 (S-4): true when a sport key's matches can end after extra time or penalties. The
 * league phase of a European cup cannot, but /scores does not say which phase a match is in, so
 * the whole key counts. Leans to true: an unknown word in a cup's key costs a person a look, a
 * cup taken for a league could settle bets on a score after extra time.
 */
export function theOddsApiMayGoToExtraTime(sportKey: string): boolean {
  return sportKey
    .trim()
    .toLowerCase()
    .split('_')
    .some((word) => KNOCKOUT_WORDS.has(word));
}

/**
 * Rule A10 (S-4): the basis of the scores a scores source reports. The Odds API's /scores gives
 * each team's score and `completed`, nothing about extra time or penalties, so `regular_time` is
 * only what the operator says of a league. For a knockout key (`theOddsApiMayGoToExtraTime`) it is
 * `unknown` whatever the config says: such a score never votes for a result (R10), it opens
 * `score_basis_unknown` and a person enters the 90-minute score. A config of `unknown` or
 * `includes_extra_time` is kept as it is (the safe direction).
 */
export function theOddsApiScoreBasis(config: TheOddsApiConfig): ScrapeScoreBasis | null {
  const basis = config.scoreBasis ?? null;
  if (basis === 'regular_time' && theOddsApiMayGoToExtraTime(config.sportKey)) return 'unknown';
  return basis;
}

/** The one request URL of a run (the key is added by the fetcher, in a header). */
export function theOddsApiUrl(config: TheOddsApiConfig): string {
  if (config.mode === 'scores') {
    const query = new URLSearchParams({ daysFrom: String(config.daysFrom), dateFormat: 'iso' });
    return `https://${THEODDSAPI_HOST}/v4/sports/${config.sportKey}/scores?${query.toString()}`;
  }
  if (config.mode === 'events') {
    const query = new URLSearchParams({ dateFormat: 'iso' });
    return `https://${THEODDSAPI_HOST}/v4/sports/${config.sportKey}/events?${query.toString()}`;
  }
  const query = new URLSearchParams({
    bookmakers: (config.bookmakers ?? []).join(','),
    markets: config.markets.join(','),
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  });
  return `https://${THEODDSAPI_HOST}/v4/sports/${config.sportKey}/odds?${query.toString()}`;
}

/** Credits one request costs: markets × regions, ten named books making one region (A9). */
export function theOddsApiCost(config: TheOddsApiConfig): number {
  // Events: the fixture list is free, whatever the sport key.
  if (config.mode === 'events') return 0;
  // Scores: 1 credit, 2 with daysFrom (always set here).
  if (config.mode === 'scores') return 2;
  return (
    config.markets.length * Math.ceil((config.bookmakers ?? []).length / THEODDSAPI_MAX_BOOKMAKERS)
  );
}

/** A credit count from a usage header: a whole number ≥ 0, else null. */
function creditCount(value: string | undefined): number | null {
  if (value === undefined || !/^\s*\d{1,12}(\.0+)?\s*$/.test(value)) return null;
  return Math.trunc(Number(value));
}

/**
 * The usage The Odds API reports on every response (A9): `x-requests-last` (this request),
 * `x-requests-used` and `x-requests-remaining` (this month). Null when none of them is readable.
 */
export function readTheOddsApiUsage(headers: Readonly<Record<string, string>>): ApiUsage | null {
  const usage = {
    last: creditCount(headers['x-requests-last']),
    used: creditCount(headers['x-requests-used']),
    remaining: creditCount(headers['x-requests-remaining']),
  };
  return usage.last === null && usage.used === null && usage.remaining === null ? null : usage;
}

// ---------------------------------------------------------------------------
// Reading the document

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type Selection = '1' | 'X' | '2' | 'over' | 'under';
const SELECTION_ORDER: readonly Selection[] = ['1', 'X', '2', 'over', 'under'];

interface Candidate {
  market: '1x2' | 'ou';
  line: string | null;
  selection: Selection;
  bookmaker: string;
  milli: number;
  updatedAt: Date;
}

/** What was left out of one document, for one summary issue. */
interface Tally {
  checked: number;
  failed: number;
  failures: Partial<Record<PriceProblem, number>>;
  firstFailure: { problem: PriceProblem; value: unknown } | null;
  live: number;
  beyondHorizon: number;
  bookNotListed: number;
  noSelection: number;
  notHalfLine: number;
  badUpdatedAt: number;
  staleMarkets: number;
  futureMarkets: number;
  incompleteBooks: number;
  conflictingBooks: number;
  examples: string[];
}

const newTally = (): Tally => ({
  checked: 0,
  failed: 0,
  failures: {},
  firstFailure: null,
  live: 0,
  beyondHorizon: 0,
  bookNotListed: 0,
  noSelection: 0,
  notHalfLine: 0,
  badUpdatedAt: 0,
  staleMarkets: 0,
  futureMarkets: 0,
  incompleteBooks: 0,
  conflictingBooks: 0,
  examples: [],
});

/**
 * An over/under `point` as canonical text when it is an x.5 line ('2.5'), else null. Whole and
 * quarter lines (Pinnacle's 2.75, 3) can push or split the stake: not comparable to our lines.
 */
function halfLine(point: unknown): string | null {
  if (typeof point !== 'number' || !Number.isFinite(point) || point < 0 || point >= 100) {
    return null;
  }
  const doubled = point * 2;
  if (!Number.isInteger(doubled) || doubled % 2 === 0) return null;
  return `${(doubled - 1) / 2}.5`;
}

/** The sport key and the endpoint (`odds`, `scores` or `events`) of a request URL, or null. */
function requestOfUrl(
  url: string,
): { sportKey: string; endpoint: 'odds' | 'scores' | 'events' } | null {
  try {
    const m = /^\/v4\/sports\/([a-z0-9_]{2,60})\/(odds|scores|events)\/?$/.exec(
      new URL(url).pathname,
    );
    return m ? { sportKey: m[1] as string, endpoint: m[2] as 'odds' | 'scores' | 'events' } : null;
  } catch {
    return null;
  }
}

export function createTheOddsApiAdapter(
  descriptor: SourceDescriptor,
  config: TheOddsApiConfig,
): SourceAdapter {
  const listed = new Set(config.bookmakers ?? []);
  const wantH2h = config.markets.includes('h2h');
  const wantTotals = config.markets.includes('totals');

  /** One market's `last_update` (or the book's), checked against the fetch time (A7). */
  function updatedAtOf(market: Json, book: Json, fetchedAt: Date, tally: Tally): Date | null {
    const raw = typeof market.last_update === 'string' ? market.last_update : book.last_update;
    const at = typeof raw === 'string' ? parseIsoInstant(raw) : null;
    if (at === null) {
      tally.badUpdatedAt += 1;
      return null;
    }
    if (at.getTime() > fetchedAt.getTime() + FUTURE_TOLERANCE_MS) {
      tally.futureMarkets += 1;
      return null;
    }
    if (
      config.maxBookAgeMinutes !== null &&
      fetchedAt.getTime() - at.getTime() > config.maxBookAgeMinutes * 60_000
    ) {
      tally.staleMarkets += 1;
      return null;
    }
    return at;
  }

  /** Converts a price, counting failures for the wrong-format check. */
  function milliOf(value: unknown, tally: Tally): number | null {
    tally.checked += 1;
    const converted = decimalToMilli(value);
    if (converted.ok) return converted.milli;
    tally.failed += 1;
    tally.failures[converted.problem] = (tally.failures[converted.problem] ?? 0) + 1;
    tally.firstFailure ??= { problem: converted.problem, value };
    return null;
  }

  /** The candidates of one bookmaker of one event (A5 to A7). */
  function readBook(
    book: Json,
    teams: { home: string; away: string },
    fetchedAt: Date,
    tally: Tally,
    out: Candidate[],
  ): void {
    const bookmaker = typeof book.key === 'string' ? book.key : '';
    if (!listed.has(bookmaker)) {
      tally.bookNotListed += 1;
      return;
    }
    for (const market of asArray(book.markets).filter(isObject)) {
      const kind =
        market.key === 'h2h' && wantH2h
          ? '1x2'
          : market.key === 'totals' && wantTotals
            ? 'ou'
            : null;
      if (kind === null) continue;
      const updatedAt = updatedAtOf(market, book, fetchedAt, tally);
      if (updatedAt === null) continue;
      for (const outcome of asArray(market.outcomes).filter(isObject)) {
        let selection: Selection | null = null;
        let line: string | null = null;
        if (kind === '1x2') {
          // Matched by exact name: the event's home_team and away_team, and "Draw".
          if (outcome.name === teams.home) selection = '1';
          else if (outcome.name === teams.away) selection = '2';
          else if (outcome.name === DRAW) selection = 'X';
        } else {
          if (outcome.name === 'Over') selection = 'over';
          else if (outcome.name === 'Under') selection = 'under';
          line = halfLine(outcome.point);
          if (selection !== null && line === null) {
            tally.notHalfLine += 1;
            continue;
          }
        }
        if (selection === null) {
          tally.noSelection += 1;
          continue;
        }
        const milli = milliOf(outcome.price, tally);
        if (milli === null) continue;
        out.push({ market: kind, line, selection, bookmaker, milli, updatedAt });
      }
    }
  }

  /** Candidates to whole books: a bookmaker's complete 1X2, or both sides of one line. */
  function completeBooks(
    candidates: Candidate[],
    base: Pick<
      MarketOddsDraft,
      'externalRef' | 'sport' | 'competition' | 'home' | 'away' | 'kickoff'
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
      const needed: readonly Selection[] =
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
        picked.push(same.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)));
      }
      const note = (what: string) => {
        if (tally.examples.length < 3) tally.examples.push(`${eventId}:${first.bookmaker}:${what}`);
      };
      if (conflict) {
        tally.conflictingBooks += 1;
        note('conflict');
        continue;
      }
      if (picked.length !== needed.length) {
        tally.incompleteBooks += 1;
        note('incomplete');
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
        a.bookmaker.localeCompare(b.bookmaker) ||
        rank(a) - rank(b),
    );
  }

  /**
   * Scores mode: a finished result for every completed match that gives one whole-number score
   * per team (named exactly as home_team and away_team). No half time: R2 takes it from the
   * sources that give one. A match not completed yet says nothing; a completed one without a
   * usable score is reported and skipped.
   */
  function parseScores(json: readonly unknown[], collector: ParseCollector, fetchedAt: Date): void {
    const scoreBasis = theOddsApiScoreBasis(config);
    json.forEach((raw: unknown, index) => {
      if (!collector.beginRecord()) return;
      const ctx: Record<string, unknown> = { index };
      if (!isObject(raw)) {
        collector.issue('error', 'bad_record', 'an event must be an object', ctx);
        return;
      }
      const eventId = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
      if (eventId === null) {
        collector.issue('error', 'bad_record', 'an event needs an id', ctx);
        return;
      }
      ctx.eventId = eventId;
      if (raw.sport_key !== config.sportKey) {
        collector.issue('error', 'sport_mismatch', 'the event belongs to another sport key', {
          ...ctx,
          sportKey: raw.sport_key,
        });
        return;
      }
      const homeRaw = typeof raw.home_team === 'string' ? raw.home_team : null;
      const awayRaw = typeof raw.away_team === 'string' ? raw.away_team : null;
      const home = cleanName(homeRaw);
      const away = cleanName(awayRaw);
      if (homeRaw === null || awayRaw === null || home === null || away === null) {
        collector.issue('error', 'bad_name', 'an event needs a home_team and an away_team', ctx);
        return;
      }
      const named = { ...ctx, home, away };
      const kickoff =
        typeof raw.commence_time === 'string' ? parseIsoInstant(raw.commence_time) : null;
      if (kickoff === null) {
        collector.issue('error', 'bad_time', 'commence_time must be an ISO instant', {
          ...named,
          value: raw.commence_time,
        });
        return;
      }
      if (raw.completed !== true) return;
      if (kickoff.getTime() >= fetchedAt.getTime()) {
        collector.issue('error', 'bad_time', 'a completed match cannot start in the future', named);
        return;
      }
      const scores = asArray(raw.scores).filter(isObject);
      const goalsOf = (team: string): number | null => {
        const rows = scores.filter((row) => row.name === team);
        return rows.length === 1 ? parseScoreInt(rows[0]?.score) : null;
      };
      const homeGoals = goalsOf(homeRaw);
      const awayGoals = goalsOf(awayRaw);
      if (homeGoals === null || awayGoals === null) {
        collector.issue(
          'warning',
          'bad_score',
          'a completed match needs one whole-number score per team',
          named,
        );
        return;
      }
      const drafts = draftsFor({
        home,
        away,
        competition: config.competition,
        kickoff,
        externalRef: eventId.slice(0, 200),
        round: null,
        status: 'finished',
        score: { home: homeGoals, away: awayGoals, htHome: null, htAway: null },
        // A10 (S-4): a cup's score may include extra time; /scores does not say.
        scoreBasis,
      });
      if (Array.isArray(drafts)) collector.acceptCompanion(drafts, named);
      else collector.issue('error', drafts.code, drafts.message, named);
    });
  }

  function summarize(collector: ParseCollector, tally: Tally): void {
    const counts = {
      live: tally.live,
      beyondHorizon: tally.beyondHorizon,
      bookNotListed: tally.bookNotListed,
      noSelection: tally.noSelection,
      notHalfLine: tally.notHalfLine,
      badUpdatedAt: tally.badUpdatedAt,
      staleMarkets: tally.staleMarkets,
      futureMarkets: tally.futureMarkets,
      incompleteBooks: tally.incompleteBooks,
      conflictingBooks: tally.conflictingBooks,
      formatFailures: tally.failed,
    };
    // Skipping live matches and Pinnacle's quarter lines is routine: not worth a warning alone.
    const routine = new Set(['live', 'beyondHorizon', 'notHalfLine']);
    const notable = Object.entries(counts).some(([k, n]) => n > 0 && !routine.has(k));
    if (!notable) return;
    collector.issue(
      'warning',
      'prices_dropped',
      'some prices or books were left out (see context for the counts)',
      { ...counts, examples: tally.examples },
    );
  }

  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    usage: { expectedCost: theOddsApiCost(config), read: readTheOddsApiUsage },
    plan(): FetchPlanItem[] {
      return [
        {
          url: theOddsApiUrl(config),
          // Odds: read on the odds schedule, by the next kickoff, slowed by the credit guard (P3).
          // Scores: read only in the result window of the league's own matches (scheduler).
          // Events: the free fixture list, on the fixtures schedule, outside the credit guard.
          purpose:
            config.mode === 'scores' ? 'results' : config.mode === 'events' ? 'fixtures' : 'odds',
          // A reference only: the fetcher reads the value when it fetches.
          auth: { header: THEODDSAPI_AUTH_HEADER, secret: config.secret },
        },
      ];
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      const request = requestOfUrl(doc.url);
      if (request?.sportKey !== config.sportKey || request.endpoint !== config.mode) {
        collector.fatal('unknown_request', 'the document URL is not this source’s request', {
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
      // An error answer ({ message, error_code }) or anything but a list: nothing is stored (A3).
      if (!Array.isArray(json)) {
        collector.fatal('bad_shape', 'expected a JSON array of events', {
          errorCode: isObject(json) && typeof json.error_code === 'string' ? json.error_code : null,
        });
        return collector.outcome();
      }
      const fetchedAt = doc.fetchedAt;
      if (config.mode === 'scores') {
        parseScores(json, collector, fetchedAt);
        return collector.outcome();
      }
      const horizon = fetchedAt.getTime() + config.horizonDays * 86_400_000;
      const tally = newTally();
      json.forEach((raw: unknown, index) => {
        if (!collector.beginRecord()) return;
        const ctx: Record<string, unknown> = { index };
        if (!isObject(raw)) {
          collector.issue('error', 'bad_record', 'an event must be an object', ctx);
          return;
        }
        const eventId = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
        if (eventId === null) {
          collector.issue('error', 'bad_record', 'an event needs an id', ctx);
          return;
        }
        ctx.eventId = eventId;
        if (raw.sport_key !== config.sportKey) {
          collector.issue('error', 'sport_mismatch', 'the event belongs to another sport key', {
            ...ctx,
            sportKey: raw.sport_key,
          });
          return;
        }
        // Kept exactly as sent: h2h outcomes are matched against these names.
        const homeRaw = typeof raw.home_team === 'string' ? raw.home_team : null;
        const awayRaw = typeof raw.away_team === 'string' ? raw.away_team : null;
        const home = cleanName(homeRaw);
        const away = cleanName(awayRaw);
        if (homeRaw === null || awayRaw === null || home === null || away === null) {
          collector.issue('error', 'bad_name', 'an event needs a home_team and an away_team', ctx);
          return;
        }
        const named = { ...ctx, home, away };
        const kickoff =
          typeof raw.commence_time === 'string' ? parseIsoInstant(raw.commence_time) : null;
        if (kickoff === null) {
          collector.issue('error', 'bad_time', 'commence_time must be an ISO instant', {
            ...named,
            value: raw.commence_time,
          });
          return;
        }
        // A4: the endpoint also returns matches being played; their prices are never read.
        if (kickoff.getTime() <= fetchedAt.getTime()) {
          tally.live += 1;
          return;
        }
        if (kickoff.getTime() > horizon) {
          tally.beyondHorizon += 1;
          return;
        }
        if (config.fixtures || config.mode === 'events') {
          const drafts = draftsFor({
            home,
            away,
            competition: config.competition,
            kickoff,
            externalRef: eventId.slice(0, 200),
            round: null,
            status: 'scheduled',
            score: null,
            scoreBasis: null,
          });
          if (Array.isArray(drafts)) collector.acceptCompanion(drafts, named);
          else collector.issue('error', drafts.code, drafts.message, named);
        }
        if (config.mode === 'events') return;
        const candidates: Candidate[] = [];
        for (const book of asArray(raw.bookmakers).filter(isObject)) {
          readBook(book, { home: homeRaw, away: awayRaw }, fetchedAt, tally, candidates);
        }
        const rows = completeBooks(
          candidates,
          {
            externalRef: eventId.slice(0, 200),
            sport: config.sport,
            competition: config.competition,
            home,
            away,
            kickoff,
          },
          tally,
          eventId,
        );
        if (rows.length > 0) collector.acceptMarketOdds(rows, named);
      });
      // Every price failed, or about half of many did: the format is not what we asked for.
      // Nothing from this page is stored: a wrong format is never worth garbage prices (A6).
      if (
        tally.failed > 0 &&
        (tally.failed === tally.checked ||
          (tally.checked >= 10 && tally.failed * 2 >= tally.checked))
      ) {
        collector.fatal(
          'wrong_price_format',
          `${tally.failed} of ${tally.checked} prices are not valid decimal prices`,
          {
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
