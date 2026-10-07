import { z } from 'zod';
import { Santim } from './common';

export const WalletResponse = z.object({
  currency: z.literal('ETB'),
  /** True in demo mode: balances are play money. */
  demo: z.boolean(),
  cash: Santim,
  bonus: Santim,
});
export type WalletResponse = z.infer<typeof WalletResponse>;

export const WalletTransactionType = z.enum([
  'demo_topup',
  'deposit',
  'withdrawal',
  'withdrawal_reversal',
  'bet_stake',
  'bet_payout',
  'bet_refund',
  'bet_cashout',
  'tax_withholding',
  'settlement_reversal',
  'bonus',
  'adjustment',
  'jackpot_entry',
  'jackpot_prize',
]);

export const WalletTransaction = z.object({
  id: z.string(),
  type: WalletTransactionType,
  /** Signed change to the player's cash balance in santim. */
  amount: Santim,
  balanceAfter: Santim,
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type WalletTransaction = z.infer<typeof WalletTransaction>;

export const WalletTransactionsResponse = z.object({
  items: z.array(WalletTransaction),
  nextCursor: z.string().nullable(),
});
export type WalletTransactionsResponse = z.infer<typeof WalletTransactionsResponse>;

export const DemoTopUpRequest = z.object({
  /** Defaults to 1,000 ETB of play money. */
  amount: Santim.optional(),
});
export type DemoTopUpRequest = z.infer<typeof DemoTopUpRequest>;
