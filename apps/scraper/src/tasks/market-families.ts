import {
  ACTIVE_FAMILY,
  FAMILY_SUSPEND_AFTER_WEEKS,
  familyDecision,
  familyMarginBps,
  factoryPricingPlan,
  MARKET_FAMILIES,
  type FamilyDecision,
  type FamilyWeek,
} from '@vamos/core';
import {
  enqueueOwnerAlert,
  familyMoneyBetween,
  type FamilyMoney,
  listMarketFamilyStates,
  loadMarketFamilies,
  MARKET_FAMILY_MOVED_ACTION,
  MARKET_FAMILY_REVIEW_ACTION,
  marketFamilyReviewExists,
  recordMarketFamilyMove,
} from '@vamos/db';
import { HOUR_MS } from '@vamos/scraper';
import { sql } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { isoWeekId, lastCompleteWeek, type WeekWindow } from '../eval/weekly-report';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';
import { auditScraper } from '../pipeline/common';

/** How often the task looks at the clock; it decides only when the week's run is missing. */
export const MARKET_FAMILY_INTERVAL_MS = HOUR_MS;
/**
 * The job waits this long after its week ends, so the week's last matches are settled, and runs
 * before the weekly report (48 hours), which lists its moves.
 */
export const MARKET_FAMILY_WAIT_MS = 24 * HOUR_MS;
const MARKET_FAMILY_LOCK_TTL_MS = 10 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/**
 * Whether a history test of a family at a given margin exists (plan 4.1: "It returns once, two
 * points of margin higher, after the history test passes at that margin"). None is built yet, so
 * the job never claims one passed: a suspended family stays suspended, and its reason says why.
 */
export const FAMILY_HISTORY_TEST_AVAILABLE = false;

export interface MarketFamilyJobSummary {
  /** False when the week's run exists, it is too early, or another instance holds the lock. */
  ran: boolean;
  week: string;
  /** The moves made (suspend, return, off). */
  moves: FamilyDecision[];
}

/** The ISO weeks judged: the FAMILY_SUSPEND_AFTER_WEEKS weeks ending with `week`, oldest first. */
function judgedWeeks(week: WeekWindow): WeekWindow[] {
  const out: WeekWindow[] = [];
  for (let back = FAMILY_SUSPEND_AFTER_WEEKS - 1; back >= 0; back -= 1) {
    const from = new Date(week.from.getTime() - back * WEEK_MS);
    out.push({ id: isoWeekId(from), from, to: new Date(from.getTime() + WEEK_MS) });
  }
  return out;
}

/**
 * The weekly family job (plan task 2.5, "Self-defending margins, with no review"): for the last
 * complete ISO week, once it is 24 hours over, every market family is judged by familyDecision on
 * its settled singles of the last three weeks (familyMoneyBetween) at the margin it is priced at now
 * (margins are not kept per week; a change of margins inside the window is in the settings audit).
 * A move (suspend, return, off) is stored with its reason (market_family_state and _moves), audited
 * and sent to the owner; factory pricing reads the new state at the next re-price, which leaves a
 * suspended family out (its stored markets are suspended by the feed) and prices a returned one at
 * its raised margin. Runs once per week: the run's audit row is the marker.
 */
export async function runMarketFamilyJob(ctx: ScraperContext): Promise<MarketFamilyJobSummary> {
  const now = ctx.clock();
  const week = lastCompleteWeek(now);
  const skipped: MarketFamilyJobSummary = { ran: false, week: week.id, moves: [] };
  if (now.getTime() < week.to.getTime() + MARKET_FAMILY_WAIT_MS) return skipped;
  if (await marketFamilyReviewExists(ctx.db, week.id)) return skipped;
  const lock = await tryLock(ctx.redis, 'scraper:market-families', MARKET_FAMILY_LOCK_TTL_MS);
  if (lock === null) return skipped;
  try {
    const windows = judgedWeeks(week);
    const money: Array<Map<string, FamilyMoney>> = [];
    for (const window of windows) money.push(await familyMoneyBetween(ctx.db, window));
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vamos:market-families'))`);
      if (await marketFamilyReviewExists(tx, week.id)) return null;
      const settings = await loadMarketFamilies(tx);
      const states = await listMarketFamilyStates(tx);
      const plan = factoryPricingPlan(settings, states);
      const moves: FamilyDecision[] = [];
      let stillSuspended = 0;
      for (const family of MARKET_FAMILIES) {
        const state = states.get(family) ?? ACTIVE_FAMILY;
        const marginBps = familyMarginBps(plan, family);
        const weeks: FamilyWeek[] = windows.map((window, i) => {
          const m = money[i]!.get(family);
          return {
            week: window.id,
            stakes: m?.stakes ?? 0n,
            kept: m?.kept ?? 0n,
            marginBps,
          };
        });
        const decision = familyDecision({
          family,
          state,
          week: week.id,
          weeks,
          minWeeklyStake: settings.minWeeklyStake,
          historyTestPassed: FAMILY_HISTORY_TEST_AVAILABLE,
        });
        if (decision.move === 'stay_suspended') stillSuspended += 1;
        if (decision.move !== 'suspend' && decision.move !== 'return' && decision.move !== 'off') {
          continue;
        }
        moves.push(decision);
        await recordMarketFamilyMove(tx, {
          week: week.id,
          decision,
          from: state,
          marginBps,
          weeks,
          now,
        });
        await auditScraper(tx, {
          action: MARKET_FAMILY_MOVED_ACTION,
          targetType: 'market_family',
          targetId: family,
          metadata: {
            week: week.id,
            move: decision.move,
            from: state,
            to: decision.next,
            reason: decision.reason,
            marginBps,
          },
        });
        await enqueueOwnerAlert(
          tx,
          ctx.config.ownerAlerts,
          { alarm: 'market_family_moved', family, move: decision.move, week: week.id },
          now,
        );
      }
      await auditScraper(tx, {
        action: MARKET_FAMILY_REVIEW_ACTION,
        targetType: 'week',
        targetId: week.id,
        metadata: {
          families: MARKET_FAMILIES.length,
          weeks: windows.map((w) => w.id),
          minWeeklyStake: settings.minWeeklyStake.toString(),
          moves: moves.map((m) => ({ family: m.family, move: m.move, reason: m.reason })),
          stillSuspended,
          historyTest: FAMILY_HISTORY_TEST_AVAILABLE ? 'available' : 'none',
        },
      });
      return { moves, stillSuspended };
    });
    if (result === null) return skipped;
    ctx.logger.info(
      {
        week: week.id,
        moves: result.moves.map((m) => ({ family: m.family, move: m.move, reason: m.reason })),
        stillSuspended: result.stillSuspended,
      },
      'market families reviewed',
    );
    return { ran: true, week: week.id, moves: result.moves };
  } finally {
    await lock.release().catch(() => false);
  }
}

export function marketFamilyTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-market-families',
    intervalMs: MARKET_FAMILY_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runMarketFamilyJob(ctx),
    runOnStart: false,
  });
}
