import { normalizeEthiopianMsisdn, toWire, type PaymentRules } from '@vamos/core';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import {
  DomainError,
  domainBadRequest,
  domainConflict,
  domainNotFound,
  domainUnprocessable,
} from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { toJsonSafe } from '../platform/json';
import { enqueueOutbox } from '../platform/outbox';
import { assertDepositAllowed, lockUser } from '../rg/limits';
import { users } from '../schema/accounts';
import { paymentEvents, paymentIntents } from '../schema/payments';
import { DEPOSIT_FAILED, DEPOSIT_FLAGGED, DEPOSIT_SUCCEEDED } from './events';
import { depositEntries, depositLedgerKey } from './postings';
import {
  assertAmount,
  assertProviderName,
  type DepositInitiationInput,
  type PaymentIntent,
  type ProviderEventInput,
} from './types';

const MINUTE_MS = 60_000;
const MAX_REASON_LENGTH = 500;

/** Statuses of an intent that may still be paid. */
const OPEN_STATUSES = ['created', 'pending'] as const;

/**
 * How long after its expiry an expired intent that reached the provider
 * (has a provider reference) may still be paid: the deposit reconciliation
 * keeps asking the provider about it, and deposit limits keep counting it.
 * A verified success after that is still credited.
 */
export const DEPOSIT_LATE_PAYMENT_WINDOW_MS = 24 * 60 * MINUTE_MS;

export interface CreateDepositIntentInput {
  userId: string;
  /** An enabled provider (the caller checks it against its provider registry). */
  provider: string;
  /** Santim. */
  amount: bigint;
  /** The paying number; defaults to, and must be, the player's registered phone. */
  phone?: string;
  /** The client's idempotency key (already validated: 8–100 printable characters). */
  idempotencyKey: string;
  now: Date;
  /** loadGameSettings().payments */
  rules: PaymentRules;
  ip?: string | null;
}

export interface CreateDepositIntentResult {
  intent: PaymentIntent;
  /** true when the idempotency key had been used already: nothing was written. */
  replayed: boolean;
}

/** 422 `deposit_amount_out_of_range`, details `{ min, max, amount }` (santim strings). */
function amountOutOfRange(rules: PaymentRules, amount: bigint): DomainError {
  return domainUnprocessable(
    'deposit_amount_out_of_range',
    amount < rules.minDeposit
      ? 'This deposit is below the minimum deposit.'
      : 'This deposit is above the maximum deposit.',
    { min: toWire(rules.minDeposit), max: toWire(rules.maxDeposit), amount: toWire(amount) },
  );
}

async function lockIntent(tx: DbTransaction, intentId: string): Promise<PaymentIntent> {
  const [row] = await tx
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .for('update');
  if (!row) throw domainNotFound('Deposit');
  return row;
}

/**
 * Creates a deposit intent (status `created`) in the caller's transaction:
 * 1. lockUser (serialises the player's deposits, withdrawals and RG changes);
 * 2. a replayed idempotency key returns the existing intent (422
 *    `idempotency_key_reused` when amount, provider or phone differ);
 * 3. 422 `deposit_amount_out_of_range` outside [minDeposit, maxDeposit];
 * 4. 422 `deposit_phone_mismatch` when `phone` is not the registered phone;
 * 5. assertDepositAllowed (403 account disabled / exclusion, 422
 *    `deposit_limit_exceeded`), counting the player's other intents that may
 *    still be paid as if they had been (created or pending, expired with a
 *    provider reference within DEPOSIT_LATE_PAYMENT_WINDOW_MS, flagged and
 *    not credited: staff may credit it), so neither concurrent nor expired
 *    intents can slip past a limit;
 * 6. insert, expiring `depositIntentTtlMinutes` after `now`, and audit.
 * Then (outside the transaction) call provider.initiateDeposit and record
 * the answer with markDepositInitiated, or markDepositInitiationFailed. On
 * a replay of an intent still `created` without a provider reference (the
 * first provider call never got an answer), call initiateDeposit again: the
 * providers key the deposit by intent id.
 */
