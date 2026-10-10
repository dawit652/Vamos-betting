import type { AccountRef, PostingEntry } from '../ledger/types';

/**
 * Ledger postings of deposits and withdrawals. The provider's clearing
 * account (`house:psp:<provider>`) goes negative as deposits arrive (money
 * the PSP holds for us) and back up as payouts leave through it, so its
 * balance is -(deposits - payouts) to reconcile against the PSP statement.
 *
 * | Event              | Type                  | Entries                                                     |
 * | ------------------ | --------------------- | ----------------------------------------------------------- |
 * | Deposit succeeded  | `deposit`             | house_psp_clearing:<p> -amount, player_cash +amount         |
 * | Withdrawal request | `withdrawal`          | player_cash -amount, house_withdrawals_pending +amount      |
 * | Payout paid        | `withdrawal`          | house_withdrawals_pending -amount, house_psp_clearing:<p> +amount |
 * | Rejected / cancelled / failed | `withdrawal_reversal` | house_withdrawals_pending -amount, player_cash +amount |
 *
 * The hold is taken when the withdrawal is requested so the same money can
 * never be bet or withdrawn twice; `house_withdrawals_pending` always equals
 * the sum of open (requested, approved, processing) payouts.
 */

const pspAccount = (provider: string): AccountRef => ({ kind: 'house_psp_clearing', provider });
const cashAccount = (userId: string): AccountRef => ({ kind: 'player_cash', userId });
const PENDING: AccountRef = { kind: 'house_withdrawals_pending' };

export const depositLedgerKey = (intentId: string) => `deposit:${intentId}`;
export const withdrawalHoldLedgerKey = (payoutId: string) => `withdrawal:${payoutId}:hold`;
export const withdrawalPaidLedgerKey = (payoutId: string) => `withdrawal:${payoutId}:paid`;
export const withdrawalReversalLedgerKey = (payoutId: string) => `withdrawal:${payoutId}:reversal`;

export function depositEntries(provider: string, userId: string, amount: bigint): PostingEntry[] {
  return [
    { account: pspAccount(provider), amount: -amount },
    { account: cashAccount(userId), amount },
  ];
}

export function withdrawalHoldEntries(userId: string, amount: bigint): PostingEntry[] {
  return [
    { account: cashAccount(userId), amount: -amount },
    { account: PENDING, amount },
  ];
}

export function withdrawalPaidEntries(provider: string, amount: bigint): PostingEntry[] {
  return [
    { account: PENDING, amount: -amount },
    { account: pspAccount(provider), amount },
  ];
}

export function withdrawalReversalEntries(userId: string, amount: bigint): PostingEntry[] {
  return [
    { account: PENDING, amount: -amount },
    { account: cashAccount(userId), amount },
  ];
}
