import type { BetView, RgLimitsResponse } from '@vamos/contracts';
import { MESSAGES, lookup } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/api/errors';
import {
  BET_STATUS_LABEL,
  belongsToTab,
  reconcileBet,
  LEG_STATE_LABEL,
  betPayout,
  betStatusTone,
  betTab,
  bonusPercent,
  isPositiveAmount,
  isSettledStatus,
} from './bets';
import { formatBirthDate, formatDate, formatDateTime } from './dates';
import { detailString, formErrors, isExclusionError, retryAfterSeconds } from './errors';
import {
  COOL_OFF_DURATIONS,
  DURATION_LABEL,
  SELF_EXCLUSION_DURATIONS,
  addUtcMonths,
  exclusionRequest,
  previewEnd,
} from './exclusion';
import { KYC_LABEL } from './kyc';
import { refetchPages } from './paging';
import { deviceLabel, exportFileName } from './security';
import {
  buildLimitsRequest,
  limitFormFrom,
  parseLimitInput,
  santimToInput,
  type LimitForm,
} from './limits';
import { firstParam, loginHref, registerHref, safeNextPath } from './paths';
import {
  cleanOtp,
  dateOfBirthError,
  hasErrors,
  latestBirthDate,
  normalizeFaydaId,
  otpError,
  validateKyc,
  validateLogin,
  validateRegister,
  validateReset,
  passwordError,
  passwordStrength,
} from './validation';
import {
  DEFAULT_DEMO_TOPUP,
  DEMO_TOPUP_AMOUNTS,
  TRANSACTION_LABEL,
  amountDirection,
  appendPage,
  formatSignedSantim,
  formatWholeBirr,
} from './wallet';

const NOW = new Date('2026-10-10T09:00:00Z');

function apiError(status: number, code: string, details?: unknown) {
  return new ApiClientError(status, code, code, { details });
}