export async function createDepositIntent(
  tx: DbTransaction,
  input: CreateDepositIntentInput,
): Promise<CreateDepositIntentResult> {
  const { userId, amount, now, rules } = input;
  assertAmount(amount, 'deposit amount');
  assertProviderName(input.provider);

  await lockUser(tx, userId);

  const [user] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  const phone = input.phone === undefined ? user.phone : normalizeEthiopianMsisdn(input.phone);

  const [existing] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.userId, userId),
        eq(paymentIntents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.amount !== amount ||
      existing.provider !== input.provider ||
      (input.phone !== undefined && existing.phone !== phone)
    ) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different deposit.',
      );
    }
    return { intent: existing, replayed: true };
  }

  if (amount < rules.minDeposit || amount > rules.maxDeposit) throw amountOutOfRange(rules, amount);
  if (phone !== user.phone) {
    throw domainUnprocessable(
      'deposit_phone_mismatch',
      'Deposits can only be made from your registered phone number.',
    );
  }

  const [open] = await tx
    .select({ total: sql<string>`COALESCE(SUM(${paymentIntents.amount}), 0)::text` })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.userId, userId),
        or(
          inArray(paymentIntents.status, [...OPEN_STATUSES]),
          and(
            eq(paymentIntents.status, 'expired'),
            isNotNull(paymentIntents.providerRef),
            gt(paymentIntents.expiresAt, new Date(now.getTime() - DEPOSIT_LATE_PAYMENT_WINDOW_MS)),
          ),
          and(isNotNull(paymentIntents.flaggedAt), ne(paymentIntents.status, 'succeeded')),
        ),
      ),
    );
  const openTotal = BigInt(open?.total ?? '0');
  try {
    await assertDepositAllowed(tx, userId, amount + openTotal, now);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'deposit_limit_exceeded' && openTotal > 0n) {
      throw new DomainError(error.status, error.code, error.message, {
        ...(error.details as Record<string, unknown>),
        pending: toWire(openTotal),
      });
    }
    throw error;
  }

  const [intent] = await tx
    .insert(paymentIntents)
    .values({
      userId,
      provider: input.provider,
      amount,
      phone: user.phone,
      status: 'created',
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(now.getTime() + rules.depositIntentTtlMinutes * MINUTE_MS),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!intent) throw new Error('payment intent insert returned no row');
  await writeAudit(tx, {
    actorType: 'user',
    actorId: userId,
    action: 'payment.deposit_created',
    targetType: 'payment_intent',
    targetId: intent.id,
    metadata: { provider: intent.provider, amount },
    ip: input.ip ?? null,
  });
  return { intent, replayed: false };
}

/**
 * Records the provider's answer to initiateDeposit: the providerRef (so its
 * webhooks find the intent) and how the player pays. `created` becomes
 * `pending`; an intent that expired or failed meanwhile keeps its status but
 * still gets the reference, so a late success can be matched and credited.
 * Repeating the call with the same reference is a no-op; another reference
 * is a 409 `provider_ref_conflict`.
 */
export async function markDepositInitiated(
  tx: DbTransaction,
  input: { intentId: string; initiation: DepositInitiationInput; now: Date },
): Promise<PaymentIntent> {
  const intent = await lockIntent(tx, input.intentId);
  const { initiation } = input;
  if (intent.providerRef !== null) {
    if (intent.providerRef !== initiation.providerRef) {
      throw domainConflict(
        'provider_ref_conflict',
        'This deposit already has a provider reference.',
      );
    }
    return intent;
  }
  const [updated] = await tx
    .update(paymentIntents)
    .set({
      providerRef: initiation.providerRef,
      initiationKind: initiation.kind,
      redirectUrl: initiation.redirectUrl ?? null,
      instructions: initiation.instructions ?? null,
      status: intent.status === 'created' ? 'pending' : intent.status,
      updatedAt: input.now,
    })
    .where(eq(paymentIntents.id, intent.id))
    .returning();
  if (!updated) throw new Error(`payment intent ${intent.id} vanished`);
  return updated;
}

/**
 * The provider refused to start the deposit (or could not be reached and
 * the caller gives up): a `created` intent becomes `failed`. Anything else
 * is left as it is (an intent that already has a provider reference may
 * still be paid).
 */
