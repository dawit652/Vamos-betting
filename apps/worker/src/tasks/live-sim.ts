import { randomBytes } from 'node:crypto';
import {
  certainMarketResult,
  marketKey,
  MARKET_TYPES,
  type InPlayScore,
  type MarketTypeCode,
} from '@vamos/core';
import {
  applyLiveState,
  ensureSimulationSeed,
  isSelectionBettable,
  listSimulationCandidates,
  lockEventForSimulation,
  marketsWithSelections,
  oddsMessage,
  resultEvent,
  resultMarket,
  resumeEvent,
  setMarketStatus,
  setSelectionOdds,
  suspendEvent,
  type DbTransaction,
  type EventForSimulation,
  type LiveMessage,
  type MarketWithSelections,
  type OddsChange,
  type SimulationCandidate,
} from '@vamos/db';
import {
  advance,
  createRng,
  finalResult,
  initialState,
  isSuspended,
  liveMinute,
  matchStrengths,
  MOCK_PROVIDER_NAME,
  priceState,
  type FeedMarket,
  type LiveMatchState,
  type MatchStrengths,
} from '@vamos/feed';
import type { Redis } from 'ioredis';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { publishAfterCommit } from '../lib/publish';
import type { TaskContext } from './context';

/**
 * The demo live simulator (FEED_PROVIDER=mock). Every second it:
 * - kicks off scheduled mock events whose start time has come (status live);
 * - advances each live match to SIM_SPEED × (real seconds since its start
 *   time) simulated minutes and writes the score, clock and period;
 * - results the markets the model no longer offers whose outcome the score
 *   already decides (core certainMarketResult: 'over' once the line is
 *   passed, 'yes' once both teams scored…) with resultMarket, so their bets
 *   settle before full time (market.resulted), and closes the others the
 *   model dropped (their outcome is practically, not certainly, decided);
 * - suspends every open market while the simulator says so (after a goal or
 *   a set) and afterwards re-opens the markets it suspended itself (never a
 *   trader's suspension: see TradingActor in @vamos/db);
 * - reprices open and suspended markets from the in-play model, writing odds
 *   that moved by at least 1% (and every shortening below 1.10, see
 *   shouldWriteOdds). The statuses change first, so each `odds` delta carries
 *   the bettability that is committed; the selections of a market suspended
 *   or re-opened in the tick get an `odds` delta with their new `st` too;
 * - at full time results the event (resultEvent settles every market).
 * Deltas are published after each event's transaction commits.
 *
 * Determinism: the match is advanced in fixed steps of SIM_STEP_MINUTES and
 * step n draws from an RNG seeded with (event seed, n), so a match plays out
 * the same way however the ticks fall, across restarts, and even when its
 * Redis state is lost (it is then replayed from the start time). The event
 * seed is random, drawn at kick-off and kept in events.sim_seed, so the
 * result cannot be computed in advance from public data (event id, ratings).
 *
 * A Redis lock (SET NX PX) per event keeps two worker instances from
 * simulating the same event at once; the event row lock (FOR UPDATE) backs
 * it up should a lock ever expire mid-run.
 */

export interface LiveSimOptions {
  /** Simulated match minutes per real second (config.feed.simSpeed). */
  simSpeed: number;
  /** Default 1000 ms. */
  tickMs?: number;
  /** Events of this feed provider are simulated (default 'mock'). */
  feedProvider?: string;
  /** Default 30 s; must comfortably exceed the time one event takes. */
  lockTtlMs?: number;
  /** How long a match's simulator state is kept in Redis (default 6 h). */
  stateTtlSeconds?: number;
  /** Smallest relative odds move that is written (default 0.01 = 1%). */
  repriceThreshold?: number;
  /** Default 200. */
  maxEventsPerTick?: number;
  /** Events processed in parallel (default 4). */
  concurrency?: number;
  /** Prefix of the Redis state and lock keys (default 'vamos:sim:'). */
  keyPrefix?: string;
}

