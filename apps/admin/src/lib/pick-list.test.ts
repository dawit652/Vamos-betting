import type { StaffWithdrawalView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { claimRefusalText, pickList, plainBirr } from './pick-list';

describe('plainBirr', () => {
  it('writes a dot, two decimals and no separators', () => {
    expect(plainBirr('0')).toBe('0.00');
    expect(plainBirr('5')).toBe('0.05');
    expect(plainBirr('100')).toBe('1.00');
    expect(plainBirr('123450')).toBe('1234.50');
    expect(plainBirr('100000000000000000')).toBe('1000000000000000.00');
    expect(plainBirr('-250')).toBe('-2.50');
  });

  it('refuses what is not a whole number of santim', () => {
    expect(plainBirr('1.5')).toBeNull();
    expect(plainBirr('')).toBeNull();
    expect(plainBirr('12a')).toBeNull();
  });

  it('is exact beyond 2^53 and reads back to the same santim', () => {
    expect(plainBirr('9007199254740993')).toBe('90071992547409.93');
    // A spread of magnitudes (admin has no property-test library): every one reads back exactly.
    for (let digits = 1; digits <= 19; digits += 1) {
      for (const santim of [10n ** BigInt(digits - 1), 10n ** BigInt(digits) - 1n]) {
        const text = plainBirr(santim.toString());
        expect(text).toMatch(/^\d+\.\d{2}$/);
        expect(BigInt(text!.replace('.', ''))).toBe(santim);
      }
    }
  });
});

function payout(
  id: string,
  options: {
    institution?: string | null;
    processingAt?: string;
    status?: StaffWithdrawalView['status'];
    payingBy?: string | null;
  } = {},
): StaffWithdrawalView {
  const institution = options.institution === undefined ? 'Telebirr' : options.institution;
  return {
    id,
    manual: true,
    status: options.status ?? 'processing',
    payingBy: options.payingBy === undefined ? 'op' : options.payingBy,
    processingAt: options.processingAt ?? '2026-11-01T10:00:00.000Z',
    approvedAt: '2026-11-01T09:00:00.000Z',
    requestedAt: '2026-11-01T08:00:00.000Z',
    destination:
      institution === null
        ? null
        : {
            institution: 'x',
            institutionName: institution,
            kind: 'wallet',
            account: '1',
            name: 'N',
          },
  } as StaffWithdrawalView;
}

describe('pickList', () => {
  it('keeps only the payouts the signed-in operator holds', () => {
    const list = pickList(
      [
        payout('a'),
        payout('b', { payingBy: 'someone-else' }),
        payout('c', { status: 'approved', payingBy: null }),
      ],
      'op',
    );
    expect(list.flatMap((g) => g.items.map((w) => w.id))).toEqual(['a']);
    expect(pickList([payout('a')], undefined)).toEqual([]);
  });

  it('groups by institution, oldest first, the group with the oldest payout first', () => {
    const list = pickList(
      [
        payout('t2', { processingAt: '2026-11-01T11:00:00.000Z' }),
        payout('c1', {
          institution: 'Commercial Bank of Ethiopia',
          processingAt: '2026-11-01T09:30:00.000Z',
        }),
        payout('t1', { processingAt: '2026-11-01T10:00:00.000Z' }),
        payout('n1', { institution: null, processingAt: '2026-11-01T12:00:00.000Z' }),
      ],
      'op',
    );
    expect(list.map((g) => [g.institution, g.items.map((w) => w.id)])).toEqual([
      ['Commercial Bank of Ethiopia', ['c1']],
      ['Telebirr', ['t1', 't2']],
      ['Other', ['n1']],
    ]);
  });
});

describe('claimRefusalText', () => {
  it('explains the known codes and falls back to the code itself', () => {
    expect(claimRefusalText('manual_payout_approver_cannot_pay')).toMatch(/approved/);
    expect(claimRefusalText('aml_review_pending')).toMatch(/Compliance/);
    expect(claimRefusalText('something_new')).toBe('something_new');
    expect(claimRefusalText(undefined)).toBe('Refused.');
  });
});
