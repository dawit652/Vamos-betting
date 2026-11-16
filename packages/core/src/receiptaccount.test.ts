import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareReceiptAccount,
  receiptAccountMatches,
  receiptMatchesAnyAccount,
} from './receiptaccount';

/**
 * The matcher exactly as it was in `@vamos/payments` (receipts/accountmatch.ts)
 * before it moved to core: the oracle for "identical behaviour for its
 * existing callers". Do not edit it to follow a change in the real one.
 */
function legacyReceiptAccountMatches(
  receiptValue: string | null | undefined,
  ours: string | null | undefined,
): boolean {
  const MASK = /[*x×•·#]/i;
  const canonical = (value: string) => value.replace(/[\s\-()+]/g, '').trim();
  const forms = (value: string): string[] => {
    const c = canonical(value);
    const out = new Set([c]);
    if (/^251\d{9}$/.test(c)) {
      out.add(`0${c.slice(3)}`);
      out.add(c.slice(3));
    } else if (/^0[79]\d{8}$/.test(c)) {
      out.add(`251${c.slice(1)}`);
      out.add(c.slice(1));
    } else if (/^[79]\d{8}$/.test(c)) {
      out.add(`251${c}`);
      out.add(`0${c}`);
    }
    if (/^251[\d*x×•·#]{9}$/i.test(c)) out.add(`0${c.slice(3)}`);
    if (/^0[\d*x×•·#]{9}$/i.test(c)) out.add(`251${c.slice(1)}`);
    return [...out];
  };
  const compareMasked = (masked: string, plain: string): boolean => {
    if (masked.length === 0 || masked.length !== plain.length) return false;
    let revealed = 0;
    for (let i = 0; i < masked.length; i++) {
      const ch = masked[i]!;
      if (MASK.test(ch)) continue;
      if (ch !== plain[i]) return false;
      revealed++;
    }
    if (revealed < 4) return false;
    const tail = masked.slice(-3);
    if (tail.length < 3) return false;
    for (const ch of tail) if (MASK.test(ch)) return false;
    return true;
  };
  if (!receiptValue || !ours) return false;
  return forms(receiptValue).some((a) => forms(ours).some((b) => compareMasked(a, b)));
}

const DEST = '+251922334455';
const subscriber = fc.stringMatching(/^[79]\d{8}$/);
const SUBSCRIBER_ONLY = { subscriberDigitsOnly: true } as const;

/** `subscriber` written in one of the receipt forms, with the chosen positions masked. */
function masked(sub: string, prefix: string, hidden: ReadonlySet<number>): string {
  return prefix + [...sub].map((ch, i) => (hidden.has(i) ? '*' : ch)).join('');
}

describe('compareReceiptAccount: digits shown', () => {
  it('matches a masked or plain value in any phone form', () => {
    for (const value of ['251922***455', '0922***455', '+251 922 334 455', '0922334455']) {
      expect(compareReceiptAccount(value, DEST), value).toBe('match');
      expect(compareReceiptAccount(value, DEST, { ...SUBSCRIBER_ONLY, minRevealed: 6 })).toBe(
        'match',
      );
    }
  });

  it('calls it another account when a shown digit or the length differs', () => {
    expect(compareReceiptAccount('251922***456', DEST)).toBe('differs');
    expect(compareReceiptAccount('251923***455', DEST)).toBe('differs');
    expect(compareReceiptAccount('25192233445', DEST)).toBe('differs');
    expect(compareReceiptAccount('0922334456', DEST)).toBe('differs');
  });

  it('is unreadable, never a match, for absent, blank or non-account values', () => {
    for (const value of [null, undefined, '', '   ', 42, 'Abebe K.', 'Abebe (2519***455)']) {
      expect(compareReceiptAccount(value, DEST), String(value)).toBe('unreadable');
    }
    expect(compareReceiptAccount('251922***455', null)).toBe('unreadable');
    expect(compareReceiptAccount('251922***455', ' ')).toBe('unreadable');
  });
});

describe('compareReceiptAccount: too few digits shown', () => {
  it('is unreadable when everything but the prefix, or the tail, is hidden', () => {
    expect(compareReceiptAccount('251*********', DEST)).toBe('unreadable');
    expect(compareReceiptAccount('2519223344**', DEST)).toBe('unreadable');
    expect(compareReceiptAccount('251922334***', DEST)).toBe('unreadable');
  });

  it('counts only subscriber digits when asked: the 251 prefix reveals nothing', () => {
    // 251 + 9 + 455: seven characters shown, four of them in the subscriber part.
    expect(compareReceiptAccount('2519*****455', DEST)).toBe('match');
    expect(compareReceiptAccount('2519*****455', DEST, SUBSCRIBER_ONLY)).toBe('match');
    expect(
      compareReceiptAccount('2519*****455', DEST, { ...SUBSCRIBER_ONLY, minRevealed: 5 }),
    ).toBe('unreadable');
    // 251 + 455 alone: six characters shown but three subscriber digits.
    expect(compareReceiptAccount('251******455', DEST)).toBe('match');
    expect(compareReceiptAccount('251******455', DEST, SUBSCRIBER_ONLY)).toBe('unreadable');
  });

  it('never accepts fewer than four revealed digits, and a non-integer minimum accepts nothing', () => {
    expect(
      compareReceiptAccount('251******455', DEST, { ...SUBSCRIBER_ONLY, minRevealed: 0 }),
    ).toBe('unreadable');
    expect(compareReceiptAccount(DEST, DEST, { minRevealed: Number.NaN })).toBe('unreadable');
    expect(compareReceiptAccount(DEST, DEST, { minRevealed: 4.5 })).toBe('unreadable');
  });

  it('never matches a value that reveals fewer subscriber digits than required', () => {
    fc.assert(
      fc.property(
        subscriber,
        fc.constantFrom('251', '0', ''),
        fc.uniqueArray(fc.integer({ min: 0, max: 8 }), { maxLength: 9 }),
        fc.integer({ min: 4, max: 9 }),
        (sub, prefix, hiddenList, minRevealed) => {
          const hidden = new Set(hiddenList);
          fc.pre(9 - hidden.size < minRevealed);
          const result = compareReceiptAccount(masked(sub, prefix, hidden), `+251${sub}`, {
            minRevealed,
            subscriberDigitsOnly: true,
          });
          expect(result).not.toBe('match');
        },
      ),
    );
  });

  it('with the default rule, never matches a value showing fewer than four digits or a hidden tail', () => {
    fc.assert(
      fc.property(
        subscriber,
        fc.uniqueArray(fc.integer({ min: 0, max: 8 }), { maxLength: 9 }),
        (sub, hiddenList) => {
          const hidden = new Set(hiddenList);
          const tailHidden = [6, 7, 8].some((i) => hidden.has(i));
          fc.pre(tailHidden || 9 - hidden.size < 4);
          expect(compareReceiptAccount(masked(sub, '', hidden), `+251${sub}`)).not.toBe('match');
        },
      ),
    );
  });
});

describe('compareReceiptAccount: one mask, two numbers', () => {
  it('matches every number that agrees with the shown digits: the residual a minimum bounds', () => {
    const mask = '251922***455';
    const other = '+251922999455';
    expect(compareReceiptAccount(mask, DEST)).toBe('match');
    expect(compareReceiptAccount(mask, other)).toBe('match');
    // Asking for more digits than the mask shows makes it prove neither number.
    const strict = { ...SUBSCRIBER_ONLY, minRevealed: 7 };
    expect(compareReceiptAccount(mask, DEST, strict)).toBe('unreadable');
    expect(compareReceiptAccount(mask, other, strict)).toBe('unreadable');
  });

  it('a fully shown number matches only itself', () => {
    fc.assert(
      fc.property(subscriber, subscriber, (a, b) => {
        fc.pre(a !== b);
        const rule = { ...SUBSCRIBER_ONLY, minRevealed: 9 };
        expect(compareReceiptAccount(`251${a}`, `+251${a}`, rule)).toBe('match');
        expect(compareReceiptAccount(`251${a}`, `+251${b}`, rule)).toBe('differs');
      }),
    );
  });
});

describe('receiptAccountMatches: unchanged for its existing callers', () => {
  it('keeps the examples of the payments receipt tests', () => {
    expect(receiptAccountMatches('251911***426', '0911678426')).toBe(true);
    expect(receiptAccountMatches('251911***427', '0911678426')).toBe(false);
    expect(receiptAccountMatches(null, '0911678426')).toBe(false);
    expect(receiptMatchesAnyAccount('251911***426', ['1000123', '0911678426'])).toBe(true);
    expect(receiptMatchesAnyAccount('251911***426', [])).toBe(false);
  });

  it('gives the same answer as the implementation it replaced', () => {
    const glyph = fc.constantFrom(...'0123456789*x×•·#X +-()'.split(''));
    const digits = fc.array(fc.constantFrom(...'0123456789'.split('')), {
      minLength: 0,
      maxLength: 14,
    });
    const value = fc.oneof(
      fc.array(glyph, { maxLength: 14 }).map((cs) => cs.join('')),
      fc
        .tuple(subscriber, fc.constantFrom('251', '0', '', '+251'), fc.array(fc.nat({ max: 8 })))
        .map(([sub, prefix, hidden]) => masked(sub, prefix, new Set(hidden))),
      digits.map((ds) => ds.join('')),
      fc.constantFrom(null, undefined, ''),
    );
    fc.assert(
      fc.property(value, value, (receiptValue, ours) => {
        expect(receiptAccountMatches(receiptValue, ours)).toBe(
          legacyReceiptAccountMatches(receiptValue, ours),
        );
      }),
      { numRuns: 5000 },
    );
    // Close pairs, where the forms and the mask rules decide.
    fc.assert(
      fc.property(
        subscriber,
        fc.constantFrom('251', '0', '', '+251'),
        fc.constantFrom('251', '0', '', '+251'),
        fc.array(fc.nat({ max: 8 })),
        (sub, receiptPrefix, oursPrefix, hidden) => {
          const receiptValue = masked(sub, receiptPrefix, new Set(hidden));
          expect(receiptAccountMatches(receiptValue, oursPrefix + sub)).toBe(
            legacyReceiptAccountMatches(receiptValue, oursPrefix + sub),
          );
        },
      ),
      { numRuns: 2000 },
    );
  });
});
