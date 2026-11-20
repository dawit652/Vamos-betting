import type { TicketLimitsRequest } from '@vamos/contracts';
import { parseEtbToSantim } from './format';

/** The ticket limits form: every field is text, an empty one means "use the default". */
export interface LimitFields {
  minStake: string;
  maxStake: string;
  maxWin: string;
  dailySales: string;
  hqApprovalAbove: string;
  maxLegs: string;
  minLegOddsMilli: string;
  cancelMinutes: string;
  expiryDays: string;
}

export const MONEY_LIMITS = [
  'minStake',
  'maxStake',
  'maxWin',
  'dailySales',
  'hqApprovalAbove',
] as const;
export const COUNT_LIMITS = ['maxLegs', 'minLegOddsMilli', 'cancelMinutes', 'expiryDays'] as const;

/** "123456" santim → "1234.56" birr for an input (no grouping, so it parses back). */
export function santimToBirrInput(santim: string): string {
  const digits = santim.padStart(3, '0');
  const whole = digits.slice(0, -2);
  const cents = digits.slice(-2);
  return cents === '00' ? whole : `${whole}.${cents}`;
}

/** The form's starting values: what an admin set before (the defaults show as empty fields). */
export function limitFields(overrides: TicketLimitsRequest): LimitFields {
  const money = (v: string | null | undefined) =>
    v === null || v === undefined ? '' : santimToBirrInput(v);
  const count = (v: number | undefined) => (v === undefined ? '' : String(v));
  return {
    minStake: money(overrides.minStake),
    maxStake: money(overrides.maxStake),
    maxWin: money(overrides.maxWin),
    dailySales: money(overrides.dailySales),
    hqApprovalAbove: money(overrides.hqApprovalAbove),
    maxLegs: count(overrides.maxLegs),
    minLegOddsMilli: count(overrides.minLegOddsMilli),
    cancelMinutes: count(overrides.cancelMinutes),
    expiryDays: count(overrides.expiryDays),
  };
}

export type LimitsResult = { ok: true; body: TicketLimitsRequest } | { ok: false; error: string };

/**
 * The PUT body: birr → santim strings, whole numbers as numbers, empty fields left out. The first
 * field that is not a number is named in the error (the API checks the ranges).
 */
export function limitsRequest(fields: LimitFields): LimitsResult {
  const body: TicketLimitsRequest = {};
  for (const name of MONEY_LIMITS) {
    const text = fields[name].trim();
    if (text === '') continue;
    const santim = parseEtbToSantim(text);
    if (santim === null)
      return { ok: false, error: `${LIMIT_LABELS[name]}: enter an amount in ETB.` };
    body[name] = santim;
  }
  for (const name of COUNT_LIMITS) {
    const text = fields[name].trim();
    if (text === '') continue;
    if (!/^\d{1,7}$/.test(text)) {
      return { ok: false, error: `${LIMIT_LABELS[name]}: enter a whole number.` };
    }
    body[name] = Number(text);
  }
  return { ok: true, body };
}

export const LIMIT_LABELS: Readonly<Record<keyof LimitFields, string>> = {
  minStake: 'Minimum stake (ETB)',
  maxStake: 'Maximum stake (ETB)',
  maxWin: 'Maximum win per ticket (ETB)',
  dailySales: 'Sales per day (ETB)',
  hqApprovalAbove: 'HQ approval above (ETB)',
  maxLegs: 'Most matches per ticket',
  minLegOddsMilli: 'Minimum odds per match (1000 = 1.00)',
  cancelMinutes: 'Cashier cancel window (minutes)',
  expiryDays: 'Winning ticket expires after (days)',
};
