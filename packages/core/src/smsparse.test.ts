import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { santimToBirrString } from './money';
import { BANK_SMS, CBE_SMS, NOISE_SMS, TELEBIRR_SMS } from './smsparse.fixtures';
import {
  INSTITUTIONS,
  RECEIPT_VERIFIABLE_INSTITUTIONS,
  SMS_MAX_LENGTH,
  bareSmsReference,
  institutionById,
  institutionFromSender,
  parseSms,
  parseSmsWithSpec,
  pastedSmsReference,
  smsBirrToSantim,
  smsPhoneFits,
} from './smsparse';

const telebirr = institutionById('telebirr')!;
const cbe = institutionById('cbe')!;

describe('smsBirrToSantim', () => {
  it('reads exact amounts without floats', () => {
    expect(smsBirrToSantim('100')).toBe(10000n);
    expect(smsBirrToSantim('100.37')).toBe(10037n);
    expect(smsBirrToSantim('100.5')).toBe(10050n);
    expect(smsBirrToSantim('1,234.56')).toBe(123456n);
    expect(smsBirrToSantim('99,999,999.99')).toBe(9999999999n);
  });

  it('refuses what it cannot read exactly', () => {
    expect(smsBirrToSantim('abc')).toBeNull();
    expect(smsBirrToSantim('100.375')).toBeNull();
    // A decimal comma, not grouping: never read as 10,037 birr.
    expect(smsBirrToSantim('100,37')).toBeNull();
  });

  it('round-trips every santim amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (santim) => {
        return smsBirrToSantim(santimToBirrString(santim)) === santim;
      }),
    );
  });
});

describe('telebirr messages', () => {
  it('reads a full credit (the payment, not the later balance)', () => {
    const sms = parseSmsWithSpec(TELEBIRR_SMS.creditEnglish, telebirr)!;
    expect(sms).toMatchObject({
      institution: 'telebirr',
      direction: 'credit',
      amount: 10037n,
      reference: 'CA999DASAD',
      counterpartyName: 'SENDER NAME',
      counterpartyPhone: '+251900000000',
      balance: 123456n,
    });
    expect(sms.occurredAt?.toISOString()).toBe('2026-08-15T12:31:00.000Z');
  });

  it('classifies an outgoing transfer as a debit', () => {
    expect(parseSmsWithSpec(TELEBIRR_SMS.debitEnglish, telebirr)?.direction).toBe('debit');
  });

  it('reads the Amharic variant', () => {
    expect(parseSmsWithSpec(TELEBIRR_SMS.creditAmharic, telebirr)).toMatchObject({
      direction: 'credit',
      amount: 10037n,
      reference: 'CA999DASAD',
    });
  });

  it('degrades field by field', () => {
    expect(parseSmsWithSpec(TELEBIRR_SMS.creditMinimal, telebirr)).toMatchObject({
      amount: 7542n,
      reference: 'CD456QWERT',
      counterpartyPhone: null,
    });
  });
});