export async function markDepositInitiationFailed(
  tx: DbTransaction,
  input: { intentId: string; reason: string; now: Date },
): Promise<PaymentIntent> {
  const intent = await lockIntent(tx, input.intentId);
  if (intent.status !== 'created' || intent.providerRef !== null) return intent;
  const [updated] = await tx
    .update(paymentIntents)
    .set({
      status: 'failed',
      failureReason: input.reason.slice(0, MAX_REASON_LENGTH),
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(paymentIntents.id, intent.id))
    .returning();
  if (!updated) throw new Error(`payment intent ${intent.id} vanished`);
  return updated;
}

/**
 * - credited: the deposit was credited to the player's cash account;
 * - failed: the provider declined it;
 * - pending: the provider reports it in progress;
 * - flagged: it could not be applied automatically (see `flagReason`) and
 *   nothing was credited;
 * - ignored: it changes nothing (e.g. a second success for a credited intent);
 * - duplicate: this provider event id was already applied (a redelivery).
 */
export type DepositEventOutcome =
  'credited' | 'failed' | 'pending' | 'flagged' | 'ignored' | 'duplicate';

export interface ApplyDepositEventResult {
  outcome: DepositEventOutcome;
  intent: PaymentIntent;
  /** outcome = 'flagged': why. */
  flagReason?: DepositFlagReason;
}

export type DepositFlagReason =
  | 'amount_mismatch'
  | 'amount_missing'
  | 'currency_mismatch'
  | 'success_after_failure'
  | 'failure_after_success';

type Decision =
  | { outcome: 'credit' }
  | { outcome: 'fail' }
  | { outcome: 'pending' }
  | { outcome: 'flag'; reason: DepositFlagReason }
  | { outcome: 'ignore' };

function decide(intent: PaymentIntent, event: ProviderEventInput): Decision {
  switch (event.status) {
    case 'pending':
      return intent.status === 'created' ? { outcome: 'pending' } : { outcome: 'ignore' };
    case 'failed':
      if (intent.status === 'succeeded')
        return { outcome: 'flag', reason: 'failure_after_success' };
      if (intent.status === 'failed' || intent.flaggedAt !== null) return { outcome: 'ignore' };
      return { outcome: 'fail' };
    case 'succeeded':
      if (intent.status === 'succeeded' || intent.flaggedAt !== null) return { outcome: 'ignore' };
      if (intent.status === 'failed') return { outcome: 'flag', reason: 'success_after_failure' };
      if (event.currency !== null && event.currency.toUpperCase() !== intent.currency) {
        return { outcome: 'flag', reason: 'currency_mismatch' };
      }
      if (event.amount === null) return { outcome: 'flag', reason: 'amount_missing' };
      if (event.amount !== intent.amount) return { outcome: 'flag', reason: 'amount_mismatch' };
      // created, pending or expired (our own timeout; the money did move).
      return { outcome: 'credit' };
  }
}

const OUTCOME_LABEL: Record<Decision['outcome'], DepositEventOutcome> = {
  credit: 'credited',
  fail: 'failed',
  pending: 'pending',
  flag: 'flagged',
  ignore: 'ignored',
};

/**
 * Applies a verified deposit notification (provider.verifyWebhook, or a
 * queryDeposit result with a stable event id) in the caller's transaction.
 * The intent is found by (provider, providerRef) and locked; an unknown
 * reference is a 404 `unknown_payment_reference` that records nothing, so
 * the provider's retry can match once markDepositInitiated has committed.
 * The event is recorded in payment_events once per (provider,
 * providerEventId); a redelivery returns `duplicate` and changes nothing.
 *
 * A success credits the intent's amount exactly once (ledger key
 * `deposit:<intentId>`): house_psp_clearing:<provider> -amount, player_cash
 * +amount, with the `payment.deposit_succeeded` outbox event, in the same
 * transaction. A reported amount or currency that differs from the intent,
 * a missing amount, a success after a failure or a failure after a success
 * flags the intent (`payment.deposit_flagged`) and credits nothing.
 * Responsible-gambling checks are not repeated here: they ran when the
 * intent was created, and money that has left the player's wallet is always
 * credited.
 */
export async function applyDepositEvent(
  tx: DbTransaction,
  input: { provider: string; event: ProviderEventInput; now: Date },
): Promise<ApplyDepositEventResult> {
  const { provider, event, now } = input;
  assertProviderName(provider);
  if (event.kind !== undefined && event.kind !== 'deposit') {
    throw new RangeError('applyDepositEvent: not a deposit event');
  }

  const [found] = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(eq(paymentIntents.provider, provider), eq(paymentIntents.providerRef, event.providerRef)),
    )
    .limit(1);
  if (!found) {
    throw new DomainError(
      404,
      'unknown_payment_reference',
      `No ${provider} deposit has this reference (yet).`,
    );
  }
  const intent = await lockIntent(tx, found.id);
  const decision = decide(intent, event);

  const [recorded] = await tx
    .insert(paymentEvents)
    .values({
      provider,
      providerEventId: event.providerEventId,
      kind: 'deposit',
      providerRef: event.providerRef,
      status: event.status,
      amount: event.amount,
      currency: event.currency,
      intentId: intent.id,
      outcome:
        decision.outcome === 'flag'
          ? `flagged:${decision.reason}`
          : OUTCOME_LABEL[decision.outcome],
      payload: toJsonSafe(event.raw ?? null) ?? null,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.providerEventId] })
    .returning({ id: paymentEvents.id });
  if (!recorded) return { outcome: 'duplicate', intent };

  switch (decision.outcome) {
    case 'ignore':
      return { outcome: 'ignored', intent };
    case 'pending': {
      const updated = await updateIntent(tx, intent.id, { status: 'pending', updatedAt: now });
      return { outcome: 'pending', intent: updated };
    }
    case 'fail': {
      const updated = await updateIntent(tx, intent.id, {
        status: 'failed',
        failureReason: 'declined_by_provider',
        completedAt: now,
        updatedAt: now,
      });
      await enqueueOutbox(tx, {
        type: DEPOSIT_FAILED,
        aggregateType: 'payment_intent',
        aggregateId: intent.id,
        payload: {
          intentId: intent.id,
          userId: intent.userId,
          provider,
          amount: intent.amount,
          reason: 'declined_by_provider',
        },
      });
      return { outcome: 'failed', intent: updated };
    }
    case 'flag': {
      const updated = await updateIntent(tx, intent.id, {
        flagReason: decision.reason,
        flaggedAt: now,
        updatedAt: now,
      });
      await enqueueOutbox(tx, {
        type: DEPOSIT_FLAGGED,
        aggregateType: 'payment_intent',
        aggregateId: intent.id,
        payload: {
          intentId: intent.id,
          userId: intent.userId,
          provider,
          reason: decision.reason,
          amount: intent.amount,
          reportedAmount: event.amount,
          reportedCurrency: event.currency,
          providerEventId: event.providerEventId,
        },
      });
      await writeAudit(tx, {
        actorType: 'system',
        action: DEPOSIT_FLAGGED,
        targetType: 'payment_intent',
        targetId: intent.id,
        metadata: { reason: decision.reason, amount: intent.amount, reportedAmount: event.amount },
      });
      return { outcome: 'flagged', intent: updated, flagReason: decision.reason };
    }
    case 'credit': {
      // Serialises the credit with the player's withdrawal checks (wagering, balance).
      await lockUser(tx, intent.userId);
      const posting = await postTransaction(tx, {
        type: 'deposit',
        idempotencyKey: depositLedgerKey(intent.id),
        refType: 'payment_intent',
        refId: intent.id,
        description: `Deposit via ${provider}`,
        entries: depositEntries(provider, intent.userId, intent.amount),
      });
      const updated = await updateIntent(tx, intent.id, {
        status: 'succeeded',
        ledgerTransactionId: posting.transactionId,
        completedAt: now,
        updatedAt: now,
      });
      await enqueueOutbox(tx, {
        type: DEPOSIT_SUCCEEDED,
        aggregateType: 'payment_intent',
        aggregateId: intent.id,
        payload: {
          intentId: intent.id,
          userId: intent.userId,
          provider,
          amount: intent.amount,
          providerRef: event.providerRef,
        },
      });
      await writeAudit(tx, {
        actorType: 'system',
        action: DEPOSIT_SUCCEEDED,
        targetType: 'payment_intent',
        targetId: intent.id,
        metadata: { provider, amount: intent.amount, providerEventId: event.providerEventId },
      });
      return { outcome: 'credited', intent: updated };
    }
  }
}

