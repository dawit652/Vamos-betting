import type {
  FetchPlanItem,
  ParseOutcome,
  RateLimitReading,
  RawDocument,
  SourceAdapter,
  SourceDescriptor,
} from '../types';
import {
  cleanName,
  parseEpoch,
  parseIsoInstant,
  startParse,
  type MarketOddsDraft,
  type ParseCollector,
} from './common';
import { decimalToMilli } from './odds-price';

/**
 * API-Football's pre-match odds as bookmaker prices (`market_odds`), the `odds` mode of the
 * `apifootball` adapter (docs/plans/feed-gaps-2026-11-23.md, E2): the rows The Odds API gives
 * today, so the pricing step is unchanged. One source is one league.
 *
 * Checked on a real answer (23 Nov 2026, Premier League): `GET /odds?league=&season=&page=` lists
 * 10 matches a page (`paging.total` pages, past matches of the week included), each with `league`,
 * `fixture` (id, date, timestamp: no team names), `update` (when its odds were last refreshed) and
 * `bookmakers` (id, name, bets: id, name, values: value, odd as text). So each run reads the
 * league's fixtures first (team names, from today to `horizonDays` ahead) and then `pages` odds
 * pages, all on the odds schedule and always in full (`revalidate: false`). The fixtures page
 * yields no records: it only names the matches of the odds pages that follow it in the same run
 * (the adapter is built for one run).
 *
 * - Match Winner (bet 1: Home, Draw, Away) is the 1X2; Goals Over/Under (bet 5: "Over 2.5", "Under
 *   2.5") gives the over/under on half lines from 0.5 to 5.5 (others, such as 7.5 at 1.00, are
 *   left out). A bookmaker's 1X2 or line is kept whole or not at all.
 * - Bookmakers are named like The Odds API's keys where it is the same book (Pinnacle is
 *   `pinnacle`, a sharp book: rule O1m), so one book listed by both upstreams counts once.
 * - A match that started, lies beyond the horizon, or whose `update` is older than
 *   `maxOddsAgeMinutes` (API-Football refreshes pre-match odds about every 3 hours) or in the
 *   future gives no prices. Most prices unreadable: the page is refused (wrong format, rule A6).
 */

export interface ApiFootballOddsOptions {
  descriptor: SourceDescriptor;
  allowedHosts: readonly string[];
  host: string;
  authHeader: string;
  /** The NAME of the environment variable that holds the key. */
  secret: string;
  sport: MarketOddsDraft['sport'];
  league: number;
  /** The season (its first year); undefined: worked out from the date (apiFootballSeason). */
  season: number | undefined;
  calendarYear: boolean;
  pages: number;
  horizonDays: number;
  maxOddsAgeMinutes: number;
  readRateLimit: (headers: Readonly<Record<string, string>>) => RateLimitReading | null;
}

const DAY_MS = 86_400_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** Kickoffs of the fixtures page and the odds page may differ this much (seconds rounding). */
const KICKOFF_TOLERANCE_MS = 60_000;
/** The highest over/under line read. */
const MAX_LINE = 5.5;
/** Longest competition label (types.ts nameSchema). */
const MAX_NAME = 120;

type Json = Record<string, unknown>;
type Selection = MarketOddsDraft['selection'];
type Market = MarketOddsDraft['market'];

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The season API-Football files a league's current matches under: its first year. A league
 * played from August to May starts a new season in July; a calendar-year league (Brasileirão)
 * each January.
 */
export function apiFootballSeason(now: Date, calendarYear: boolean): number {
  const year = now.getUTCFullYear();
  return calendarYear || now.getUTCMonth() >= 6 ? year : year - 1;
}

/** API-Football bookmaker names (letters and digits, lower case) to The Odds API's keys. */
const BOOKMAKER_KEYS: Readonly<Record<string, string>> = {
  pinnacle: 'pinnacle',
  williamhill: 'williamhill',
  marathonbet: 'marathonbet',
  '1xbet': 'onexbet',
  betvictor: 'betvictor',
  '888sport': 'sport888',
  unibet: 'unibet_eu',
  betsson: 'betsson',
  nordicbet: 'nordicbet',
};

/** A bookmaker's key: The Odds API's when it is the same book, else its name in plain letters. */
export function apiFootballBookmakerKey(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const plain = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (plain === '') return null;
  return (BOOKMAKER_KEYS[plain] ?? plain).slice(0, 64);
}

