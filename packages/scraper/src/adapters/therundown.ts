import { americanToOddsMilli, americanToProbability, isValidAmericanOdds } from '@vamos/core';
import { z } from 'zod';
import type { ParseOutcome, RawDocument, SourceAdapter, SourceDescriptor } from '../types';
import { allowedHostsSchema, requestAuthSchema, startParse } from './common';

/**
 * TheRundown v2 (therundown.io): a pure parser of event responses, URL builders and the source
 * config. No I/O and no clock here; the poller (apps/scraper) fetches, this file reads. The API
 * key never appears in a URL: it travels in the auth block of the config (header
 * `X-TheRundown-Key`) through the fetcher. Rules P1 to P3 and M3 of docs/therundown-plan.
 */

export const THERUNDOWN_HOST = 'therundown.io';
/** TheRundown's "off the board" price: the book has no price. It never enters a calculation. */
export const THERUNDOWN_OFF_BOARD = 0.0001;
export const THERUNDOWN_MONEYLINE = 1;
export const THERUNDOWN_TOTAL = 3;

const MAX_ISSUES = 200;
const NO_STATUS = 'STATUS_NOT_AVAILABLE';

export type TherundownOutcome = 'home' | 'draw' | 'away' | 'over' | 'under';

export interface TherundownPrice {
  bookId: number;
  marketId: number;
  outcome: TherundownOutcome;
  /** half-point line for totals ("2.5"), null for the moneyline */
  line: string | null;
  american: number;
  oddsMilli: number;
  /** implied, with the book's margin */
  probability: number;
  isMainLine: boolean;
  updatedAt: Date;
  liquidityUsd: number | null;
}

export interface TherundownTeam {
  teamId: number;
  name: string;
}

export interface TherundownEvent {
  eventId: string;
  sportId: number;
  kickoff: Date;
  /** score.event_status as sent; 'STATUS_NOT_AVAILABLE' when the score object or its status is missing */
  status: string;
  home: TherundownTeam;
  away: TherundownTeam;
  prices: TherundownPrice[];
}

export type TherundownIssueCode =
  | 'fatal'
  | 'invalid_event'
  | 'home_away_mismatch'
  | 'market_not_allowed'
  | 'period_not_allowed'
  | 'line_not_allowed'
  | 'unknown_participant'
  | 'off_board'
  | 'closed_price'
  | 'invalid_price'
  | 'duplicate_price';

export interface TherundownIssue {
  code: TherundownIssueCode;
  eventId?: string;
  detail: string;
}

export interface TherundownParseResult {
  events: TherundownEvent[];
  issues: TherundownIssue[];
  counts: Partial<Record<TherundownIssueCode, number>>;
}

export interface TherundownParseOptions {
  /** market ids kept (default [1, 3]); every other market is dropped (rule P1) */
  allowedMarketIds?: readonly number[];
}

// ---------------------------------------------------------------------------
// Fields we read (everything else is ignored)

const eventHeaderSchema = z.object({
  event_id: z.string().min(1),
  sport_id: z.number().int(),
  event_date: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()))
    .transform((s) => new Date(s)),
});

