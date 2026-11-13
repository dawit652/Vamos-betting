import {
  factoryPricingPlan,
  MARKET_FAMILIES,
  type FactoryPricingPlan,
  type FamilyDecision,
  type FamilyWeek,
  type MarketFamilyState,
  type MarketFamilyStatus,
} from '@vamos/core';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { betLegs, bets } from '../schema/betting';
import { markets } from '../schema/catalog';
import { auditLog } from '../schema/platform';
import { marketFamilyMoves, marketFamilyState } from '../schema/scrape';
import { loadMarketFamilies } from '../settings/index';

/**
 * Market families and the weekly family job (plan task 2.5, docs/scraper.md "Market families"):
 * the families' states, what factory pricing takes from them and the settings, the settled stakes
 * and payouts per family for a week, and the job's moves. The decision itself is familyDecision in
 * @vamos/core; the job is apps/scraper tasks/market-families.ts.
 */

/** Audit action of one run of the weekly job (target: the ISO week); its presence means it ran. */
export const MARKET_FAMILY_REVIEW_ACTION = 'scrape.market_families.reviewed';
/** Audit action of one move of a family (target: the family). */
export const MARKET_FAMILY_MOVED_ACTION = 'scrape.market_family.moved';

/** Every family the job ever moved, with its state (families without a row are active). */
export async function listMarketFamilyStates(
  exec: DbExecutor,
): Promise<Map<string, MarketFamilyState>> {
  const rows = await exec.select().from(marketFamilyState);
  return new Map(
    rows.map((row) => [
      row.family,
      {
        status: row.status as MarketFamilyStatus,
        sinceWeek: row.sinceWeek,
        raisedMarginBps: row.raisedMarginBps,
      },
    ]),
  );
}

/**
 * What factory pricing uses now: the settings' margins per class and family, the job's suspended
 * and off families left out, a returned family at its raised margin (factoryPricingPlan). Read at
 * every pricing, so a change in the back office or by the job applies at the next re-price.
 */
export async function loadFactoryPricingPlan(exec: DbExecutor): Promise<FactoryPricingPlan> {
  const [settings, states] = await Promise.all([
    loadMarketFamilies(exec),
    listMarketFamilyStates(exec),
  ]);
  return factoryPricingPlan(settings, states);
}

/** Settled stakes and what the house kept (stakes − gross payouts) of one family over a window. */
export interface FamilyMoney {
  stakes: bigint;
  kept: bigint;
}

/**
 * Per family, the stakes and the money kept of the bets settled in [from, to): singles only, won,
 * lost or cashed out (a void bet is refunded and has no margin to keep). Accumulators are left
 * out on purpose: a multi's result depends on its other legs, so its money cannot be honestly
 * split per family, and a mispriced family shows on its singles. What is kept is measured on the
 * gross payout (the winnings tax is the government's, not the house's).
 */
export async function familyMoneyBetween(
  exec: DbExecutor,
  window: { from: Date; to: Date },
): Promise<Map<string, FamilyMoney>> {
  const rows = await exec
    .select({
      family: markets.type,
      stakes: sql<string>`coalesce(sum(${bets.stake}), 0)::text`,
      payouts: sql<string>`coalesce(sum(${bets.settledGrossPayout}), 0)::text`,
    })
    .from(bets)
    .innerJoin(betLegs, eq(betLegs.betId, bets.id))
    .innerJoin(markets, eq(markets.id, betLegs.marketId))
    .where(
      and(
        eq(bets.betType, 'single'),
        inArray(bets.status, ['won', 'lost', 'cashed_out']),
        gte(bets.settledAt, window.from),
        lt(bets.settledAt, window.to),
        inArray(markets.type, [...MARKET_FAMILIES]),
      ),
    )
    .groupBy(markets.type);
  return new Map(
    rows.map((row) => {
      const stakes = BigInt(row.stakes);
      return [row.family, { stakes, kept: stakes - BigInt(row.payouts) }];
    }),
  );
}

/** True when the weekly job already ran for the ISO week (its audit row exists). */
export async function marketFamilyReviewExists(exec: DbExecutor, week: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, MARKET_FAMILY_REVIEW_ACTION),
        eq(auditLog.targetType, 'week'),
        eq(auditLog.targetId, week),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** One stored move of the weekly job. */
export interface MarketFamilyMoveRow {
  week: string;
  family: string;
  move: 'suspend' | 'return' | 'off';
  fromStatus: MarketFamilyStatus;
  toStatus: MarketFamilyStatus;
  marginBps: number | null;
  raisedMarginBps: number | null;
  reason: string;
  createdAt: Date;
}

/**
 * Stores a move (suspend, return or off): the family's new state and an append-only move row with
 * the weeks judged. Call it in the job's transaction, with the audit row. Other decisions (keep,
 * stay_*) change nothing and are refused here.
 */
export async function recordMarketFamilyMove(
  exec: DbExecutor,
  input: {
    week: string;
    decision: FamilyDecision;
    from: MarketFamilyState;
    /** The margin charged in the last week judged. */
    marginBps: number | null;
    weeks: readonly FamilyWeek[];
    now: Date;
  },
): Promise<void> {
  const { decision, week, now } = input;
  if (decision.move !== 'suspend' && decision.move !== 'return' && decision.move !== 'off') {
    throw new RangeError(`not a move: ${decision.move}`);
  }
  const state = {
    status: decision.next.status,
    sinceWeek: decision.next.sinceWeek,
    raisedMarginBps: decision.next.raisedMarginBps,
    updatedAt: now,
  };
  await exec
    .insert(marketFamilyState)
    .values({ family: decision.family, ...state })
    .onConflictDoUpdate({ target: marketFamilyState.family, set: state });
  await exec.insert(marketFamilyMoves).values({
    week,
    family: decision.family,
    move: decision.move,
    fromStatus: input.from.status,
    toStatus: decision.next.status,
    marginBps: input.marginBps,
    raisedMarginBps: decision.next.raisedMarginBps,
    reason: decision.reason,
    weeks: input.weeks.map((w) => ({
      week: w.week,
      stakes: w.stakes.toString(),
      kept: w.kept.toString(),
      marginBps: w.marginBps,
    })),
    createdAt: now,
  });
}

/** The moves the job made for an ISO week, by family. */
export async function listMarketFamilyMoves(
  exec: DbExecutor,
  week: string,
): Promise<MarketFamilyMoveRow[]> {
  const rows = await exec
    .select()
    .from(marketFamilyMoves)
    .where(eq(marketFamilyMoves.week, week))
    .orderBy(asc(marketFamilyMoves.family));
  return rows.map((row) => ({
    week: row.week,
    family: row.family,
    move: row.move as MarketFamilyMoveRow['move'],
    fromStatus: row.fromStatus as MarketFamilyStatus,
    toStatus: row.toStatus as MarketFamilyStatus,
    marginBps: row.marginBps,
    raisedMarginBps: row.raisedMarginBps,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}
