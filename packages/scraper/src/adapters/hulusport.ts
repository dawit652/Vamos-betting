import { type MarketTypeCode, parseHandicap, parseLine } from '@vamos/core';
import { decimalToMilli } from './odds-price';

/**
 * Hulusport (api.hulusport.et), a competitor's sportsbook board, read as a price source (owner's
 * decision of 14 Nov 2026, docs/plans/hulusport-feed.md). Pure: no network, no clock.
 *
 * Nahubet does not call Hulusport itself: the owner's mr-x service polls it and serves the board
 * (`GET /api/board`, parseMrxBoard), each match in Hulusport's own shape. apps/scraper
 * (tasks/hulusport.ts) reads that board. Hulusport's own documents, which mr-x reads:
 * - `/sport-data/coredata/?ln=en`: sports (`sport_types`), leagues and league groups (countries);
 * - `/sport-data/matches/?ln=en`: every listed match, without its markets;
 * - `/sport-data/matches/<id>/`: one match with every market (`items`).
 *
 * Only the markets Vamos can settle are kept, mapped onto its market types: 3 Way (1x2), Double
 * chance (dc), Over/Under on half-point lines (ou), Handicap "a:b" on a non-zero whole line (eh),
 * Both teams to score (btts), Draw no bet (dnb) and 1st half 3 Way (ht_1x2). A market is kept only
 * when every one of its selections is listed, available and priced: a partial book cannot be
 * re-margined. Correct score is left out on purpose: Hulusport lists only scores up to six goals,
 * caps long shots at 101 and has no "other" selection, so its book cannot be completed. Asian
 * handicaps are not offered by Hulusport.
 *
 * The prices are Hulusport's, margin included. They are never shown as they are: the pricing step
 * (@vamos/feed priceBoardMarkets) removes the margin and applies ours.
 */

export const HULUSPORT_HOST = 'api.hulusport.et';
export const HULUSPORT_SOURCE_ID = 'hulusport';
export const HULUSPORT_COREDATA_PATH = '/sport-data/coredata/?ln=en';
export const HULUSPORT_MATCHES_PATH = '/sport-data/matches/?ln=en';
export const hulusportMatchPath = (id: number): string => `/sport-data/matches/${id}/`;

/** One market of a board: Hulusport's own prices (margin included) under Vamos selection codes. */
export interface BoardMarket {
  type: MarketTypeCode;
  /** The canonical line ('2.5', '-1') for 'ou' and 'eh', else null. */
  line: string | null;
  /** Every selection of the market type, in display order. */
  prices: Array<{ code: string; priceMilli: number }>;
}

export interface HulusportLeague {
  id: number;
  name: string;
  sportTypeId: number | null;
  /** The country or region (league group), when coredata names it. */
  group: string | null;
}

export interface HulusportCoredata {
  /** The id of football (a sport type named Soccer or Football), null when none is listed. */
  footballSportTypeId: number | null;
  leagues: Map<number, HulusportLeague>;
}

export interface HulusportListedMatch {
  id: number;
  home: string;
  away: string;
  kickoff: Date;
  leagueId: number | null;
}

export interface HulusportMatch extends HulusportListedMatch {
  sportTypeId: number | null;
  leagueName: string | null;
  /** True once Hulusport has taken the match off its board (it started or finished). */
  expired: boolean;
  markets: BoardMarket[];
  /** Markets of a supported kind that were dropped (incomplete, unavailable, a bad price or line). */
  dropped: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const int = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};
/** An id given as a number or as an object with an id ({ id: 79 } or 79). */
const idOf = (value: unknown): number | null => (isObject(value) ? int(value.id) : int(value));

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The kickoff: an ISO time with an offset ('2026-11-13T22:45:00+03:00'); anything else is null. */
function kickoffOf(value: unknown): Date | null {
  const s = text(value);
  if (
    s === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)
  ) {
    return null;
  }
  const at = new Date(s);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The coredata document, or null when it is not one. */
