import { formatSantim, parseEtbToSantim } from './format';

/** Form validation for the staff UI. The API validates again; these only save a round trip. */

export function validateLogin(input: {
  email: string;
  password: string;
  code: string;
}): string | null {
  if (!/^\S+@\S+$/.test(input.email.trim())) return 'Enter your email address.';
  if (input.password.length === 0) return 'Enter your password.';
  if (!/^\d{6}$/.test(input.code.trim()))
    return 'Enter the 6-digit code from your authenticator app.';
  return null;
}

const CODE_RE = /^\d{6}$/;

/** The own password change: current password, code, and the new password typed twice. */
export function validatePasswordChange(input: {
  currentPassword: string;
  code: string;
  newPassword: string;
  confirmPassword: string;
}): string | null {
  if (input.currentPassword.length === 0) return 'Enter your current password.';
  if (!CODE_RE.test(input.code.trim()))
    return 'Enter the 6-digit code from your authenticator app.';
  if (input.newPassword.length < 12) return 'The new password needs at least 12 characters.';
  if (input.newPassword.length > 128) return 'The new password is at most 128 characters.';
  if (input.newPassword === input.currentPassword)
    return 'Choose a password you have not used here.';
  if (input.newPassword !== input.confirmPassword) return 'The two new passwords differ.';
  return null;
}

/** A 6-digit authenticator code (confirming a new authenticator). */
export function validateCode(code: string): string | null {
  return CODE_RE.test(code.trim()) ? null : 'Enter the 6-digit code from your authenticator app.';
}

/** A required free-text reason (void, reject, cancel, correction). */
export function validateReason(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'A reason is required.';
  if (trimmed.length > 500) return 'The reason is at most 500 characters.';
  return null;
}

export type FieldKind = 'santim' | 'int' | 'digits' | 'bool' | 'select';

export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  /** int: inclusive bounds. */
  min?: number;
  max?: number;
  options?: readonly string[];
  /** The field may be zero (santim) – otherwise it must be positive. */
  allowZero?: boolean;
}

export interface SettingSpec {
  key: 'bet_rules' | 'tax' | 'cash_out' | 'live_bet_delay_ms' | 'responsible_gambling' | 'payments';
  title: string;
  /** Where the value sits in the GameSettingsView. */
  path: string;
  /** A scalar setting (live_bet_delay_ms) is a bare number, not an object. */
  scalar?: boolean;
  fields: readonly FieldSpec[];
}

export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: 'bet_rules',
    title: 'Bet rules',
    path: 'betRules',
    fields: [
      { name: 'minStake', label: 'Minimum stake (ETB)', kind: 'santim' },
      { name: 'maxStake', label: 'Maximum stake (ETB)', kind: 'santim' },
      { name: 'maxPayout', label: 'Maximum payout (ETB)', kind: 'santim' },
      { name: 'maxLegs', label: 'Maximum legs', kind: 'int', min: 1, max: 100 },
      {
        name: 'minLegOddsMilli',
        label: 'Minimum leg odds (milli)',
        kind: 'int',
        min: 1001,
        max: 1_000_000,
      },
      { name: 'maxTotalOddsMilli', label: 'Maximum total odds (milli)', kind: 'digits' },
    ],
  },
  {
    key: 'tax',
    title: 'Winnings tax',
    path: 'tax',
    fields: [
      { name: 'rateBps', label: 'Rate (basis points)', kind: 'int', min: 0, max: 10_000 },
      {
        name: 'base',
        label: 'Taxed amount',
        kind: 'select',
        options: ['net_winnings', 'gross_payout'],
      },
      { name: 'exemptBelow', label: 'Exempt below (ETB)', kind: 'santim', allowZero: true },
    ],
  },
  {
    key: 'cash_out',
    title: 'Cash-out',
    path: 'cashOut',
    fields: [
      { name: 'enabled', label: 'Enabled', kind: 'bool' },
      { name: 'marginBps', label: 'Margin (basis points)', kind: 'int', min: 0, max: 10_000 },
      { name: 'minOffer', label: 'Minimum offer (ETB)', kind: 'santim', allowZero: true },
    ],
  },
  {
    key: 'live_bet_delay_ms',
    title: 'Live bet delay',
    path: 'liveBetDelayMs',
    scalar: true,
    fields: [{ name: 'value', label: 'Delay (ms)', kind: 'int', min: 0, max: 60_000 }],
  },
  {
    key: 'responsible_gambling',
    title: 'Responsible gambling defaults',
    path: 'responsibleGambling',
    fields: [{ name: 'minAge', label: 'Minimum age', kind: 'int', min: 21, max: 100 }],
  },
  {
    key: 'payments',
    title: 'Payment rules',
    path: 'payments',
    fields: [
      { name: 'minDeposit', label: 'Minimum deposit (ETB)', kind: 'santim' },
      { name: 'maxDeposit', label: 'Maximum deposit (ETB)', kind: 'santim' },
      { name: 'minWithdrawal', label: 'Minimum withdrawal (ETB)', kind: 'santim' },
      { name: 'maxWithdrawal', label: 'Maximum withdrawal (ETB)', kind: 'santim' },
      { name: 'dailyWithdrawalCap', label: 'Daily withdrawal cap (ETB)', kind: 'santim' },
      {
        name: 'autoApproveBelow',
        label: 'Auto-approve below (ETB, 0 = review all)',
        kind: 'santim',
        allowZero: true,
      },
      {
        name: 'wageringMultiplierBps',
        label: 'Wagering multiplier (bps)',
        kind: 'int',
        min: 0,
        max: 1_000_000,
      },
      {
        name: 'depositIntentTtlMinutes',
        label: 'Deposit intent lifetime (min)',
        kind: 'int',
        min: 1,
        max: 10_080,
      },
      { name: 'payoutMaxAttempts', label: 'Payout attempts', kind: 'int', min: 1, max: 100 },
    ],
  },
];

