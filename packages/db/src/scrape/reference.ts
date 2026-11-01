import { SCRAPER_ACTOR } from '@vamos/core';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { MAX_CLOSE_LEAD_MS } from '../catalog/live';
import { setMarketStatus, type CatalogChange, type TradingActor } from '../catalog/status';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { toJsonSafe } from '../platform/json';
import { events } from '../schema/catalog';
import {
  type REFERENCE_BUDGET_LEVELS,
  type REFERENCE_CONFIDENCES,
  referenceBookPrices,
  referenceBudget,
  referenceConsensus,
  referenceEventMap,
  referencePollState,
  type ReferenceProvider,
} from '../schema/reference';

/**
 * The reference store of a licensed odds provider (TheRundown, docs/therundown-plan): which of our
 * events each provider event is, the provider's book prices and the consensus made from them, the
 * provider's data-point meters and the poller's own timers. On the provider's Starter licence
 * nothing taken from it may be kept longer than `retentionHours` (24), so `pruneReference` deletes
 * by age; `reference_budget` and `reference_poll_state` hold only our own bookkeeping.
 *
 * Nothing here writes a price or a status of the catalogue except `raiseCloseLead`, which only
 * moves an event's betting close earlier.
 */

export type ReferenceBudgetLevel = (typeof REFERENCE_BUDGET_LEVELS)[number];
export type ReferenceConfidence = (typeof REFERENCE_CONFIDENCES)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Poll-state rows nobody has touched for this long are pruned (they only hold our own timers). */
export const POLL_STATE_RETENTION_MS = 8 * DAY_MS;

/** 'YYYY-MM-DD' of the UTC day of a moment. */
export function utcDay(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid date');
  return date.toISOString().slice(0, 10);
}

// --- The event map ------------------------------------------------------------------------

