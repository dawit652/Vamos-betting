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
  'sms',
]);
export type PaymentProviderName = z.infer<typeof PaymentProviderNameSchema>;

/**
 * The provider a deposit or withdrawal record carries: an online provider, or `cash` (taken or
 * paid at a shop's desk, docs/plans/cashier-dashboard.md). Never something a player requests.
 */
export const PaymentRecordProviderSchema = z.enum([
  ...PaymentProviderNameSchema.options,
  'cash',
  // Player cash at an agent's shop: the agent's prepaid balance pays (agent-shops.md phase 2).
  'agent_cash',
]);
export type PaymentRecordProvider = z.infer<typeof PaymentRecordProviderSchema>;

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
  /** SMS rail: deposits by transfer to a collection account, payouts sent by hand to a saved account. */
  manual: z.boolean(),
});
export type PaymentProviderOption = z.infer<typeof PaymentProviderOption>;

/** A collection account players pay into (SMS rail). */
export const CollectionAccountView = z.object({
  /** What the player sends to, as they type it (phone or account number). */
  account: z.string(),
  /** The account holder's name as the player's app shows it. */
  name: z.string(),
  hint: z.string().nullable(),
});
export type CollectionAccountView = z.infer<typeof CollectionAccountView>;

/** How to pay into one institution (SMS rail), with its collection accounts. */
export const DepositMethodView = z.object({
  institution: z.string(),
  name: z.string(),
  kind: z.enum(['wallet', 'bank']),
  /** The USSD code to dial (unencoded, e.g. *127#), when verified. */
  ussd: z.string().nullable(),
  appName: z.string().nullable(),
  accounts: z.array(CollectionAccountView),
});
export type DepositMethodView = z.infer<typeof DepositMethodView>;

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
  /**
   * The SMS rail when `sms` is enabled: `simulated` in demo mode (the dev SMS
   * simulator plays the bank), `live` with real collection accounts.
   */
  smsRail: z
    .object({
      mode: z.enum(['simulated', 'live']),
      methods: z.array(DepositMethodView),
      /** Santim players may be asked to add (1 to this) to make the amount their reference. */
      maxExtraSantim: z.number().int(),
    })
    .nullable(),
});
export type PaymentOptionsResponse = z.infer<typeof PaymentOptionsResponse>;

// ---------------------------------------------------------------- deposits