export type FormValues = Record<string, string | boolean>;

/** The form state for a setting's current value (santim shown in ETB). */
export function formFromSetting(spec: SettingSpec, current: unknown): FormValues {
  const source: Record<string, unknown> = spec.scalar
    ? { value: current }
    : (current as Record<string, unknown>);
  const out: FormValues = {};
  for (const field of spec.fields) {
    const raw = source[field.name];
    if (field.kind === 'bool') out[field.name] = raw === true;
    else if (field.kind === 'santim')
      out[field.name] = typeof raw === 'string' ? formatSantim(raw).replace(/,/g, '') : '';
    else out[field.name] = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  }
  return out;
}

export type BuildResult =
  { ok: true; value: unknown } | { ok: false; errors: Record<string, string> };

/** Turns form state into the request value, or says what is wrong per field. */
export function buildSettingValue(spec: SettingSpec, form: FormValues): BuildResult {
  const errors: Record<string, string> = {};
  const value: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const raw = form[field.name];
    switch (field.kind) {
      case 'bool':
        value[field.name] = raw === true;
        break;
      case 'select':
        if (typeof raw === 'string' && field.options?.includes(raw) === true)
          value[field.name] = raw;
        else errors[field.name] = 'Choose a value.';
        break;
      case 'santim': {
        const santim = typeof raw === 'string' ? parseEtbToSantim(raw) : null;
        if (santim === null) errors[field.name] = 'Enter an amount with at most 2 decimals.';
        else if (field.allowZero !== true && /^0+$/.test(santim))
          errors[field.name] = 'Must be more than zero.';
        else value[field.name] = santim;
        break;
      }
      case 'digits':
        if (typeof raw === 'string' && /^[1-9]\d{0,17}$/.test(raw.trim()))
          value[field.name] = raw.trim();
        else errors[field.name] = 'Enter a whole number.';
        break;
      case 'int': {
        const text = typeof raw === 'string' ? raw.trim() : '';
        const n = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
        if (Number.isNaN(n)) errors[field.name] = 'Enter a whole number.';
        else if (field.min !== undefined && n < field.min)
          errors[field.name] = `At least ${field.min}.`;
        else if (field.max !== undefined && n > field.max)
          errors[field.name] = `At most ${field.max}.`;
        else value[field.name] = n;
        break;
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: spec.scalar ? value.value : value };
}

/** Parses the JSON typed into the multi-bonus / jackpot template editors. */
export function parseJsonValue(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'Enter a JSON object.' };
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'This is not valid JSON.' };
  }
}