export const LIVE_SIM_TICK_MS = 1000;
/** Simulated minutes per simulator step. */
export const SIM_STEP_MINUTES = 1;
/** odds_history.source of in-play prices. */
export const LIVE_ODDS_SOURCE = 'live';
const DEFAULT_KEY_PREFIX = 'vamos:sim:';
const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_STATE_TTL_SECONDS = 6 * 3600;
const DEFAULT_REPRICE_THRESHOLD = 0.01;
/** Bounds the catch-up work of one tick (a whole match is ~110–250 steps). */
const MAX_STEPS_PER_TICK = 1000;
/**
 * Below this price a shortening move is written however small: the model's
 * margin can be squeezed there (priceProbability falls back to thousandths
 * below 1.01), so a stale, longer price could pay more than the model allows.
 */
export const ALWAYS_WRITE_BELOW_MILLI = 1100;
const SIM_RECORD_VERSION = 2;

/** Simulator state of one event, kept in Redis between ticks. */
export interface SimRecord {
  v: typeof SIM_RECORD_VERSION;
  eventId: string;
  /** The event's secret simulator seed (events.sim_seed). */
  seed: string;
  /** The event's start time (epoch ms): the simulated clock runs from here. */
  kickoffAt: number;
  /** Simulator steps taken so far. */
  steps: number;
  /** The simulator suspended the event's markets and has to re-open them. */
  suspended: boolean;
  state: LiveMatchState;
}

export interface LiveSimTickSummary {
  candidates: number;
  /** Events advanced (and written) this tick. */
  processed: string[];
  kickedOff: string[];
  finished: string[];
  /** Locked by another worker instance. */
  busy: string[];
  failed: string[];
  published: number;
  /** Markets resulted early (before full time) this tick. */
  marketsResulted: number;
}

export function simStateKey(eventId: string, prefix = DEFAULT_KEY_PREFIX): string {
  return `${prefix}state:${eventId}`;
}

export function simLockKey(eventId: string, prefix = DEFAULT_KEY_PREFIX): string {
  return `${prefix}lock:${eventId}`;
}

/** A fresh random simulator seed (stored in events.sim_seed at kick-off). */
export function newSimulationSeed(): string {
  return randomBytes(16).toString('hex');
}

/** The state of a match that has not been simulated yet. */
export function newSimRecord(
  event: Pick<EventForSimulation, 'id' | 'sport' | 'startTime'>,
  seed: string,
): SimRecord {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new RangeError('a simulation seed is required');
  }
  return {
    v: SIM_RECORD_VERSION,
    eventId: event.id,
    seed,
    kickoffAt: event.startTime.getTime(),
    steps: 0,
    suspended: false,
    state: initialState(event.sport),
  };
}

/**
 * Advances a match to `now`: kicks off at the start time, then takes one
 * SIM_STEP_MINUTES step per step that fits in SIM_SPEED × elapsed seconds.
 * Pure and deterministic (see the module notes).
 */
export function simulateTo(
  record: SimRecord,
  strengths: MatchStrengths,
  now: Date,
  simSpeed: number,
): SimRecord {
  if (!Number.isFinite(simSpeed) || simSpeed <= 0) {
    throw new RangeError(`simSpeed must be > 0, got ${simSpeed}`);
  }
  const elapsedMs = now.getTime() - record.kickoffAt;
  if (elapsedMs < 0) return record;
  let state = record.state;
  if (state.phase === 'pre') {
    const rng = createRng(`${record.seed}|kick-off`);
    state = advance(state, { strengths, rng, minutes: 0 }).state;
  }
  const target = Math.floor(((elapsedMs / 1000) * simSpeed) / SIM_STEP_MINUTES + 1e-9);
  let steps = record.steps;
  for (let i = 0; i < MAX_STEPS_PER_TICK && steps < target && state.phase !== 'finished'; i++) {
    const rng = createRng(`${record.seed}|${steps}`);
    state = advance(state, { strengths, rng, minutes: SIM_STEP_MINUTES }).state;
    steps++;
  }
  return { ...record, steps, state };
}

