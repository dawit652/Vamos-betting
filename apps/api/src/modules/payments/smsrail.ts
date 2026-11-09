import {
  SmsGatewayRequest,
  type AddPayoutAccountResponse,
  type DepositCheckResponse,
  type PaymentOptionsResponse,
  type PaymentWebhookAck,
  type PayoutAccountView,
  type PayoutAccountsResponse,
} from '@vamos/contracts';
import {
  MAX_SANTIM_OFFSET,
  PAYOUT_DESTINATIONS,
  RECEIPT_VERIFIABLE_INSTITUTIONS,
  depositMethodFor,
  normalizeEthiopianMsisdn,
  payoutDestination,
} from '@vamos/core';
import {
  addPayoutAccount,
  checkSmsDepositForPlayer,
  ensureOwnWalletPayoutAccount,
  getActivePayoutAccount,
  ingestSms,
  listPayoutAccounts,
  payoutAccountOtpBinding,
  recordReceiptPaymentForPlayer,
  removePayoutAccount,
  SMS_AMOUNT_QUARANTINE_MS,
  SMS_PROVIDER,
  verifyPayoutAccount,
  withTxRetry,
  type PayoutAccount,
  type SmsCheckResult,
} from '@vamos/db';
import { kycProfiles, paymentIntents, users } from '@vamos/db/schema';
import { SMS_GATEWAY_SECRET_HEADER, SmsRailProvider, type ReceiptVerifier } from '@vamos/payments';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../../deps';
import { clientAddressKey } from '../../lib/client-address';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import type { Locale } from '../../lib/locale';
import { consumeOtp, createOtpChallenge, otpSentBody, sendOtpSms } from '../../lib/otp';
import { parseId } from './service';
import { depositView } from './views';

type Deps = Pick<AppDeps, 'config' | 'db' | 'clock' | 'payments'>;

/** The SMS rail's provider, when `sms` is enabled. */
export function smsProviderOf(deps: Pick<AppDeps, 'payments'>): SmsRailProvider | null {
  const provider = deps.payments.get(SMS_PROVIDER);
  return provider instanceof SmsRailProvider ? provider : null;
}

/** The `smsRail` part of GET /payments/options: how to pay into each collection institution. */
export function smsRailOptions(deps: Pick<AppDeps, 'payments'>): PaymentOptionsResponse['smsRail'] {
  const provider = smsProviderOf(deps);
  if (provider === null) return null;
  const institutions = [...new Set(provider.collectionAccounts.map((a) => a.institution))];
  return {
    mode: provider.mode,
    maxExtraSantim: MAX_SANTIM_OFFSET,
    methods: institutions.map((institution) => {
      const method = depositMethodFor(institution);
      return {
        institution,
        name: method.name,
        kind: method.kind,
        ussd: method.ussd ?? null,
        appName: method.appName ?? null,
        accounts: provider.collectionAccounts
          .filter((a) => a.institution === institution)
          .map((a) => ({ account: a.account, name: a.name, hint: a.hint ?? null })),
      };
    }),
  };
}

function checkResponse(result: SmsCheckResult): DepositCheckResponse {
  return {
    status: result.status,
    deposit: result.intent === undefined ? null : depositView(result.intent),
  };
}

/** Amounts of the player's SMS deposits that a payment may still settle. */
async function openSmsAmounts(deps: Pick<AppDeps, 'db'>, userId: string, now: Date) {
  const rows = await deps.db
    .select({ amount: paymentIntents.amount })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.userId, userId),
        eq(paymentIntents.provider, SMS_PROVIDER),
        isNull(paymentIntents.flaggedAt),
        or(
          inArray(paymentIntents.status, ['created', 'pending']),
          and(
            eq(paymentIntents.status, 'expired'),
            gt(paymentIntents.expiresAt, new Date(now.getTime() - SMS_AMOUNT_QUARANTINE_MS)),
          ),
        ),
      ),
    );
  return new Set(rows.map((row) => row.amount));
}

/**
 * POST /payments/deposits/check: "I paid but my balance did not change".
 * The paste is a lookup key into the SMS the collection handset delivered
 * (checkSmsDepositForPlayer). When the handset never forwarded it and the
 * rail is live, the institution's own receipt page is asked (telebirr);
 * only a verified payment into one of our accounts is recorded, and it is
 * matched against this player's own deposits.
 */
