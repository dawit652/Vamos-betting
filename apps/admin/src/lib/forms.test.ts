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

describe('house liability caps form', () => {
  const spec = SETTING_SPECS.find((s) => s.key === 'risk_limits')!;
  const contract = STAFF_SETTING_VALUE_SCHEMAS.risk_limits;

  it('builds amounts in santim, and an empty field means no cap (null)', () => {
    const both = buildSettingValue(spec, {
      maxSelectionLiability: '50,000',
      maxEventLiability: '250000.50',
    });
    expect(both).toEqual({
      ok: true,
      value: { maxSelectionLiability: '5000000', maxEventLiability: '25000050' },
    });
    const none = buildSettingValue(spec, { maxSelectionLiability: '', maxEventLiability: '  ' });
    expect(none).toEqual({
      ok: true,
      value: { maxSelectionLiability: null, maxEventLiability: null },
    });
    for (const built of [both, none]) {
      if (built.ok) expect(contract.safeParse(built.value).success).toBe(true);
    }
  });

  it('refuses zero, which would be a cap that blocks every bet, and bad amounts', () => {
    const built = buildSettingValue(spec, { maxSelectionLiability: '0', maxEventLiability: 'abc' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.errors).sort()).toEqual([
      'maxEventLiability',
      'maxSelectionLiability',
    ]);
  });

  it('shows a stored null as an empty field and round-trips both states', () => {
    const none = { maxSelectionLiability: null, maxEventLiability: null };
    expect(formFromSetting(spec, none)).toEqual({
      maxSelectionLiability: '',
      maxEventLiability: '',
    });
    expect(buildSettingValue(spec, formFromSetting(spec, none))).toEqual({ ok: true, value: none });
    const set = { maxSelectionLiability: '123456', maxEventLiability: '9999900' };
    const form = formFromSetting(spec, set);
    expect(form).toEqual({ maxSelectionLiability: '1234.56', maxEventLiability: '99999.00' });
    expect(buildSettingValue(spec, form)).toEqual({ ok: true, value: set });
  });

  it('the contract refuses a selection cap above the match cap', () => {
    expect(
      contract.safeParse({ maxSelectionLiability: '200', maxEventLiability: '100' }).success,
    ).toBe(false);
    expect(
      contract.safeParse({ maxSelectionLiability: '100', maxEventLiability: '100' }).success,
    ).toBe(true);
    expect(
      contract.safeParse({ maxSelectionLiability: '0', maxEventLiability: null }).success,
    ).toBe(false); // A malformed amount is a validation issue, never an exception from the cross-field check.
    expect(
      contract.safeParse({ maxSelectionLiability: '1.5', maxEventLiability: '5' }).success,
    ).toBe(false);
    expect(contract.safeParse({ maxSelectionLiability: '5', maxEventLiability: 'x' }).success).toBe(
      false,
    );
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

describe('market families setting (edited as JSON)', () => {
  const contract = STAFF_SETTING_VALUE_SCHEMAS.market_families;
  const defaults = {
    marginBps: { main: 600, derivative: 700, long: 1200 },
    typeMarginBps: {},
    factoryLiabilityShareBps: 2500,
    minWeeklyStake: '10000000',
  };

  it('the contract takes the defaults and an override, and refuses bad margins or fields', () => {
    expect(contract.safeParse(defaults).success).toBe(true);
    expect(contract.safeParse({ ...defaults, typeMarginBps: { htft: 1400 } }).success).toBe(true);
    const parsed = parseJsonValue(JSON.stringify(defaults));
    expect(parsed.ok && contract.safeParse(parsed.value).success).toBe(true);
    for (const value of [
      { ...defaults, marginBps: { main: 10_001, derivative: 700, long: 1200 } },
      { ...defaults, typeMarginBps: { htft: 1.5 } },
      { ...defaults, factoryLiabilityShareBps: -1 },
      { ...defaults, minWeeklyStake: '-1' },
      { ...defaults, extra: true },
    ]) {
      expect(contract.safeParse(value).success).toBe(false);
    }
  });
});