describe('the live telebirr and CBE credits (22 Nov 2026)', () => {
  it("reads telebirr's Amharic credit: amount, reference, masked payer, date", () => {
    for (const hint of ['127', 'telebirr', null]) {
      const sms = parseSms(TELEBIRR_SMS.creditAmharicLive, hint)!;
      expect(sms).toMatchObject({
        institution: 'telebirr',
        direction: 'credit',
        amount: 1073n,
        reference: 'DKA1BC2DEF',
        counterpartyName: 'sender name',
        counterpartyPhone: '+2519****0000',
        balance: 123456n,
      });
      // 23:53:23 in Addis Ababa.
      expect(sms.occurredAt?.toISOString()).toBe('2026-11-22T20:53:00.000Z');
    }
  });

  it("reads CBE's credit by its receipt token; the payer is a name, never a phone", () => {
    for (const hint of ['CBE', null]) {
      const sms = parseSms(CBE_SMS.creditLive, hint)!;
      expect(sms).toMatchObject({
        institution: 'cbe',
        direction: 'credit',
        amount: 5028n,
        reference: 'ABCDEFGH12IJKL34MNOP',
        counterpartyName: 'Sender Full Name',
        counterpartyPhone: null,
        balance: 123456n,
        occurredAt: null,
      });
    }
  });

  it("reads CBE's credit of money sent from telebirr by its BranchReceipt FT reference", () => {
    for (const hint of ['CBE', null]) {
      expect(parseSms(CBE_SMS.creditFromWalletLive, hint)).toMatchObject({
        institution: 'cbe',
        direction: 'credit',
        amount: 1040n,
        reference: 'FT26001ABC12',
        counterpartyPhone: null,
        balance: 123456n,
      });
    }
  });

  it('a masked number fits only the phones that agree at every visible place', () => {
    expect(smsPhoneFits('+2519****0000', '+251911110000')).toBe(true);
    expect(smsPhoneFits('+2519****0000', '+251911110001')).toBe(false);
    expect(smsPhoneFits('+2519****0000', '+251711110000')).toBe(false);
    expect(smsPhoneFits('+251911110000', '+251911110000')).toBe(true);
    expect(smsPhoneFits('+251911110000', '+251911110001')).toBe(false);
    expect(smsPhoneFits(null, '+251911110000')).toBeNull();
    fc.assert(
      fc.property(
        fc.stringMatching(/^\+2519\d{8}$/),
        fc.array(fc.integer({ min: 5, max: 12 }), { maxLength: 6 }),
        fc.integer({ min: 4, max: 12 }),
        (phone, masked, changed) => {
          const mask = [...phone].map((c, i) => (masked.includes(i) ? '*' : c)).join('');
          if (!smsPhoneFits(mask, phone)) return false;
          // Another digit at a visible place never fits.
          if (masked.includes(changed)) return true;
          const other = [...phone]
            .map((c, i) => (i === changed ? String((Number(c) + 1) % 10) : c))
            .join('');
          return smsPhoneFits(mask, other) === false;
        },
      ),
    );
  });

  it('keeps a masked number only for credits, and needs four visible digits', () => {
    const debit = TELEBIRR_SMS.creditAmharicLive.replace('ተቀብለዋል', 'ልከዋል');
    expect(parseSms(debit, '127')).toMatchObject({ direction: 'debit', counterpartyPhone: null });
    const hidden = TELEBIRR_SMS.creditAmharicLive.replace('2519****0000', '251*******00');
    expect(parseSms(hidden, '127')?.counterpartyPhone).toBeNull();
  });
});

describe('CBE messages', () => {
  it('reads a credit', () => {
    expect(parseSmsWithSpec(CBE_SMS.creditEnglish, cbe)).toMatchObject({
      direction: 'credit',
      amount: 25000n,
      reference: 'CAA2K819ZY',
      balance: 340000n,
    });
  });

  it('classifies a debit as a debit', () => {
    expect(parseSmsWithSpec(CBE_SMS.debitEnglish, cbe)?.direction).toBe('debit');
  });
});

describe('other banks', () => {
  it.each([
    ['awash', BANK_SMS.awash, 30045n, 'AWB123456789'],
    ['abyssinia', BANK_SMS.abyssinia, 45022n, 'BOA9988776'],
    ['coop', BANK_SMS.coop, 12033n, 'CBO202608150001'],
    ['amole', BANK_SMS.amole, 7519n, 'AML55667788'],
    ['mpesa', BANK_SMS.mpesa, 20066n, 'QGH7TR8901'],
    ['amhara', BANK_SMS.amharic, 64028n, 'AMB2026081501'],
  ] as const)('reads a %s credit', (sender, text, amount, reference) => {
    expect(parseSms(text, sender)).toMatchObject({ direction: 'credit', amount, reference });
  });

  it('reads an M-PESA (07…) sender phone', () => {
    expect(parseSms(BANK_SMS.mpesa, 'MPESA')?.counterpartyPhone).toBe('+251712345678');
  });

  it('classifies a bank debit', () => {
    expect(parseSms(BANK_SMS.bankDebit, 'Awash')?.direction).toBe('debit');
  });

  it('skips a balance stated before the payment', () => {
    expect(parseSms(BANK_SMS.balanceFirst)?.amount).toBe(25075n);
  });

  it('does not read a 9-digit run inside an account number as a phone', () => {
    expect(parseSms(BANK_SMS.accountWithNineRun, 'CBE')?.counterpartyPhone).toBeNull();
  });
});