export function parseHulusportCoredata(body: string): HulusportCoredata | null {
  const doc = parseJson(body);
  if (!isObject(doc) || !Array.isArray(doc.sport_types) || !Array.isArray(doc.leagues)) return null;
  const sportTypes: unknown[] = doc.sport_types;
  const football = sportTypes.find(
    (s) => isObject(s) && /^(soccer|football)$/i.test(text(s.name) ?? ''),
  );
  const groups = new Map<number, string>();
  if (Array.isArray(doc.league_groups)) {
    for (const g of doc.league_groups) {
      const id = isObject(g) ? int(g.id) : null;
      const name = isObject(g) ? text(g.name) : null;
      if (id !== null && name !== null) groups.set(id, name);
    }
  }
  const leagues = new Map<number, HulusportLeague>();
  for (const l of doc.leagues) {
    if (!isObject(l)) continue;
    const id = int(l.id);
    const name = text(l.name);
    if (id === null || name === null) continue;
    const groupId = idOf(l.league_group);
    leagues.set(id, {
      id,
      name,
      sportTypeId: idOf(l.sport_type),
      group: groupId === null ? null : (groups.get(groupId) ?? null),
    });
  }
  return { footballSportTypeId: isObject(football) ? int(football.id) : null, leagues };
}

function listedMatchOf(m: unknown): HulusportListedMatch | null {
  if (!isObject(m)) return null;
  const id = int(m.id);
  const home = text(m.hom);
  const away = text(m.awy);
  const kickoff = kickoffOf(m.schedule);
  if (id === null || home === null || away === null || kickoff === null || home === away) {
    return null;
  }
  return { id, home, away, kickoff, leagueId: idOf(m.league) };
}

/** The match list (an array, or a page with `results`); null when the document is not one. */
export function parseHulusportMatchList(body: string): HulusportListedMatch[] | null {
  const doc = parseJson(body);
  const list = Array.isArray(doc)
    ? doc
    : isObject(doc) && Array.isArray(doc.results)
      ? doc.results
      : null;
  if (list === null) return null;
  return list.flatMap((m) => {
    const match = listedMatchOf(m);
    return match === null ? [] : [match];
  });
}

/** The competitor placeholders Hulusport writes in selection names. */
const HOME = '{$competitor1}';
const AWAY = '{$competitor2}';

/** Hulusport selection name (lower case, placeholders kept) to Vamos code, per market type. */
const SELECTION_CODES: Partial<Record<MarketTypeCode, Readonly<Record<string, string>>>> = {
  '1x2': { [HOME]: '1', draw: 'X', [AWAY]: '2' },
  ht_1x2: { [HOME]: '1', draw: 'X', [AWAY]: '2' },
  dc: { [`${HOME} or draw`]: '1X', [`${HOME} or ${AWAY}`]: '12', [`draw or ${AWAY}`]: 'X2' },
  ou: { 'over {total}': 'over', 'under {total}': 'under' },
  eh: { [`${HOME} ({hcp})`]: '1', 'draw ({hcp})': 'X', [`${AWAY} ({hcp})`]: '2' },
  btts: { yes: 'yes', no: 'no' },
  dnb: { [HOME]: '1', [AWAY]: '2' },
};

/** Selection codes per type, in display order (the same as selectionsFor in @vamos/core). */
const CODE_ORDER: Partial<Record<MarketTypeCode, readonly string[]>> = {
  '1x2': ['1', 'X', '2'],
  ht_1x2: ['1', 'X', '2'],
  dc: ['1X', '12', 'X2'],
  ou: ['over', 'under'],
  eh: ['1', 'X', '2'],
  btts: ['yes', 'no'],
  dnb: ['1', '2'],
};

/** Hulusport market (bet group) name, lower case, to Vamos type. */
const MARKET_TYPE_OF: Readonly<Record<string, MarketTypeCode>> = {
  '3 way': '1x2',
  'double chance': 'dc',
  'over/under': 'ou',
  'handicap {hcp}': 'eh',
  'both teams to score': 'btts',
  'draw no bet': 'dnb',
  '1st half - 3 way': 'ht_1x2',
};

/** The Vamos line of a market, or null when it cannot be offered ('' for a market without lines). */
function lineOf(type: MarketTypeCode, specifier: unknown): string | null {
  const spec = isObject(specifier) ? specifier : {};
  if (type === 'ou') {
    const total = text(spec.total) ?? (typeof spec.total === 'number' ? String(spec.total) : null);
    if (total === null) return null;
    try {
      return String(parseLine(total));
    } catch {
      return null; // whole and quarter totals cannot be settled without a push
    }
  }
  if (type === 'eh') {
    // "a:b": the home side starts with a goals, the away side with b, so the home line is a - b.
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(text(spec.hcp) ?? '');
    if (m === null) return null;
    const value = Number(m[1]) - Number(m[2]);
    try {
      parseHandicap(String(value), { wholeOnly: true });
    } catch {
      return null; // a level start (0:0) is the 1X2 itself, not a handicap
    }
    return String(value);
  }
  return Object.keys(spec).length === 0 ? '' : null;
}