async function updateIntent(
  tx: DbTransaction,
  intentId: string,
  values: Partial<typeof paymentIntents.$inferInsert>,
): Promise<PaymentIntent> {
  const [updated] = await tx
    .update(paymentIntents)
    .set(values)
    .where(eq(paymentIntents.id, intentId))
    .returning();
  if (!updated) throw new Error(`payment intent ${intentId} vanished`);
  return updated;
}

export interface ExpiredIntent {
  id: string;
  userId: string;
  provider: string;
  providerRef: string | null;
}

/**
 * Expires up to `limit` open (created / pending), unflagged intents whose
 * expires_at is at or before `now`, skipping rows another transaction holds
 * (FOR UPDATE SKIP LOCKED), and returns them. Expiry is our own timeout: a
 * verified success that arrives later still credits the intent.
 */
export async function expireStaleDepositIntents(
  tx: DbTransaction,
  options: { now: Date; limit?: number },
): Promise<ExpiredIntent[]> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('expireStaleDepositIntents: limit must be a positive integer');
  }
  const due = await tx
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.status, [...OPEN_STATUSES]),
        isNull(paymentIntents.flaggedAt),
        lte(paymentIntents.expiresAt, options.now),
      ),
    )
    .orderBy(asc(paymentIntents.expiresAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return [];
  return tx
    .update(paymentIntents)
    .set({
      status: 'expired',
      failureReason: 'expired',
      completedAt: options.now,
      updatedAt: options.now,
    })
    .where(
      inArray(
        paymentIntents.id,
        due.map((row) => row.id),
      ),
    )
    .returning({
      id: paymentIntents.id,
      userId: paymentIntents.userId,
      provider: paymentIntents.provider,
      providerRef: paymentIntents.providerRef,
    });
}

/** One deposit intent of the player, or null (also for another player's intent). */
export async function getUserDepositIntent(
  exec: DbExecutor,
  userId: string,
  intentId: string,
): Promise<PaymentIntent | null> {
  const [row] = await exec
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Pending intents of a provider for a phone that have not expired, oldest
 * first: what the dev phone simulator shows for the mock provider.
 */
export async function listOpenDepositIntentsForPhone(
  exec: DbExecutor,
  options: { provider: string; phone: string; now: Date; limit?: number },
): Promise<PaymentIntent[]> {
  const phone = normalizeEthiopianMsisdn(options.phone);
  if (phone === null) throw domainBadRequest('invalid_phone', 'Enter an Ethiopian mobile number.');
  return exec
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.provider, options.provider),
        eq(paymentIntents.phone, phone),
        eq(paymentIntents.status, 'pending'),
        isNull(paymentIntents.flaggedAt),
        gt(paymentIntents.expiresAt, options.now),
      ),
    )
    .orderBy(asc(paymentIntents.createdAt))
    .limit(options.limit ?? 20);
}

