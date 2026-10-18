import type { WithdrawalStep, WithdrawalView } from '@vamos/contracts';
import { MESSAGES, lookup } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/api/errors';
import {
  DEPOSIT_QUICK_AMOUNTS,
  DEPOSIT_STATUS_LABEL,
  WITHDRAWAL_STATUS_LABEL,
  checkAmount,
  createIntentKeys,
  depositFailureKey,
  depositPollDelayMs,
  isDefiniteRefusal,
  isDepositFinal,
  isWithdrawalOpen,
  paymentErrorMessage,
  pickProvider,
  reviewReasonKey,
  stepLabelKey,
  upsertWithdrawal,
  withdrawRules,
} from './payments';

const MIN = '1000'; // ETB 10
const MAX = '5000000'; // ETB 50,000

describe('checkAmount', () => {
  it('reads birr into santim without floating point', () => {
    expect(checkAmount('100', MIN, MAX)).toEqual({ ok: true, amount: '10000' });
    expect(checkAmount(' 1,250.50 ', MIN, MAX)).toEqual({ ok: true, amount: '125050' });
    expect(checkAmount('10.10', MIN, MAX)).toEqual({ ok: true, amount: '1010' });
    expect(checkAmount('0.1', '1', MAX)).toEqual({ ok: true, amount: '10' });
  });
  it('rejects junk, zero and negatives', () => {
    for (const input of ['', ' ', 'abc', '0', '0.00', '-5', '1.234', '1e3']) {
      expect(checkAmount(input, MIN, MAX)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
  it('checks the limits inclusively', () => {
    expect(checkAmount('9.99', MIN, MAX)).toEqual({ ok: false, reason: 'tooLow' });
    expect(checkAmount('10', MIN, MAX)).toEqual({ ok: true, amount: MIN });
    expect(checkAmount('50000', MIN, MAX)).toEqual({ ok: true, amount: MAX });
    expect(checkAmount('50000.01', MIN, MAX)).toEqual({ ok: false, reason: 'tooHigh' });
  });
});

describe('quick amounts', () => {
  it('are santim strings in ascending order', () => {
    expect(DEPOSIT_QUICK_AMOUNTS).toEqual(['5000', '10000', '50000', '100000']);
  });
});

describe('createIntentKeys', () => {
  const make = () => {
    let n = 0;
    return createIntentKeys((prefix) => `${prefix}-${++n}`, 'deposit');
  };
  it('reuses the key for the same intent and changes it for a new one', () => {
    const keys = make();
    const first = keys.get('mock:10000');
    expect(keys.get('mock:10000')).toBe(first);
    expect(keys.get('mock:20000')).not.toBe(first);
  });
  it('starts a new key after clear', () => {
    const keys = make();
    const first = keys.get('a');
    keys.clear();
    expect(keys.get('a')).not.toBe(first);
  });
});

describe('isDefiniteRefusal', () => {
  const err = (status: number) => new ApiClientError(status, 'x', 'x');
  it('is true for 4xx except 429, false for network, 5xx and other errors', () => {
    expect(isDefiniteRefusal(err(422))).toBe(true);
    expect(isDefiniteRefusal(err(409))).toBe(true);
    expect(isDefiniteRefusal(err(429))).toBe(false);
    expect(isDefiniteRefusal(err(503))).toBe(false);
    expect(isDefiniteRefusal(err(0))).toBe(false);
    expect(isDefiniteRefusal(new Error('x'))).toBe(false);
  });
});

describe('deposits', () => {
  it('knows final statuses', () => {
    expect(isDepositFinal('created')).toBe(false);
    expect(isDepositFinal('pending')).toBe(false);
    expect(isDepositFinal('succeeded')).toBe(true);
    expect(isDepositFinal('failed')).toBe(true);
    expect(isDepositFinal('expired')).toBe(true);
  });
  it('polls every 2 s at first and never slower than 5 s', () => {
    expect(depositPollDelayMs(0)).toBe(2000);
    expect(depositPollDelayMs(2)).toBe(3000);
    expect(depositPollDelayMs(100)).toBe(5000);
    expect(depositPollDelayMs(-3)).toBe(2000);
  });
  it('explains failures', () => {
    const base = { status: 'failed' as const };
    expect(depositFailureKey({ ...base, failureReason: 'declined_by_provider' })).toBe(
      'account.payments.deposit.failure.declined',
    );
    expect(depositFailureKey({ ...base, failureReason: 'something_new' })).toBe(
      'account.payments.deposit.failure.generic',
    );
    expect(depositFailureKey({ status: 'expired', failureReason: null })).toBe(
      'account.payments.deposit.failure.expired',
    );
  });
  it('picks the first provider for the purpose', () => {
    const providers = [
      { name: 'telebirr', deposits: true, payouts: false },
      { name: 'mock', deposits: true, payouts: true },
    ] as DepositProviders;
    expect(pickProvider({ providers }, 'deposits')).toBe('telebirr');
    expect(pickProvider({ providers }, 'payouts')).toBe('mock');
    expect(pickProvider({ providers: [] }, 'deposits')).toBeNull();
  });
});
type DepositProviders = Parameters<typeof pickProvider>[0]['providers'];

describe('withdrawals', () => {
  const step = (key: WithdrawalStep['key'], state: WithdrawalStep['state']): WithdrawalStep => ({
    key,
    state,
    at: null,
  });
  const withdrawal = (over: Partial<WithdrawalView>): WithdrawalView =>
    ({ id: 'w1', status: 'requested', reviewReason: null, ...over }) as WithdrawalView;

  it('tells open from closed', () => {
    for (const s of ['requested', 'approved', 'processing'] as const) {
      expect(isWithdrawalOpen(s)).toBe(true);
    }
    for (const s of ['paid', 'failed', 'rejected', 'cancelled'] as const) {
      expect(isWithdrawalOpen(s)).toBe(false);
    }
  });
  it('labels a stopped step with how it stopped', () => {
    expect(stepLabelKey(step('approved', 'failed'), 'rejected')).toBe(
      'account.payments.withdraw.status.rejected',
    );
    expect(stepLabelKey(step('requested', 'failed'), 'cancelled')).toBe(
      'account.payments.withdraw.status.cancelled',
    );
    expect(stepLabelKey(step('processing', 'failed'), 'failed')).toBe(
      'account.payments.withdraw.status.failed',
    );
    expect(stepLabelKey(step('approved', 'done'), 'processing')).toBe(
      'account.payments.withdraw.status.approved',
    );
  });
  it('shows the review reason only while requested', () => {
    expect(reviewReasonKey(withdrawal({ reviewReason: 'above_auto_approve_threshold' }))).toBe(
      'account.payments.withdraw.review.aboveThreshold',
    );
    expect(reviewReasonKey(withdrawal({ reviewReason: 'manual_review' }))).toBe(
      'account.payments.withdraw.review.generic',
    );
    expect(reviewReasonKey(withdrawal({ reviewReason: 'other' }))).toBe(
      'account.payments.withdraw.review.generic',
    );
    expect(reviewReasonKey(withdrawal({ status: 'approved', reviewReason: 'other' }))).toBeNull();
    expect(reviewReasonKey(withdrawal({ reviewReason: null }))).toBeNull();
  });
  it('upserts newest first without duplicates', () => {
    const a = withdrawal({ id: 'a' });
    const b = withdrawal({ id: 'b' });
    expect(upsertWithdrawal([a], b).map((w) => w.id)).toEqual(['b', 'a']);
    const a2 = withdrawal({ id: 'a', status: 'approved' });
    const next = upsertWithdrawal([b, a], a2);
    expect(next.map((w) => w.id)).toEqual(['b', 'a']);
    expect(next[1]?.status).toBe('approved');
  });
  it('marks the rules met or not yet met', () => {
    const state = (input: Parameters<typeof withdrawRules>[0]) =>
      Object.fromEntries(withdrawRules(input).map((r) => [r.id, r.state]));
    expect(state({ kycStatus: 'verified', wageringRemaining: '0' })).toMatchObject({
      kyc: 'ok',
      wagering: 'ok',
    });
    expect(state({ kycStatus: 'pending', wageringRemaining: '500' })).toMatchObject({
      kyc: 'todo',
      wagering: 'todo',
    });
    expect(state({ kycStatus: null, wageringRemaining: null }).wagering).toBe('info');
  });
});

describe('paymentErrorMessage', () => {
  const api = (code: string, details?: unknown, status = 422) =>
    new ApiClientError(status, code, code, { details });
  it('fills amounts from details', () => {
    expect(
      paymentErrorMessage(api('deposit_amount_out_of_range', { min: '1000', max: '5000000' })),
    ).toEqual({
      key: 'account.payments.errors.amountRange',
      vars: { min: '10.00', max: '50,000.00' },
    });
    expect(
      paymentErrorMessage(api('wagering_requirement_not_met', { remaining: '12550' })),
    ).toEqual({
      key: 'account.payments.errors.wagering',
      vars: { remaining: '125.50' },
    });
  });
  it('maps known codes and falls back to the generic message', () => {
    expect(paymentErrorMessage(api('kyc_required')).key).toBe(
      'account.payments.errors.kycRequired',
    );
    expect(paymentErrorMessage(api('payment_provider_unavailable', undefined, 503)).key).toBe(
      'account.payments.errors.providerUnavailable',
    );
    expect(paymentErrorMessage(api('payout_not_cancellable', undefined, 409)).key).toBe(
      'account.payments.errors.notCancellable',
    );
    expect(paymentErrorMessage(api('deposit_under_review', { depositId: 'x' }, 409)).key).toBe(
      'account.payments.errors.depositUnderReview',
    );
    expect(paymentErrorMessage(api('cooling_off')).key).toBe('account.errors.coolingOff');
    expect(paymentErrorMessage(api('brand_new')).key).toBe('common.errors.generic');
    expect(paymentErrorMessage(new Error('x')).key).toBe('common.errors.generic');
  });
});

describe('message keys exist in every shipped language', () => {
  const keys = [
    ...Object.values(DEPOSIT_STATUS_LABEL),
    ...Object.values(WITHDRAWAL_STATUS_LABEL),
    'account.payments.dev.wrongPin',
    'account.payments.deposit.failure.generic',
  ] as const;
  it.each(['en', 'am'] as const)('%s', (locale) => {
    for (const key of keys) {
      expect(lookup(MESSAGES[locale], key), key).toBeTypeOf('string');
    }
  });
});