describe('safeNextPath', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/my-bets')).toBe('/my-bets');
    expect(safeNextPath('/event/123?tab=all#markets')).toBe('/event/123?tab=all#markets');
  });

  it('rejects anything that could leave the site', () => {
    for (const raw of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'my-bets',
      '/x\nSet-Cookie: a',
      '',
      undefined,
      ['/my-bets'],
      `/${'a'.repeat(600)}`,
    ]) {
      expect(safeNextPath(raw, '/fallback')).toBe('/fallback');
    }
  });

  it('never returns to the auth pages', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/register?next=/x')).toBe('/');
    expect(safeNextPath('/verify')).toBe('/');
  });

  it('builds login and register links that come back', () => {
    expect(loginHref('/my-bets')).toBe('/login?next=%2Fmy-bets');
    expect(loginHref('/')).toBe('/login');
    expect(loginHref('https://evil.example')).toBe('/login');
    expect(registerHref('/wallet')).toBe('/register?next=%2Fwallet');
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe('validation', () => {
  it('validates registration like the API', () => {
    expect(
      validateRegister(
        {
          phone: '0911 234 567',
          password: 'secret12-abc',
          dateOfBirth: '1990-05-17',
          acceptTerms: true,
        },
        NOW,
      ),
    ).toEqual({});
    // New passwords need 12 characters (the API also refuses common ones).
    expect(
      validateRegister(
        {
          phone: '0911 234 567',
          password: 'secret1-abc',
          dateOfBirth: '1990-05-17',
          acceptTerms: true,
        },
        NOW,
      ).password,
    ).toBe('account.validation.passwordShort');
    expect(
      validateRegister(
        { phone: '0111234567', password: '123', dateOfBirth: '', acceptTerms: false },
        NOW,
      ),
    ).toEqual({
      phone: 'account.validation.phone',
      password: 'account.validation.passwordShort',
      dateOfBirth: 'account.validation.dateOfBirthRequired',
      acceptTerms: 'account.validation.terms',
    });
    expect(
      validateRegister(
        {
          phone: '+251711234567',
          password: 'abcdefgh-ijk',
          dateOfBirth: '1990-01-01',
          acceptTerms: true,
        },
        NOW,
      ),
    ).toEqual({});
  });

  it('enforces 21+ on the UTC calendar date', () => {
    expect(dateOfBirthError('2005-10-10', NOW)).toBeUndefined();
    expect(dateOfBirthError('2005-10-11', NOW)).toBe('account.validation.underage');
    expect(dateOfBirthError('2030-01-01', NOW)).toBe('account.validation.dateOfBirth');
    expect(dateOfBirthError('1990-02-30', NOW)).toBe('account.validation.dateOfBirth');
    expect(latestBirthDate(NOW)).toBe('2005-10-10');
    // 29 Feb in a leap year → 28 Feb 21 years earlier (not a leap year), still old enough.
    expect(latestBirthDate(new Date('2024-02-29T12:00:00Z'))).toBe('2003-02-28');
    expect(
      dateOfBirthError(
        latestBirthDate(new Date('2024-02-29T12:00:00Z')),
        new Date('2024-02-29T12:00:00Z'),
      ),
    ).toBeUndefined();
  });

  it('checks login, OTP and reset forms', () => {
    expect(validateLogin({ phone: '', password: '' })).toEqual({
      phone: 'account.validation.phoneRequired',
      password: 'account.validation.passwordRequired',
    });
    expect(cleanOtp(' 12-34 567 8')).toBe('123456');
    expect(otpError('123456')).toBeUndefined();
    expect(otpError('12345')).toBe('account.validation.otp');
    expect(
      validateReset({
        phone: '0911234567',
        code: '123456',
        newPassword: 'abcdefgh-ijk',
        confirmPassword: 'abcdefgh-ijl',
      }),
    ).toEqual({ confirmPassword: 'account.validation.passwordMismatch' });
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ phone: undefined })).toBe(false);
    expect(hasErrors({ phone: 'account.validation.phone' })).toBe(true);
  });

  it('counts a run of spaces once and rates password strength (ASVS 2.1.1, 2.1.8)', () => {
    expect(passwordError('abc  defghij')).toBe('account.validation.passwordShort');
    expect(passwordError('abc defghijkl')).toBeUndefined();
    expect(passwordError('x'.repeat(129))).toBe('account.validation.passwordLong');
    expect(passwordStrength('short')).toBe('short');
    expect(passwordStrength('aaaaaaaaaaaa')).toBe('fair');
    expect(passwordStrength('abcdefghijkl')).toBe('fair');
    expect(passwordStrength('abcdefghijkl12')).toBe('good');
    expect(passwordStrength('Abebe-bikila-1960')).toBe('strong');
    expect(passwordStrength('tej and injera at noon')).toBe('strong');
  });

  it('accepts a Fayda FIN or FAN with spaces or dashes', () => {
    expect(normalizeFaydaId('1234 5678 9012')).toBe('123456789012');
    expect(normalizeFaydaId('1234-5678-9012-3456')).toBe('1234567890123456');
    expect(normalizeFaydaId('12345678901')).toBeNull();
    expect(normalizeFaydaId('12345678901234')).toBeNull();
    expect(validateKyc({ idNumber: 'abc', fullName: 'A', dateOfBirth: '1990-01-01' }, NOW)).toEqual(
      { idNumber: 'account.validation.fayda', fullName: 'account.validation.fullName' },
    );
  });
});