function marketOf(item: unknown): { market: BoardMarket | null; supported: boolean } {
  if (!isObject(item) || !isObject(item.bet_group)) return { market: null, supported: false };
  const type = MARKET_TYPE_OF[(text(item.bet_group.name) ?? '').toLowerCase()];
  if (type === undefined) return { market: null, supported: false };
  const line = lineOf(type, item.specifier);
  const codes = SELECTION_CODES[type]!;
  const order = CODE_ORDER[type]!;
  if (line === null || !Array.isArray(item.odds)) return { market: null, supported: true };
  const found = new Map<string, number>();
  for (const odd of item.odds) {
    if (!isObject(odd) || !isObject(odd.bet_type)) continue;
    const code = codes[(text(odd.bet_type.name) ?? '').toLowerCase()];
    if (code === undefined) continue;
    const price = decimalToMilli(odd.odd);
    if (odd.is_available !== true || !price.ok || found.has(code)) {
      return { market: null, supported: true };
    }
    found.set(code, price.milli);
  }
  if (found.size !== order.length) return { market: null, supported: true };
  return {
    market: {
      type,
      line: line === '' ? null : line,
      prices: order.map((code) => ({ code, priceMilli: found.get(code)! })),
    },
    supported: true,
  };
}

/** One match with its markets, or null when the document is not a match. */
export function parseHulusportMatch(body: string): HulusportMatch | null {
  return readHulusportMatch(parseJson(body));
}

/** A match as the mr-x board serves it: Hulusport's match, plus when mr-x last read its odds. */
export interface BoardMatch extends HulusportMatch {
  /** When mr-x last read the match from Hulusport successfully; null: its odds were never read. */
  pricesAt: Date | null;
  /** The league's country or region, when known. */
  leagueGroup: string | null;
}

export interface MrxBoard {
  generatedAt: Date;
  /** When mr-x's poller last finished a cycle with at least one match read; null if never. */
  lastSuccessAt: Date | null;
  matches: BoardMatch[];
  /** Matches in the document that could not be read. */
  rejected: number;
}

/** An ISO time (any offset), or null. */
function timeOf(value: unknown): Date | null {
  const s = text(value);
  if (s === null) return null;
  const at = new Date(s);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * The board of the mr-x service (`GET /api/board`): `{ generated_at, worker, matches }`, each match
 * in Hulusport's shape with `odds_checked_at` and the league's name and group. Null when the
 * document is not a board; a match that cannot be read is counted in `rejected`.
 */
export function parseMrxBoard(body: string): MrxBoard | null {
  const doc = parseJson(body);
  if (!isObject(doc) || !Array.isArray(doc.matches)) return null;
  const generatedAt = timeOf(doc.generated_at);
  if (generatedAt === null) return null;
  const worker = isObject(doc.worker) ? doc.worker : null;
  const matches: BoardMatch[] = [];
  let rejected = 0;
  for (const raw of doc.matches) {
    const match = readHulusportMatch(raw);
    if (match === null || !isObject(raw)) {
      rejected += 1;
      continue;
    }
    const league = isObject(raw.league) ? raw.league : null;
    matches.push({
      ...match,
      pricesAt: timeOf(raw.odds_checked_at),
      leagueGroup: league === null ? null : text(league.group),
    });
  }
  return {
    generatedAt,
    lastSuccessAt: worker === null ? null : timeOf(worker.last_success_at),
    matches,
    rejected,
  };
}

function readHulusportMatch(doc: unknown): HulusportMatch | null {
  const listed = listedMatchOf(doc);
  if (listed === null || !isObject(doc) || !Array.isArray(doc.items)) return null;
  const league = isObject(doc.league) ? doc.league : null;
  const markets: BoardMarket[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of doc.items) {
    const { market, supported } = marketOf(item);
    if (market === null) {
      if (supported) dropped += 1;
      continue;
    }
    const key = `${market.type}:${market.line ?? ''}`;
    if (seen.has(key)) {
      // Two books for one market: neither is trusted.
      const at = markets.findIndex((m) => `${m.type}:${m.line ?? ''}` === key);
      if (at >= 0) markets.splice(at, 1);
      dropped += 2;
      continue;
    }
    seen.add(key);
    markets.push(market);
  }
  return {
    ...listed,
    sportTypeId: league === null ? null : idOf(league.sport_type),
    leagueName: league === null ? null : text(league.name),
    expired: doc.expired === true || doc.is_active === false,
    markets,
    dropped,
  };
}
