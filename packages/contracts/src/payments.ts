import { z } from 'zod';
import { IsoDateTime, Santim } from './common';

/**
 * Deposits and withdrawals (Phase 6). Money is santim as a decimal string.
 *
 * Deposit flow: POST /payments/deposits (Idempotency-Key) returns the deposit
 * with `initiation` telling the player how to pay (a push to the phone, a
 * hosted checkout to open, or a USSD code). The provider's webhook then
 * credits it; poll GET /payments/deposits/:id until `status` is final.
 *
 * Withdrawal flow: POST /payments/withdrawals (Idempotency-Key) takes the
 * money off the balance at once (held until paid or returned). `steps` is the
 * status tracker: requested → approved → processing → paid.
 */

/** Every provider name the platform knows; which ones are enabled is in GET /payments/options. */
export const PaymentProviderNameSchema = z.enum([
  'mock',
  'chapa',
  'telebirr',
  'cbebirr',
  'mpesa-et',
]);
export type PaymentProviderName = z.infer<typeof PaymentProviderNameSchema>;

/** A positive amount of santim (decimal string). */
export const PositiveSantim = Santim.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value) && value.length <= 15,
  { message: 'amount must be a positive amount of santim' },
);

/** An Ethiopian mobile number as typed (normalised by the server). */
const PhoneInput = z.string().trim().min(9).max(32);

// ---------------------------------------------------------------- options

export const PaymentProviderOption = z.object({
  name: PaymentProviderNameSchema,
  deposits: z.boolean(),
  payouts: z.boolean(),
});
export type PaymentProviderOption = z.infer<typeof PaymentProviderOption>;

/** GET /payments/options (public): the enabled providers and the amount limits. */
export const PaymentOptionsResponse = z.object({
  /** True in demo mode: the only provider is the play-money mock (dev phone simulator). */
  demo: z.boolean(),
  providers: z.array(PaymentProviderOption),
  limits: z.object({
    minDeposit: Santim,
    maxDeposit: Santim,
    minWithdrawal: Santim,
    maxWithdrawal: Santim,
    /** Most a player may withdraw over any rolling 24 hours. */
    dailyWithdrawalCap: Santim,
    /** Withdrawals below this are approved automatically; the rest are reviewed by staff. */
    autoApproveBelow: Santim,
  }),
});
export type PaymentOptionsResponse = z.infer<typeof PaymentOptionsResponse>;

// ---------------------------------------------------------------- deposits

export const CreateDepositRequest = z.object({
  amount: PositiveSantim,
  /** Defaults to the first enabled provider that takes deposits. */
  provider: PaymentProviderNameSchema.optional(),
  /** Must be the registered phone (the default). */
  phone: PhoneInput.optional(),
});
export type CreateDepositRequest = z.infer<typeof CreateDepositRequest>;

/**
 * - created: the provider is being asked;
 * - pending: waiting for the player to pay (approve the push, finish checkout…);
 * - succeeded: credited to the balance;
 * - failed: declined, or the provider refused to start it;
 * - expired: not paid in time (a late payment is still credited).
 */
export const DepositStatusSchema = z.enum(['created', 'pending', 'succeeded', 'failed', 'expired']);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;

export const DepositInitiationKindSchema = z.enum(['push', 'redirect', 'ussd']);