describe('formErrors', () => {
  const config = {
    paths: { phone: ['phone', 'account.validation.phone'] },
    codes: {
      phone_taken: { field: 'phone', key: 'account.errors.phoneTaken' },
      invalid_credentials: { key: 'account.errors.invalidCredentials' },
    },
  } as const;

  it('maps codes to a field or the form', () => {
    expect(formErrors(apiError(409, 'phone_taken'), config)).toEqual({
      fields: { phone: 'account.errors.phoneTaken' },
      form: null,
    });
    expect(formErrors(apiError(401, 'invalid_credentials'), config)).toEqual({
      fields: {},
      form: 'account.errors.invalidCredentials',
    });
  });

  it('maps validation paths and keeps a form message for unknown ones', () => {
    const known = apiError(400, 'validation_error', [{ path: 'phone', message: 'x' }]);
    expect(formErrors(known, config)).toEqual({
      fields: { phone: 'account.validation.phone' },
      form: null,
    });
    const mixed = apiError(400, 'validation_error', [
      { path: 'phone', message: 'x' },
      { path: 'locale', message: 'y' },
    ]);
    expect(formErrors(mixed, config).form).toBe('common.errors.validation');
    expect(formErrors(apiError(400, 'validation_error', 'garbage'), config).form).toBe(
      'common.errors.validation',
    );
  });

  it('falls back to the common messages', () => {
    expect(formErrors(apiError(0, 'network_error')).form).toBe('common.errors.network');
    expect(formErrors(new Error('boom')).form).toBe('common.errors.generic');
    expect(formErrors(apiError(429, 'rate_limited')).form).toBe('common.errors.rateLimited');
  });

  it('reads error details', () => {
    const cap = apiError(409, 'demo_balance_cap', { cap: '2000000', maxTopUp: '50000' });
    expect(detailString(cap, 'cap')).toBe('2000000');
    expect(detailString(cap, 'nope')).toBeNull();
    expect(detailString(new Error('x'), 'cap')).toBeNull();
    expect(isExclusionError(apiError(403, 'cooling_off'))).toBe(true);
    expect(isExclusionError(apiError(403, 'self_excluded'))).toBe(true);
    expect(isExclusionError(apiError(403, 'forbidden'))).toBe(false);
    expect(retryAfterSeconds(apiError(429, 'otp_cooldown', { retryAfterSeconds: 42 }))).toBe(42);
    // The hourly cap (otp_limit) also says how long to wait: a countdown, not a generic error.
    expect(retryAfterSeconds(apiError(429, 'otp_limit', { retryAfterSeconds: 1800 }))).toBe(1800);
    expect(retryAfterSeconds(apiError(429, 'otp_limit', { retryAfterSeconds: 9000 }))).toBe(3600);
    expect(retryAfterSeconds(apiError(429, 'rate_limited', { retryAfterSeconds: 42 }))).toBeNull();
    expect(retryAfterSeconds(apiError(429, 'otp_cooldown', {}))).toBeNull();
  });
});

function bet(overrides: Partial<BetView>): BetView {
  return {
    id: 'b1',
    shortId: 'AB12CD34',
    betType: 'single',
    status: 'open',
    channel: 'web',
    oddsChangePolicy: 'higher',
    stake: '1000',
    totalOddsMilli: '2500',
    potentialGross: '2500',
    bonusPercentBps: 0,
    potentialBonus: '0',
    potentialTax: '0',
    potentialNet: '2500',
    settledGross: null,
    settledTax: null,
    settledNet: null,
    rejectReason: null,
    placedAt: '2026-10-10T09:00:00Z',
    acceptAfter: null,
    acceptedAt: null,
    settledAt: null,
    cashOutOffer: null,
    cashedOut: null,
    legs: [],
    ...overrides,
  };
}

describe('bets', () => {
  it('shows the possible win while open and the payout once settled', () => {
    expect(betPayout(bet({}))).toEqual({ label: 'account.myBets.potentialWin', amount: '2500' });
    expect(betPayout(bet({ status: 'won', settledNet: '2300' }))).toEqual({
      label: 'account.myBets.paidOut',
      amount: '2300',
    });
    expect(betPayout(bet({ status: 'lost', settledNet: null }))).toEqual({
      label: 'account.myBets.paidOut',
      amount: '0',
    });
    expect(betPayout(bet({ status: 'void' }))).toEqual({
      label: 'account.myBets.refunded',
      amount: '1000',
    });
    expect(betPayout(bet({ status: 'cashed_out', settledNet: '1800' })).amount).toBe('1800');
  });

  it('classifies statuses', () => {
    expect(isSettledStatus('open')).toBe(false);
    expect(isSettledStatus('pending_acceptance')).toBe(false);
    expect(isSettledStatus('won')).toBe(true);
    expect(betStatusTone('won')).toBe('positive');
    expect(betStatusTone('lost')).toBe('negative');
    expect(betTab('settled')).toBe('settled');
    expect(betTab('anything')).toBe('open');
    expect(betTab(undefined)).toBe('open');
  });

  it('reconciles a re-fetched bet into the loaded list of a tab', () => {
    const a = bet({ id: 'a' });
    const b = bet({ id: 'b' });
    expect(belongsToTab(bet({ status: 'pending_acceptance' }), 'open')).toBe(true);
    expect(belongsToTab(bet({ status: 'cashed_out' }), 'open')).toBe(false);
    expect(belongsToTab(bet({ status: 'rejected' }), 'settled')).toBe(true);
    // accepted in place
    const accepted = bet({ id: 'a', status: 'open', stake: '2000' });
    expect(reconcileBet([a, b], accepted, 'open')).toEqual([accepted, b]);
    // settled or cashed out: leaves Open, appears on Settled
    const cashed = bet({ id: 'a', status: 'cashed_out' });
    expect(reconcileBet([a, b], cashed, 'open')).toEqual([b]);
    expect(reconcileBet([b], cashed, 'settled')).toEqual([cashed, b]);
    // re-opened by a correction: leaves Settled, returns to Open
    expect(reconcileBet([cashed, b], bet({ id: 'a' }), 'settled')).toEqual([b]);
    expect(reconcileBet([b], a, 'open')).toEqual([a, b]);
    // not on this tab and not loaded: nothing changes
    expect(reconcileBet([b], cashed, 'open')).toEqual([b]);
  });

  it('formats bonus percentages and amounts', () => {
    expect(bonusPercent(0)).toBe('');
    expect(bonusPercent(300)).toBe('3%');
    expect(bonusPercent(350)).toBe('3.5%');
    expect(bonusPercent(1525)).toBe('15.25%');
    expect(bonusPercent(20000)).toBe('200%');
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('000')).toBe(false);
    expect(isPositiveAmount('10')).toBe(true);
    expect(isPositiveAmount('-10')).toBe(false);
    expect(isPositiveAmount(null)).toBe(false);
  });
});

