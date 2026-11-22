import type {
  DepositStatus,
  DepositView,
  PaymentOptionsResponse,
  PaymentProviderName,
  WithdrawalStatus,
  WithdrawalStep,
  WithdrawalView,
} from '@vamos/contracts';
import { parseBirr, toWire } from '@vamos/core';
import type { MessageKey } from '@vamos/i18n/translate';
import { detailString, isExclusionError, type Message } from '@/components/account/errors';
import { isApiClientError } from '@/lib/api/errors';
import { formatSantim } from '@/lib/format';
import type { Tone } from '@/components/account/bets';

/** Deposit / withdrawal rules and view state (pure; the forms only render it). */

// ------------------------------------------------------------------ amounts

/** Quick deposit amounts in santim (50, 100, 500, 1,000 ETB). */
export const DEPOSIT_QUICK_AMOUNTS: readonly string[] = ['50', '100', '500', '1000'].map((birr) =>
  toWire(parseBirr(birr)),
);

export type AmountCheck =
  { ok: true; amount: string } | { ok: false; reason: 'invalid' | 'tooLow' | 'tooHigh' };

/**
 * A birr input checked against the API's santim limits. Never floating point:
 * `parseBirr` reads at most two decimals into a bigint.
 */
export function checkAmount(input: string, min: string, max: string): AmountCheck {
  const text = input.trim().replace(/,/g, '');
  if (text === '') return { ok: false, reason: 'invalid' };
  let santim: bigint;
  try {
    santim = parseBirr(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (santim <= 0n) return { ok: false, reason: 'invalid' };
  if (santim < BigInt(min)) return { ok: false, reason: 'tooLow' };
  if (santim > BigInt(max)) return { ok: false, reason: 'tooHigh' };
  return { ok: true, amount: toWire(santim) };
}

export const AMOUNT_ERROR_KEY = {
  invalid: 'account.payments.amountInvalid',
  tooLow: 'account.payments.amountTooLow',
  tooHigh: 'account.payments.amountTooHigh',
} as const satisfies Record<string, MessageKey>;

// -------------------------------------------------------------- idempotency

/**
 * One idempotency key per intent. The same fingerprint (what the player asked
 * for: kind, provider, amount) keeps its key across retries after a timeout or
 * a 5xx, so the API cannot run it twice; a new fingerprint gets a new key.
 * Keep the store at module level so it outlives the component that used it.
 */
export interface IntentKeys {
  get(fingerprint: string): string;
  clear(): void;
}

export function createIntentKeys(make: (prefix: string) => string, prefix: string): IntentKeys {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    get(fingerprint) {
      if (current === null || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: make(prefix) };
      }
      return current.key;
    },
    clear() {
      current = null;
    },
  };
}

