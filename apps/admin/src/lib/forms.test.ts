import { STAFF_SETTING_VALUE_SCHEMAS } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import {
  SETTING_SPECS,
  buildSettingValue,
  formFromSetting,
  parseJsonValue,
  passwordStrength,
  validateCode,
  validateLogin,
  validatePasswordChange,
  validateReason,
} from './forms';

describe('login validation', () => {
  it('accepts a complete form and rejects each missing piece', () => {
    expect(validateLogin({ email: 'a@b.test', password: 'x', code: '123456' })).toBeNull();
    expect(validateLogin({ email: 'nope', password: 'x', code: '123456' })).not.toBeNull();
    expect(validateLogin({ email: 'a@b.test', password: '', code: '123456' })).not.toBeNull();
    expect(validateLogin({ email: 'a@b.test', password: 'x', code: '12345' })).not.toBeNull();
    expect(validateLogin({ email: 'a@b.test', password: 'x', code: 'abcdef' })).not.toBeNull();
  });
});

describe('own password change and authenticator code', () => {
  const ok = {
    currentPassword: 'old password',
    code: '123456',
    newPassword: 'a new long passphrase',
    confirmPassword: 'a new long passphrase',
  };
  it('accepts a complete form and rejects each problem', () => {
    expect(validatePasswordChange(ok)).toBeNull();
    expect(validatePasswordChange({ ...ok, currentPassword: '' })).not.toBeNull();
    expect(validatePasswordChange({ ...ok, code: '12345' })).not.toBeNull();
    expect(
      validatePasswordChange({ ...ok, newPassword: 'short', confirmPassword: 'short' }),
    ).not.toBeNull();
    expect(
      validatePasswordChange({
        ...ok,
        newPassword: 'old password',
        confirmPassword: 'old password',
      }),
    ).not.toBeNull();
    expect(validatePasswordChange({ ...ok, confirmPassword: 'something else' })).toMatch(/differ/);
    expect(validateCode(' 654321 ')).toBeNull();
    expect(validateCode('65432a')).not.toBeNull();
  });
});

describe('reason validation', () => {
  it('needs 1 to 500 characters', () => {
    expect(validateReason('  ')).not.toBeNull();
    expect(validateReason('postponed by the league')).toBeNull();
    expect(validateReason('x'.repeat(501))).not.toBeNull();
  });
});

describe('settings forms', () => {
  const spec = (key: string) => SETTING_SPECS.find((s) => s.key === key)!;

  it('builds a bet_rules value the contract accepts, with ETB converted to santim', () => {
    const form = {
      minStake: '10',
      maxStake: '50,000',
      maxPayout: '1000000',
      maxLegs: '20',
      minLegOddsMilli: '1100',
      maxTotalOddsMilli: '10000000',
    };
    const built = buildSettingValue(spec('bet_rules'), form);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value).toMatchObject({ minStake: '1000', maxStake: '5000000', maxLegs: 20 });
    expect(STAFF_SETTING_VALUE_SCHEMAS.bet_rules.safeParse(built.value).success).toBe(true);
  });

  it('reports each bad field', () => {
    const built = buildSettingValue(spec('bet_rules'), {
      minStake: '0',
      maxStake: '1.234',
      maxPayout: '5',
      maxLegs: '0',
      minLegOddsMilli: '1100',
      maxTotalOddsMilli: 'abc',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.errors).sort()).toEqual([
      'maxLegs',
      'maxStake',
      'maxTotalOddsMilli',
      'minStake',
    ]);
  });

  it('keeps the minimum age at 21 or more and the delay a bare number', () => {
    expect(buildSettingValue(spec('responsible_gambling'), { minAge: '18' }).ok).toBe(false);
    expect(buildSettingValue(spec('responsible_gambling'), { minAge: '21' })).toEqual({
      ok: true,
      value: { minAge: 21 },
    });
    expect(buildSettingValue(spec('live_bet_delay_ms'), { value: '5000' })).toEqual({
      ok: true,
      value: 5000,
    });
    expect(buildSettingValue(spec('live_bet_delay_ms'), { value: '70000' }).ok).toBe(false);
  });

  it('allows zero only where the field says so, and handles booleans and selects', () => {
    const tax = buildSettingValue(spec('tax'), {
      rateBps: '1500',
      base: 'net_winnings',
      exemptBelow: '0',
    });
    expect(tax).toEqual({
      ok: true,
      value: { rateBps: 1500, base: 'net_winnings', exemptBelow: '0' },
    });
    expect(
      buildSettingValue(spec('tax'), { rateBps: '1500', base: 'other', exemptBelow: '0' }).ok,
    ).toBe(false);
    const cash = buildSettingValue(spec('cash_out'), {
      enabled: true,
      marginBps: '500',
      minOffer: '1',
    });
    expect(cash).toEqual({ ok: true, value: { enabled: true, marginBps: 500, minOffer: '100' } });
  });

  it('round-trips current values through the form', () => {
    const current = { rateBps: 1500, base: 'gross_payout', exemptBelow: '12345' };
    const form = formFromSetting(spec('tax'), current);
    expect(form).toEqual({ rateBps: '1500', base: 'gross_payout', exemptBelow: '123.45' });
    expect(buildSettingValue(spec('tax'), form)).toEqual({ ok: true, value: current });
  });
});

describe('JSON editor', () => {
  it('accepts objects only', () => {
    expect(parseJsonValue('{"enabled":true}')).toEqual({ ok: true, value: { enabled: true } });
    expect(parseJsonValue('[1]').ok).toBe(true);
    expect(parseJsonValue('5').ok).toBe(false);
    expect(parseJsonValue('{bad').ok).toBe(false);
  });
});

describe('new password strength hint (ASVS 2.1.8)', () => {
  it('rates by length first, then by the kinds of characters', () => {
    expect(passwordStrength('short')).toBe('Too short');
    expect(passwordStrength('abc  defghij')).toBe('Too short');
    expect(passwordStrength('aaaaaaaaaaaa')).toBe('Fair');
    expect(passwordStrength('abcdefghijkl')).toBe('Fair');
    expect(passwordStrength('abcdefghijkl12')).toBe('Good');
    expect(passwordStrength('a new long passphrase')).toBe('Strong');
  });
});
