import { expireUncollectedCashPayouts, expireWithdrawalCodes } from '@vamos/db';
import { intervalTask, type IntervalTask } from '../lib/interval';
import type { TaskContext } from './context';

/** Uncollected approved cash withdrawals are looked at hourly (the expiry is counted in days). */
export const CASH_COLLECT_INTERVAL_MS = 60 * 60_000;

export interface CashCollectOptions {
  intervalMs?: number;
  /** CASH_WITHDRAWAL_COLLECT_DAYS in milliseconds (config.payments.cashCollectMs); 0: off. */
  maxAgeMs: number;
}

/**
 * Cashier phase "uncollected approved cash withdrawals": an approved cash withdrawal not collected
 * at a shop within CASH_WITHDRAWAL_COLLECT_DAYS of its approval goes back to the player's balance
 * (expireUncollectedCashPayouts: the hold returned, the player notified, audited); a withdrawal code
 * not used within its 24 hours likewise (expireWithdrawalCodes).
 */
export async function runCashCollect(ctx: TaskContext, maxAgeMs: number): Promise<number> {
  const expired = await expireUncollectedCashPayouts(ctx.db, { now: ctx.clock(), maxAgeMs });
  if (expired > 0) {
    ctx.logger.info({ expired }, 'uncollected cash withdrawals returned to the players');
  }
  // Withdrawal codes (G4) not used within their 24 hours: the money goes back to the player.
  const codes = await expireWithdrawalCodes(ctx.db, { now: ctx.clock() });
  if (codes > 0) ctx.logger.info({ codes }, 'expired withdrawal codes returned to the players');
  return expired + codes;
}

export function cashCollectTask(ctx: TaskContext, options: CashCollectOptions): IntervalTask {
  return intervalTask({
    name: 'cash-collect',
    intervalMs: options.intervalMs ?? CASH_COLLECT_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runCashCollect(ctx, options.maxAgeMs),
  });
}
