import { isValidOddsMilli } from '@vamos/core';
import { HOUR_MS, MINUTE_MS } from '../constants';
import { instant } from './internal';

/**
 * TheRundown as a reference: the pure rules that turn its prices, a minute or
 * more late, into checks on our own markets (docs/therundown-plan/README.md:
 * A1 the plan check, the timing of P7, P6 the odds-error guard, P8 moves, and
 * the kickoff rule M1/L3). No I/O, no clock (`now` is always an argument), no
 * randomness.
 *
 * Fail closed: every doubt (an invalid date, an unknown status, a broken
 * price, an unreadable header) closes, suspends or lengthens a delay. Nothing
 * here can open a market, set a price or raise a stake limit.
 *
 * Probabilities are numbers in [0, 1], odds are integer milli (1.85 is 1850);
 * money is never involved.
 */

/**
 * Float noise allowed where a computed value meets a limit written as a
 * decimal: an edge of 3% (computed as 0.030000000000000027) is on the limit of
 * 3%, not above it. Far below anything a price can resolve.
 */
const LIMIT_EPSILON = 1e-9;

// --- Cadence tiers (P7) -----------------------------------------------------

/** A TheRundown kickoff within this of ours is the same time (rule M1). */
export const KICKOFF_MATCH_TOLERANCE_MS = 5 * MINUTE_MS;

/**
 * How an event is polled, and how old its reference may be, by the time to its
 * kickoff (README 5.3, the cadence table).
 */
export interface ReferenceTier {
  name: 'near' | 'day' | 'two_days' | 'week';
  /** The tier applies while the time to kickoff is at most this. */
  upToMs: number;
  /** Poll the event this often. */
  pollMs: number;
  /** The reference (P7) is valid this long after its as-of time. */
  maxAgeMs: number;
  /** A book's newest price may be this old and still count (P4). */
  maxBookAgeMs: number;
}

const frozen = (value: ReferenceTier): ReferenceTier => Object.freeze(value);

/** From the nearest kickoff out: last 3 h, 12 h, 48 h, 7 days. Slower and longer-lived the further out. */
export const REFERENCE_TIERS: readonly ReferenceTier[] = Object.freeze([
  frozen({
    name: 'near',
    upToMs: 3 * HOUR_MS,
    pollMs: MINUTE_MS,
    maxAgeMs: 3 * MINUTE_MS,
    maxBookAgeMs: 30 * MINUTE_MS,
  }),
  frozen({
    name: 'day',
    upToMs: 12 * HOUR_MS,
    pollMs: 5 * MINUTE_MS,
    maxAgeMs: 15 * MINUTE_MS,
    maxBookAgeMs: 6 * HOUR_MS,
  }),
  frozen({
    name: 'two_days',
    upToMs: 48 * HOUR_MS,
    pollMs: 20 * MINUTE_MS,
    maxAgeMs: 60 * MINUTE_MS,
    maxBookAgeMs: 6 * HOUR_MS,
  }),
  frozen({
    name: 'week',
    upToMs: 7 * 24 * HOUR_MS,
    pollMs: 60 * MINUTE_MS,
    maxAgeMs: 3 * HOUR_MS,
    maxBookAgeMs: 6 * HOUR_MS,
  }),
]);

/**
 * The tier of an event at `now`: the first whose `upToMs` covers the time to
 * kickoff. Null once the event has started (`startTime <= now`), when it
 * starts more than 7 days ahead, or when a date is invalid.
 */
export function referenceTier(startTime: Date, now: Date): ReferenceTier | null {
  const start = instant(startTime);
  const at = instant(now);
  if (start === null || at === null) return null;
  const untilKickoff = start - at;
  if (untilKickoff <= 0) return null;
  return REFERENCE_TIERS.find((candidate) => untilKickoff <= candidate.upToMs) ?? null;
}

// --- The plan's delay (A1) --------------------------------------------------

/** What a response without a usable delay header counts as: the Free plan's delay, never 0. */
export const DEFAULT_UNKNOWN_DELAY_SECONDS = 300;
const MAX_DELAY_SECONDS = 86_400;