export const DepositView = z.object({
  id: z.string(),
  provider: PaymentProviderNameSchema,
  amount: Santim,
  currency: z.literal('ETB'),
  /** The paying (registered) phone. */
  phone: z.string(),
  status: DepositStatusSchema,
  /** How to pay; null until the provider answered. */
  initiation: z
    .object({
      kind: DepositInitiationKindSchema,
      /** kind = redirect: open this page. */
      redirectUrl: z.string().nullable(),
      /** kind = push / ussd: what to tell the player. */
      instructions: z.string().nullable(),
    })
    .nullable(),
  /** declined_by_provider, expired, … when not succeeded. */
  failureReason: z.string().nullable(),
  /** The provider reported something unexpected; staff are checking it. Nothing is credited meanwhile. */
  underReview: z.boolean(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type DepositView = z.infer<typeof DepositView>;

export const DepositsResponse = z.object({ items: z.array(DepositView) });
export type DepositsResponse = z.infer<typeof DepositsResponse>;

// ---------------------------------------------------------------- withdrawals

/**
 * Error codes of POST /payments/withdrawals besides the generic ones
 * (unauthorized, csrf_invalid, validation_failed, idempotency_key_*):
 * - 403 kyc_required, account_disabled;
 * - 409 deposit_under_review: a deposit of the player was reported reversed
 *   by its provider and waits for staff (details `{ depositId }`);
 * - 409 settlement_correction_pending: a corrected result on one of the
 *   player's bets could not be posted yet (it would overdraw the balance);
 *   withdrawals wait until it is (details `{ betId }`);
 * - 422 payout_phone_mismatch, withdrawal_amount_out_of_range,
 *   withdrawal_daily_cap_exceeded, wagering_requirement_not_met (details
 *   `{ remaining }`), insufficient_funds, payment_provider_unavailable.
 */
export const WithdrawalErrorCodeSchema = z.enum([
  'kyc_required',
  'account_disabled',
  'deposit_under_review',
  'settlement_correction_pending',
  'payout_phone_mismatch',
  'withdrawal_amount_out_of_range',
  'withdrawal_daily_cap_exceeded',
  'wagering_requirement_not_met',
  'insufficient_funds',
  'payment_provider_unavailable',
]);
export type WithdrawalErrorCode = z.infer<typeof WithdrawalErrorCodeSchema>;

export const CreateWithdrawalRequest = z.object({
  amount: PositiveSantim,
  /** Defaults to the first enabled provider that pays out. */
  provider: PaymentProviderNameSchema.optional(),
  /** Must be the registered phone (the default): payouts never go to anyone else. */
  phone: PhoneInput.optional(),
});
export type CreateWithdrawalRequest = z.infer<typeof CreateWithdrawalRequest>;

/**
 * - requested: waiting for staff review (large amount, or an active exclusion);
 * - approved: queued for payout;
 * - processing: sent to the provider;
 * - paid: done;
 * - failed / rejected / cancelled: the amount went back to the balance.
 */
export const WithdrawalStatusSchema = z.enum([
  'requested',
  'approved',
  'processing',
  'paid',
  'failed',
  'rejected',
  'cancelled',
]);
export type WithdrawalStatus = z.infer<typeof WithdrawalStatusSchema>;

export const WithdrawalStepKeySchema = z.enum(['requested', 'approved', 'processing', 'paid']);
/**
 * done: reached at `at`; current: in progress now; upcoming: not yet;
 * failed: the withdrawal stopped here (rejected, cancelled or failed).
 */
export const WithdrawalStepStateSchema = z.enum(['done', 'current', 'upcoming', 'failed']);

export const WithdrawalStep = z.object({
  key: WithdrawalStepKeySchema,
  state: WithdrawalStepStateSchema,
  at: IsoDateTime.nullable(),
});
export type WithdrawalStep = z.infer<typeof WithdrawalStep>;

export const WithdrawalView = z.object({
  id: z.string(),
  provider: PaymentProviderNameSchema,
  amount: Santim,
  currency: z.literal('ETB'),
  /** The player's registered phone, where the money goes. */
  phone: z.string(),
  status: WithdrawalStatusSchema,
  /**
   * status = requested: why it is reviewed (above_auto_approve_threshold, active_exclusion, or
   * the generic manual_review). Never an AML reason: that would tip the player off.
   */
  reviewReason: z.string().nullable(),
  /** status = rejected: staff's reason. */
  rejectionReason: z.string().nullable(),
  /** status = failed: why. */
  failureReason: z.string().nullable(),
  /** The player may still cancel it (POST /payments/withdrawals/:id/cancel). */
  cancellable: z.boolean(),
  requestedAt: IsoDateTime,
  approvedAt: IsoDateTime.nullable(),
  processingAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  /** Status tracker, always the four steps in order. */
  steps: z.array(WithdrawalStep),
});
export type WithdrawalView = z.infer<typeof WithdrawalView>;

export const WithdrawalsResponse = z.object({
  items: z.array(WithdrawalView),
  /** Stakes still needed before a withdrawal is allowed (0 = none). */
  wageringRemaining: Santim,
});
export type WithdrawalsResponse = z.infer<typeof WithdrawalsResponse>;

// ---------------------------------------------------------------- webhooks

/** Body of a 200 answer to a provider webhook. */
export const PaymentWebhookAck = z.object({
  received: z.literal(true),
  /** What applying it did (credited, failed, paid, duplicate, ignored…). */
  outcome: z.string(),
});
export type PaymentWebhookAck = z.infer<typeof PaymentWebhookAck>;

// ---------------------------------------------------------------- dev only

/**
 * DEV ONLY (demo mode, mock provider, NODE_ENV not production): the dev
 * phone simulator, for the signed-in player's own phone. GET
 * /dev/payments/phone lists the deposit pushes waiting on it; `phone`, when
 * given, must be the player's registered number (404 otherwise).
 */
export const DevPhoneQuery = z.object({ phone: PhoneInput.optional() });
export type DevPhoneQuery = z.infer<typeof DevPhoneQuery>;

export const DevPhonePush = z.object({
  depositId: z.string(),
  amount: Santim,
  instructions: z.string().nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type DevPhonePush = z.infer<typeof DevPhonePush>;

export const DevPhonePushesResponse = z.object({ items: z.array(DevPhonePush) });
export type DevPhonePushesResponse = z.infer<typeof DevPhonePushesResponse>;

/**
 * DEV ONLY: POST /dev/payments/phone – the signed-in player approves (PIN
 * 1234) or declines a push to their own phone. `phone`, when given, must be
 * their registered number.
 */
export const DevPhoneDecisionRequest = z.object({
  phone: PhoneInput.optional(),
  depositId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'decline']),
  pin: z.string().max(12).optional(),
});
export type DevPhoneDecisionRequest = z.infer<typeof DevPhoneDecisionRequest>;

export const DevPhoneDecisionResponse = z.object({
  /** What the signed webhook did (credited, failed, duplicate, ignored…). */
  outcome: z.string(),
  deposit: DepositView,
});
export type DevPhoneDecisionResponse = z.infer<typeof DevPhoneDecisionResponse>;

/** DEV ONLY: POST /dev/payments/withdrawals/:id/reject (stand-in for the Phase 9 back office). */
export const DevRejectWithdrawalRequest = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type DevRejectWithdrawalRequest = z.infer<typeof DevRejectWithdrawalRequest>;

/** DEV ONLY: GET /dev/payments/withdrawals – withdrawals waiting for review. */
export const DevWithdrawalQueueResponse = z.object({
  items: z.array(WithdrawalView.extend({ userId: z.string() })),
});
export type DevWithdrawalQueueResponse = z.infer<typeof DevWithdrawalQueueResponse>;