export async function checkPlayerSmsDeposit(
  deps: Deps & { receipts?: ReceiptVerifier | undefined },
  input: { userId: string; text: string },
): Promise<DepositCheckResponse> {
  const provider = smsProviderOf(deps);
  if (provider === null) throw notFound('Payment provider');
  const now = deps.clock();
  const result = await withTxRetry(deps.db, (tx) =>
    checkSmsDepositForPlayer(tx, { userId: input.userId, text: input.text, now }),
  );
  if (
    result.status !== 'not_found' ||
    result.reference === null ||
    provider.mode !== 'live' ||
    deps.receipts === undefined ||
    deps.config.payments.sms.receiptVerify === 'off'
  ) {
    return checkResponse(result);
  }
  const reference = result.reference;
  for (const spec of RECEIPT_VERIFIABLE_INSTITUTIONS) {
    const receiverAccounts = provider.collectionAccountsAt(spec.id);
    if (receiverAccounts.length === 0) continue;
    const verdict = await deps.receipts.verify({
      institution: spec.id,
      reference,
      receiverAccounts,
    });
    if (verdict.status !== 'verified') continue;
    const open = await openSmsAmounts(deps, input.userId, now);
    const amount = verdict.facts.amounts.find((a) => open.has(a)) ?? verdict.amount;
    const payerPhone =
      verdict.facts.payerAccount !== null && /^[+\d]+$/.test(verdict.facts.payerAccount)
        ? normalizeEthiopianMsisdn(verdict.facts.payerAccount)
        : null;
    const recorded = await withTxRetry(deps.db, (tx) =>
      recordReceiptPaymentForPlayer(tx, {
        userId: input.userId,
        receipt: {
          institution: spec.id,
          reference,
          amount,
          payerName: verdict.facts.payerName,
          payerPhone,
          receiver: verdict.facts.receiverAccount ?? '',
          paidAt: verdict.facts.occurredAt,
          raw: '',
        },
        now: deps.clock(),
      }),
    );
    return checkResponse(recorded);
  }
  return checkResponse(result);
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * POST /payments/webhooks/sms: the forwarder on a collection handset (live
 * rail only: 404 otherwise). 403 for an address outside
 * SMS_GATEWAY_ALLOWLIST, 401 `webhook_signature_invalid` without the shared
 * secret (header, else the body's `secret`), 400 `webhook_malformed`. Then
 * ingestSms: a forwarder's retries are duplicates and change nothing.
 */
export async function receiveGatewaySms(
  deps: Pick<AppDeps, 'db' | 'clock' | 'payments'>,
  input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    rawBody: Buffer;
    ip: string;
  },
  log?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<PaymentWebhookAck> {
  const provider = smsProviderOf(deps);
  if (provider === null || provider.mode !== 'live') throw notFound('Payment provider');
  if (!provider.gatewayAddressAllowed(input.ip)) {
    log?.warn({ ip: input.ip }, 'sms gateway request from an address outside the allowlist');
    throw forbidden('gateway_forbidden', 'This address may not post to the SMS gateway.');
  }
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw badRequest('webhook_malformed', 'The webhook body could not be read.');
  }
  const parsed = SmsGatewayRequest.safeParse(json);
  if (!parsed.success) throw badRequest('webhook_malformed', 'The webhook body could not be read.');
  const header = headerString(input.headers[SMS_GATEWAY_SECRET_HEADER]);
  if (!provider.gatewaySecretMatches(header ?? parsed.data.secret)) {
    log?.warn({ ip: input.ip }, 'sms gateway request without a valid secret');
    throw new AppError(401, 'webhook_signature_invalid', 'The gateway secret is not valid.');
  }
  const body = parsed.data;
  const result = await withTxRetry(deps.db, (tx) =>
    ingestSms(tx, {
      source: 'gateway',
      sender: body.sender ?? null,
      text: body.text,
      deviceReceivedAt: body.receivedAt === undefined ? null : new Date(body.receivedAt),
      now: deps.clock(),
    }),
  );
  return { received: true, outcome: result.outcome };
}

// ---------------------------------------------------------------- payout accounts

function payoutAccountView(account: PayoutAccount): PayoutAccountView {
  const destination = payoutDestination(account.institution);
  return {
    id: account.id,
    institution: account.institution,
    institutionName: destination?.name ?? account.institution,
    kind: destination?.kind ?? 'bank',
    account: account.account,
    accountName: account.accountName,
    verified: account.verifiedAt !== null,
    createdAt: account.createdAt.toISOString(),
  };
}

/**
 * GET /payments/payout-accounts. The player's own wallet (their registered
 * phone) is saved for them once they are KYC-verified, so the common case
 * needs no setup.
 */
export async function listPlayerPayoutAccounts(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
): Promise<PayoutAccountsResponse> {
  const { items, canAdd } = await withTxRetry(deps.db, async (tx) => {
    const own = await ensureOwnWalletPayoutAccount(tx, { userId, now: deps.clock() });
    const [kyc] = await tx
      .select({ status: kycProfiles.status })
      .from(kycProfiles)
      .where(eq(kycProfiles.userId, userId))
      .limit(1);
    return {
      items: await listPayoutAccounts(tx, userId),
      canAdd: own !== null || kyc?.status === 'verified',
    };
  });
  return {
    items: items.map(payoutAccountView),
    destinations: PAYOUT_DESTINATIONS.map((d) => ({ ...d })),
    canAdd,
  };
}

async function issuePayoutAccountCode(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock' | 'sms'>,
  input: { userId: string; accountId: string; locale: Locale; ip: string },
  log?: Pick<FastifyBaseLogger, 'error'>,
): Promise<NonNullable<AddPayoutAccountResponse['otp']>> {
  const now = deps.clock();
  const { phone, otp } = await withTxRetry(deps.db, async (tx) => {
    const [user] = await tx
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw notFound('User');
    const issued = await createOtpChallenge(tx, {
      secret: deps.config.sessionSecret,
      phone: user.phone,
      purpose: 'payout_account',
      now,
      requesterKey: clientAddressKey(input.ip),
      binding: payoutAccountOtpBinding(input.accountId),
    });
    return { phone: user.phone, otp: issued };
  });
  await sendOtpSms(
    deps,
    { phone, purpose: 'payout_account', code: otp.code, locale: input.locale },
    log,
  );
  return otpSentBody(deps, phone, otp, 'payout_account');
}

/**
 * POST /payments/payout-accounts: saves the account (wallet: the registered
 * phone, verified at once; bank: in the KYC name, confirmed by a code sent
 * to the registered phone and bound to this account).
 */
export async function addPlayerPayoutAccount(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock' | 'sms'>,
  input: {
    userId: string;
    institution: string;
    account: string;
    accountName?: string | undefined;
    locale: Locale;
    ip: string;
  },
  log?: Pick<FastifyBaseLogger, 'error'>,
): Promise<AddPayoutAccountResponse> {
  const added = await withTxRetry(deps.db, (tx) =>
    addPayoutAccount(tx, {
      userId: input.userId,
      institution: input.institution,
      account: input.account,
      ...(input.accountName === undefined ? {} : { accountName: input.accountName }),
      now: deps.clock(),
      ip: input.ip,
    }),
  );
  const otp = added.needsOtp
    ? await issuePayoutAccountCode(
        deps,
        { userId: input.userId, accountId: added.account.id, locale: input.locale, ip: input.ip },
        log,
      )
    : null;
  return { account: payoutAccountView(added.account), otp };
}

/** POST /payments/payout-accounts/:id/resend: a new code for an unconfirmed account. */
export async function resendPayoutAccountCode(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock' | 'sms'>,
  input: { userId: string; accountId: string; locale: Locale; ip: string },
  log?: Pick<FastifyBaseLogger, 'error'>,
): Promise<AddPayoutAccountResponse> {
  const id = parseId(input.accountId, 'Payout account');
  const account = await getActivePayoutAccount(deps.db, input.userId, id);
  if (account === null) throw notFound('Payout account');
  if (account.verifiedAt !== null) return { account: payoutAccountView(account), otp: null };
  const otp = await issuePayoutAccountCode(deps, { ...input, accountId: id }, log);
  return { account: payoutAccountView(account), otp };
}

/** POST /payments/payout-accounts/:id/confirm: the code bound to this account. */
export async function confirmPlayerPayoutAccount(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock'>,
  input: { userId: string; phone: string; accountId: string; code: string; ip: string },
): Promise<PayoutAccountView> {
  const id = parseId(input.accountId, 'Payout account');
  const account = await getActivePayoutAccount(deps.db, input.userId, id);
  if (account === null) throw notFound('Payout account');
  if (account.verifiedAt !== null) return payoutAccountView(account);
  const now = deps.clock();
  const verified = await consumeOtp(
    deps.db,
    {
      secret: deps.config.sessionSecret,
      phone: input.phone,
      purpose: 'payout_account',
      code: input.code,
      now,
      binding: payoutAccountOtpBinding(id),
    },
    (tx) =>
      verifyPayoutAccount(tx, { userId: input.userId, payoutAccountId: id, now, ip: input.ip }),
  );
  return payoutAccountView(verified);
}

/** POST /payments/payout-accounts/:id/remove. */
export async function removePlayerPayoutAccount(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  input: { userId: string; accountId: string; ip: string },
): Promise<void> {
  const id = parseId(input.accountId, 'Payout account');
  await withTxRetry(deps.db, (tx) =>
    removePayoutAccount(tx, {
      userId: input.userId,
      payoutAccountId: id,
      now: deps.clock(),
      ip: input.ip,
    }),
  );
}
