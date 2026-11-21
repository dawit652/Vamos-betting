import { type MarketTypeCode, parseLine } from '@vamos/core';
import type { BoardMarket } from './hulusport';
import { decimalToMilli } from './odds-price';

/**
 * Narobet's board as the owner's mr-z service serves it (owner, 21 Nov 2026; docs/plans/narobet-feed.md):
 * `GET /api/matches` (MRZ_MATCHES_PATH) answers an array of matches, each with the markets mr-z read
 * from Narobet's match detail (`markets`: `{ MARKET: { SELECTION: decimal } }`).
 * Narobet's own data comes from API-Football. Read as a price source only, like Hulusport's board:
 * the pricing step removes Narobet's margin and applies ours, and only while the back office switch
 * `narobet_pricing` is on. Pure: no I/O.
 */

export const NAROBET_BOARD = 'narobet';
/**
 * mr-z's list of upcoming football matches with the markets read here only (all of Narobet's ~60
 * markets for every match would be tens of megabytes).
 */
export const MRZ_MATCHES_PATH =
  '/api/matches?sport=football&status=SCHEDULED&markets=1X2,FIRST_HALF_WINNER,DOUBLE_CHANCE,OVER_UNDER,BTTS,DRAW_NO_BET';

export interface NarobetMatch {
  /** mr-z's id of the match (stable). */
  id: string;
  /** API-Football's fixture id, which Narobet's data carries, or null. */
  apiId: number | null;
  /** API-Football's league id, or null. */
  leagueApiId: number | null;
  league: string | null;
  country: string | null;
  home: string;
  away: string;
  kickoff: Date;
  /** When mr-z last read the match's markets from Narobet (its detail read); null: never. */
  pricesAt: Date | null;
  /** mr-z's own flag: Narobet still lists the match although its kickoff has passed. */
  pastKickoff: boolean;
  markets: BoardMarket[];
  /** Markets of a supported kind that were dropped (incomplete, a bad price or a bad line). */
  dropped: number;
}

export interface MrzMatchList {
  matches: NarobetMatch[];
  /** Entries of the answer that could not be read as a match. */
  rejected: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** An ISO time (mr-z writes UTC with Z), or null. */
function timeOf(value: unknown): Date | null {
  const s = text(value);
  if (s === null || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const at = new Date(s);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Narobet market name to Vamos type, and Narobet selection name to Vamos code, display order. */
const SIMPLE: Readonly<
  Record<string, { type: MarketTypeCode; codes: ReadonlyArray<readonly [string, string]> }>
> = {
  '1X2': {
    type: '1x2',
    codes: [
      ['HOME', '1'],
      ['DRAW', 'X'],
      ['AWAY', '2'],
    ],
  },
  FIRST_HALF_WINNER: {
    type: 'ht_1x2',
    codes: [
      ['HOME', '1'],
      ['DRAW', 'X'],
      ['AWAY', '2'],
    ],
  },
  DOUBLE_CHANCE: {
    type: 'dc',
    codes: [
      ['HOME_DRAW', '1X'],
      ['HOME_AWAY', '12'],
      ['DRAW_AWAY', 'X2'],
    ],
  },
  BTTS: {
    type: 'btts',
    codes: [
      ['YES', 'yes'],
      ['NO', 'no'],
    ],
  },
  DRAW_NO_BET: {
    type: 'dnb',
    codes: [
      ['HOME', '1'],
      ['AWAY', '2'],
    ],
  },
};

const OU_SELECTION = /^(OVER|UNDER)_(\d+(?:\.\d+)?)$/;

/** A decimal price as milli, or null when it is not a valid price. */
function milliOf(value: unknown): number | null {
  const price = decimalToMilli(value);
  return price.ok ? price.milli : null;
}

/**
 * The supported markets of one match: complete books only (every selection of the type with a valid
 * price); anything else is counted in `dropped` and left out. Narobet's other markets (handicaps,
 * correct score, half-time totals, combinations...) are not read.
 */
function marketsOf(raw: unknown): { markets: BoardMarket[]; dropped: number } {
  const markets: BoardMarket[] = [];
  let dropped = 0;
  if (!isObject(raw)) return { markets, dropped };
  for (const [name, spec] of Object.entries(SIMPLE)) {
    const book = raw[name];
    if (book === undefined) continue;
    if (!isObject(book)) {
      dropped += 1;
      continue;
    }
    const prices: BoardMarket['prices'] = [];
    for (const [selection, code] of spec.codes) {
      const milli = milliOf(book[selection]);
      if (milli === null) break;
      prices.push({ code, priceMilli: milli });
    }
    if (prices.length === spec.codes.length) {
      markets.push({ type: spec.type, line: null, prices });
    } else {
      dropped += 1;
    }
  }
  const totals = raw.OVER_UNDER;
  if (totals !== undefined) {
    if (!isObject(totals)) {
      dropped += 1;
    } else {
      // One market per line: OVER_2.5 and UNDER_2.5 make the 2.5 book.
      const lines = new Map<string, { over: number | null; under: number | null }>();
      for (const [selection, value] of Object.entries(totals)) {
        const m = OU_SELECTION.exec(selection);
        if (m === null) continue;
        let line: string;
        try {
          line = String(parseLine(m[2]!));
        } catch {
          dropped += 1;
          continue;
        }
        const entry = lines.get(line) ?? { over: null, under: null };
        entry[m[1] === 'OVER' ? 'over' : 'under'] = milliOf(value);
        lines.set(line, entry);
      }
      for (const [line, { over, under }] of [...lines.entries()].sort(
        ([a], [b]) => Number(a) - Number(b),
      )) {
        if (over === null || under === null) {
          dropped += 1;
          continue;
        }
        markets.push({
          type: 'ou',
          line,
          prices: [
            { code: 'over', priceMilli: over },
            { code: 'under', priceMilli: under },
          ],
        });
      }
    }
  }
  return { markets, dropped };
}

function matchOf(raw: unknown): NarobetMatch | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const home = text(raw.hom);
  const away = text(raw.awy);
  const kickoff = timeOf(raw.schedule);
  if (id === null || home === null || away === null || kickoff === null || home === away) {
    return null;
  }
  const { markets, dropped } = marketsOf(raw.markets);
  return {
    id,
    apiId: int(raw.api_id),
    leagueApiId: int(raw.league_api_id),
    league: text(raw.league),
    country: text(raw.country),
    home,
    away,
    kickoff,
    pricesAt: timeOf(raw.detail_at),
    pastKickoff: raw.past_kickoff === true,
    markets,
    dropped,
  };
}

/**
 * mr-z's `/api/matches` answer: a JSON array of matches. Null when the document is not such an
 * array; an entry that cannot be read is counted in `rejected`.
 */
export function parseMrzMatches(body: string): MrzMatchList | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  const matches: NarobetMatch[] = [];
  let rejected = 0;
  for (const raw of doc) {
    const match = matchOf(raw);
    if (match === null) rejected += 1;
    else matches.push(match);
  }
  return { matches, rejected };
}