/** One simulator tick over every due or live event of the provider. */
export async function runLiveSimTick(
  ctx: TaskContext,
  options: LiveSimOptions,
): Promise<LiveSimTickSummary> {
  const now = ctx.clock();
  const candidates = await listSimulationCandidates(ctx.db, {
    feedProvider: options.feedProvider ?? MOCK_PROVIDER_NAME,
    now,
    limit: options.maxEventsPerTick ?? 200,
  });
  const summary: LiveSimTickSummary = {
    candidates: candidates.length,
    processed: [],
    kickedOff: [],
    finished: [],
    busy: [],
    failed: [],
    published: 0,
    marketsResulted: 0,
  };
  await forEachLimited(candidates, options.concurrency ?? 4, async (candidate) => {
    try {
      const result = await simulateEvent(ctx, options, candidate, now);
      if (result === 'busy') {
        summary.busy.push(candidate.id);
        return;
      }
      if (result === null) return;
      summary.processed.push(candidate.id);
      summary.published += result.published;
      summary.marketsResulted += result.marketsResulted;
      if (result.kickedOff) {
        summary.kickedOff.push(candidate.id);
        ctx.logger.info({ eventId: candidate.id }, 'simulated match kicked off');
      }
      if (result.finished) {
        summary.finished.push(candidate.id);
        ctx.logger.info({ eventId: candidate.id }, 'simulated match finished and resulted');
      }
    } catch (error) {
      summary.failed.push(candidate.id);
      ctx.logger.error({ err: error, eventId: candidate.id }, 'live simulation failed');
    }
  });
  return summary;
}

interface EventOutcome {
  record: SimRecord;
  messages: LiveMessage[];
  kickedOff: boolean;
  finished: boolean;
  marketsResulted: number;
}

/**
 * Simulates one event under its Redis lock. Returns 'busy' when another
 * instance holds the lock and null when the event no longer needs simulating.
 */
async function simulateEvent(
  ctx: TaskContext,
  options: LiveSimOptions,
  candidate: SimulationCandidate,
  now: Date,
): Promise<
  | 'busy'
  | null
  | { kickedOff: boolean; finished: boolean; published: number; marketsResulted: number }
