import { remainingWagering, withdrawableAmount, type WageringEvent } from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accountKey } from '../ledger/accounts';
import { getBalance } from '../ledger/queries';
import { getActiveExclusion } from '../rg/exclusions';
import type { DbExecutor, LedgerTransactionType } from '../ledger/types';
import { bets } from '../schema/betting';
import { jackpotEntries } from '../schema/jackpots';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';

/** Credits that create a wagering requirement (play money counts in demo mode). */
export const WAGERING_FUNDING_TYPES = [
  'deposit',
  'demo_topup',
] as const satisfies readonly LedgerTransactionType[];

/**
 * Debits that count as turnover (subject to COUNTED_BET_STATUSES for bets
 * and COUNTED_JACKPOT_ENTRY_STATUSES for jackpot entries).
 */
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

/**
 * A jackpot entry's cost counts as wagered (it is a real stake) while the
 * entry is open or settled won or lost. A void entry (its round was void)
 * was refunded, so its cost does not count, as for a void bet; the refund
 * itself (a positive `jackpot_entry` amount) is never turnover.
 */
export const COUNTED_JACKPOT_ENTRY_STATUSES = ['open', 'won', 'lost'] as const;

const COUNTED = new Set<string>(COUNTED_BET_STATUSES);
const COUNTED_JACKPOT = new Set<string>(COUNTED_JACKPOT_ENTRY_STATUSES);

/**
 * The player's funding credits and counted stakes, in ledger order (by
 * ledger entry id), as input for core `remainingWagering`: bet stakes per
 * COUNTED_BET_STATUSES, jackpot entry costs per
 * COUNTED_JACKPOT_ENTRY_STATUSES.
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
      entryStatus: jackpotEntries.status,
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
    .leftJoin(
      jackpotEntries,
      and(
        eq(ledgerTransactions.type, 'jackpot_entry'),
        eq(jackpotEntries.userId, userId),
        sql`${jackpotEntries.id}::text = ${ledgerTransactions.refId}`,
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
      if (row.type === 'jackpot_entry' && !COUNTED_JACKPOT.has(row.entryStatus ?? '')) continue;
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

/**
 * What the player may withdraw now (owner, 21 Nov 2026: winnings only, never deposited money): the
 * cash balance less the deposits not yet played through. While an exclusion is active the whole
 * balance (requestWithdrawal waives the rule then and sends the withdrawal to review).
 */
export async function getWithdrawable(
  exec: DbExecutor,
  userId: string,
  multiplierBps: number,
  now: Date,
): Promise<{ remaining: bigint; withdrawable: bigint; balance: bigint }> {
  const [remaining, balance, exclusion] = await Promise.all([
    getRemainingWagering(exec, userId, multiplierBps),
    getBalance(exec, { kind: 'player_cash', userId }),
    getActiveExclusion(exec, userId, now),
  ]);
  return {
    remaining,
    balance,
    withdrawable:
      exclusion === null ? withdrawableAmount(balance, remaining) : balance > 0n ? balance : 0n,
  };
}
