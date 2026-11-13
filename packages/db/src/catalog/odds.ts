import { isValidOddsMilli } from '@vamos/core';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { events, markets, oddsHistory, selections } from '../schema/catalog';
import { CatalogNotFoundError, CatalogStateError } from './errors';
import {
  isSelectionBettable,
  oddsMessage,
  type EventStatus,
  type LiveMessage,
  type MarketStatus,
} from './live';

/** odds_history.source of prices set by a trader in the back office. */
export const MANUAL_ODDS_SOURCE = 'manual';

export interface OddsChange {
  selectionId: string;
  /** Integer milli, 1001..1000000. */
  oddsMilli: number;
  /** odds_history.source: 'feed', 'live', 'drift', 'manual', … */
  source: string;
}

export interface ChangedOdds {
  selectionId: string;
  marketId: string;
  eventId: string;
  previousOddsMilli: number;
  oddsMilli: number;
  source: string;
}

export interface SetOddsResult {
  /** Selections whose odds changed (one odds_history row each). */
  changed: ChangedOdds[];
  /**
   * Selections left alone because they cannot be repriced: the selection is
   * settled, its market is not open or suspended, or its event is not
   * scheduled or live.
   */
  skipped: string[];
  /** One `odds` delta per changed selection; publish after COMMIT. */
  messages: LiveMessage[];
}

export interface SetOddsOptions {
  /**
   * The current time, for the bettability (`st`) of the deltas: a scheduled
   * event past its start time is not bettable. Default: the system clock.
   */
  now?: Date;
  /**
   * Default true. False (plan task 2.3, the market factory's selections): the prices change but
   * no odds_history row and no live delta is written; the pricing run's recipe (the event's
   * pricing key) is the record, and bet placement checks the current price anyway.
   */
  record?: boolean;
}

const REPRICEABLE_MARKETS: ReadonlySet<MarketStatus> = new Set(['open', 'suspended']);
const REPRICEABLE_EVENTS: ReadonlySet<EventStatus> = new Set(['scheduled', 'live']);

/**
 * Sets the odds of several selections and records each change in
 * odds_history. Every price is validated first (RangeError outside
 * 1001..1000000, before anything is written); an unknown selection id throws
 * CatalogNotFoundError. Unchanged prices write nothing. Rows are locked in id
 * order, so concurrent repricing of overlapping selections cannot deadlock.
 */
