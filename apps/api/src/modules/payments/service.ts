import type {
  CreateDepositRequest,
  CreateWithdrawalRequest,
  DepositView,
  DepositsResponse,
  PaymentOptionsResponse,
  PaymentWebhookAck,
  WithdrawalView,
  WithdrawalsResponse,
} from '@vamos/contracts';
import { toWire } from '@vamos/core';
import {
  applyDepositEvent,
  applyPayoutEvent,
  cancelWithdrawal,
  createDepositIntent,
  getRemainingWagering,
  getUserDepositIntent,
  listUserDepositIntents,
  listUserPayouts,
  loadGameSettings,
  markDepositInitiated,
  markDepositInitiationFailed,
  requestWithdrawal,
  withTxRetry,
  type PaymentIntent,
} from '@vamos/db';
import { payouts } from '@vamos/db/schema';
import {
  paymentWebhookUrl,
  PaymentProviderError,
  WebhookVerificationError,
  type PaymentProvider,
  type ProviderCapabilities,
  type WebhookInput,
} from '@vamos/payments';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
  unprocessable,
} from '../../lib/errors';
import { cachedGameSettings } from '../betting/service';
import { depositView, withdrawalView } from './views';

type Deps = Pick<AppDeps, 'config' | 'db' | 'clock' | 'payments'>;

const Uuid = z.uuid();

/** Ids in paths: anything but a UUID is simply not found (never a database error). */
export function parseId(id: string, what: string): string {
  if (!Uuid.safeParse(id).success) throw notFound(what);
  return id;
}

/**
 * The enabled provider to use for `capability`: the requested one, or the
 * first enabled one that can do it. 422 `payment_provider_unavailable` when
 * there is none (unknown, disabled, or a provider that cannot pay out).
 */
export function pickProvider(
  registry: AppDeps['payments'],
  requested: string | undefined,
  capability: keyof ProviderCapabilities,
): PaymentProvider {
  const provider =
    requested === undefined
      ? registry.names.map((name) => registry.get(name)).find((p) => p?.capabilities[capability])
      : registry.get(requested);
  if (provider === undefined || !provider.capabilities[capability]) {
    throw unprocessable(
      'payment_provider_unavailable',
      capability === 'deposits'
        ? 'This payment method cannot take deposits right now.'
        : 'This payment method cannot pay out withdrawals right now.',
      { provider: requested ?? null, enabled: registry.names },
    );
  }
  return provider;
}

/** GET /payments/options: enabled providers and the amount limits. */
export async function paymentOptions(
  deps: Pick<AppDeps, 'config' | 'db' | 'clock' | 'payments'>,
): Promise<PaymentOptionsResponse> {
  const rules = (await cachedGameSettings(deps)).payments;
  return {
    demo: deps.config.mode === 'demo',
    providers: deps.payments.names.flatMap((name) => {
      const provider = deps.payments.get(name);
      return provider === undefined ? [] : [{ name, ...provider.capabilities }];
    }),
    limits: {
      minDeposit: toWire(rules.minDeposit),
      maxDeposit: toWire(rules.maxDeposit),
      minWithdrawal: toWire(rules.minWithdrawal),
      maxWithdrawal: toWire(rules.maxWithdrawal),
      dailyWithdrawalCap: toWire(rules.dailyWithdrawalCap),
      autoApproveBelow: toWire(rules.autoApproveBelow),
    },
  };
}

/** Where a redirect checkout sends the player back to (the web app's deposit page). */
export function depositReturnUrl(config: AppDeps['config'], intentId: string): string {
  const url = new URL('/wallet/deposit', config.web.publicUrl);
  url.searchParams.set('id', intentId);
  return url.toString();
}

export interface CreateDepositCommand {
  userId: string;
  idempotencyKey: string;
  request: CreateDepositRequest;
  ip?: string | null;
}

export interface CreatedDeposit {
  deposit: DepositView;
  /** true when the idempotency key had been used already (no second intent). */
  replayed: boolean;
}

/**
 * Asks the provider to start the deposit (outside any transaction) and
 * records its answer. A refusal fails the intent (`refused_by_provider`); a
 * timeout or outage is a 503 that leaves the intent `created`, so repeating
 * the request with the same Idempotency-Key asks the provider again (the
 * providers key a deposit by intent id, so this never charges twice).
 */
