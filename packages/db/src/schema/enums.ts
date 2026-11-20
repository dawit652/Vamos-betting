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
  'payout_account',
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
  // A betting shop's desk: cash deposits and withdrawals, receipts (docs/plans/cashier-dashboard.md).
  'cashier',
  // An agent's owner (docs/plans/agent-shops.md): works in the shop app only, never the back office.
  'agent_owner',
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
 * - house_withdrawals_pending: withdrawals requested but not paid out yet
 *   (taken from the player's cash at request time, so they cannot be bet;
 *   moved to the provider's clearing account when paid, back to the player
 *   when rejected, cancelled or failed).
 * - house_cash_variance: cash shops counted short (debit) or over (credit) at shift close, booked
 *   when a supervisor approves it (cashier desk); kept out of house_revenue (GGR stays clean).
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
  'house_withdrawals_pending',
  'house_cash_variance',
  // An agent's prepaid balance: what Nahubet owes the agent; never below zero (agent-shops.md).
  'agent_balance',
  // The cash and bank money agents paid to Nahubet for their balances (top-ups, take-backs).
  'house_agent_funding',
  // What won (or void) shop tickets are owed until a shop pays them; never below zero (phase 3).
  'house_retail_payable',
  // Ticket cash in Nahubet HQ's own drawers (an agent's tickets use its balance instead).
  'house_retail_cash',
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
  // An agent's top-up (money in) or take-back (money out), approved by a second person.
  'agent_topup',
  'agent_take_back',
  // A shop ticket cancelled before its first kick-off: the stake goes back where it came from.
  'retail_ticket_cancel',
]);

export const actorType = pgEnum('actor_type', ['user', 'admin', 'system']);

/** The operating mode a database belongs to (see `database_identity`). */
export const operatingMode = pgEnum('operating_mode', ['demo', 'licensed']);

export const smsStatus = pgEnum('sms_status', ['queued', 'sent', 'failed']);
