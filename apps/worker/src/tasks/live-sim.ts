import { marketKey } from '@vamos/core';
import {
  applyLiveState,
  listSimulationCandidates,
  lockEventForSimulation,
  marketsWithSelections,
  resultEvent,
  resumeEvent,
  setMarketStatus,
  setSelectionOdds,
  suspendEvent,
  type DbTransaction,
  type EventForSimulation,
  type LiveMessage,
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
 * - suspends every open market while the simulator says so (after a goal or
 *   a set) and re-opens them afterwards;
 * - reprices open and suspended markets from the in-play model, writing only
 *   odds that moved by at least 1%, and closes markets the model no longer
 *   offers (their outcome is certain);
 * - at full time results the event (resultEvent settles every market).
 * Deltas are published after each event's transaction commits.
 *
 * Determinism: the match is advanced in fixed steps of SIM_STEP_MINUTES and
 * step n draws from an RNG seeded with (event id, n), so a match plays out
 * the same way however the ticks fall, across restarts, and even when its
 * Redis state is lost (it is then replayed from the start time).
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

/** Simulator state of one event, kept in Redis between ticks. */
export interface SimRecord {
  v: 1;
  eventId: string;
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
}

export function simStateKey(eventId: string, prefix = DEFAULT_KEY_PREFIX): string {
  return `${prefix}state:${eventId}`;
}

export function simLockKey(eventId: string, prefix = DEFAULT_KEY_PREFIX): string {
  return `${prefix}lock:${eventId}`;
}

/** The state of a match that has not been simulated yet. */
export function newSimRecord(
  event: Pick<EventForSimulation, 'id' | 'sport' | 'startTime'>,
): SimRecord {
  return {
    v: 1,
    eventId: event.id,
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
    const rng = createRng(`${record.eventId}|kick-off`);
    state = advance(state, { strengths, rng, minutes: 0 }).state;
  }
  const target = Math.floor(((elapsedMs / 1000) * simSpeed) / SIM_STEP_MINUTES + 1e-9);
  let steps = record.steps;
  for (let i = 0; i < MAX_STEPS_PER_TICK && steps < target && state.phase !== 'finished'; i++) {
    const rng = createRng(`${record.eventId}|${steps}`);
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
): Promise<'busy' | null | { kickedOff: boolean; finished: boolean; published: number }> {
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

      const strengths = matchStrengths(event.sport, event.homeRatings, event.awayRatings);
      const base =
        stored !== null &&
        stored.state.sport === event.sport &&
        stored.kickoffAt === event.startTime.getTime()
          ? stored
          : // No usable state: replay from the start. A live event's markets may
            // still be suspended by the lost state, so re-open them when calm.
            { ...newSimRecord(event), suspended: event.status === 'live' };
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
        return { record: { ...record, suspended: false }, messages, kickedOff, finished: true };
      }

      messages.push(...(await reprice(tx, event.id, state, strengths, options)));

      let suspended = record.suspended;
      if (isSuspended(state) && !suspended) {
        messages.push(...(await suspendEvent(tx, event.id)).messages);
        suspended = true;
      } else if (!isSuspended(state) && suspended) {
        messages.push(...(await resumeEvent(tx, event.id)).messages);
        suspended = false;
      }
      return { record: { ...record, suspended }, messages, kickedOff, finished: false };
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
    return { kickedOff: outcome.kickedOff, finished: outcome.finished, published };
  } finally {
    await lock.release().catch((error: unknown) => {
      ctx.logger.warn({ err: error, eventId: candidate.id }, 'releasing the simulator lock failed');
    });
  }
}

/** Closes markets the model no longer offers and writes odds that moved enough. */
async function reprice(
  tx: DbTransaction,
  eventId: string,
  state: LiveMatchState,
  strengths: MatchStrengths,
  options: LiveSimOptions,
): Promise<LiveMessage[]> {
  const threshold = options.repriceThreshold ?? DEFAULT_REPRICE_THRESHOLD;
  const priced = new Map(
    priceState(state, strengths).map((market) => [marketKey(market.type, market.line), market]),
  );
  const messages: LiveMessage[] = [];
  const changes: OddsChange[] = [];
  for (const market of await marketsWithSelections(tx, eventId)) {
    if (market.status !== 'open' && market.status !== 'suspended') continue;
    const price = priced.get(market.key);
    if (price === undefined) {
      messages.push(...(await setMarketStatus(tx, market.id, 'closed')).messages);
      continue;
    }
    const odds = new Map(price.selections.map((s) => [s.code, s.oddsMilli]));
    for (const selection of market.selections) {
      const next = odds.get(selection.code);
      if (next === undefined || selection.status !== 'open') continue;
      if (Math.abs(next - selection.oddsMilli) >= selection.oddsMilli * threshold) {
        changes.push({ selectionId: selection.id, oddsMilli: next, source: LIVE_ODDS_SOURCE });
      }
    }
  }
  messages.push(...(await setSelectionOdds(tx, changes)).messages);
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
      record?.v !== 1 ||
      record.eventId !== eventId ||
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