/** A non-negative whole number of seconds, or null for anything else (blank, a fraction, a sign, text). */
function parseDelayHeader(header: unknown): number | null {
  if (typeof header !== 'string') return null;
  const text = header.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The delay to assume for a response (A1), in whole seconds: what the
 * `X-Data-Delay-Seconds` header says, but never less than the plan says. A
 * missing, blank, non-integer or negative header counts as
 * DEFAULT_UNKNOWN_DELAY_SECONDS (or the plan's delay when that is longer):
 * never 0. Clamped to 0..86400. A plan delay that is not a number of at least
 * 0 counts as DEFAULT_UNKNOWN_DELAY_SECONDS; a fractional one is rounded up.
 */
export function effectiveDelaySeconds(
  header: string | null | undefined,
  planDelaySeconds: number,
): number {
  const plan =
    Number.isFinite(planDelaySeconds) && planDelaySeconds >= 0
      ? Math.ceil(planDelaySeconds)
      : DEFAULT_UNKNOWN_DELAY_SECONDS;
  const reported = parseDelayHeader(header);
  const delay =
    reported === null ? Math.max(DEFAULT_UNKNOWN_DELAY_SECONDS, plan) : Math.max(reported, plan);
  return Math.min(MAX_DELAY_SECONDS, delay);
}

/** The shortest close lead: betting on an event that uses TheRundown data closes at least this long before its start. */
export const MIN_CLOSE_LEAD_MS = 5 * MINUTE_MS;
/** The most a close lead can be: the cap the database allows (events.close_lead_ms, 6 h). */
const MAX_CLOSE_LEAD_MS = 6 * HOUR_MS;
const DEFAULT_NEAR_POLL_MS = MINUTE_MS;

/**
 * How long before the scheduled start betting closes on an event that uses
 * TheRundown data (events.close_lead_ms): twice the delay plus one poll of the
 * near tier, since its data is late by the delay and is read once a poll;
 * never under MIN_CLOSE_LEAD_MS and never over 6 h. A whole number of
 * milliseconds, rounded up. A delay that is not a finite number of at least 0
 * counts as DEFAULT_UNKNOWN_DELAY_SECONDS; a bad `nearPollMs` counts as one
 * minute.
 */
export function closeLeadMs(
  delaySeconds: number,
  nearPollMs: number = DEFAULT_NEAR_POLL_MS,
): number {
  const delay =
    Number.isFinite(delaySeconds) && delaySeconds >= 0
      ? delaySeconds
      : DEFAULT_UNKNOWN_DELAY_SECONDS;
  const poll = Number.isFinite(nearPollMs) && nearPollMs >= 0 ? nearPollMs : DEFAULT_NEAR_POLL_MS;
  const lead = Math.ceil(2 * delay * 1000 + poll);
  return Math.min(MAX_CLOSE_LEAD_MS, Math.max(MIN_CLOSE_LEAD_MS, lead));
}

/**
 * When the prices of a poll were true: the fetch time minus the delay. An
 * invalid `fetchedAt` gives an invalid Date. A delay that is not a finite
 * number of at least 0 counts as DEFAULT_UNKNOWN_DELAY_SECONDS (older, so the
 * reference expires sooner).
 */
export function referenceAsOf(fetchedAt: Date, delaySeconds: number): Date {
  const delay =
    Number.isFinite(delaySeconds) && delaySeconds >= 0
      ? delaySeconds
      : DEFAULT_UNKNOWN_DELAY_SECONDS;
  return new Date(fetchedAt.getTime() - delay * 1000);
}

/** P7: the reference is valid until its as-of time plus the tier's max age. */
export function priceValidUntil(asOf: Date, tier: ReferenceTier): Date {
  return new Date(asOf.getTime() + tier.maxAgeMs);
}

// --- The kickoff rule (M1, L3) ----------------------------------------------

/** The one status that says a match has not started and is on: a plain scheduled fixture. */
export const THERUNDOWN_PREMATCH_STATUSES: ReadonlySet<string> = new Set(['STATUS_SCHEDULED']);

/** Statuses that say a match has started, is over or was stopped (TheRundown's reference/event-statuses). */
export const THERUNDOWN_STARTED_STATUSES: ReadonlySet<string> = new Set([
  'STATUS_IN_PROGRESS',
  'STATUS_HALFTIME',
  'STATUS_END_PERIOD',
  'STATUS_END_OF_REGULATION',
  'STATUS_OVERTIME',
  'STATUS_FIRST_HALF',
  'STATUS_SECOND_HALF',
  'STATUS_FULL_TIME',
  'STATUS_FINAL',
  'STATUS_FINAL_AET',
  'STATUS_FINAL_PEN',
  'STATUS_SHOOTOUT',
  'STATUS_SUSPENDED',
  'STATUS_FORFEIT',
]);

/**
 * `close` shuts betting on the event, which only reduces exposure; there is no
 * action that opens it.
 */
export type KickoffVerdict =
  { action: 'none' } | { action: 'close'; reason: 'started' | 'not_scheduled' | 'earlier_kickoff' };

/**
 * Whether TheRundown's view of a match closes betting on our event. Its data is
 * a minute late, so any sign that the match is not a plain scheduled fixture
 * closes betting, in this order:
 *
 * 1. a started status (THERUNDOWN_STARTED_STATUSES): `started`;
 * 2. any other status that is not STATUS_SCHEDULED (postponed, cancelled,
 *    delayed, TBD, not available, anything unknown): `not_scheduled`;
 * 3. an invalid date: `not_scheduled`;
 * 4. their kickoff earlier than our start minus KICKOFF_MATCH_TOLERANCE_MS
 *    (exactly the tolerance earlier is not earlier): `earlier_kickoff`;
 * 5. their kickoff already past while our start is not: `started`;
 * 6. otherwise `none`.
 *
 * A kickoff later than ours does not close anything here (another rule maps
 * it). Statuses are compared exactly, so a differently written one closes.
 */
export function kickoffVerdict(input: {
  ourStart: Date;
  theirKickoff: Date;
  theirStatus: string;
  now: Date;
}): KickoffVerdict {
  const { theirStatus } = input;
  if (THERUNDOWN_STARTED_STATUSES.has(theirStatus)) return { action: 'close', reason: 'started' };
  if (!THERUNDOWN_PREMATCH_STATUSES.has(theirStatus)) {
    return { action: 'close', reason: 'not_scheduled' };
  }
  const ourStart = instant(input.ourStart);
  const theirKickoff = instant(input.theirKickoff);
  const now = instant(input.now);
  if (ourStart === null || theirKickoff === null || now === null) {
    return { action: 'close', reason: 'not_scheduled' };
  }
  if (theirKickoff < ourStart - KICKOFF_MATCH_TOLERANCE_MS) {
    return { action: 'close', reason: 'earlier_kickoff' };
  }
  if (theirKickoff <= now && ourStart > now) return { action: 'close', reason: 'started' };
  return { action: 'none' };
}

// --- The odds-error guard (P6) ----------------------------------------------

/**
 * The subject mark of an odds-error guard item: its subject is `<feedRef>|reference|<marketKey>`.
 * A drift test in the API compares it with FEED_REFERENCE_SUBJECT_MARK of the contracts, which
 * keeps "Open betting" off these items.
 */
export const REFERENCE_SUBJECT_MARK = '|reference';

/** The largest player's edge an open price may have against the consensus, by the consensus's confidence. */
export const GUARD_MAX_PLAYER_EDGE: Readonly<Record<'high' | 'normal' | 'low', number>> =
  Object.freeze({ high: 0.03, normal: 0.03, low: 0.05 });

/** When every price of a market is worse than the consensus by more than this, a person is told (never a suspension). */
export const GUARD_UNCOMPETITIVE_EDGE = -0.15;

/** The player's edge of a price: the consensus probability times our odds, minus 1. */
export function playerEdge(probability: number, oddsMilli: number): number {
  return (probability * oddsMilli) / 1000 - 1;
}

export interface GuardSelection {
  selectionId: string;
  /** The outcome code, the key of the consensus's fair probabilities. */
  code: string;
  oddsMilli: number;
}

export interface GuardEdge {
  selectionId: string;
  code: string;
  edge: number;
}

/**
 * `suspend` stops the market; `info` only tells a person; `none` does
 * nothing. `worst` is the largest edge and `edges` all that were compared, in
 * the order given.
 */
export type GuardVerdict =
  | { action: 'none'; edges: GuardEdge[] }
  | { action: 'suspend'; worst: GuardEdge; edges: GuardEdge[] }
  | { action: 'info'; worst: GuardEdge; edges: GuardEdge[] };

/** The consensus probability of a code: a number in [0, 1], else none (no reference for that outcome). */
function referenceProbability(fair: Readonly<Record<string, number>>, code: string): number | null {
  if (typeof fair !== 'object' || fair === null || !Object.hasOwn(fair, code)) return null;
  const value: unknown = fair[code];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

const STRICTEST_EDGE = Math.min(...Object.values(GUARD_MAX_PLAYER_EDGE));

/** The limit for a confidence; anything that is not one of the three gets the strictest. */
function edgeLimit(confidence: string): number {
  return Object.hasOwn(GUARD_MAX_PLAYER_EDGE, confidence)
    ? GUARD_MAX_PLAYER_EDGE[confidence as keyof typeof GUARD_MAX_PLAYER_EDGE]
    : STRICTEST_EDGE;
}

/**
 * P6, the odds-error guard, on one market: the player's edge of each of our
 * selections against the consensus.
 *
 * - Only selections whose code has a fair probability (a number in [0, 1]) are
 *   compared. Odds that are not an integer in 1001..1000000 count as an edge of
 *   +Infinity: a broken price must not stay open.
 * - Any edge above GUARD_MAX_PLAYER_EDGE[confidence] (an edge on the limit is
 *   not above it) gives `suspend`, with `worst` the largest edge. An
 *   unrecognised confidence gets the strictest limit.
 * - Else, when at least one selection was compared and every compared edge is
 *   below GUARD_UNCOMPETITIVE_EDGE, `info`.
 * - Else `none`.
 *
 * The verdict never carries a price: the guard suspends and informs, it does
 * not price.
 */
export function guardMarket(
  selections: readonly GuardSelection[],
  fair: Readonly<Record<string, number>>,
  confidence: 'high' | 'normal' | 'low',
): GuardVerdict {
  const edges: GuardEdge[] = [];
  for (const selection of selections) {
    const probability = referenceProbability(fair, selection.code);
    if (probability === null) continue;
    edges.push({
      selectionId: selection.selectionId,
      code: selection.code,
      edge: isValidOddsMilli(selection.oddsMilli)
        ? playerEdge(probability, selection.oddsMilli)
        : Number.POSITIVE_INFINITY,
    });
  }
  if (edges.length === 0) return { action: 'none', edges };
  // The first of equal edges wins, so the same input names the same selection.
  const worst = edges.reduce((best, candidate) => (candidate.edge > best.edge ? candidate : best));
  const limit = edgeLimit(confidence);
  if (edges.some((e) => e.edge > limit + LIMIT_EPSILON)) return { action: 'suspend', worst, edges };
  if (edges.every((e) => e.edge < GUARD_UNCOMPETITIVE_EDGE - LIMIT_EPSILON)) {
    return { action: 'info', worst, edges };
  }
  return { action: 'none', edges };
}

// --- Moves (P8, used in phase 4) --------------------------------------------

/** A move of an outcome's probability over this (8 pp) suspends the market. */
export const MAX_MOVE = 0.08;
/** A move over this (3 pp) between two polls keeps the market suspended for one more poll. */
export const STEAM_MOVE = 0.03;

/**
 * How far the probabilities moved, by the largest change over the outcomes
 * both records have: over MAX_MOVE is `large_move`, over STEAM_MOVE is `steam`,
 * else `ok` (a move exactly on a limit is not over it). Outcomes only one record
 * has are not compared, so records with no outcome in common are `ok`. A
 * shared outcome whose change is not a finite number (a NaN or infinite
 * probability) counts as `large_move`.
 */
export function moveVerdict(
  previous: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
): 'ok' | 'steam' | 'large_move' {
  let largest = 0;
  for (const outcome of Object.keys(previous)) {
    if (!Object.hasOwn(next, outcome)) continue;
    const before: unknown = previous[outcome];
    const after: unknown = next[outcome];
    if (typeof before !== 'number' || typeof after !== 'number') continue;
    const move = Math.abs(after - before);
    if (!Number.isFinite(move)) return 'large_move';
    largest = Math.max(largest, move);
  }
  if (largest > MAX_MOVE + LIMIT_EPSILON) return 'large_move';
  if (largest > STEAM_MOVE + LIMIT_EPSILON) return 'steam';
  return 'ok';
}
