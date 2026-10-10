import type { RgLimitEntry, RgLimitsRequest, RgLimitsResponse } from '@vamos/contracts';
import { parseBirr, parseSantim, santimToBirrString, toWire } from '@vamos/core';
import type { MessageKey } from '@vamos/i18n/translate';

/**
 * Responsible-gambling limits form (pure). Inputs are birr strings; an empty
 * input means "no limit". Only the fields that differ from the active limit
 * are sent, so untouched fields never restart a pending change.
 */

export type LimitGroup = 'deposit' | 'loss' | 'stake';
export type LimitPeriod = 'day' | 'week' | 'month' | 'bet';
export type LimitFieldId =
  | 'deposit.day'
  | 'deposit.week'
  | 'deposit.month'
  | 'loss.day'
  | 'loss.week'
  | 'loss.month'
  | 'stake.bet';

export interface LimitField {
  id: LimitFieldId;
  group: LimitGroup;
  period: LimitPeriod;
}

export const LIMIT_FIELDS: readonly LimitField[] = [
  { id: 'deposit.day', group: 'deposit', period: 'day' },
  { id: 'deposit.week', group: 'deposit', period: 'week' },
  { id: 'deposit.month', group: 'deposit', period: 'month' },
  { id: 'loss.day', group: 'loss', period: 'day' },
  { id: 'loss.week', group: 'loss', period: 'week' },
  { id: 'loss.month', group: 'loss', period: 'month' },
  { id: 'stake.bet', group: 'stake', period: 'bet' },
];

export const LIMIT_GROUPS: readonly LimitGroup[] = ['deposit', 'loss', 'stake'];

export type LimitForm = Record<LimitFieldId, string>;

export function limitEntry(limits: RgLimitsResponse, field: LimitField): RgLimitEntry {
  switch (field.group) {
    case 'deposit':
      return limits.deposit[field.period as 'day' | 'week' | 'month'];
    case 'loss':
      return limits.loss[field.period as 'day' | 'week' | 'month'];
    case 'stake':
      return limits.stake.bet;
  }
}

/** "500" or "250.50" for an input; "" for no limit. */
export function santimToInput(wire: string | null): string {
  if (wire === null) return '';
  try {
    const plain = santimToBirrString(parseSantim(wire));
    return plain.endsWith('.00') ? plain.slice(0, -3) : plain;
  } catch {
    return '';
  }
}

export function limitFormFrom(limits: RgLimitsResponse): LimitForm {
  const form = {} as LimitForm;
  for (const field of LIMIT_FIELDS)
    form[field.id] = santimToInput(limitEntry(limits, field).amount);
  return form;
}

export type ParsedLimit = { ok: true; amount: string | null } | { ok: false };

/** A birr input as a santim wire string; `amount: null` for an empty input (no limit). */
export function parseLimitInput(input: string): ParsedLimit {
  const text = input.trim();
  if (text === '') return { ok: true, amount: null };
  try {
    const santim = parseBirr(text);
    return santim > 0n ? { ok: true, amount: toWire(santim) } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface LimitsDiff {
  /** null when nothing changed. */
  request: RgLimitsRequest | null;
  errors: Partial<Record<LimitFieldId, MessageKey>>;
}

export function buildLimitsRequest(limits: RgLimitsResponse, form: LimitForm): LimitsDiff {
  const errors: Partial<Record<LimitFieldId, MessageKey>> = {};
  const request: {
    deposit?: Partial<Record<'day' | 'week' | 'month', string | null>>;
    loss?: Partial<Record<'day' | 'week' | 'month', string | null>>;
    stake?: { bet?: string | null };
  } = {};
  let changed = false;

  for (const field of LIMIT_FIELDS) {
    const parsed = parseLimitInput(form[field.id]);
    if (!parsed.ok) {
      errors[field.id] = 'account.validation.amount';
      continue;
    }
    const value = parsed.amount;
    if (value === limitEntry(limits, field).amount) continue;
    changed = true;
    if (field.group === 'stake') {
      request.stake = { bet: value };
    } else {
      const group = (request[field.group] ??= {});
      group[field.period as 'day' | 'week' | 'month'] = value;
    }
  }
  return { request: changed ? request : null, errors };
}