> {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const lock = await tryLock(
    ctx.redis,
    simLockKey(candidate.id, prefix),
    options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
  );
  if (lock === null) return 'busy';
  try {
    const stored = await loadSimRecord(ctx.redis, simStateKey(candidate.id, prefix), candidate.id);
    const outcome = await ctx.db.transaction(async (tx): Promise<EventOutcome | null> => {
      const event = await lockEventForSimulation(tx, candidate.id);
      if (event.status !== 'scheduled' && event.status !== 'live') return null;
      if (event.status === 'scheduled' && event.startTime.getTime() > now.getTime()) return null;

      const seed = event.simSeed ?? (await ensureSimulationSeed(tx, event.id, newSimulationSeed()));
      const strengths = matchStrengths(event.sport, event.homeRatings, event.awayRatings);
      const base =
        stored !== null &&
        stored.seed === seed &&
        stored.state.sport === event.sport &&
        stored.kickoffAt === event.startTime.getTime()
          ? stored
          : // No usable state: replay from the start. A live event's markets may
            // still be suspended by the lost state, so re-open them when calm
            // (resumeEvent re-opens only the simulator's own suspensions).
            { ...newSimRecord(event, seed), suspended: event.status === 'live' };
      const record = simulateTo(base, strengths, now, options.simSpeed);
      const { state } = record;
      const kickedOff = event.status === 'scheduled';
      const messages: LiveMessage[] = [];

      const live = await applyLiveState(tx, event.id, {
        status: 'live',
        minute: liveMinute(state),
        period: state.periodLabel,
        home: state.home,
        away: state.away,
        htHome: state.htHome,
        htAway: state.htAway,
      });
      messages.push(...live.messages);

      if (state.phase === 'finished') {
        const resulted = await resultEvent(tx, event.id, finalResult(state));
        messages.push(...resulted.messages);
        return {
          record: { ...record, suspended: false },
          messages,
          kickedOff,
          finished: true,
          marketsResulted: 0,
        };
      }

      const priced = new Map(
        priceState(state, strengths).map((market) => [marketKey(market.type, market.line), market]),
      );
      const current = await marketsWithSelections(tx, event.id);
      // The score just written by applyLiveState: resultMarket checks it is the stored one.
      const score: InPlayScore = {
        home: state.home,
        away: state.away,
        htHome: state.htHome,
        htAway: state.htAway,
      };
      const unpriced = await settleOrCloseUnpriced(tx, current, priced, score);
      messages.push(...unpriced.messages);

      // Statuses before prices, so the odds deltas carry the committed bettability.
      let suspended = record.suspended;
      let moved: LiveMessage[] = [];
      if (isSuspended(state) && !suspended) {
        moved = (await suspendEvent(tx, event.id)).messages;
        suspended = true;
      } else if (!isSuspended(state) && suspended) {
        moved = (await resumeEvent(tx, event.id)).messages;
        suspended = false;
      }
      messages.push(...moved);

      const repriced = await reprice(tx, current, priced, options, now);
      messages.push(...repriced.messages);
      messages.push(...restatedOdds(event, current, moved, repriced.written, now));
      return {
        record: { ...record, suspended },
        messages,
        kickedOff,
        finished: false,
        marketsResulted: unpriced.resulted,
      };
    });
    if (outcome === null) return null;

    await ctx.redis.set(
      simStateKey(candidate.id, prefix),
      JSON.stringify(outcome.record),
      'EX',
      options.stateTtlSeconds ?? DEFAULT_STATE_TTL_SECONDS,
    );
    const published = await publishAfterCommit(
      ctx.redis,
      outcome.messages,
      ctx.channel,
      ctx.logger,
    );
    return {
      kickedOff: outcome.kickedOff,
      finished: outcome.finished,
      published,
      marketsResulted: outcome.marketsResulted,
    };
  } finally {
    await lock.release().catch((error: unknown) => {
      ctx.logger.warn({ err: error, eventId: candidate.id }, 'releasing the simulator lock failed');
    });
  }
}

/**
 * Whether a new in-play price replaces the current one: a move of at least
 * `threshold` (relative), or any shortening below ALWAYS_WRITE_BELOW_MILLI.
 */
export function shouldWriteOdds(current: number, next: number, threshold: number): boolean {
  if (next === current) return false;
  if (Math.abs(next - current) >= current * threshold) return true;
  return next < current && next < ALWAYS_WRITE_BELOW_MILLI;
}

/**
 * The certain result of a market at the in-play score (core
 * certainMarketResult), or null while it can still change, for an unknown
 * market type or a malformed line.
 */
export function certainResultOf(
  market: Pick<MarketWithSelections, 'type' | 'line'>,
  score: InPlayScore,
): ReturnType<typeof certainMarketResult> {
  if (!Object.hasOwn(MARKET_TYPES, market.type)) return null;
  try {
    return certainMarketResult({ type: market.type as MarketTypeCode, line: market.line }, score);
  } catch {
    return null;
  }
}

/**
 * The markets the model no longer offers: those whose outcome the score
 * already decides are resulted (resultMarket writes `market.resulted`, so
 * their bets settle now), including ones closed earlier before they were
 * decided; the other open or suspended ones are closed (the model drops a
 * market once its outcome is practically decided, which is not certain).
 */
async function settleOrCloseUnpriced(
  tx: DbTransaction,
  current: MarketWithSelections[],
  priced: ReadonlyMap<string, FeedMarket>,
  score: InPlayScore,
): Promise<{ messages: LiveMessage[]; resulted: number }> {
  const messages: LiveMessage[] = [];
  let resulted = 0;
  for (const market of current) {
    if (market.status !== 'open' && market.status !== 'suspended' && market.status !== 'closed') {
      continue;
    }
    if (priced.has(market.key)) continue;
    if (certainResultOf(market, score) !== null) {
      const outcome = await resultMarket(tx, market.id, { score });
      messages.push(...outcome.messages);
      market.status = outcome.status;
      if (outcome.outcome === 'resulted') resulted += 1;
      continue;
    }
    if (market.status === 'closed') continue;
    messages.push(...(await setMarketStatus(tx, market.id, 'closed')).messages);
    market.status = 'closed';
  }
  return { messages, resulted };
}