describe('parseSms', () => {
  it('routes on the sender address or an institution id', () => {
    expect(parseSms(TELEBIRR_SMS.creditEnglish, 'telebirr')?.institution).toBe('telebirr');
    expect(parseSms(CBE_SMS.creditEnglish, 'CBE')?.institution).toBe('cbe');
    expect(parseSms(CBE_SMS.creditEnglish, 'cbe')?.institution).toBe('cbe');
  });

  it('attributes distinctive messages without a sender', () => {
    expect(parseSms(CBE_SMS.creditEnglish)?.institution).toBe('cbe');
    expect(parseSms(TELEBIRR_SMS.creditEnglish)?.institution).toBe('telebirr');
  });

  it('still parses under an unrecognised sender', () => {
    expect(parseSms(TELEBIRR_SMS.creditEnglish, 'UNKNOWN-SENDER')?.amount).toBe(10037n);
  });

  it.each(NOISE_SMS)('refuses noise: %j', (text) => {
    expect(parseSms(text)).toBeNull();
  });

  it('refuses over-long text', () => {
    expect(parseSms(`${TELEBIRR_SMS.creditEnglish} ${'x'.repeat(SMS_MAX_LENGTH)}`)).toBeNull();
  });

  it('never throws and never yields a non-positive amount or a malformed reference', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.option(fc.string({ maxLength: 20 })),
        (text, hint) => {
          const sms = parseSms(text, hint);
          return sms === null || (sms.amount > 0n && /^[A-Z0-9]{6,25}$/.test(sms.reference));
        },
      ),
    );
  });

  it('reads any amount and reference put into a telebirr credit template', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 10n }),
        fc.stringMatching(/^[A-Z][A-Z0-9]{9}$/),
        (amount, reference) => {
          const text = `Dear CUSTOMER, you have received ETB ${santimToBirrString(amount)} from X (251911111111) on 01/09/2026 at 1:00:00 PM. Your transaction number is ${reference}. Your telebirr balance is ETB 5.00.`;
          const sms = parseSms(text, 'telebirr');
          return (
            sms?.amount === amount && sms.reference === reference && sms.direction === 'credit'
          );
        },
      ),
    );
  });

  it('never reads a templated debit as a credit', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 10n }), (amount) => {
        const text = `Dear CUSTOMER, you have transferred ETB ${santimToBirrString(amount)} to Y (251922222222) on 01/09/2026. Your transaction number is CB1234567X.`;
        return parseSms(text, 'telebirr')?.direction === 'debit';
      }),
    );
  });
});

describe('dates', () => {
  it('refuses impossible dates rather than rolling them over', () => {
    const text =
      'You have received ETB 10.00 on 31/02/2026. Your transaction number is CD456QWERT.';
    expect(parseSms(text, 'telebirr')?.occurredAt).toBeNull();
  });
});

describe('registry', () => {
  it('has unique ids', () => {
    const ids = INSTITUTIONS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves decorated sender addresses', () => {
    expect(institutionFromSender('CBEBank')?.id).toBe('cbe');
    expect(institutionFromSender('')).toBeNull();
    expect(institutionFromSender(null)).toBeNull();
  });

  it('only telebirr is receipt-verifiable, with a URL built from the reference', () => {
    expect(RECEIPT_VERIFIABLE_INSTITUTIONS.map((spec) => spec.id)).toEqual(['telebirr']);
    expect(telebirr.receiptUrl?.('CA999DASAD')).toBe(
      'https://transactioninfo.ethiotelecom.et/receipt/CA999DASAD',
    );
  });
});

describe('pasted references', () => {
  it('takes the reference out of a whole SMS or accepts a bare one', () => {
    expect(pastedSmsReference(TELEBIRR_SMS.creditEnglish)).toBe('CA999DASAD');
    expect(pastedSmsReference('  ca999dasad ')).toBe('CA999DASAD');
    expect(pastedSmsReference('not a reference!')).toBeNull();
    expect(bareSmsReference('ABC')).toBeNull();
  });
});