/** Which provider event one of our events is (rule M1). One each way: an event has one provider event and the reverse. */
export interface ReferenceEventMapRow {
  provider: ReferenceProvider;
  providerEventId: string;
  eventId: string;
  providerSportId: number;
  /** The provider's own ids of the two teams. */
  homeTeamRef: number;
  awayTeamRef: number;
  /** What the provider said at `lastSeenAt`. */
  kickoff: Date;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface UpsertReferenceEventMapInput {
  provider: ReferenceProvider;
  providerEventId: string;
  eventId: string;
  providerSportId: number;
  homeTeamRef: number;
  awayTeamRef: number;
  kickoff: Date;
  status: string;
  /** When the provider event was seen (its fetch time). */
  seenAt: Date;
}

/**
 * Maps a provider event to one of our events, or refreshes the map. A provider
 * keeps one event per match and gives a rescheduled match a new id, so another
 * provider event that was mapped to the same event of ours is dropped first
 * (with its book prices); the mapping the new id replaces then cannot linger.
 * `first_seen_at` stays while the provider event keeps pointing at the same
 * event of ours.
 */
export async function upsertReferenceEventMap(
  tx: DbTransaction,
  input: UpsertReferenceEventMapInput,
): Promise<ReferenceEventMapRow> {
  const replaced = await tx
    .delete(referenceEventMap)
    .where(
      and(
        eq(referenceEventMap.provider, input.provider),
        eq(referenceEventMap.eventId, input.eventId),
        sql`${referenceEventMap.providerEventId} <> ${input.providerEventId}`,
      ),
    )
    .returning({ providerEventId: referenceEventMap.providerEventId });
  if (replaced.length > 0) {
    await tx.delete(referenceBookPrices).where(
      and(
        eq(referenceBookPrices.provider, input.provider),
        inArray(
          referenceBookPrices.providerEventId,
          replaced.map((row) => row.providerEventId),
        ),
      ),
    );
  }
  const [row] = await tx
    .insert(referenceEventMap)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventId: input.eventId,
      providerSportId: input.providerSportId,
      homeTeamRef: input.homeTeamRef,
      awayTeamRef: input.awayTeamRef,
      kickoff: input.kickoff,
      status: input.status,
      firstSeenAt: input.seenAt,
      lastSeenAt: input.seenAt,
    })
    .onConflictDoUpdate({
      target: [referenceEventMap.provider, referenceEventMap.providerEventId],
      set: {
        firstSeenAt: sql`CASE WHEN ${referenceEventMap.eventId} = excluded.event_id THEN ${referenceEventMap.firstSeenAt} ELSE excluded.first_seen_at END`,
        eventId: sql`excluded.event_id`,
        providerSportId: sql`excluded.provider_sport_id`,
        homeTeamRef: sql`excluded.home_team_ref`,
        awayTeamRef: sql`excluded.away_team_ref`,
        kickoff: sql`excluded.kickoff`,
        status: sql`excluded.status`,
        lastSeenAt: sql`GREATEST(${referenceEventMap.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
    .returning();
  return toMapRow(row!);
}

function toMapRow(row: typeof referenceEventMap.$inferSelect): ReferenceEventMapRow {
  return { ...row, provider: row.provider as ReferenceProvider };
}

/** The map rows of a provider, optionally only for some of our events or some provider events. */
export async function listReferenceEventMap(
  exec: DbExecutor,
  provider: ReferenceProvider,
  filter: { eventIds?: readonly string[]; providerEventIds?: readonly string[] } = {},
): Promise<ReferenceEventMapRow[]> {
  if (filter.eventIds?.length === 0 || filter.providerEventIds?.length === 0) return [];
  const rows = await exec
    .select()
    .from(referenceEventMap)
    .where(
      and(
        eq(referenceEventMap.provider, provider),
        filter.eventIds === undefined
          ? undefined
          : inArray(referenceEventMap.eventId, [...filter.eventIds]),
        filter.providerEventIds === undefined
          ? undefined
          : inArray(referenceEventMap.providerEventId, [...filter.providerEventIds]),
      ),
    )
    .orderBy(asc(referenceEventMap.providerEventId));
  return rows.map(toMapRow);
}

/**
 * Forgets one provider event: its map row and its book prices. True when there was a map row. The
 * consensus of our event stays (it is keyed by our event and is pruned by age like the rest).
 */
export async function removeReferenceEventMap(
  tx: DbTransaction,
  provider: ReferenceProvider,
  providerEventId: string,
): Promise<boolean> {
  const removed = await tx
    .delete(referenceEventMap)
    .where(
      and(
        eq(referenceEventMap.provider, provider),
        eq(referenceEventMap.providerEventId, providerEventId),
      ),
    )
    .returning({ providerEventId: referenceEventMap.providerEventId });
  await tx
    .delete(referenceBookPrices)
    .where(
      and(
        eq(referenceBookPrices.provider, provider),
        eq(referenceBookPrices.providerEventId, providerEventId),
      ),
    );
  return removed.length > 0;
}

// --- Book prices --------------------------------------------------------------------------

/** One book's price of one outcome of one of our markets (`marketKey` and `outcome` are ours: 'ou:2.5', 'over'). */
export interface ReferenceBookPriceInput {
  marketKey: string;
  outcome: string;
  bookId: number;
  american: number;
  oddsMilli: number;
  /** When the book last changed the price (the provider's `updated_at`). */
  vendorUpdatedAt: Date;
  liquidityUsd: number | null;
}

export interface ReferenceBookPriceRow extends ReferenceBookPriceInput {
  provider: ReferenceProvider;
  providerEventId: string;
  fetchedAt: Date;
  asOf: Date;
}

/**
 * Replaces everything stored for one provider event with this snapshot (a book that left the
 * response leaves the table too). `asOf` is when the prices were true: the fetch time minus the
 * provider's data delay.
 */
export async function replaceReferenceBookPrices(
  tx: DbTransaction,
  input: {
    provider: ReferenceProvider;
    providerEventId: string;
    fetchedAt: Date;
    asOf: Date;
    prices: readonly ReferenceBookPriceInput[];
  },
): Promise<{ deleted: number; inserted: number }> {
  const deleted = await tx
    .delete(referenceBookPrices)
    .where(
      and(
        eq(referenceBookPrices.provider, input.provider),
        eq(referenceBookPrices.providerEventId, input.providerEventId),
      ),
    )
    .returning({ bookId: referenceBookPrices.bookId });
  // One row per (market, outcome, book): the last of a repeated one wins.
  const byKey = new Map<string, ReferenceBookPriceInput>();
  for (const price of input.prices) {
    byKey.set(`${price.marketKey}\u0000${price.outcome}\u0000${price.bookId}`, price);
  }
  const rows = [...byKey.values()].map((price) => ({
    provider: input.provider,
    providerEventId: input.providerEventId,
    marketKey: price.marketKey,
    outcome: price.outcome,
    bookId: price.bookId,
    american: price.american,
    oddsMilli: price.oddsMilli,
    vendorUpdatedAt: price.vendorUpdatedAt,
    liquidityUsd: price.liquidityUsd,
    fetchedAt: input.fetchedAt,
    asOf: input.asOf,
  }));
  if (rows.length > 0) await tx.insert(referenceBookPrices).values(rows);
  return { deleted: deleted.length, inserted: rows.length };
}

/** The stored book prices of a provider event, in a fixed order (market, outcome, book). */
export async function listReferenceBookPrices(
  exec: DbExecutor,
  provider: ReferenceProvider,
  providerEventId: string,
): Promise<ReferenceBookPriceRow[]> {
  const rows = await exec
    .select()
    .from(referenceBookPrices)
    .where(
      and(
        eq(referenceBookPrices.provider, provider),
        eq(referenceBookPrices.providerEventId, providerEventId),
      ),
    )
    .orderBy(
      asc(referenceBookPrices.marketKey),
      asc(referenceBookPrices.outcome),
      asc(referenceBookPrices.bookId),
    );
  return rows.map((row) => ({ ...row, provider: row.provider as ReferenceProvider }));
}

// --- Consensus ----------------------------------------------------------------------------

export interface ReferenceConsensusInput {
  eventId: string;
  provider: ReferenceProvider;
  /** Our market key ('1x2', 'ou:2.5'). */
  marketKey: string;
  /** The fair probability per selection code; they sum to 1. */
  fair: Readonly<Record<string, number>>;
  booksUsed: readonly number[];
  dispersion: number;
  confidence: ReferenceConfidence;
  /** When the prices behind it were true (fetch time minus the provider's delay). */
  asOf: Date;
  computedAt: Date;
}

export interface ReferenceConsensusRow {
  eventId: string;
  provider: ReferenceProvider;
  marketKey: string;
  fair: Record<string, number>;
  booksUsed: number[];
  dispersion: number;
  confidence: ReferenceConfidence;
  asOf: Date;
  computedAt: Date;
}

function toConsensusRow(row: typeof referenceConsensus.$inferSelect): ReferenceConsensusRow {
  return {
    ...row,
    provider: row.provider as ReferenceProvider,
    confidence: row.confidence as ReferenceConfidence,
  };
}

/** Writes consensus rows (one per event, provider and market; a later one replaces an earlier). Returns the count written. */
export async function upsertReferenceConsensus(
  exec: DbExecutor,
  rows: readonly ReferenceConsensusInput[],
): Promise<number> {
  const byKey = new Map<string, ReferenceConsensusInput>();
  for (const row of rows)
    byKey.set(`${row.eventId}\u0000${row.provider}\u0000${row.marketKey}`, row);
  if (byKey.size === 0) return 0;
  await exec
    .insert(referenceConsensus)
    .values(
      [...byKey.values()].map((row) => ({
        eventId: row.eventId,
        provider: row.provider,
        marketKey: row.marketKey,
        fair: toJsonSafe(row.fair) as Record<string, number>,
        booksUsed: [...row.booksUsed],
        dispersion: row.dispersion,
        confidence: row.confidence,
        asOf: row.asOf,
        computedAt: row.computedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [
        referenceConsensus.eventId,
        referenceConsensus.provider,
        referenceConsensus.marketKey,
      ],
      set: {
        fair: sql`excluded.fair`,
        booksUsed: sql`excluded.books_used`,
        dispersion: sql`excluded.dispersion`,
        confidence: sql`excluded.confidence`,
        asOf: sql`excluded.as_of`,
        computedAt: sql`excluded.computed_at`,
      },
    });
  return byKey.size;
}

/** The consensus rows of some of our events (market key order). */
export async function listReferenceConsensus(
  exec: DbExecutor,
  provider: ReferenceProvider,
  eventIds: readonly string[],
): Promise<ReferenceConsensusRow[]> {
  if (eventIds.length === 0) return [];
  const rows = await exec
    .select()
    .from(referenceConsensus)
    .where(
      and(
        eq(referenceConsensus.provider, provider),
        inArray(referenceConsensus.eventId, [...eventIds]),
      ),
    )
    .orderBy(asc(referenceConsensus.eventId), asc(referenceConsensus.marketKey));
  return rows.map(toConsensusRow);
}

// --- The data-point budget ----------------------------------------------------------------

/** The provider's meters as last seen, and what we spent today (UTC). */
export interface ReferenceBudget {
  provider: ReferenceProvider;
  /** Data points used this period, as the provider last said. */
  used: number | null;
  remaining: number | null;
  /** When the provider's period resets. */
  resetAt: Date | null;
  /** When the meters were read. */
  observedAt: Date;
  /** The UTC day `spentToday` is for ('YYYY-MM-DD'). */
  spentDay: string;
  spentToday: number;
  /** The effective data delay last used (rule A1), seconds. */
  delaySeconds: number | null;
  rateLimit: number | null;
  level: ReferenceBudgetLevel;
  updatedAt: Date;
}

function toBudget(row: typeof referenceBudget.$inferSelect): ReferenceBudget {
  return {
    ...row,
    provider: row.provider as ReferenceProvider,
    level: row.level as ReferenceBudgetLevel,
  };
}

export async function getReferenceBudget(
  exec: DbExecutor,
  provider: ReferenceProvider,
): Promise<ReferenceBudget | null> {
  const [row] = await exec
    .select()
    .from(referenceBudget)
    .where(eq(referenceBudget.provider, provider));
  return row === undefined ? null : toBudget(row);
}

export interface RecordReferenceBudgetInput {
  provider: ReferenceProvider;
  now: Date;
  /** Data points a response cost: added to today's total (rounded up; fractions never count as less). */
  cost?: number;
  /** What the response said about the quota; ignored when it is older than the meters already stored. */
  snapshot?: {
    used: number | null;
    remaining: number | null;
    resetAt: Date | null;
    observedAt: Date;
  } | null;
  delaySeconds?: number | null;
  rateLimit?: number | null;
  level?: ReferenceBudgetLevel;
}

function wholeOrNull(
  value: number | null | undefined,
  round: (n: number) => number,
): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : round(value);
}

/**
 * Records one response (or a level change) in the budget row, creating the row on first use. The
 * row is locked, so two pollers cannot lose each other's spend. Today's spend adds `cost` and starts
 * again from `cost` when the UTC day of `now` is later than the stored one. A snapshot replaces the
 * meters only when it is not older than the stored reading, and only the figures it carries.
 */
export async function recordReferenceBudget(
  tx: DbTransaction,
  input: RecordReferenceBudgetInput,
): Promise<ReferenceBudget> {
  const { provider, now } = input;
  const cost = wholeOrNull(input.cost ?? 0, Math.ceil) ?? 0;
  if (cost < 0) throw new RangeError(`cost must be at least 0, got ${cost}`);
  const day = utcDay(now);
  await tx
    .insert(referenceBudget)
    .values({ provider, observedAt: now, spentDay: day, spentToday: 0, updatedAt: now })
    .onConflictDoNothing();
  const [current] = await tx
    .select()
    .from(referenceBudget)
    .where(eq(referenceBudget.provider, provider))
    .for('update');
  if (current === undefined) throw new Error('reference budget row vanished during update');

  const snapshot = input.snapshot ?? null;
  const takeSnapshot =
    snapshot !== null && snapshot.observedAt.getTime() >= current.observedAt.getTime();
  const sameDay = day <= current.spentDay;
  const [row] = await tx
    .update(referenceBudget)
    .set({
      spentDay: sameDay ? current.spentDay : day,
      spentToday: (sameDay ? current.spentToday : 0) + cost,
      ...(takeSnapshot
        ? {
            used: wholeOrNull(snapshot.used, Math.trunc) ?? current.used,
            remaining: wholeOrNull(snapshot.remaining, Math.trunc) ?? current.remaining,
            resetAt: snapshot.resetAt ?? current.resetAt,
            observedAt: snapshot.observedAt,
          }
        : {}),
      ...(input.delaySeconds === undefined
        ? {}
        : { delaySeconds: wholeOrNull(input.delaySeconds, Math.ceil) }),
      ...(input.rateLimit === undefined
        ? {}
        : { rateLimit: wholeOrNull(input.rateLimit, Math.floor) }),
      ...(input.level === undefined ? {} : { level: input.level }),
      updatedAt: now,
    })
    .where(eq(referenceBudget.provider, provider))
    .returning();
  return toBudget(row!);
}

// --- Poll state ---------------------------------------------------------------------------

/** When a request kind was last made (`day:11:2026-11-01`, `event:<id>`, `affiliates`), so the cadence survives a restart. */
export interface ReferencePollState {
  provider: ReferenceProvider;
  requestKey: string;
  lastFetchedAt: Date;
  lastOutcome: string;
  lastCost: number | null;
  details: Record<string, unknown> | null;
}

export interface SetReferencePollStateInput {
  provider: ReferenceProvider;
  requestKey: string;
  fetchedAt: Date;
  outcome: string;
  cost?: number | null;
  details?: Record<string, unknown> | null;
}

function toPollState(row: typeof referencePollState.$inferSelect): ReferencePollState {
  return { ...row, provider: row.provider as ReferenceProvider };
}

/** The timers of some request keys (those never made are absent); no keys: all of the provider's. */
export async function listReferencePollState(
  exec: DbExecutor,
  provider: ReferenceProvider,
  requestKeys?: readonly string[],
): Promise<ReferencePollState[]> {
  if (requestKeys?.length === 0) return [];
  const rows = await exec
    .select()
    .from(referencePollState)
    .where(
      and(
        eq(referencePollState.provider, provider),
        requestKeys === undefined
          ? undefined
          : inArray(referencePollState.requestKey, [...requestKeys]),
      ),
    )
    .orderBy(asc(referencePollState.requestKey));
  return rows.map(toPollState);
}

export async function getReferencePollState(
  exec: DbExecutor,
  provider: ReferenceProvider,
  requestKey: string,
): Promise<ReferencePollState | null> {
  const [row] = await listReferencePollState(exec, provider, [requestKey]);
  return row ?? null;
}

/** Records that a request was made (or tried) at `fetchedAt` with this outcome. */
export async function setReferencePollState(
  exec: DbExecutor,
  input: SetReferencePollStateInput,
): Promise<void> {
  const cost = wholeOrNull(input.cost, Math.ceil);
  const details =
    input.details === undefined || input.details === null
      ? null
      : (toJsonSafe(input.details) as Record<string, unknown>);
  await exec
    .insert(referencePollState)
    .values({
      provider: input.provider,
      requestKey: input.requestKey,
      lastFetchedAt: input.fetchedAt,
      lastOutcome: input.outcome,
      lastCost: cost,
      details,
    })
    .onConflictDoUpdate({
      target: [referencePollState.provider, referencePollState.requestKey],
      set: {
        lastFetchedAt: input.fetchedAt,
        lastOutcome: input.outcome,
        lastCost: cost,
        details,
      },
    });
}

// --- Our events ---------------------------------------------------------------------------

/** An event of ours the provider may have prices for. */
export interface ReferenceCandidate {
  eventId: string;
  feedRef: string;
  gameId: number;
  sportId: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  bettingOpen: boolean;
  closeLeadMs: number;
}

/**
 * Scheduled events of some competitions that start after `after` and no later than `upTo`, by
 * start time: the events a poll can still say something useful about.
 */
export async function listReferenceCandidates(
  exec: DbExecutor,
  query: { competitionIds: readonly string[]; after: Date; upTo: Date },
): Promise<ReferenceCandidate[]> {
  if (query.competitionIds.length === 0) return [];
  return exec
    .select({
      eventId: events.id,
      feedRef: events.feedRef,
      gameId: events.gameId,
      sportId: events.sportId,
      competitionId: events.competitionId,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
      startTime: events.startTime,
      bettingOpen: events.bettingOpen,
      closeLeadMs: events.closeLeadMs,
    })
    .from(events)
    .where(
      and(
        inArray(events.competitionId, [...query.competitionIds]),
        eq(events.status, 'scheduled'),
        gt(events.startTime, query.after),
        lte(events.startTime, query.upTo),
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id));
}

// --- Betting close ------------------------------------------------------------------------

/**
 * Makes prematch betting on an event close at least `leadMs` before its start time
 * (events.close_lead_ms), because its reference data arrives late. It only ever raises the lead
 * (a lead a trader or an earlier call set is never lowered), `leadMs` is rounded up and held to
 * MAX_CLOSE_LEAD_MS, and only a scheduled event is touched. Returns whether the stored lead
 * changed and the lead the event has now (null when the event is not scheduled or does not exist).
 */
export async function raiseCloseLead(
  tx: DbTransaction,
  eventId: string,
  leadMs: number,
): Promise<{ changed: boolean; closeLeadMs: number | null }> {
  if (typeof leadMs !== 'number' || Number.isNaN(leadMs)) {
    throw new RangeError(`leadMs must be a number, got ${String(leadMs)}`);
  }
  const lead = Math.min(MAX_CLOSE_LEAD_MS, Math.max(0, Math.ceil(leadMs)));
  const updated = await tx
    .update(events)
    .set({
      closeLeadMs: sql`GREATEST(${events.closeLeadMs}, ${lead})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, 'scheduled'),
        sql`${events.closeLeadMs} < ${lead}`,
      ),
    )
    .returning({ closeLeadMs: events.closeLeadMs });
  if (updated[0] !== undefined) return { changed: true, closeLeadMs: updated[0].closeLeadMs };
  const [current] = await tx
    .select({ closeLeadMs: events.closeLeadMs, status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  return {
    changed: false,
    closeLeadMs:
      current !== undefined && current.status === 'scheduled' ? current.closeLeadMs : null,
  };
}

// --- The odds-error guard -----------------------------------------------------------------

/**
 * Who the odds-error guard (rule P6) suspends markets as. A suspension made without an actor is
 * recorded as the feed's (`markets.suspended_by = 'feed'`) and automatic code may lift it
 * (`resumeEvent` and `setMarketStatus('open')` without an actor do). The guard's suspension must
 * stay until a person opens the market, and the column only knows 'feed' and 'trader', so the guard
 * suspends as a trader: the scraper's own id as the actor. The audit row it writes then reads
 * `admin` with the actor id `system:scraper` (the id is plain text; the back office only joins it
 * to a staff member when it matches one).
 */
export const REFERENCE_GUARD_ACTOR: TradingActor = Object.freeze({
  adminId: SCRAPER_ACTOR,
  reason: 'odds-error guard (rule P6)',
});

/**
 * Suspends one market for the guard (see REFERENCE_GUARD_ACTOR): only a person re-opens it. The
 * market's event must be scheduled or live (CatalogStateError otherwise); a market that is already
 * suspended by the feed is taken over, one a trader suspended stays theirs. Publish the deltas
 * after COMMIT.
 */
export function suspendMarketForGuard(tx: DbTransaction, marketId: string): Promise<CatalogChange> {
  return setMarketStatus(tx, marketId, 'suspended', REFERENCE_GUARD_ACTOR);
}

// --- Retention ----------------------------------------------------------------------------

export interface ReferencePruneCounts {
  eventMap: number;
  bookPrices: number;
  consensus: number;
  pollState: number;
}

/**
 * Deletes what the provider's licence does not let us keep: map, book-price and consensus rows
 * older than `retentionHours` (by `last_seen_at`, `fetched_at` and `computed_at`), and poll-state
 * rows untouched for 8 days. The budget row stays. Returns what was deleted.
 *
 * @throws RangeError for a `retentionHours` that is not a finite number above 0.
 */
export async function pruneReference(
  exec: DbExecutor,
  provider: ReferenceProvider,
  now: Date,
  retentionHours: number,
): Promise<ReferencePruneCounts> {
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
    throw new RangeError(`retentionHours must be a finite number above 0, got ${retentionHours}`);
  }
  const cutoff = new Date(now.getTime() - retentionHours * HOUR_MS).toISOString();
  const pollCutoff = new Date(now.getTime() - POLL_STATE_RETENTION_MS).toISOString();
  const result = await exec.execute<{ kind: string; n: number }>(sql`
    WITH
      map AS (DELETE FROM reference_event_map
              WHERE provider = ${provider} AND last_seen_at < ${cutoff}::timestamptz RETURNING 1),
      prices AS (DELETE FROM reference_book_prices
                 WHERE provider = ${provider} AND fetched_at < ${cutoff}::timestamptz RETURNING 1),
      consensus AS (DELETE FROM reference_consensus
                    WHERE provider = ${provider} AND computed_at < ${cutoff}::timestamptz RETURNING 1),
      polls AS (DELETE FROM reference_poll_state
                WHERE provider = ${provider} AND last_fetched_at < ${pollCutoff}::timestamptz RETURNING 1)
    SELECT 'eventMap' AS kind, count(*)::int AS n FROM map
    UNION ALL SELECT 'bookPrices', count(*)::int FROM prices
    UNION ALL SELECT 'consensus', count(*)::int FROM consensus
    UNION ALL SELECT 'pollState', count(*)::int FROM polls`);
  const counts: ReferencePruneCounts = { eventMap: 0, bookPrices: 0, consensus: 0, pollState: 0 };
  for (const row of result.rows) {
    if (row.kind in counts) counts[row.kind as keyof ReferencePruneCounts] = Number(row.n);
  }
  return counts;
}