/** "Country - League [id]", the label the by-date fixtures of the same adapter use. */
function competitionLabel(league: Json, leagueId: number): string | null {
  const name = cleanName(league.name);
  if (name === null) return null;
  const country = cleanName(league.country);
  const suffix = ` [${leagueId}]`;
  const prefix = country === null ? '' : `${country} - `;
  return `${prefix}${name.slice(0, Math.max(1, MAX_NAME - prefix.length - suffix.length))}${suffix}`.slice(
    0,
    MAX_NAME,
  );
}

/** Field names of a non-empty `errors` (never the messages: they can echo the request). */
function envelopeErrors(errors: unknown): string | null {
  if (Array.isArray(errors)) return errors.length > 0 ? `${errors.length} error(s)` : null;
  if (isObject(errors)) {
    const keys = Object.keys(errors);
    return keys.length > 0 ? keys.slice(0, 5).join(',') : null;
  }
  return errors === undefined || errors === null ? null : 'errors is not an object or array';
}

interface Request {
  kind: 'fixtures' | 'odds';
  league: number;
  season: number;
  page: number | null;
}

function requestOf(url: string, host: string): Request | null {
  try {
    const u = new URL(url);
    if (u.host !== host) return null;
    const kind = u.pathname === '/fixtures' ? 'fixtures' : u.pathname === '/odds' ? 'odds' : null;
    const league = Number(u.searchParams.get('league'));
    const season = Number(u.searchParams.get('season'));
    if (kind === null || !Number.isSafeInteger(league) || !Number.isSafeInteger(season))
      return null;
    const page = kind === 'odds' ? Number(u.searchParams.get('page')) : null;
    if (page !== null && !(Number.isSafeInteger(page) && page >= 1)) return null;
    return { kind, league, season, page };
  } catch {
    return null;
  }
}

interface Named {
  home: string;
  away: string;
  kickoff: Date;
  competition: string;
}

interface Tally {
  checked: number;
  failed: number;
  firstFailure: unknown;
  outOfRange: number;
  notListed: number;
  kickoffMismatch: number;
  started: number;
  beyondHorizon: number;
  badUpdatedAt: number;
  futureUpdatedAt: number;
  stale: number;
  incomplete: number;
  duplicateBook: number;
}

const newTally = (): Tally => ({
  checked: 0,
  failed: 0,
  firstFailure: null,
  outOfRange: 0,
  notListed: 0,
  kickoffMismatch: 0,
  started: 0,
  beyondHorizon: 0,
  badUpdatedAt: 0,
  futureUpdatedAt: 0,
  stale: 0,
  incomplete: 0,
  duplicateBook: 0,
});

const ONE_X_TWO: Readonly<Record<string, Selection>> = { Home: '1', Draw: 'X', Away: '2' };
const OVER_UNDER = /^(Over|Under) (\d{1,2}\.5)$/;