describe('wallet', () => {
  it('signs and colours amounts without floats', () => {
    expect(amountDirection('100000')).toBe('credit');
    expect(amountDirection('-2500')).toBe('debit');
    expect(amountDirection('0')).toBe('zero');
    expect(amountDirection('-0')).toBe('zero');
    expect(formatSignedSantim('100000')).toBe('+1,000.00');
    expect(formatSignedSantim('-2550')).toBe('-25.50');
    expect(formatSignedSantim('0')).toBe('0.00');
    expect(formatSignedSantim('900719925474099312')).toBe('+9,007,199,254,740,993.12');
  });

  it('shortens whole-birr labels', () => {
    expect(formatWholeBirr('100000')).toBe('1,000');
    expect(formatWholeBirr('1050')).toBe('10.50');
  });

  it('offers top-ups within the API range', () => {
    expect(DEMO_TOPUP_AMOUNTS).toEqual(['10000', '50000', '100000', '500000']);
    expect(DEMO_TOPUP_AMOUNTS).toContain(DEFAULT_DEMO_TOPUP);
  });

  it('appends pages without duplicates', () => {
    expect(appendPage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
});

describe('paging: a silent refresh after a resync', () => {
  // Bets c (settled meanwhile) left the list; x is new.
  const server = ['x', 'a', 'b', 'd', 'e', 'f', 'g'].map((id) => ({ id }));
  const calls: Array<string | null> = [];
  const fetchPage = async (cursor: string | null) => {
    calls.push(cursor);
    const start = cursor === null ? 0 : Number(cursor);
    const items = server.slice(start, start + 2);
    const next = start + 2 < server.length ? String(start + 2) : null;
    return { items, nextCursor: next };
  };

  it('fetches as many pages as were loaded, from the first, as one list with the new cursor', async () => {
    calls.length = 0;
    const signal = new AbortController().signal;
    expect(await refetchPages(fetchPage, 2, signal)).toEqual({
      items: [{ id: 'x' }, { id: 'a' }, { id: 'b' }, { id: 'd' }],
      nextCursor: '4',
      pages: 2,
    });
    expect(calls).toEqual([null, '2']);
  });

  it('stops at the end of the list, and fetches at least the first page', async () => {
    calls.length = 0;
    const signal = new AbortController().signal;
    expect(await refetchPages(fetchPage, 9, signal)).toMatchObject({ nextCursor: null, pages: 4 });
    expect((await refetchPages(fetchPage, 0, signal)).pages).toBe(1);
  });

  it('gives up when aborted (the list was reloaded or left)', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(refetchPages(fetchPage, 2, abort.signal)).rejects.toThrow();
  });
});

const entry = (amount: string | null) => ({ amount, pending: null });
const LIMITS: RgLimitsResponse = {
  deposit: { day: entry('50000'), week: entry(null), month: entry(null) },
  loss: { day: entry(null), week: entry('125050'), month: entry(null) },
  stake: { bet: entry(null) },
};

describe('limits', () => {
  it('turns santim into input text and back', () => {
    expect(santimToInput('50000')).toBe('500');
    expect(santimToInput('125050')).toBe('1250.50');
    expect(santimToInput(null)).toBe('');
    expect(parseLimitInput('')).toEqual({ ok: true, amount: null });
    expect(parseLimitInput('1,250.5')).toEqual({ ok: true, amount: '125050' });
    expect(parseLimitInput('0')).toEqual({ ok: false });
    expect(parseLimitInput('12.345')).toEqual({ ok: false });
    expect(parseLimitInput('-5')).toEqual({ ok: false });
  });

  it('sends only the changed limits', () => {
    const form = limitFormFrom(LIMITS);
    expect(form['deposit.day']).toBe('500');
    expect(buildLimitsRequest(LIMITS, form)).toEqual({ request: null, errors: {} });

    const changed: LimitForm = {
      ...form,
      'deposit.day': '',
      'loss.month': '2000',
      'stake.bet': '100',
    };
    expect(buildLimitsRequest(LIMITS, changed)).toEqual({
      request: { deposit: { day: null }, loss: { month: '200000' }, stake: { bet: '10000' } },
      errors: {},
    });
  });

  it('reports invalid inputs per field', () => {
    const form: LimitForm = { ...limitFormFrom(LIMITS), 'loss.day': 'abc' };
    expect(buildLimitsRequest(LIMITS, form).errors).toEqual({
      'loss.day': 'account.validation.amount',
    });
  });
});

describe('exclusion', () => {
  it('maps durations to the API request', () => {
    expect(exclusionRequest('24h')).toEqual({ kind: 'cool_off', duration: '24h' });
    expect(exclusionRequest('permanent')).toEqual({
      kind: 'self_exclusion',
      duration: 'permanent',
    });
    for (const d of COOL_OFF_DURATIONS) expect(exclusionRequest(d).kind).toBe('cool_off');
    for (const d of SELF_EXCLUSION_DURATIONS)
      expect(exclusionRequest(d).kind).toBe('self_exclusion');
  });

  it('previews the end like the API', () => {
    expect(previewEnd('24h', NOW)?.toISOString()).toBe('2026-10-11T09:00:00.000Z');
    expect(previewEnd('30d', NOW)?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
    expect(previewEnd('6m', NOW)?.toISOString()).toBe('2027-04-10T09:00:00.000Z');
    expect(previewEnd('5y', NOW)?.toISOString()).toBe('2031-10-10T09:00:00.000Z');
    expect(previewEnd('permanent', NOW)).toBeNull();
    expect(addUtcMonths(new Date('2026-08-31T00:00:00Z'), 6).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });
});

describe('dates', () => {
  it('formats in East Africa Time with Latin digits', () => {
    expect(formatDateTime('2026-10-10T21:30:00Z', 'en')).toBe('11 Oct 2026, 00:30');
    expect(formatDate('2026-10-10T21:30:00Z', 'en')).toBe('11 Oct 2026');
    expect(formatBirthDate('1990-05-17', 'en')).toBe('17 May 1990');
    expect(formatDate('nope', 'en')).toBe('–');
    expect(formatDateTime('2026-10-10T21:30:00Z', 'am')).toMatch(/2026/);
  });
});

describe('message keys used by the account pages', () => {
  it('exist in English and Amharic', () => {
    const keys = [
      ...Object.values(BET_STATUS_LABEL),
      ...Object.values(LEG_STATE_LABEL),
      ...Object.values(TRANSACTION_LABEL),
      ...Object.values(DURATION_LABEL),
      ...Object.values(KYC_LABEL),
    ];
    for (const key of keys) {
      expect(lookup(MESSAGES.en, key), key).toBeTypeOf('string');
      expect(lookup(MESSAGES.am, key), key).toBeTypeOf('string');
    }
  });
});

describe('security page helpers', () => {
  it('names the device of a session from its user agent', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android');
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS');
    expect(deviceLabel('Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS)')).toBe('Opera Mini');
    expect(deviceLabel('curl/8.0')).toBeNull();
    expect(deviceLabel(null)).toBeNull();
  });

  it('names the data export file by its UTC date', () => {
    expect(exportFileName(new Date('2026-10-27T21:30:00Z'))).toBe('vamos-my-data-2026-10-27.json');
  });
});