/** True when the failure is final for this key: the next attempt is a new intent. */
export function isDefiniteRefusal(error: unknown): boolean {
  if (!isApiClientError(error)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

// ----------------------------------------------------------------- deposits

const DEPOSIT_FINAL: ReadonlySet<DepositStatus> = new Set(['succeeded', 'failed', 'expired']);

export function isDepositFinal(status: DepositStatus): boolean {
  return DEPOSIT_FINAL.has(status);
}

export const DEPOSIT_STATUS_LABEL: Readonly<Record<DepositStatus, MessageKey>> = {
  created: 'account.payments.deposit.status.created',
  pending: 'account.payments.deposit.status.pending',
  succeeded: 'account.payments.deposit.status.succeeded',
  failed: 'account.payments.deposit.status.failed',
  expired: 'account.payments.deposit.status.expired',
};

/**
 * The status chip of a deposit. A transfer (telebirr or bank, the SMS rail) is credited by itself
 * when the money arrives, so while it waits it says so ("Waiting for your payment"), never
 * "Waiting for approval"; a flagged one says that staff are checking it.
 */
export function depositStatusKey(
  deposit: Pick<DepositView, 'status' | 'underReview' | 'transfer'>,
): MessageKey {
  const open = deposit.status === 'created' || deposit.status === 'pending';
  if (open && deposit.underReview) return 'account.payments.deposit.status.review';
  if (open && deposit.transfer) return 'account.payments.deposit.status.awaitingPayment';
  return DEPOSIT_STATUS_LABEL[deposit.status];
}

const DEPOSIT_FAILURE_LABEL: Readonly<Record<string, MessageKey>> = {
  declined_by_provider: 'account.payments.deposit.failure.declined',
  refused_by_provider: 'account.payments.deposit.failure.refused',
  failed_at_provider: 'account.payments.deposit.failure.failedAtProvider',
  expired: 'account.payments.deposit.failure.expired',
};

/** Why a deposit did not go through, in the player's words. */
export function depositFailureKey(
  deposit: Pick<DepositView, 'status' | 'failureReason'>,
): MessageKey {
  const known =
    deposit.failureReason === null ? undefined : DEPOSIT_FAILURE_LABEL[deposit.failureReason];
  if (known !== undefined) return known;
  return deposit.status === 'expired'
    ? 'account.payments.deposit.failure.expired'
    : 'account.payments.deposit.failure.generic';
}

/** The tag to show in a status chip. */
export function depositTone(status: DepositStatus): Tone {
  switch (status) {
    case 'succeeded':
      return 'positive';
    case 'failed':
      return 'negative';
    case 'expired':
      return 'muted';
    default:
      return 'pending';
  }
}

/** Poll delays: 2 s at first, easing to 5 s. */
export function depositPollDelayMs(attempt: number): number {
  return Math.min(5000, 2000 + Math.max(0, attempt) * 500);
}

/** Stop polling after this long; the player can tap "check again". */
export const DEPOSIT_POLL_LIMIT_MS = 10 * 60 * 1000;

/** First enabled provider that takes deposits (the mock in demo mode). */
export function pickProvider(
  options: Pick<PaymentOptionsResponse, 'providers'>,
  purpose: 'deposits' | 'payouts',
): PaymentProviderName | null {
  return options.providers.find((p) => p[purpose])?.name ?? null;
}

// -------------------------------------------------------------- withdrawals

const OPEN_WITHDRAWAL: ReadonlySet<WithdrawalStatus> = new Set([
  'requested',
  'approved',
  'processing',
]);

export function isWithdrawalOpen(status: WithdrawalStatus): boolean {
  return OPEN_WITHDRAWAL.has(status);
}

export const WITHDRAWAL_STATUS_LABEL: Readonly<Record<WithdrawalStatus, MessageKey>> = {
  requested: 'account.payments.withdraw.status.requested',
  approved: 'account.payments.withdraw.status.approved',
  processing: 'account.payments.withdraw.status.processing',
  paid: 'account.payments.withdraw.status.paid',
  failed: 'account.payments.withdraw.status.failed',
  rejected: 'account.payments.withdraw.status.rejected',
  cancelled: 'account.payments.withdraw.status.cancelled',
};

/**
 * The label of a tracker step. A step the withdrawal stopped at shows how it
 * stopped (rejected, cancelled, failed) instead of its own name.
 */
export function stepLabelKey(step: WithdrawalStep, status: WithdrawalStatus): MessageKey {
  if (
    step.state === 'failed' &&
    (status === 'rejected' || status === 'cancelled' || status === 'failed')
  ) {
    return WITHDRAWAL_STATUS_LABEL[status];
  }
  return WITHDRAWAL_STATUS_LABEL[step.key];
}

export function withdrawalTone(status: WithdrawalStatus): Tone {
  switch (status) {
    case 'paid':
      return 'positive';
    case 'failed':
    case 'rejected':
      return 'negative';
    case 'cancelled':
      return 'muted';
    default:
      return 'pending';
  }
}

/** Anything else (manual_review included) shows the generic message. */
const REVIEW_REASON: Readonly<Record<string, MessageKey>> = {
  above_auto_approve_threshold: 'account.payments.withdraw.review.aboveThreshold',
  active_exclusion: 'account.payments.withdraw.review.exclusion',
};

/** Why a requested withdrawal waits for staff, or null when there is nothing to say. */
export function reviewReasonKey(
  w: Pick<WithdrawalView, 'status' | 'reviewReason'>,
): MessageKey | null {
  if (w.status !== 'requested' || w.reviewReason === null) return null;
  return REVIEW_REASON[w.reviewReason] ?? 'account.payments.withdraw.review.generic';
}

/** Replaces one withdrawal in a list (newest first) or puts it on top; keeps ids unique. */
export function upsertWithdrawal(
  items: readonly WithdrawalView[],
  next: WithdrawalView,
): WithdrawalView[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [next, ...items];
  return items.map((item) => (item.id === next.id ? next : item));
}

export const WITHDRAWAL_POLL_MS = 8000;

export type RuleState = 'ok' | 'todo' | 'info';

export interface WithdrawRule {
  id: 'kyc' | 'wagering' | 'ownPhone' | 'dailyCap' | 'limits' | 'review';
  state: RuleState;
}

/**
 * The rules shown above the withdraw form, each marked met (`ok`), not yet met
 * (`todo`) or informational. The API still enforces every one of them.
 */
export function withdrawRules(input: {
  kycStatus: string | null;
  wageringRemaining: string | null;
}): WithdrawRule[] {
  const wagering = input.wageringRemaining;
  return [
    { id: 'kyc', state: input.kycStatus === 'verified' ? 'ok' : 'todo' },
    {
      id: 'wagering',
      state: wagering === null ? 'info' : BigInt(wagering) === 0n ? 'ok' : 'todo',
    },
    { id: 'ownPhone', state: 'info' },
    { id: 'dailyCap', state: 'info' },
    { id: 'limits', state: 'info' },
    { id: 'review', state: 'info' },
  ];
}

// ------------------------------------------------------------------- errors

/** Maps a payments API failure to a message (with amounts filled in from `details`). */
export function paymentErrorMessage(error: unknown): Message {
  if (isExclusionError(error)) return { key: 'account.errors.coolingOff' };
  if (!isApiClientError(error)) return { key: 'common.errors.generic' };
  switch (error.code) {
    case 'deposit_amount_out_of_range':
    case 'withdrawal_amount_out_of_range':
      return {
        key: 'account.payments.errors.amountRange',
        vars: {
          min: formatSantim(detailString(error, 'min')),
          max: formatSantim(detailString(error, 'max')),
        },
      };
    case 'deposit_limit_exceeded':
      return { key: 'account.payments.errors.depositLimit' };
    case 'deposit_phone_mismatch':
    case 'payout_phone_mismatch':
      return { key: 'account.payments.errors.phoneMismatch' };
    case 'payment_provider_unavailable':
    case 'provider_unavailable':
      return { key: 'account.payments.errors.providerUnavailable' };
    case 'kyc_required':
      return { key: 'account.payments.errors.kycRequired' };
    case 'wagering_requirement_not_met':
      return {
        key: 'account.payments.errors.wagering',
        vars: { withdrawable: formatSantim(detailString(error, 'withdrawable')) },
      };
    case 'withdrawal_daily_cap_exceeded':
      return { key: 'account.payments.errors.dailyCap' };
    case 'insufficient_funds':
      return { key: 'account.payments.errors.insufficientFunds' };
    case 'payout_not_cancellable':
      return { key: 'account.payments.errors.notCancellable' };
    case 'deposit_under_review':
      return { key: 'account.payments.errors.depositUnderReview' };
    case 'settlement_correction_pending':
      return { key: 'account.payments.errors.settlementCorrection' };
    case 'invalid_phone':
      return { key: 'account.payments.errors.invalidPhone' };
    case 'wrong_pin':
      return { key: 'account.payments.dev.wrongPin' };
    case 'payout_account_required':
      return { key: 'account.payments.errors.payoutAccountRequired' };
    case 'payout_account_unverified':
      return { key: 'account.payments.errors.payoutAccountUnverified' };
    case 'payout_account_not_own':
      return { key: 'account.payments.errors.payoutAccountNotOwn' };
    case 'payout_account_name_mismatch':
      return { key: 'account.payments.errors.payoutAccountNameMismatch' };
    case 'invalid_payout_account':
      return { key: 'account.payments.errors.invalidPayoutAccount' };
    case 'too_many_payout_accounts':
      return { key: 'account.payments.errors.tooManyPayoutAccounts' };
    case 'sms_amount_unavailable':
      return { key: 'account.payments.errors.smsAmountUnavailable' };
    case 'otp_invalid':
      return { key: 'account.payments.errors.otpInvalid' };
    case 'otp_expired':
      return { key: 'account.payments.errors.otpExpired' };
    default:
      return { key: 'common.errors.generic' };
  }
}

// ---------------------------------------------------------------- dev phone

/** Demo PIN of the simulated phone (shown as a hint; the API checks it). */
export const DEV_PHONE_PIN_HINT = '1234';

export const DEV_PHONE_REFRESH_MS = 4000;

// ------------------------------------------------------------------ SMS rail

/**
 * The exact amount of a transfer deposit, split for display: the whole
 * birr, and the santim that identify the payment (highlighted).
 */
export function splitSendAmount(sendAmount: string): { birr: string; santim: string } {
  const formatted = formatSantim(sendAmount);
  const dot = formatted.lastIndexOf('.');
  return dot === -1
    ? { birr: formatted, santim: '00' }
    : { birr: formatted.slice(0, dot), santim: formatted.slice(dot + 1) };
}

/** The santim added to the requested amount (what makes the amount the reference). */
export function extraSantim(transfer: { requestedAmount: string; sendAmount: string }): string {
  return (BigInt(transfer.sendAmount) - BigInt(transfer.requestedAmount)).toString();
}

/**
 * What the copy button puts on the clipboard. Wallet apps prefill the
 * country code and ask for the nine subscriber digits, so a pasted
 * `0911…` would become `+2510911…`: a phone-shaped account is copied as its
 * nine digits. Bank account numbers are copied as they are.
 */
export function clipboardAccount(account: string): string {
  const compact = account.replace(/[\s-]/g, '');
  const local = /^0([79]\d{8})$/.exec(compact);
  if (local?.[1]) return local[1];
  const international = /^\+?251([79]\d{8})$/.exec(compact);
  if (international?.[1]) return international[1];
  return compact;
}

export const DEPOSIT_CHECK_LABEL = {
  credited: 'account.payments.deposit.transfer.checkResult.credited',
  already_credited: 'account.payments.deposit.transfer.checkResult.already_credited',
  in_review: 'account.payments.deposit.transfer.checkResult.in_review',
  not_found: 'account.payments.deposit.transfer.checkResult.not_found',
} as const satisfies Record<string, MessageKey>;
