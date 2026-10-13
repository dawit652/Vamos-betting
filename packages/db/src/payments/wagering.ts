import { remainingWagering, type WageringEvent } from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accountKey } from '../ledger/accounts';
import type { DbExecutor, LedgerTransactionType } from '../ledger/types';
import { bets } from '../schema/betting';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';

/** Credits that create a wagering requirement (play money counts in demo mode). */
export const WAGERING_FUNDING_TYPES = [
  'deposit',
  'demo_topup',
] as const satisfies readonly LedgerTransactionType[];

/** Debits that count as turnover (subject to COUNTED_BET_STATUSES for bets). */
export const WAGERING_STAKE_TYPES = [
  'bet_stake',
  'jackpot_entry',
] as const satisfies readonly LedgerTransactionType[];

/**
 * A bet stake counts as wagered while its bet is open or settled won or
 * lost. Void and rejected bets were refunded and a bet waiting for live
 * acceptance may still be, so their stakes do not count (if a correction
 * later turns a void bet into a settled one, it counts again).
 *
 * Cashed-out bets do not count either (the usual sportsbook rule): a
 * cash-out hands most of the stake straight back, so counting it would let
 * a player meet the requirement by depositing, betting, cashing out at once
 * and withdrawing, without ever having played the deposit through.
 */
export const COUNTED_BET_STATUSES = ['open', 'won', 'lost'] as const;

const COUNTED = new Set<string>(COUNTED_BET_STATUSES);

/**
 * The player's funding credits and counted stakes, in ledger order (by
 * ledger entry id), as input for core `remainingWagering`. Jackpot entries
 * count in full (refunds of cancelled jackpots arrive in Phase 8).
 */
export async function loadWageringEvents(
  exec: DbExecutor,
  userId: string,
): Promise<WageringEvent[]> {
  const key = accountKey({ kind: 'player_cash', userId });
  const rows = await exec
    .select({
      amount: ledgerEntries.amount,
      type: ledgerTransactions.type,
      betStatus: bets.status,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .leftJoin(
      bets,
      and(
        eq(ledgerTransactions.type, 'bet_stake'),
        eq(bets.userId, userId),
        sql`${bets.id}::text = ${ledgerTransactions.refId}`,
      ),
    )
    .where(
      and(
        eq(ledgerAccounts.key, key),
        inArray(ledgerTransactions.type, [...WAGERING_FUNDING_TYPES, ...WAGERING_STAKE_TYPES]),
      ),
    )
    .orderBy(asc(ledgerEntries.id));

  const events: WageringEvent[] = [];
  for (const row of rows) {
    if (row.type === 'deposit' || row.type === 'demo_topup') {
      if (row.amount > 0n) events.push({ kind: 'funding', amount: row.amount });
    } else if (row.amount < 0n) {
      if (row.type === 'bet_stake' && !COUNTED.has(row.betStatus ?? '')) continue;
      events.push({ kind: 'stake', amount: -row.amount });
    }
  }
  return events;
}

/** Turnover the player still has to stake before withdrawing (0 = may withdraw). */
export async function getRemainingWagering(
  exec: DbExecutor,
  userId: string,
  multiplierBps: number,
): Promise<bigint> {
  return remainingWagering(await loadWageringEvents(exec, userId), multiplierBps);
}