export const CreateDepositRequest = z.object({
  amount: PositiveSantim,
  /** Defaults to the first enabled provider that takes deposits. */
  provider: PaymentProviderNameSchema.optional(),
  /** Must be the registered phone (the default). */
  phone: PhoneInput.optional(),
  /**
   * SMS rail: the institution the player pays through (one of `smsRail.methods`; default the
   * first). The server gives the deposit one of that institution's collection accounts only.
   */
  institution: z
    .string()
    .regex(/^[a-z]{2,20}$/)
    .optional(),
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

export const DepositInitiationKindSchema = z.enum(['push', 'redirect', 'ussd', 'transfer']);

export const DepositView = z.object({
  id: z.string(),
  provider: PaymentRecordProviderSchema,
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
  /**
   * SMS rail (kind = transfer): send exactly `sendAmount` (the requested
   * amount plus a few santim: they identify the deposit) to one of the
   * collection accounts of GET /payments/options.
   */
  transfer: z
    .object({
      requestedAmount: Santim,
      sendAmount: Santim,
      /**
       * The one collection account this deposit's exact amount belongs to: pay only there.
       * Null for older deposits and when no accounts are configured (then any account of
       * GET /payments/options). Optional so an older client's parse still passes.
       */
      account: z
        .object({
          institution: z.string(),
          account: z.string(),
          name: z.string(),
          hint: z.string().nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type DepositView = z.infer<typeof DepositView>;

export const DepositsResponse = z.object({ items: z.array(DepositView) });
export type DepositsResponse = z.infer<typeof DepositsResponse>;

/**
 * POST /payments/deposits/check (Idempotency-Key not needed): "I paid but my
 * balance did not change". `text` is the confirmation SMS pasted whole, or
 * just its transaction number. It is only a lookup key: what credits is an
 * SMS the collection account received, or the institution's own receipt.
 */
export const DepositCheckRequest = z.object({ text: z.string().trim().min(4).max(2000) });
export type DepositCheckRequest = z.infer<typeof DepositCheckRequest>;

/**
 * - credited: this check credited your deposit;
 * - already_credited: that payment was credited already;
 * - in_review: we have it, but staff must place it (they will);
 * - not_found: no payment with that reference reached us (yet).
 */
export const DepositCheckResponse = z.object({
  status: z.enum(['credited', 'already_credited', 'in_review', 'not_found']),
  deposit: DepositView.nullable(),
});
export type DepositCheckResponse = z.infer<typeof DepositCheckResponse>;

// ---------------------------------------------------------------- payout accounts

/** Where an SMS-rail withdrawal can go (institution registry). */
export const PayoutDestinationView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['wallet', 'bank']),
  /** A wallet is the registered phone; a bank takes an account number. */
  accountKind: z.enum(['phone', 'account']),
});
export type PayoutDestinationView = z.infer<typeof PayoutDestinationView>;

export const PayoutAccountView = z.object({
  id: z.string(),
  institution: z.string(),
  institutionName: z.string(),
  kind: z.enum(['wallet', 'bank']),
  account: z.string(),
  accountName: z.string(),
  /** False until the OTP confirmed it (bank accounts). */
  verified: z.boolean(),
  createdAt: IsoDateTime,
});
export type PayoutAccountView = z.infer<typeof PayoutAccountView>;

/** GET /payments/payout-accounts: the player's saved accounts and where they may add one. */
export const PayoutAccountsResponse = z.object({
  items: z.array(PayoutAccountView),
  destinations: z.array(PayoutDestinationView),
  /** False until KYC is verified (accounts must be in the player's own name). */
  canAdd: z.boolean(),
});
export type PayoutAccountsResponse = z.infer<typeof PayoutAccountsResponse>;

/**
 * POST /payments/payout-accounts. A wallet must be the registered phone; a
 * bank account must be in the KYC name (`accountName`) and is confirmed by
 * a code sent to the registered phone (POST …/:id/confirm). Errors: 403
 * kyc_required; 422 invalid_payout_account, payout_account_not_own,
 * payout_account_name_mismatch, too_many_payout_accounts.
 */
export const AddPayoutAccountRequest = z.object({
  institution: z.string().trim().min(2).max(20),
  account: z.string().trim().min(5).max(40),
  accountName: z.string().trim().min(2).max(120).optional(),
});
export type AddPayoutAccountRequest = z.infer<typeof AddPayoutAccountRequest>;

export const AddPayoutAccountResponse = z.object({
  account: PayoutAccountView,
  /** Sent when the account needs confirming; `demoOtp` only with the demo SMS provider. */
  otp: z
    .object({ otpSentTo: z.string(), otpExpiresAt: z.string(), demoOtp: z.string().optional() })
    .nullable(),
});
export type AddPayoutAccountResponse = z.infer<typeof AddPayoutAccountResponse>;

/** POST /payments/payout-accounts/:id/confirm (400 otp_invalid / otp_expired). */
export const ConfirmPayoutAccountRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type ConfirmPayoutAccountRequest = z.infer<typeof ConfirmPayoutAccountRequest>;

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
  'payout_account_required',
  'payout_account_unverified',
]);
export type WithdrawalErrorCode = z.infer<typeof WithdrawalErrorCodeSchema>;

export const CreateWithdrawalRequest = z.object({
  amount: PositiveSantim,
  /** Defaults to the first enabled provider that pays out. */
  provider: PaymentProviderNameSchema.optional(),
  /** Must be the registered phone (the default): payouts never go to anyone else. */
  phone: PhoneInput.optional(),
  /** SMS rail (manual payouts): the saved, verified payout account to pay. */
  payoutAccountId: z.uuid().optional(),
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
  provider: PaymentRecordProviderSchema,
  amount: Santim,
  currency: z.literal('ETB'),
  /** The player's registered phone, where the money goes. */
  phone: z.string(),
  /** SMS rail: paid by hand to `destination`; `settlementReference` is the transfer once paid. */
  manual: z.boolean(),
  destination: z
    .object({ institution: z.string(), institutionName: z.string(), account: z.string() })
    .nullable(),
  settlementReference: z.string().nullable(),
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

/**
 * POST /payments/webhooks/sms: the forwarder app on a collection handset
 * (live SMS rail only; 404 otherwise). The shared secret goes in the
 * x-gateway-secret header, or in `secret` for forwarders that cannot set
 * headers (never in the query string: URLs are logged).
 */
export const SmsGatewayRequest = z.object({
  sender: z.string().trim().max(64).optional(),
  text: z.string().min(1).max(2000),
  /** Epoch milliseconds from the handset (informational; our clock is used). */
  receivedAt: z.number().int().positive().optional(),
  secret: z.string().max(200).optional(),
  /**
   * The id of the collection account this handset receives for (SMS_COLLECTION_ACCOUNTS `id`,
   * default `<institution>:<account>`). Left out, it is the only account when there is one.
   */
  account: z.string().trim().min(1).max(64).optional(),
});
export type SmsGatewayRequest = z.infer<typeof SmsGatewayRequest>;

/**
 * POST /payments/webhooks/sms/heartbeat: the forwarder on a collection handset says it is alive
 * (every few minutes), with its battery when it can read it. Same guards as the gateway; `account`
 * is resolved the same way (it may be left out when there is one collection account).
 */
export const SmsHeartbeatRequest = z.object({
  account: z.string().trim().min(1).max(64).optional(),
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  secret: z.string().max(200).optional(),
});
export type SmsHeartbeatRequest = z.infer<typeof SmsHeartbeatRequest>;

// ---------------------------------------------------------------- dev only

/**
 * DEV ONLY (simulated SMS rail): POST /dev/payments/sms – the signed-in
 * player's bank "sends" the confirmation SMS of their own open deposit:
 * `exact` pays the exact amount from their phone, `round` the requested
 * amount (a common mistake: flagged for staff), `other_phone` the exact
 * amount from someone else's number (flagged as a third-party payer).
 */
export const DevSmsRequest = z.object({
  depositId: z.string().min(1).max(64),
  variant: z.enum(['exact', 'round', 'other_phone']).default('exact'),
  /** The collection institution that "received" it (default: the first). */
  institution: z.string().max(20).optional(),
});
export type DevSmsRequest = z.infer<typeof DevSmsRequest>;

export const DevSmsResponse = z.object({
  /** What ingesting it did (credited, flagged, unmatched…). */
  outcome: z.string(),
  /** The SMS text the simulator composed (paste it into the deposit check to try that path). */
  text: z.string(),
  deposit: DepositView,
});
export type DevSmsResponse = z.infer<typeof DevSmsResponse>;

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