export type DepositResolution = 'credit' | 'close';

/**
 * Staff resolve a flagged deposit intent (after checking the provider's
 * records), clearing the flag:
 * - `credit`: the provider did collect the intent's amount; it is credited
 *   now exactly as applyDepositEvent would (ledger key `deposit:<intentId>`,
 *   `payment.deposit_succeeded`). 409 `deposit_already_credited` for an
 *   intent that succeeded (close its flag instead). An amount other than
 *   the intent's is not credited here: close the intent and correct the
 *   balance with a separate adjustment.
 * - `close`: nothing is credited; an intent that was still open (or
 *   expired) becomes `failed` (`payment.deposit_failed`), a failed or
 *   succeeded one keeps its status (e.g. a refund at the provider after a
 *   credit, handled outside this function).
 * 409 `deposit_not_flagged` for an intent that is not flagged.
 */
export async function resolveFlaggedDeposit(
  tx: DbTransaction,
  input: {
    intentId: string;
    adminId: string;
    resolution: DepositResolution;
    note: string;
    now: Date;
    ip?: string | null;
  },
): Promise<PaymentIntent> {
  const { now } = input;
  const note = input.note.trim().slice(0, MAX_REASON_LENGTH);
  if (note.length === 0) throw new RangeError('resolveFlaggedDeposit: a note is required');
  const intent = await lockIntent(tx, input.intentId);
  if (intent.flaggedAt === null) {
    throw domainConflict('deposit_not_flagged', 'This deposit is not waiting for staff.');
  }
  const audit = {
    actorType: 'admin' as const,
    actorId: input.adminId,
    targetType: 'payment_intent',
    targetId: intent.id,
    ip: input.ip ?? null,
  };
  const metadata = {
    resolution: input.resolution,
    flagReason: intent.flagReason,
    status: intent.status,
    amount: intent.amount,
    note,
  };

  if (input.resolution === 'credit') {
    if (intent.status === 'succeeded') {
      throw domainConflict(
        'deposit_already_credited',
        'This deposit was already credited; close its flag instead.',
      );
    }
    await lockUser(tx, intent.userId);
    const posting = await postTransaction(tx, {
      type: 'deposit',
      idempotencyKey: depositLedgerKey(intent.id),
      refType: 'payment_intent',
      refId: intent.id,
      description: `Deposit via ${intent.provider} (confirmed by staff)`,
      actor: { type: 'admin', id: input.adminId },
      entries: depositEntries(intent.provider, intent.userId, intent.amount),
    });
    const updated = await updateIntent(tx, intent.id, {
      status: 'succeeded',
      ledgerTransactionId: posting.transactionId,
      failureReason: null,
      flagReason: null,
      flaggedAt: null,
      completedAt: now,
      updatedAt: now,
    });
    await enqueueOutbox(tx, {
      type: DEPOSIT_SUCCEEDED,
      aggregateType: 'payment_intent',
      aggregateId: intent.id,
      payload: {
        intentId: intent.id,
        userId: intent.userId,
        provider: intent.provider,
        amount: intent.amount,
        providerRef: intent.providerRef,
      },
    });
    await writeAudit(tx, { ...audit, action: 'payment.deposit_resolved', metadata });
    return updated;
  }

  const stillOpen = intent.status !== 'succeeded' && intent.status !== 'failed';
  const updated = await updateIntent(tx, intent.id, {
    flagReason: null,
    flaggedAt: null,
    ...(stillOpen
      ? { status: 'failed' as const, failureReason: 'closed_by_staff', completedAt: now }
      : {}),
    updatedAt: now,
  });
  if (stillOpen) {
    await enqueueOutbox(tx, {
      type: DEPOSIT_FAILED,
      aggregateType: 'payment_intent',
      aggregateId: intent.id,
      payload: {
        intentId: intent.id,
        userId: intent.userId,
        provider: intent.provider,
        amount: intent.amount,
        reason: 'closed_by_staff',
      },
    });
  }
  await writeAudit(tx, { ...audit, action: 'payment.deposit_resolved', metadata });
  return updated;
}

