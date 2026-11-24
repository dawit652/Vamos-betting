import { businessDateOf, santimToBirrString } from '@vamos/core';
import { listMoneyNotCredited } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { raiseOwnerAlert } from '../lib/owner-alert';
import type { TaskContext } from './context';

/**
 * The owner's daily line (docs/plans/counter-codes-and-deposit-recovery.md, G6): from 09:00 in Addis
 * Ababa, when money that arrived is still not credited, one Telegram line a day says how much and
 * since when (Back office → Money not credited). Nothing waiting: nothing is sent.
 */

export const MONEY_LINE_INTERVAL_MS = 30 * 60_000;
/** The hour (Addis Ababa, UTC+3) from which the day's line goes out. */
export const MONEY_LINE_HOUR = 9;

export async function runMoneyNotCreditedLine(
  ctx: TaskContext,
): Promise<{ raised: boolean; count: number }> {
  const now = ctx.clock();
  if ((now.getUTCHours() + 3) % 24 < MONEY_LINE_HOUR) return { raised: false, count: 0 };
  const { waiting } = await listMoneyNotCredited(ctx.db);
  if (waiting.count === 0 || waiting.oldestAt === null) return { raised: false, count: 0 };
  const raised = await raiseOwnerAlert(ctx, {
    alarm: 'money_not_credited',
    date: businessDateOf(now),
    count: waiting.count,
    amountEtb: santimToBirrString(waiting.amount),
    oldestDate: businessDateOf(waiting.oldestAt),
  });
  return { raised, count: waiting.count };
}

export function moneyNotCreditedTask(ctx: TaskContext): IntervalTask {
  return intervalTask({
    name: 'money-not-credited',
    intervalMs: MONEY_LINE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runMoneyNotCreditedLine(ctx),
  });
}
