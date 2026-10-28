import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PAYOUT_DESTINATIONS,
  depositMethodFor,
  normalizeBankAccountNumber,
  normalizePayoutDestination,
  payoutDestination,
  personNamesMatch,
  ussdHref,
} from './paymentmethods';
import { INSTITUTIONS } from './smsparse';

/**
 * Pinned literally: a dial code wrong by one digit opens another bank's menu
 * and the player's birr goes there. A legitimate change must fail this test
 * and be re-verified against the institution's own instructions.
 */
const CODES: Readonly<Record<string, string>> = {
  telebirr: '*127#',
  cbe: '*847#',
  mpesa: '*733#',
  coop: '*841#',
  awash: '*901#',
  dashen: '*996#',
  abyssinia: '*815#',
};

describe('depositMethodFor', () => {
  it.each(Object.entries(CODES))('dials the pinned code for %s', (id, ussd) => {
    const method = depositMethodFor(id);
    expect(method.ussd).toBe(ussd);
    expect(method.appName).toBeTruthy();
  });

  it('only carries codes for registered institutions', () => {
    const known = new Set(INSTITUTIONS.map((spec) => spec.id));
    for (const id of Object.keys(CODES)) expect(known.has(id)).toBe(true);
  });

  it('falls back to the raw id with no code', () => {
    expect(depositMethodFor('no-such-bank')).toEqual({
      institution: 'no-such-bank',
      name: 'no-such-bank',
      kind: 'wallet',
    });
  });
});

describe('ussdHref', () => {
  it('percent-encodes every #', () => {
    expect(ussdHref('*127#')).toBe('tel:*127%23');
    expect(ussdHref('*888*1#*2#')).toBe('tel:*888*1%23*2%23');
  });
});

describe('payout destinations', () => {
  it('leads with telebirr and CBE and has no duplicates', () => {
    expect(PAYOUT_DESTINATIONS.slice(0, 2).map((d) => d.id)).toEqual(['telebirr', 'cbe']);
    const ids = PAYOUT_DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('addresses wallets by phone and banks by account', () => {
    expect(payoutDestination('telebirr')?.accountKind).toBe('phone');
    expect(payoutDestination('cbe')?.accountKind).toBe('account');
    expect(payoutDestination('dashen')?.kind).toBe('bank');
    expect(payoutDestination('amole')?.kind).toBe('wallet');
  });

  it('canonicalises every spelling of a wallet number to one E.164 form', () => {
    const forms = ['0911234567', '+251911234567', '251911234567', '0911 234 567'];
    expect(new Set(forms.map((f) => normalizePayoutDestination('telebirr', f)?.account))).toEqual(
      new Set(['+251911234567']),
    );
  });

  it('refuses mismatched shapes and unknown institutions', () => {
    expect(normalizePayoutDestination('telebirr', '1000123456789')).toBeNull();
    expect(normalizePayoutDestination('cbe', '1')).toBeNull();
    expect(normalizePayoutDestination('not-a-bank', '1000123456789')).toBeNull();
  });

  it('cleans bank account numbers', () => {
    expect(normalizePayoutDestination('cbe', '1000-1234 56789')?.account).toBe('1000123456789');
    expect(normalizeBankAccountNumber('ab12345')).toBe('AB12345');
    expect(normalizeBankAccountNumber('1000/12345')).toBeNull();
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('telebirr', 'cbe', 'awash'),
        fc.string({ maxLength: 40 }),
        (id, raw) => {
          const once = normalizePayoutDestination(id, raw);
          return (
            once === null || normalizePayoutDestination(id, once.account)?.account === once.account
          );
        },
      ),
    );
  });
});

describe('personNamesMatch', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(personNamesMatch('Abebe  Kebede', 'ABEBE KEBEDE')).toBe(true);
    expect(personNamesMatch("Abebe K'ebede", 'abebe kebede')).toBe(false);
    expect(personNamesMatch('Abebe-Kebede', 'abebe kebede')).toBe(true);
  });

  it('accepts the first two names of a three-part name', () => {
    expect(personNamesMatch('ABEBE KEBEDE', 'Abebe Kebede Tesfaye')).toBe(true);
  });

  it('refuses a single given name or a different person', () => {
    expect(personNamesMatch('ABEBE', 'Abebe Kebede Tesfaye')).toBe(false);
    expect(personNamesMatch('ABEBE TESFAYE', 'Abebe Kebede Tesfaye')).toBe(false);
    expect(personNamesMatch('', '')).toBe(false);
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), (a, b) => {
        return personNamesMatch(a, b) === personNamesMatch(b, a);
      }),
    );
  });
});