/** Writes the model's prices that moved enough (see shouldWriteOdds). */
async function reprice(
  tx: DbTransaction,
  current: readonly MarketWithSelections[],
  priced: ReadonlyMap<string, FeedMarket>,
  options: LiveSimOptions,
  now: Date,
): Promise<{ messages: LiveMessage[]; written: ReadonlyMap<string, number> }> {
  const threshold = options.repriceThreshold ?? DEFAULT_REPRICE_THRESHOLD;
  const changes: OddsChange[] = [];
  for (const market of current) {
    if (market.status !== 'open' && market.status !== 'suspended') continue;
    const price = priced.get(market.key);
    if (price === undefined) continue;
    const odds = new Map(price.selections.map((s) => [s.code, s.oddsMilli]));
    for (const selection of market.selections) {
      const next = odds.get(selection.code);
      if (next === undefined || selection.status !== 'open') continue;
      if (shouldWriteOdds(selection.oddsMilli, next, threshold)) {
        changes.push({ selectionId: selection.id, oddsMilli: next, source: LIVE_ODDS_SOURCE });
      }
    }
  }
  const result = await setSelectionOdds(tx, changes, { now });
  return {
    messages: result.messages,
    written: new Map(result.changed.map((c) => [c.selectionId, c.oddsMilli])),
  };
}

/**
 * `odds` deltas restating the bettability of the selections of markets
 * suspended or re-opened in this tick whose price did not change (those that
 * changed already have a delta with the new status).
 */
function restatedOdds(
  event: EventForSimulation,
  current: readonly MarketWithSelections[],
  moved: readonly LiveMessage[],
  written: ReadonlyMap<string, number>,
  now: Date,
): LiveMessage[] {
  const statusOf = new Map<string, 'open' | 'suspended'>();
  for (const message of moved) {
    if (message.type !== 'market') continue;
    if (message.data.st === 'open' || message.data.st === 'suspended') {
      statusOf.set(message.data.k, message.data.st);
    }
  }
  const messages: LiveMessage[] = [];
  for (const market of current) {
    const status = statusOf.get(market.id);
    if (status === undefined) continue;
    for (const selection of market.selections) {
      if (selection.status !== 'open' || written.has(selection.id)) continue;
      const bettable = isSelectionBettable(
        { status: 'live', bettingOpen: event.bettingOpen, startTime: event.startTime },
        status,
        selection.status,
        now,
      );
      messages.push(oddsMessage(event.id, selection.id, selection.oddsMilli, bettable));
    }
  }
  return messages;
}

/** The stored simulator state, or null when absent or unreadable (then it is replayed). */
export async function loadSimRecord(
  redis: Redis,
  key: string,
  eventId: string,
): Promise<SimRecord | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as Partial<SimRecord> | null;
    if (
      record?.v !== SIM_RECORD_VERSION ||
      record.eventId !== eventId ||
      typeof record.seed !== 'string' ||
      record.seed.length === 0 ||
      !Number.isSafeInteger(record.steps) ||
      typeof record.kickoffAt !== 'number' ||
      typeof record.suspended !== 'boolean' ||
      typeof record.state !== 'object' ||
      record.state === null
    ) {
      return null;
    }
    return record as SimRecord;
  } catch {
    return null;
  }
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function liveSimTask(ctx: TaskContext, options: LiveSimOptions): IntervalTask {
  return intervalTask({
    name: 'live-sim',
    intervalMs: options.tickMs ?? LIVE_SIM_TICK_MS,
    logger: ctx.logger,
    run: () => runLiveSimTick(ctx, options),
  });
}