export function createApiFootballOddsAdapter(options: ApiFootballOddsOptions): SourceAdapter {
  const { descriptor, host, league } = options;
  /** The matches the fixtures page of this run named, by fixture id. */
  const named = new Map<number, Named>();
  let fixturesRead = false;

  /** A price, counting unreadable ones (a wrong format) apart from impossible ones (1.00). */
  function milliOf(value: unknown, tally: Tally): number | null {
    tally.checked += 1;
    const converted = decimalToMilli(value);
    if (converted.ok) return converted.milli;
    if (converted.problem === 'decimal_range') {
      tally.outOfRange += 1;
      return null;
    }
    tally.failed += 1;
    tally.firstFailure ??= value;
    return null;
  }

  /** One bookmaker's whole 1X2 and over/under lines, as rows. */
  function readBook(book: Json, tally: Tally): Array<Omit<Row, 'bookmaker'>> {
    const rows: Array<Omit<Row, 'bookmaker'>> = [];
    for (const bet of asArray(book.bets).filter(isObject)) {
      if (bet.id === 1) {
        const prices = new Map<Selection, number>();
        let broken = false;
        for (const v of asArray(bet.values).filter(isObject)) {
          const selection = typeof v.value === 'string' ? ONE_X_TWO[v.value] : undefined;
          if (selection === undefined) continue;
          const milli = milliOf(v.odd, tally);
          if (milli === null || prices.has(selection)) broken = true;
          else prices.set(selection, milli);
        }
        if (broken || prices.size !== 3) {
          tally.incomplete += 1;
          continue;
        }
        for (const selection of ['1', 'X', '2'] as const) {
          rows.push({ market: '1x2', line: null, selection, priceMilli: prices.get(selection)! });
        }
      } else if (bet.id === 5) {
        const lines = new Map<string, { over?: number; under?: number; broken: boolean }>();
        for (const v of asArray(bet.values).filter(isObject)) {
          const m = typeof v.value === 'string' ? OVER_UNDER.exec(v.value) : null;
          if (m === null || Number(m[2]) > MAX_LINE) continue;
          const line = m[2]!;
          const side = m[1] === 'Over' ? 'over' : 'under';
          const entry = lines.get(line) ?? { broken: false };
          const milli = milliOf(v.odd, tally);
          if (milli === null || entry[side] !== undefined) entry.broken = true;
          else entry[side] = milli;
          lines.set(line, entry);
        }
        for (const [line, entry] of lines) {
          if (entry.broken || entry.over === undefined || entry.under === undefined) {
            tally.incomplete += 1;
            continue;
          }
          rows.push({ market: 'ou', line, selection: 'over', priceMilli: entry.over });
          rows.push({ market: 'ou', line, selection: 'under', priceMilli: entry.under });
        }
      }
    }
    return rows;
  }

  function readFixtures(items: unknown[], collector: ParseCollector): void {
    fixturesRead = true;
    for (const raw of items) {
      if (!isObject(raw)) continue;
      const leagueObj = isObject(raw.league) ? raw.league : null;
      if (leagueObj === null || idOf(leagueObj.id) !== league) continue;
      const fixture = isObject(raw.fixture) ? raw.fixture : null;
      const fixtureId = idOf(fixture?.id);
      const teams = isObject(raw.teams) ? raw.teams : null;
      const home = cleanName(isObject(teams?.home) ? teams.home.name : null);
      const away = cleanName(isObject(teams?.away) ? teams.away.name : null);
      const competition = competitionLabel(leagueObj, league);
      const kickoff = parseEpoch(fixture?.timestamp, 's');
      const dated = typeof fixture?.date === 'string' ? parseIsoInstant(fixture.date) : null;
      if (
        fixtureId === null ||
        home === null ||
        away === null ||
        home === away ||
        competition === null ||
        kickoff === null ||
        dated === null ||
        dated.getTime() !== kickoff.getTime()
      ) {
        collector.issue('warning', 'bad_fixture', 'a fixture without an id, names or kickoff', {
          fixtureId,
        });
        continue;
      }
      named.set(fixtureId, { home, away, kickoff, competition });
    }
  }

  function readOdds(items: unknown[], collector: ParseCollector, fetchedAt: Date): void {
    const tally = newTally();
    const horizon = fetchedAt.getTime() + options.horizonDays * DAY_MS;
    const oldest = fetchedAt.getTime() - options.maxOddsAgeMinutes * 60_000;
    if (!fixturesRead && items.length > 0) {
      collector.issue(
        'error',
        'no_fixtures',
        'the odds came before the fixtures page that names their matches: none are used',
      );
      return;
    }
    items.forEach((raw: unknown, index) => {
      if (!collector.beginRecord()) return;
      const ctx: Record<string, unknown> = { index };
      if (!isObject(raw)) {
        collector.issue('error', 'bad_record', 'an item must be an object', ctx);
        return;
      }
      const fixture = isObject(raw.fixture) ? raw.fixture : null;
      const fixtureId = idOf(fixture?.id);
      if (fixtureId === null) {
        collector.issue('error', 'bad_record', 'an item needs a fixture id', ctx);
        return;
      }
      ctx.fixtureId = fixtureId;
      const match = named.get(fixtureId);
      // Not on the fixtures page: a match of the past week, or beyond the horizon. Routine.
      if (match === undefined) {
        tally.notListed += 1;
        return;
      }
      const kickoff = parseEpoch(fixture?.timestamp, 's');
      if (
        kickoff === null ||
        Math.abs(kickoff.getTime() - match.kickoff.getTime()) > KICKOFF_TOLERANCE_MS
      ) {
        tally.kickoffMismatch += 1;
        return;
      }
      if (match.kickoff.getTime() <= fetchedAt.getTime()) {
        tally.started += 1;
        return;
      }
      if (match.kickoff.getTime() > horizon) {
        tally.beyondHorizon += 1;
        return;
      }
      const updatedAt = typeof raw.update === 'string' ? parseIsoInstant(raw.update) : null;
      if (updatedAt === null) {
        tally.badUpdatedAt += 1;
        return;
      }
      if (updatedAt.getTime() > fetchedAt.getTime() + FUTURE_TOLERANCE_MS) {
        tally.futureUpdatedAt += 1;
        return;
      }
      if (updatedAt.getTime() < oldest) {
        tally.stale += 1;
        return;
      }
      const rows: MarketOddsDraft[] = [];
      const seen = new Set<string>();
      for (const book of asArray(raw.bookmakers).filter(isObject)) {
        const bookmaker = apiFootballBookmakerKey(book.name);
        if (bookmaker === null) continue;
        if (seen.has(bookmaker)) {
          tally.duplicateBook += 1;
          continue;
        }
        seen.add(bookmaker);
        for (const row of readBook(book, tally)) {
          rows.push({
            kind: 'market_odds',
            externalRef: String(fixtureId),
            sport: options.sport,
            competition: match.competition,
            home: match.home,
            away: match.away,
            kickoff: match.kickoff,
            ...row,
            bookmaker,
            priceUpdatedAt: updatedAt,
          });
        }
      }
      if (rows.length > 0) {
        collector.acceptMarketOdds(rows, { ...ctx, home: match.home, away: match.away });
      }
    });
    // Every price unreadable, or about half of many: not the format we read (rule A6).
    if (
      tally.failed > 0 &&
      (tally.failed === tally.checked || (tally.checked >= 10 && tally.failed * 2 >= tally.checked))
    ) {
      collector.fatal(
        'wrong_price_format',
        `${tally.failed} of ${tally.checked} prices are not valid decimal prices`,
        { firstValue: tally.firstFailure },
      );
      return;
    }
    const notable = {
      kickoffMismatch: tally.kickoffMismatch,
      badUpdatedAt: tally.badUpdatedAt,
      futureUpdatedAt: tally.futureUpdatedAt,
      duplicateBook: tally.duplicateBook,
      formatFailures: tally.failed,
    };
    if (Object.values(notable).some((n) => n > 0)) {
      collector.issue('warning', 'prices_dropped', 'some prices or matches were left out', {
        ...notable,
        stale: tally.stale,
        incomplete: tally.incomplete,
      });
    }
  }

  return {
    descriptor,
    allowedHosts: options.allowedHosts,
    rateLimit: { read: options.readRateLimit },
    plan(now: Date): FetchPlanItem[] {
      const season = options.season ?? apiFootballSeason(now, options.calendarYear);
      const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
      const auth = { header: options.authHeader, secret: options.secret };
      const base = `https://${host}`;
      const items: FetchPlanItem[] = [
        {
          url: `${base}/fixtures?league=${league}&season=${season}&from=${isoDay(today)}&to=${isoDay(
            today + options.horizonDays * DAY_MS,
          )}&timezone=UTC`,
          purpose: 'odds',
          auth,
          revalidate: false,
        },
      ];
      for (let page = 1; page <= options.pages; page += 1) {
        items.push({
          url: `${base}/odds?league=${league}&season=${season}&page=${page}`,
          purpose: 'odds',
          auth,
          revalidate: false,
        });
      }
      return items;
    },
    parse(doc: RawDocument): ParseOutcome {
      const { collector, usable } = startParse(descriptor.id, doc);
      if (!usable) return collector.outcome();
      const request = requestOf(doc.url, host);
      if (request === null || request.league !== league) {
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
      if (!isObject(json) || !Array.isArray(json.response)) {
        collector.fatal('bad_shape', 'expected an object with a response list');
        return collector.outcome();
      }
      // HTTP 200 with errors (a bad key, the day's limit): never "no odds".
      const problem = envelopeErrors(json.errors);
      if (problem !== null) {
        collector.fatal('api_error', 'the API answered with errors', { errors: problem });
        return collector.outcome();
      }
      if (json.get !== request.kind) {
        collector.fatal('bad_shape', `the answer is not a ${request.kind} answer`, {
          get: json.get,
        });
        return collector.outcome();
      }
      const params = isObject(json.parameters) ? json.parameters : {};
      if (
        String(params.league) !== String(league) ||
        String(params.season) !== String(request.season)
      ) {
        collector.fatal('bad_shape', 'the answer is for another league or season', {
          league: params.league,
          season: params.season,
        });
        return collector.outcome();
      }
      if (request.kind === 'fixtures') {
        readFixtures(json.response, collector);
        return collector.outcome();
      }
      const paging = isObject(json.paging) ? json.paging : {};
      const total = typeof paging.total === 'number' ? paging.total : null;
      if (request.page === options.pages && total !== null && total > options.pages) {
        collector.issue(
          'warning',
          'pages_missing',
          `the league has ${total} odds pages and ${options.pages} are read: raise "pages"`,
          { total, pages: options.pages },
        );
      }
      readOdds(json.response, collector, doc.fetchedAt);
      return collector.outcome();
    },
  };
}

interface Row {
  market: Market;
  line: string | null;
  selection: Selection;
  priceMilli: number;
  bookmaker: string;
}