const priceObjectSchema = z.object({
  price: z.union([z.number(), z.string()]),
  is_main_line: z.unknown().optional(),
  updated_at: z.unknown().optional(),
  closed_at: z.unknown().optional(),
  liquidity_usd: z.unknown().optional(),
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const positiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

class Collector {
  readonly issues: TherundownIssue[] = [];
  readonly counts: Partial<Record<TherundownIssueCode, number>> = {};
  add(code: TherundownIssueCode, detail: string, eventId?: string): void {
    this.counts[code] = (this.counts[code] ?? 0) + 1;
    if (this.issues.length < MAX_ISSUES) {
      this.issues.push(eventId === undefined ? { code, detail } : { code, eventId, detail });
    }
  }
}

function fatal(detail: string): TherundownParseResult {
  const c = new Collector();
  c.add('fatal', detail);
  return { events: [], issues: c.issues, counts: c.counts };
}

function decode(body: string | Uint8Array): string | null {
  if (typeof body === 'string') return body;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/** Finds the events in the documented shapes (day list, `{events}`, `{event}`, bare event). */
function eventsOf(json: unknown): unknown[] | null {
  if (!isObject(json)) return null;
  if (Array.isArray(json.events)) return json.events as unknown[];
  if (isObject(json.event)) return [json.event];
  if (typeof json.event_id === 'string') return [json];
  return null;
}

/** "+2.5", "2.50", " 2.5 " give "2.5"; null when it is not a plain number. */
function normaliseLine(raw: unknown): string | null {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^\+?\d{1,3}(\.\d+)?$/.test(t)) return null;
  const [whole = '0', fraction = ''] = t.replace(/^\+/, '').split('.');
  const frac = fraction.replace(/0+$/, '');
  const int = String(Number(whole));
  return frac === '' ? int : `${int}.${frac}`;
}

const isHalfPoint = (line: string): boolean => /^\d{1,3}\.5$/.test(line);

const isOffBoard = (n: number): boolean => Math.abs(n - THERUNDOWN_OFF_BOARD) < 1e-9;

function priceNumber(raw: number | string): number {
  if (typeof raw === 'number') return raw;
  const t = raw.trim();
  return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

interface Teams {
  home: TherundownTeam;
  away: TherundownTeam;
}

function teamsOf(event: Record<string, unknown>): Teams | string {
  const teams = Array.isArray(event.teams) ? event.teams.filter(isObject) : [];
  const homes = teams.filter((t) => t.is_home === true);
  const aways = teams.filter((t) => t.is_away === true);
  const [h] = homes;
  const [a] = aways;
  if (homes.length !== 1 || aways.length !== 1 || !h || !a) {
    return `expected exactly one home and one away team, found ${homes.length} and ${aways.length}`;
  }
  if (!positiveInt(h.team_id) || !positiveInt(a.team_id) || h.team_id === a.team_id) {
    return 'home and away team_id must be different positive integers';
  }
  const score = isObject(event.score) ? event.score : {};
  for (const [key, id] of [
    ['team_id_home', h.team_id],
    ['team_id_away', a.team_id],
  ] as const) {
    const given = score[key];
    if (given !== undefined && given !== null && given !== 0 && given !== id) {
      return `score.${key} ${JSON.stringify(given)} disagrees with the team flags (${id})`;
    }
  }
  const name = (t: Record<string, unknown>): string => (typeof t.name === 'string' ? t.name : '');
  return {
    home: { teamId: h.team_id, name: name(h) },
    away: { teamId: a.team_id, name: name(a) },
  };
}

function outcomeOf(
  marketId: number,
  participant: Record<string, unknown>,
  teams: Teams,
): TherundownOutcome | null {
  const name = typeof participant.name === 'string' ? participant.name.trim().toLowerCase() : '';
  if (marketId === THERUNDOWN_TOTAL) {
    return name === 'over' ? 'over' : name === 'under' ? 'under' : null;
  }
  if (participant.type === 'TYPE_TEAM') {
    if (participant.id === teams.home.teamId) return 'home';
    if (participant.id === teams.away.teamId) return 'away';
  }
  return name === 'draw' ? 'draw' : null;
}

function readPrice(
  bookKey: string,
  raw: unknown,
  marketId: number,
  outcome: TherundownOutcome,
  line: string | null,
  eventId: string,
  c: Collector,
): TherundownPrice | null {
  const where = `book ${bookKey}, market ${marketId}`;
  const bookId = /^[1-9]\d{0,9}$/.test(bookKey) ? Number(bookKey) : Number.NaN;
  const parsed = priceObjectSchema.safeParse(raw);
  if (!Number.isSafeInteger(bookId) || !parsed.success) {
    c.add('invalid_price', `${where}: bad book id or price object`, eventId);
    return null;
  }
  const p = parsed.data;
  const american = priceNumber(p.price);
  if (isOffBoard(american)) {
    c.add('off_board', where, eventId);
    return null;
  }
  if (p.closed_at !== undefined && p.closed_at !== null) {
    c.add('closed_price', where, eventId);
    return null;
  }
  if (!isValidAmericanOdds(american)) {
    c.add('invalid_price', `${where}: price ${String(p.price)}`, eventId);
    return null;
  }
  const updated = typeof p.updated_at === 'string' ? new Date(p.updated_at) : null;
  if (!updated || Number.isNaN(updated.getTime())) {
    c.add('invalid_price', `${where}: updated_at is not a date`, eventId);
    return null;
  }
  const liquidity = p.liquidity_usd;
  return {
    bookId,
    marketId,
    outcome,
    line,
    american,
    oddsMilli: americanToOddsMilli(american),
    probability: americanToProbability(american),
    isMainLine: p.is_main_line === true,
    updatedAt: updated,
    liquidityUsd:
      typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity >= 0
        ? liquidity
        : null,
  };
}

function readEvent(
  raw: unknown,
  allowed: ReadonlySet<number>,
  c: Collector,
): TherundownEvent | null {
  const header = eventHeaderSchema.safeParse(raw);
  if (!header.success || !isObject(raw)) {
    const id = isObject(raw) && typeof raw.event_id === 'string' ? raw.event_id : undefined;
    c.add('invalid_event', 'event_id, sport_id and event_date are required', id);
    return null;
  }
  const eventId = header.data.event_id;
  const teams = teamsOf(raw);
  if (typeof teams === 'string') {
    c.add('home_away_mismatch', teams, eventId);
    return null;
  }
  const score = isObject(raw.score) ? raw.score : {};
  const status =
    typeof score.event_status === 'string' && score.event_status !== ''
      ? score.event_status
      : NO_STATUS;
  const kept = new Map<string, TherundownPrice>();

  for (const market of Array.isArray(raw.markets) ? raw.markets : []) {
    if (!isObject(market)) continue;
    const marketId = market.market_id;
    const ids = `market_id ${String(marketId)}, period_id ${String(market.period_id)}`;
    if (
      typeof marketId !== 'number' ||
      !allowed.has(marketId) ||
      (marketId !== THERUNDOWN_MONEYLINE && marketId !== THERUNDOWN_TOTAL)
    ) {
      c.add('market_not_allowed', ids, eventId);
      continue;
    }
    if (market.period_id !== 0) {
      c.add('period_not_allowed', ids, eventId);
      continue;
    }
    for (const participant of Array.isArray(market.participants) ? market.participants : []) {
      if (!isObject(participant)) continue;
      const outcome = outcomeOf(marketId, participant, teams);
      if (outcome === null) {
        c.add(
          'unknown_participant',
          `market_id ${marketId}, participant id ${String(participant.id)}`,
          eventId,
        );
        continue;
      }
      for (const lineObj of Array.isArray(participant.lines) ? participant.lines : []) {
        if (!isObject(lineObj)) continue;
        let line: string | null = null;
        if (marketId === THERUNDOWN_MONEYLINE) {
          const v = lineObj.value;
          if (!(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))) {
            c.add('line_not_allowed', `moneyline with a line "${JSON.stringify(v)}"`, eventId);
            continue;
          }
        } else {
          line = normaliseLine(lineObj.value);
          if (line === null || !isHalfPoint(line)) {
            c.add('line_not_allowed', `total line "${String(lineObj.value)}"`, eventId);
            continue;
          }
        }
        if (!isObject(lineObj.prices)) continue;
        for (const [bookKey, priceRaw] of Object.entries(lineObj.prices)) {
          const price = readPrice(bookKey, priceRaw, marketId, outcome, line, eventId, c);
          if (!price) continue;
          const key = `${price.bookId}|${marketId}|${outcome}|${line ?? ''}`;
          const previous = kept.get(key);
          if (previous) {
            c.add('duplicate_price', `book ${price.bookId}, ${key}`, eventId);
            if (price.updatedAt.getTime() <= previous.updatedAt.getTime()) continue;
          }
          kept.set(key, price);
        }
      }
    }
  }
  return {
    eventId,
    sportId: header.data.sport_id,
    kickoff: header.data.event_date,
    status,
    home: teams.home,
    away: teams.away,
    prices: [...kept.values()],
  };
}

/**
 * Parses a TheRundown v2 events response (day list or single event). Never throws: bad JSON or
 * a wrong top-level shape gives one `fatal` issue and no events. Keeps only the allowed markets
 * at period 0 (P1), valid American prices (P2), half-point totals (P3), and reads home and away
 * from the team flags and ids only (M3). An event with no valid price is still returned.
 */
export function parseTherundownEvents(
  body: string | Uint8Array,
  options: TherundownParseOptions = {},
): TherundownParseResult {
  try {
    const text = decode(body);
    if (text === null) return fatal('the body is not valid UTF-8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fatal('the body is not JSON');
    }
    const list = eventsOf(json);
    if (list === null) return fatal('expected an object with "events", "event" or an event_id');
    const allowed = new Set(options.allowedMarketIds ?? [THERUNDOWN_MONEYLINE, THERUNDOWN_TOTAL]);
    const c = new Collector();
    const events: TherundownEvent[] = [];
    for (const raw of list) {
      const event = readEvent(raw, allowed, c);
      if (event) events.push(event);
    }
    return { events, issues: c.issues, counts: c.counts };
  } catch (error) {
    return fatal(`unexpected: ${error instanceof Error ? error.message : 'error'}`);
  }
}

// ---------------------------------------------------------------------------
// URLs (programming errors throw RangeError)

export interface TherundownFilters {
  marketIds: readonly number[];
  bookIds: readonly number[];
}

function checkIds(name: string, ids: readonly number[], max: number): string {
  if (
    ids.length < 1 ||
    ids.length > max ||
    new Set(ids).size !== ids.length ||
    !ids.every(positiveInt)
  ) {
    throw new RangeError(`${name}: 1 to ${max} distinct positive integers`);
  }
  return ids.join(',');
}

function checkBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function checkSport(sportId: number): number {
  if (!positiveInt(sportId)) throw new RangeError('sportId must be a positive integer');
  return sportId;
}

function checkDate(utcDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) throw new RangeError('utcDate must be YYYY-MM-DD');
  return utcDate;
}

/** 'YYYY-MM-DD' of the UTC day of `date`. */
export function utcDateOf(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid date');
  return date.toISOString().slice(0, 10);
}

function filterQuery(f: TherundownFilters): string {
  const markets = checkIds('marketIds', f.marketIds, 12);
  const books = checkIds('bookIds', f.bookIds, 20);
  return `market_ids=${markets}&affiliate_ids=${books}&main_line=true&hide_closed=true`;
}

export function therundownDayUrl(
  baseUrl: string,
  sportId: number,
  utcDate: string,
  filters: TherundownFilters,
): string {
  const base = checkBase(baseUrl);
  const path = `/api/v2/sports/${checkSport(sportId)}/events/${checkDate(utcDate)}`;
  return `${base}${path}?${filterQuery(filters)}&offset=0`;
}

export function therundownEventUrl(
  baseUrl: string,
  eventId: string,
  filters: TherundownFilters,
): string {
  return `${checkBase(baseUrl)}/api/v2/events/${encodeURIComponent(eventId)}?${filterQuery(filters)}`;
}

/** The day list without prices (affiliate 0): scores and statuses only. */
export function therundownScoresUrl(baseUrl: string, sportId: number, utcDate: string): string {
  const path = `/api/v2/sports/${checkSport(sportId)}/events/${checkDate(utcDate)}`;
  return `${checkBase(baseUrl)}${path}?affiliate_ids=0&offset=0`;
}

export function therundownAffiliatesUrl(baseUrl: string): string {
  return `${checkBase(baseUrl)}/api/v2/affiliates`;
}

// ---------------------------------------------------------------------------
// Source config and adapter

const distinctInts = (min: number, max: number) =>
  z
    .array(z.number().int().positive())
    .min(min)
    .max(max)
    .refine((a) => new Set(a).size === a.length, 'ids must be distinct');

export const TherundownConfigSchema = z
  .strictObject({
    allowedHosts: allowedHostsSchema
      .default([THERUNDOWN_HOST])
      .refine((h) => h.includes(THERUNDOWN_HOST), `allowedHosts must include ${THERUNDOWN_HOST}`),
    auth: requestAuthSchema,
    competitions: z
      .array(
        z.strictObject({
          sportId: z.number().int().positive(),
          competition: z.string().trim().min(1).max(120),
        }),
      )
      .min(1)
      .max(30)
      .refine(
        (a) => new Set(a.map((x) => x.sportId)).size === a.length,
        'sportIds must be distinct',
      ),
    markets: distinctInts(1, 12).default([THERUNDOWN_MONEYLINE, THERUNDOWN_TOTAL]),
    books: z.strictObject({
      anchors: distinctInts(1, 5),
      others: distinctInts(0, 15).default([]),
    }),
  })
  .superRefine((cfg, ctx) => {
    const others = new Set(cfg.books.others);
    if (cfg.books.anchors.some((id) => others.has(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['books'],
        message: 'anchors and others must not overlap',
      });
    }
  });
export type TherundownConfig = z.infer<typeof TherundownConfigSchema>;

/**
 * TheRundown is polled by its own task (budget, cadence tiers), not by the generic scheduler,
 * so this adapter plans nothing and its documents produce no fixture or result records.
 */
export function createTherundownAdapter(
  descriptor: SourceDescriptor,
  config: TherundownConfig,
): SourceAdapter {
  return {
    descriptor,
    allowedHosts: config.allowedHosts,
    plan: () => [],
    parse(doc: RawDocument): ParseOutcome {
      return startParse(descriptor.id, doc).collector.outcome();
    },
  };
}
