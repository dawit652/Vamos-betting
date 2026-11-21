import type { LiabilityExposure } from '@vamos/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { betLegs, bets } from '../schema/betting';
import { events } from '../schema/catalog';
import { BOARD_FEED_PROVIDERS } from '../scrape/board-events';
import { OPEN_BET_STATUSES } from './types';

/**
 * Open liability for the house caps (rule L1, `liabilityBreach` in @vamos/core).
 *
 * The figures are summed from the open bets themselves, with the definition the Risk page uses
 * (`listSelectionLiabilities`): bets that are open or pending acceptance, counted through their
 * legs that are still open, at their potential gross payout. There is no counter to keep in step:
 * a bet that settles, voids, is cashed out or is rejected simply stops being summed, so the cap
 * cannot drift from the bets. The price is one indexed sum per placement, taken only when a cap
 * is set.
 */

/** The ids as a set, in a stable order. */
function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Serialises everything that adds liability to these matches until the transaction ends: bets
 * placed on them, and live bets accepted at a changed price. Without it two bets at the same
 * moment could each see room that only one of them fits in.
 *
 * One transaction-scoped advisory lock per match. The locks are taken in the order of their
 * 64-bit keys, so two transactions that share matches always queue in the same order and cannot
 * deadlock. Nothing else takes these locks, and a match's rows are not locked, so the feed and
 * traders are not held up.
 */
/**
 * Which of these matches are a competitor board's own (feed provider in BOARD_FEED_PROVIDERS):
 * those take the board caps (`board_risk_limits`, `liabilityBreach`'s `board`).
 */
export async function boardEventIds(
  tx: DbTransaction,
  eventIds: readonly string[],
): Promise<Set<string>> {
  const ids = distinct(eventIds);
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(inArray(events.id, ids), inArray(events.feedProvider, [...BOARD_FEED_PROVIDERS])));
  return new Set(rows.map((row) => row.id));
}

export async function lockEventsForRisk(
  tx: DbTransaction,
  eventIds: readonly string[],
): Promise<void> {
  const ids = distinct(eventIds);
  if (ids.length === 0) return;
  const values = sql.join(
    ids.map((id) => sql`(${id}::text)`),
    sql`, `,
  );
  const keys = await tx.execute<{ key: string }>(
    sql`SELECT DISTINCT hashtextextended('vamos:risk:event:' || v.e, 0)::text AS key
          FROM (VALUES ${values}) AS v(e)`,
  );
  // Sorted as numbers (sorting the text form would put "10" before "9").
  const ordered = keys.rows
    .map((row) => BigInt(row.key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of ordered) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`);
  }
}

export interface OpenLiabilities {
  selections: LiabilityExposure[];
  events: LiabilityExposure[];
}

/**
 * The open liability of each selection and each match, `current: 0n` for one with no open bet.
 * A selection counts the potential gross payout of every open bet with an open leg on it; a
 * match counts each such bet once, however many of its legs are on the match.
 */
export async function openLiabilities(
  tx: DbTransaction,
  input: { selectionIds: readonly string[]; eventIds: readonly string[] },
): Promise<OpenLiabilities> {
  const selectionIds = distinct(input.selectionIds);
  const eventIds = distinct(input.eventIds);

  const selectionRows =
    selectionIds.length === 0
      ? []
      : await tx
          .select({
            id: betLegs.selectionId,
            liability: sql<string>`COALESCE(sum(${bets.potentialGrossPayout}), 0)::text`,
          })
          .from(betLegs)
          .innerJoin(bets, eq(bets.id, betLegs.betId))
          .where(
            and(
              inArray(betLegs.selectionId, selectionIds),
              eq(betLegs.state, 'open'),
              inArray(bets.status, [...OPEN_BET_STATUSES]),
            ),
          )
          .groupBy(betLegs.selectionId);

  const eventRows =
    eventIds.length === 0
      ? []
      : await (async () => {
          // One row per (match, bet): a bet with two legs on the match counts once.
          const perBet = tx
            .selectDistinct({ eventId: betLegs.eventId, betId: betLegs.betId })
            .from(betLegs)
            .where(and(inArray(betLegs.eventId, eventIds), eq(betLegs.state, 'open')))
            .as('per_bet');
          return tx
            .select({
              id: perBet.eventId,
              liability: sql<string>`COALESCE(sum(${bets.potentialGrossPayout}), 0)::text`,
            })
            .from(perBet)
            .innerJoin(bets, eq(bets.id, perBet.betId))
            .where(inArray(bets.status, [...OPEN_BET_STATUSES]))
            .groupBy(perBet.eventId);
        })();

  const of = (rows: { id: string; liability: string }[], ids: readonly string[]) => {
    const found = new Map(rows.map((row) => [row.id, BigInt(row.liability)]));
    return ids.map((id) => ({ id, current: found.get(id) ?? 0n }));
  };
  return { selections: of(selectionRows, selectionIds), events: of(eventRows, eventIds) };
}