async function initiateDeposit(
  deps: Deps & { log?: { warn: (obj: object, msg: string) => void } },
  provider: PaymentProvider,
  intent: PaymentIntent,
): Promise<PaymentIntent> {
  try {
    const initiation = await provider.initiateDeposit({
      intentId: intent.id,
      amount: intent.amount,
      phone: intent.phone,
      callbackUrl: paymentWebhookUrl(deps.config.payments.callbackBaseUrl, provider.name),
      returnUrl: depositReturnUrl(deps.config, intent.id),
    });
    return await withTxRetry(deps.db, (tx) =>
      markDepositInitiated(tx, {
        intentId: intent.id,
        initiation: {
          kind: initiation.kind,
          providerRef: initiation.providerRef,
          ...(initiation.redirectUrl === undefined ? {} : { redirectUrl: initiation.redirectUrl }),
          ...(initiation.instructions === undefined
            ? {}
            : { instructions: initiation.instructions }),
        },
        now: deps.clock(),
      }),
    );
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    deps.log?.warn(
      { err: error, intentId: intent.id, provider: provider.name, retryable: error.retryable },
      'deposit initiation failed',
    );
    if (error.retryable) {
      throw serviceUnavailable(
        'payment_provider_unavailable',
        'The payment service is not answering. Try again in a moment.',
        { depositId: intent.id },
      );
    }
    return withTxRetry(deps.db, (tx) =>
      markDepositInitiationFailed(tx, {
        intentId: intent.id,
        reason: 'refused_by_provider',
        now: deps.clock(),
      }),
    );
  }
}

/**
 * POST /payments/deposits: creates the intent (createDepositIntent: RG
 * limits, registered phone, amount range, idempotency per player) and starts
 * it at the provider. A replay returns the same deposit; one still waiting
 * for the provider's first answer is initiated again.
 */
export async function createPlayerDeposit(
  deps: Deps & { log?: { warn: (obj: object, msg: string) => void } },
  command: CreateDepositCommand,
): Promise<CreatedDeposit> {
  const { request } = command;
  const provider = pickProvider(deps.payments, request.provider, 'deposits');
  const now = deps.clock();
  const created = await withTxRetry(deps.db, async (tx) => {
    const settings = await loadGameSettings(tx);
    return createDepositIntent(tx, {
      userId: command.userId,
      provider: provider.name,
      amount: BigInt(request.amount),
      ...(request.phone === undefined ? {} : { phone: request.phone }),
      idempotencyKey: command.idempotencyKey,
      now,
      rules: settings.payments,
      ip: command.ip ?? null,
    });
  });
  let intent = created.intent;
  if (intent.status === 'created' && intent.providerRef === null) {
    intent = await initiateDeposit(deps, provider, intent);
  }
  return { deposit: depositView(intent), replayed: created.replayed };
}

/** GET /payments/deposits/:id; 404 for an unknown id or another player's deposit. */
export async function getPlayerDeposit(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  depositId: string,
): Promise<DepositView> {
  const intent = await getUserDepositIntent(deps.db, userId, parseId(depositId, 'Deposit'));
  if (intent === null) throw notFound('Deposit');
  return depositView(intent);
}

/** GET /payments/deposits: the player's latest deposits. */
export async function listPlayerDeposits(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  limit: number,
): Promise<DepositsResponse> {
  const rows = await listUserDepositIntents(deps.db, userId, { limit });
  return { items: rows.map(depositView) };
}

export interface RequestWithdrawalCommand {
  userId: string;
  /** The player's registered phone (the session's). */
  phone: string;
  idempotencyKey: string;
  request: CreateWithdrawalRequest;
  ip?: string | null;
}

/**
 * POST /payments/withdrawals: requestWithdrawal (@vamos/db) with the current
 * payment rules: KYC verified, registered phone only, amount range, 24-hour
 * cap, wagering, then the hold and auto-approval or review.
 */
export async function requestPlayerWithdrawal(
  deps: Deps,
  command: RequestWithdrawalCommand,
): Promise<{ withdrawal: WithdrawalView; replayed: boolean }> {
  const { request } = command;
  const provider = pickProvider(deps.payments, request.provider, 'payouts');
  const now = deps.clock();
  const result = await withTxRetry(deps.db, async (tx) => {
    const settings = await loadGameSettings(tx);
    return requestWithdrawal(tx, {
      userId: command.userId,
      amount: BigInt(request.amount),
      phone: request.phone ?? command.phone,
      provider: provider.name,
      idempotencyKey: command.idempotencyKey,
      now,
      rules: settings.payments,
      ip: command.ip ?? null,
    });
  });
  return { withdrawal: withdrawalView(result.payout), replayed: result.replayed };
}