export async function setSelectionOdds(
  tx: DbTransaction,
  changes: readonly OddsChange[],
  options: SetOddsOptions = {},
): Promise<SetOddsResult> {
  const wanted = new Map<string, OddsChange>();
  for (const change of changes) {
    if (!isValidOddsMilli(change.oddsMilli)) {
      throw new RangeError(
        `invalid odds (milli) ${change.oddsMilli} for selection ${change.selectionId}`,
      );
    }
    if (typeof change.source !== 'string' || change.source.length === 0) {
      throw new RangeError(`odds change of selection ${change.selectionId} has no source`);
    }
    if (wanted.has(change.selectionId)) {
      throw new RangeError(`selection ${change.selectionId} appears twice in one odds update`);
    }
    wanted.set(change.selectionId, change);
  }
  if (wanted.size === 0) return { changed: [], skipped: [], messages: [] };

  const rows = await tx
    .select({
      id: selections.id,
      oddsMilli: selections.oddsMilli,
      status: selections.status,
      marketId: markets.id,
      marketStatus: markets.status,
      eventId: events.id,
      eventStatus: events.status,
      bettingOpen: events.bettingOpen,
      startTime: events.startTime,
      closeLeadMs: events.closeLeadMs,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .innerJoin(events, eq(events.id, markets.eventId))
    .where(inArray(selections.id, [...wanted.keys()]))
    .orderBy(asc(selections.id))
    .for('update', { of: selections });

  const found = new Set(rows.map((row) => row.id));
  for (const id of wanted.keys()) {
    if (!found.has(id)) throw new CatalogNotFoundError('selection', id);
  }

  const now = options.now ?? new Date();
  const changed: ChangedOdds[] = [];
  const skipped: string[] = [];
  const messages: LiveMessage[] = [];
  for (const row of rows) {
    const change = wanted.get(row.id);
    if (change === undefined) continue;
    const repriceable =
      row.status !== 'settled' &&
      REPRICEABLE_MARKETS.has(row.marketStatus) &&
      REPRICEABLE_EVENTS.has(row.eventStatus);
    if (!repriceable) {
      skipped.push(row.id);
      continue;
    }
    if (change.oddsMilli === row.oddsMilli) continue;
    changed.push({
      selectionId: row.id,
      marketId: row.marketId,
      eventId: row.eventId,
      previousOddsMilli: row.oddsMilli,
      oddsMilli: change.oddsMilli,
      source: change.source,
    });
    if (options.record === false) continue;
    messages.push(
      oddsMessage(
        row.eventId,
        row.id,
        change.oddsMilli,
        isSelectionBettable(
          {
            status: row.eventStatus,
            bettingOpen: row.bettingOpen,
            startTime: row.startTime,
            closeLeadMs: row.closeLeadMs,
          },
          row.marketStatus,
          row.status,
          now,
        ),
      ),
    );
  }

  if (changed.length > 0) {
    const cases = sql.join(
      changed.map((c) => sql`WHEN ${c.selectionId}::uuid THEN ${c.oddsMilli}::integer`),
      sql` `,
    );
    await tx
      .update(selections)
      .set({ oddsMilli: sql`CASE ${selections.id} ${cases} END`, updatedAt: sql`now()` })
      .where(
        inArray(
          selections.id,
          changed.map((c) => c.selectionId),
        ),
      );
    if (options.record !== false) {
      await tx.insert(oddsHistory).values(
        changed.map((c) => ({
          selectionId: c.selectionId,
          oddsMilli: c.oddsMilli,
          source: c.source,
        })),
      );
    }
  }
  return { changed, skipped, messages };
}

export interface ManualOddsOptions extends SetOddsOptions {
  ip?: string | null;
  reason?: string;
}

/**
 * A trader's price for one selection (back office). Recorded in odds_history
 * with source 'manual' and in the audit log. Throws CatalogStateError when
 * the selection cannot be repriced (settled, market closed, event over).
 */
export async function setManualOdds(
  tx: DbTransaction,
  selectionId: string,
  oddsMilli: number,
  adminId: string,
  options: ManualOddsOptions = {},
): Promise<SetOddsResult> {
  const result = await setSelectionOdds(
    tx,
    [{ selectionId, oddsMilli, source: MANUAL_ODDS_SOURCE }],
    options.now === undefined ? {} : { now: options.now },
  );
  if (result.skipped.length > 0) {
    throw new CatalogStateError(
      `selection ${selectionId} cannot be repriced: it is settled, its market is not open or ` +
        'suspended, or its event is over',
    );
  }
  const change = result.changed[0];
  if (change !== undefined) {
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'catalog.odds.manual',
      targetType: 'selection',
      targetId: selectionId,
      metadata: {
        eventId: change.eventId,
        marketId: change.marketId,
        fromOddsMilli: change.previousOddsMilli,
        toOddsMilli: change.oddsMilli,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      ip: options.ip ?? null,
    });
  }
  return result;
}

/** Where a selection's current and earlier prices came from (from odds_history). */
export interface OddsProvenance {
  /** Source of the most recent change. */
  latestSource: string;
  /** Most recent price recorded per source. */
  bySource: ReadonlyMap<string, number>;
}

/**
 * The latest odds_history entry per source for each selection (selections
 * with no history are absent). Lets feed updates compare against the feed's
 * own previous price, so a trader's or the demo drift's price is not
 * overwritten until the feed itself moves.
 */
export async function oddsProvenance(
  exec: DbExecutor,
  selectionIds: readonly string[],
): Promise<Map<string, OddsProvenance>> {
  const result = new Map<string, OddsProvenance>();
  if (selectionIds.length === 0) return result;
  const rows = await exec
    .selectDistinctOn([oddsHistory.selectionId, oddsHistory.source], {
      id: oddsHistory.id,
      selectionId: oddsHistory.selectionId,
      source: oddsHistory.source,
      oddsMilli: oddsHistory.oddsMilli,
    })
    .from(oddsHistory)
    .where(inArray(oddsHistory.selectionId, [...new Set(selectionIds)]))
    .orderBy(oddsHistory.selectionId, oddsHistory.source, desc(oddsHistory.id));

  const latestId = new Map<string, bigint>();
  const building = new Map<string, { latestSource: string; bySource: Map<string, number> }>();
  for (const row of rows) {
    let entry = building.get(row.selectionId);
    if (entry === undefined) {
      entry = { latestSource: row.source, bySource: new Map() };
      building.set(row.selectionId, entry);
    }
    entry.bySource.set(row.source, row.oddsMilli);
    const best = latestId.get(row.selectionId);
    if (best === undefined || row.id > best) {
      latestId.set(row.selectionId, row.id);
      entry.latestSource = row.source;
    }
  }
  for (const [id, entry] of building) result.set(id, entry);
  return result;
}