/** One deposit intent by id (back office), or null. */
export async function getDepositIntent(
  exec: DbExecutor,
  intentId: string,
): Promise<PaymentIntent | null> {
  const [row] = await exec
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .limit(1);
  return row ?? null;
}

/** The player's deposit intents, newest first (at most 100). */
export async function listUserDepositIntents(
  exec: DbExecutor,
  userId: string,
  options: { limit?: number } = {},
): Promise<PaymentIntent[]> {
  return exec
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.userId, userId))
    .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 100));
}

/** Flagged deposit intents, oldest flag first (the back office's queue). */
export async function listFlaggedDepositIntents(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<PaymentIntent[]> {
  return exec
    .select()
    .from(paymentIntents)
    .where(isNotNull(paymentIntents.flaggedAt))
    .orderBy(asc(paymentIntents.flaggedAt), asc(paymentIntents.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
}

/**
 * Unflagged intents with a provider reference that a status poller should
 * ask the provider about now (provider.queryDeposit + eventFromStatusQuery +
 * applyDepositEvent): pending ones, and expired ones within
 * `lateWindowMs` (default DEPOSIT_LATE_PAYMENT_WINDOW_MS) after their expiry
 * (a late payment is still credited), created before `createdBefore` and
 * whose next poll (scheduleDepositPoll) is due, longest waiting first.
 * Read-only; applyDepositEvent locks.
 */
export async function listPendingDepositIntents(
  exec: DbExecutor,
  options: {
    now: Date;
    createdBefore: Date;
    provider?: string;
    limit?: number;
    lateWindowMs?: number;
  },
): Promise<PaymentIntent[]> {
  const lateSince = new Date(
    options.now.getTime() - (options.lateWindowMs ?? DEPOSIT_LATE_PAYMENT_WINDOW_MS),
  );
  return exec
    .select()
    .from(paymentIntents)
    .where(
      and(
        or(
          eq(paymentIntents.status, 'pending'),
          and(eq(paymentIntents.status, 'expired'), gt(paymentIntents.expiresAt, lateSince)),
        ),
        isNull(paymentIntents.flaggedAt),
        isNotNull(paymentIntents.providerRef),
        lt(paymentIntents.createdAt, options.createdBefore),
        or(isNull(paymentIntents.nextPollAt), lte(paymentIntents.nextPollAt, options.now)),
        options.provider === undefined ? undefined : eq(paymentIntents.provider, options.provider),
      ),
    )
    .orderBy(
      asc(sql`COALESCE(${paymentIntents.nextPollAt}, ${paymentIntents.createdAt})`),
      asc(paymentIntents.id),
    )
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
}

/**
 * Sets when the deposit reconciliation asks about an intent next (after an
 * answer that settled nothing, or a failed query), so polls back off and
 * every intent gets its turn.
 */
export async function scheduleDepositPoll(
  exec: DbExecutor,
  input: { intentId: string; at: Date },
): Promise<void> {
  await exec
    .update(paymentIntents)
    .set({ nextPollAt: input.at })
    .where(eq(paymentIntents.id, input.intentId));
}
