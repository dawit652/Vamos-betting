import { pgEnum } from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', [
  'pending_verification',
  'active',
  'suspended',
  'closed',
]);

export const otpPurpose = pgEnum('otp_purpose', [
  'register',
  'login',
  'password_reset',
  'phone_change',
]);

export const kycStatus = pgEnum('kyc_status', ['unverified', 'pending', 'verified', 'rejected']);

export const rgLimitKind = pgEnum('rg_limit_kind', ['deposit', 'loss', 'stake']);
export const rgLimitPeriod = pgEnum('rg_limit_period', ['day', 'week', 'month', 'bet']);
export const rgExclusionKind = pgEnum('rg_exclusion_kind', ['cool_off', 'self_exclusion']);

export const adminRole = pgEnum('admin_role', [
  'admin',
  'trader',
  'finance',
  'kyc',
  'support',
  'compliance',
]);

export const ledgerOwnerType = pgEnum('ledger_owner_type', ['user', 'house']);

/**
 * Ledger account kinds.
 * - player_cash / player_bonus: the player's withdrawable and bonus balances.
 * - house_stakes: stakes held for open bets (a liability until settlement).
 * - house_revenue: gross gaming revenue (lost stakes minus winnings paid).
 * - house_tax_payable: winnings tax withheld, owed to the tax authority.
 * - house_psp_clearing: money in transit with a payment provider (one per provider).
 * - house_demo_funding: source of play money in demo mode.
 * - house_promotions: cost of bonuses.
 * - house_jackpot: jackpot entry pool and prizes.
 */
export const ledgerAccountKind = pgEnum('ledger_account_kind', [
  'player_cash',
  'player_bonus',
  'house_stakes',
  'house_revenue',
  'house_tax_payable',
  'house_psp_clearing',
  'house_demo_funding',
  'house_promotions',
  'house_jackpot',
]);

export const ledgerTransactionType = pgEnum('ledger_transaction_type', [
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

export const actorType = pgEnum('actor_type', ['user', 'admin', 'system']);

/** The operating mode a database belongs to (see `database_identity`). */
export const operatingMode = pgEnum('operating_mode', ['demo', 'licensed']);

export const smsStatus = pgEnum('sms_status', ['queued', 'sent', 'failed']);