/** GET /payments/withdrawals: the player's latest withdrawals and the stakes still required. */
export async function listPlayerWithdrawals(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  limit: number,
): Promise<WithdrawalsResponse> {
  const [rows, settings] = await Promise.all([
    listUserPayouts(deps.db, userId, { limit }),
    loadGameSettings(deps.db),
  ]);
  const remaining = await getRemainingWagering(
    deps.db,
    userId,
    settings.payments.wageringMultiplierBps,
  );
  return { items: rows.map(withdrawalView), wageringRemaining: toWire(remaining) };
}

/** GET /payments/withdrawals/:id; 404 for an unknown id or another player's withdrawal. */
export async function getPlayerWithdrawal(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  payoutId: string,
): Promise<WithdrawalView> {
  const id = parseId(payoutId, 'Withdrawal');
  const [row] = await deps.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.id, id), eq(payouts.userId, userId)))
    .limit(1);
  if (row === undefined) throw notFound('Withdrawal');
  return withdrawalView(row);
}

/**
 * POST /payments/withdrawals/:id/cancel. The player may cancel only while the
 * withdrawal waits for review (`requested`); an approved one is about to be
 * sent. Cancelling twice is a no-op. 404 for another player's withdrawal.
 */
export async function cancelPlayerWithdrawal(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  input: { userId: string; payoutId: string; ip?: string | null },
): Promise<WithdrawalView> {
  const payoutId = parseId(input.payoutId, 'Withdrawal');
  const now = deps.clock();
  return withTxRetry(deps.db, async (tx) => {
    const [row] = await tx
      .select({ status: payouts.status })
      .from(payouts)
      .where(and(eq(payouts.id, payoutId), eq(payouts.userId, input.userId)))
      .for('update');
    if (row === undefined) throw notFound('Withdrawal');
    if (row.status !== 'requested' && row.status !== 'cancelled') {
      throw conflict('payout_not_cancellable', 'This withdrawal can no longer be cancelled.', {
        status: row.status,
      });
    }
    const change = await cancelWithdrawal(tx, {
      payoutId,
      userId: input.userId,
      now,
      ip: input.ip ?? null,
    });
    return withdrawalView(change.payout);
  });
}

/** Why a webhook was turned away, for the log. */
export interface WebhookRejectionLog {
  provider: string;
  reason: string;
}

/**
 * A provider webhook: verifies the signature over the raw body (the
 * provider's verifyWebhook), then applies the verified event in one
 * transaction (applyDepositEvent / applyPayoutEvent), which records it in
 * payment_events once per provider event id. Answers:
 * - 200 `{received, outcome}`, also for a redelivery (`duplicate`);
 * - 401 `webhook_signature_invalid` (missing / bad signature, stale timestamp);
 * - 400 `webhook_malformed` (signed but unreadable), `webhook_rejected`;
 * - 404 for a provider that is not enabled, and `unknown_payment_reference`
 *   (nothing recorded, so the provider's retry can match later);
 * - 503 `payment_provider_unavailable` when the provider's own status check
 *   (Chapa) could not be reached: the provider delivers it again.
 */
export async function receiveWebhook(
  deps: Pick<AppDeps, 'db' | 'clock' | 'payments'>,
  providerName: string,
  input: WebhookInput,
  onReject?: (rejection: WebhookRejectionLog, error: unknown) => void,
): Promise<PaymentWebhookAck> {
  const provider = deps.payments.get(providerName);
  if (provider === undefined) throw notFound('Payment provider');
  let event;
  try {
    event = await provider.verifyWebhook(input);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      onReject?.({ provider: provider.name, reason: error.reason }, error);
      throw error.reason === 'malformed_payload'
        ? badRequest('webhook_malformed', 'The webhook body could not be read.')
        : new AppError(401, 'webhook_signature_invalid', 'The webhook signature is not valid.');
    }
    if (error instanceof PaymentProviderError) {
      onReject?.(
        { provider: provider.name, reason: error.retryable ? 'provider_unavailable' : 'rejected' },
        error,
      );
      throw error.retryable
        ? serviceUnavailable(
            'payment_provider_unavailable',
            'The payment could not be confirmed with the provider yet. Retry later.',
          )
        : badRequest('webhook_rejected', 'The webhook could not be confirmed with the provider.');
    }
    throw error;
  }
  const now = deps.clock();
  const verified = event;
  const outcome = await withTxRetry(deps.db, async (tx): Promise<string> => {
    const applied =
      verified.kind === 'deposit'
        ? await applyDepositEvent(tx, { provider: provider.name, event: verified, now })
        : await applyPayoutEvent(tx, { provider: provider.name, event: verified, now });
    return applied.outcome;
  });
  return { received: true, outcome };
}
