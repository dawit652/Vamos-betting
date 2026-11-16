import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  MAX_SANTIM_OFFSET,
  allocateSmsAmount,
  countFreeSmsAmounts,
  latestClaimForSms,
  matchSmsDeposit,
  parseSms,
  pastedSmsReference,
  proposePayoutForSms,
  smsPaidBy,
  takenAmounts,
  toWire,
  type OpenSmsDeposit,
  type ParsedSms,
  type PaymentRules,
} from '@vamos/core';
import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { lockUser } from '../rg/limits';
import { users } from '../schema/accounts';
import { paymentEvents, paymentIntents, payouts } from '../schema/payments';
import { receivedSms } from '../schema/smsrail';
import {
  applyDepositEvent,
  createDepositIntent,
  markDepositInitiated,
  resolveFlaggedDeposit,
} from './deposits';
import { DEPOSIT_SUCCEEDED } from './events';
import { depositEntries, depositLedgerKey } from './postings';
import { assertAmount, comparableDestination, type PaymentIntent } from './types';

/**
 * The SMS deposit rail (ported from Melabingo): players transfer an exact
 * amount to one of our collection accounts, the collection handset forwards
 * the confirmation SMS, and the SMS is matched to the deposit by that
 * amount and credited through applyDepositEvent (same ledger posting,
 * outbox events and audit as every provider).
 *
 * Trust boundary: only a message the gateway (or the simulator, demo only)
 * delivered, or a receipt the institution itself served, can credit. What a
 * player pastes is only ever a lookup key.
 */

/** The provider name of the SMS rail (payment intents, payouts, the PSP clearing account). */
export const SMS_PROVIDER = 'sms';

/**
 * How long after its expiry an SMS deposit keeps its exact amount reserved
 * and can still be matched: a late transfer of 100.37 still finds the
 * deposit that was told to send it, and no newer deposit can be handed
 * 100.37 meanwhile (that would credit the late payer's money to someone else).
 */
export const SMS_AMOUNT_QUARANTINE_MS = 2 * 60 * 60_000;

const MAX_NOTE_LENGTH = 500;
const MAX_RAW_LENGTH = 4000;

export type ReceivedSms = typeof receivedSms.$inferSelect;
export type ReceivedSmsStatus = (typeof receivedSms.$inferSelect)['status'];

export type SmsSource = 'gateway' | 'simulator' | 'receipt';

function textHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** A CSPRNG offset in 1..MAX_SANTIM_OFFSET. */
function secureOffset(): number {
  return randomInt(1, MAX_SANTIM_OFFSET + 1);
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export interface CreateSmsDepositInput {
  userId: string;
  /** Santim: what the player asked to deposit. */
  amount: bigint;
  idempotencyKey: string;
  now: Date;
  rules: PaymentRules;
  ip?: string | null;
  /** Tests inject a fixed offset; production uses a CSPRNG. */
  randomOffset?: () => number;
  /**
   * The ids of the live collection accounts (SMS_COLLECTION_ACCOUNTS). The deposit is given the
   * one with the most free amounts for this request, and records it; each account has its own
   * space of exact amounts. Omitted or empty: no account is recorded (one space, as before).
   */
  collectionAccounts?: readonly string[];
}

/**
 * Opens an SMS deposit in the caller's transaction and returns it `pending`
 * with `amount` set to the exact amount the player must send (the requested
 * amount plus 1–99 santim, never a whole birr, unique among open SMS deposits and those expired
 * within SMS_AMOUNT_QUARANTINE_MS).
 *
 * 1. one advisory lock serialises every SMS amount allocation: ranges of
 *    different bases overlap (100.00 and 100.25 both reach 100.30), so a
 *    lock per base would let two of them pick the same amount (the partial
 *    unique index is the backstop); the lock is held only for this short
 *    transaction;
 * 2. a replayed idempotency key returns the existing deposit (422
 *    `idempotency_key_reused` for another amount or provider);
 * 3. 409 `sms_amount_unavailable` when all 99 offsets are taken (the player
 *    picks a slightly different amount); never a colliding amount;
 * 4. createDepositIntent (range against the requested amount, responsible
 *    gambling limits against the exact amount, audit), then
 *    markDepositInitiated (`transfer`, provider reference = the intent id).
 */
export async function createSmsDepositIntent(
  tx: DbTransaction,
  input: CreateSmsDepositInput,
): Promise<{ intent: PaymentIntent; replayed: boolean }> {
  const { userId, amount, now } = input;
  assertAmount(amount, 'deposit amount');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('vamos:sms_amount', 0))`);

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
    if (existing.provider !== SMS_PROVIDER || existing.requestedAmount !== amount) {
      throw domainUnprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different deposit.',
      );
    }
    return { intent: existing, replayed: true };
  }

  const reservedSince = new Date(now.getTime() - SMS_AMOUNT_QUARANTINE_MS);
  const takenRows = await tx
    .select({
      amount: paymentIntents.amount,
      collectionAccountId: paymentIntents.collectionAccount,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.provider, SMS_PROVIDER),
        between(paymentIntents.amount, amount + 1n, amount + BigInt(MAX_SANTIM_OFFSET)),
        or(
          inArray(paymentIntents.status, ['created', 'pending']),
          and(eq(paymentIntents.status, 'expired'), gt(paymentIntents.expiresAt, reservedSince)),
          and(isNotNull(paymentIntents.flaggedAt), ne(paymentIntents.status, 'succeeded')),
        ),
      ),
    );
  // The account with the most free amounts for this request (the first of a tie); without
  // accounts, one space for everything.
  const accounts = input.collectionAccounts ?? [];
  let collectionAccount: string | null = null;
  let taken = takenAmounts(takenRows, null);
  if (accounts.length > 0) {
    let bestFree = -1;
    for (const account of accounts) {
      const candidate = takenAmounts(takenRows, account);
      const free = countFreeSmsAmounts(amount, candidate);
      if (free > bestFree) {
        bestFree = free;
        collectionAccount = account;
        taken = candidate;
      }
    }
  }
  const exact = allocateSmsAmount(amount, taken, input.randomOffset ?? secureOffset);
  if (exact === null) {
    throw domainConflict(
      'sms_amount_unavailable',
      'Many deposits of this amount are open right now. Please choose a slightly different amount.',
    );
  }

  const created = await createDepositIntent(tx, {
    userId,
    provider: SMS_PROVIDER,
    amount: exact,
    requestedAmount: amount,
    idempotencyKey: input.idempotencyKey,
    now,
    rules: input.rules,
    ip: input.ip ?? null,
  });
  if (collectionAccount !== null) {
    await tx
      .update(paymentIntents)
      .set({ collectionAccount })
      .where(eq(paymentIntents.id, created.intent.id));
  }
  const intent = await markDepositInitiated(tx, {
    intentId: created.intent.id,
    initiation: { kind: 'transfer', providerRef: created.intent.id },
    now,
  });
  return { intent, replayed: false };
}

/**
 * The SMS deposits a received SMS may pay (open, or expired within the
 * quarantine; never flagged or credited), with the player's phone. `userId`
 * restricts them to one player (the paste and receipt paths), and
 * `createdBefore` to deposits that existed when the money moved.
 */
async function openSmsDeposits(
  exec: DbExecutor,
  options: { now: Date; userId?: string; createdBefore?: Date; amount?: bigint },
): Promise<OpenSmsDeposit[]> {
  const reservedSince = new Date(options.now.getTime() - SMS_AMOUNT_QUARANTINE_MS);
  const rows = await exec
    .select({
      intentId: paymentIntents.id,
      userId: paymentIntents.userId,
      amount: paymentIntents.amount,
      collectionAccountId: paymentIntents.collectionAccount,
      phone: users.phone,
      expiresAt: paymentIntents.expiresAt,
    })
    .from(paymentIntents)
    .innerJoin(users, eq(users.id, paymentIntents.userId))
    .where(
      and(
        eq(paymentIntents.provider, SMS_PROVIDER),
        isNull(paymentIntents.flaggedAt),
        or(
          inArray(paymentIntents.status, ['created', 'pending']),
          and(eq(paymentIntents.status, 'expired'), gt(paymentIntents.expiresAt, reservedSince)),
        ),
        options.userId === undefined ? undefined : eq(paymentIntents.userId, options.userId),
        options.createdBefore === undefined
          ? undefined
          : lte(paymentIntents.createdAt, options.createdBefore),
      ),
    )
    .orderBy(asc(paymentIntents.createdAt))
    .limit(5000);
  // A deposit accepts a match until its amount is released.
  return rows.map((row) => ({
    ...row,
    expiresAt: new Date(row.expiresAt.getTime() + SMS_AMOUNT_QUARANTINE_MS),
  }));
}

function parsedOf(row: ReceivedSms): ParsedSms | null {
  if (row.reference === null || row.amount === null || row.direction === null) return null;
  return {
    institution: row.institution ?? 'unknown',
    direction: row.direction === 'debit' ? 'debit' : 'credit',
    amount: row.amount,
    reference: row.reference,
    counterpartyName: row.counterpartyName,
    counterpartyPhone: row.counterpartyPhone,
    balance: row.balance,
    occurredAt: row.occurredAt,
  };
}

async function updateSms(
  tx: DbTransaction,
  smsId: string,
  values: Partial<typeof receivedSms.$inferInsert>,
): Promise<ReceivedSms> {
  const [row] = await tx
    .update(receivedSms)
    .set(values)
    .where(eq(receivedSms.id, smsId))
    .returning();
  if (!row) throw new Error(`received_sms ${smsId} vanished`);
  return row;
}

async function lockSms(tx: DbTransaction, smsId: string): Promise<ReceivedSms> {
  const [row] = await tx.select().from(receivedSms).where(eq(receivedSms.id, smsId)).for('update');
  if (!row) throw domainNotFound('SMS');
  return row;
}

/**
 * - credited: it credited a deposit (`intentId`);
 * - flagged: it matched a deposit that was flagged instead (another amount,
 *   a third-party payer): staff decide;
 * - unmatched / ambiguous: it waits in the review queue;
 * - proposed: an outgoing transfer proposed as the payment of a manual payout;
 * - ignored_debit: an outgoing transfer that proposes nothing;
 * - unparsed: no parser could read it (review queue);
 * - duplicate: this message (or reference) was received before: nothing changed.
 */
export type SmsOutcome =
  | 'credited'
  | 'flagged'
  | 'unmatched'
  | 'ambiguous'
  | 'proposed'
  | 'ignored_debit'
  | 'unparsed'
  | 'duplicate';

export interface SmsResult {
  sms: ReceivedSms;
  outcome: SmsOutcome;
  /** credited / flagged: the deposit. */
  intent?: PaymentIntent;
}

/**
 * Matches a parsed, unresolved credit row against `open` and applies the
 * result in the caller's transaction (applyDepositEvent with event id
 * `sms:<row id>`, so one SMS can credit at most once).
 */
async function applyCredit(
  tx: DbTransaction,
  row: ReceivedSms,
  sms: ParsedSms,
  open: readonly OpenSmsDeposit[],
  now: Date,
): Promise<SmsResult> {
  // Only deposits of the account the message arrived on (or deposits without one) can match.
  const match = matchSmsDeposit({ ...sms, collectionAccountId: row.collectionAccount }, open, now);
  if (match.type === 'ambiguous') {
    const updated = await updateSms(tx, row.id, {
      status: 'ambiguous',
      statusReason: `fits ${match.intentIds.length} deposits`,
      updatedAt: now,
    });
    return { sms: updated, outcome: 'ambiguous' };
  }
  if (match.type === 'unmatched') {
    const updated = await updateSms(tx, row.id, {
      status: 'unmatched',
      statusReason: match.reason,
      updatedAt: now,
    });
    return { sms: updated, outcome: 'unmatched' };
  }

  const deposit = open.find((candidate) => candidate.intentId === match.intentId);
  const thirdParty =
    sms.counterpartyPhone !== null &&
    deposit !== undefined &&
    deposit.phone !== sms.counterpartyPhone;
  const applied = await applyDepositEvent(tx, {
    provider: SMS_PROVIDER,
    event: {
      providerEventId: `sms:${row.id}`,
      kind: 'deposit',
      providerRef: match.intentId,
      status: 'succeeded',
      amount: match.received,
      currency: 'ETB',
      raw: { smsId: row.id, reference: sms.reference, confidence: match.confidence },
    },
    now,
    ...(thirdParty ? { flagInsteadOfCredit: 'third_party_payer' as const } : {}),
  });
  switch (applied.outcome) {
    case 'credited': {
      const updated = await updateSms(tx, row.id, {
        status: 'matched',
        statusReason: match.confidence,
        matchedIntentId: applied.intent.id,
        matchedUserId: applied.intent.userId,
        updatedAt: now,
      });
      return { sms: updated, outcome: 'credited', intent: applied.intent };
    }
    case 'flagged': {
      const updated = await updateSms(tx, row.id, {
        status: 'flagged',
        statusReason: applied.flagReason ?? 'flagged',
        flaggedIntentId: applied.intent.id,
        matchedUserId: applied.intent.userId,
        updatedAt: now,
      });
      return { sms: updated, outcome: 'flagged', intent: applied.intent };
    }
    default: {
      // The deposit was credited or flagged by another message meanwhile:
      // this money still arrived, so a person must place it.
      const updated = await updateSms(tx, row.id, {
        status: 'unmatched',
        statusReason: 'deposit_already_settled',
        updatedAt: now,
      });
      return { sms: updated, outcome: 'unmatched' };
    }
  }
}

/**
 * Proposes the manual payout an outgoing (debit) SMS appears to have paid:
 * claimed (`processing`) manual payouts not yet proposed by another message,
 * claimed no later than the money moved (core latestClaimForSms). An
 * approved payout nobody claimed has not been sent, and a transfer older
 * than the claim did not pay it: such a debit stays `ignored_debit`.
 */
async function applyDebit(
  tx: DbTransaction,
  row: ReceivedSms,
  sms: ParsedSms,
  now: Date,
): Promise<SmsResult> {
  const claimedBy = latestClaimForSms({
    occurredAt: row.occurredAt,
    deviceReceivedAt: row.deviceReceivedAt,
    receivedAt: row.receivedAt,
  });
  const candidates = await tx
    .select({
      payoutId: payouts.id,
      amount: payouts.amount,
      destinationInstitution: payouts.destinationInstitution,
      destinationAccount: payouts.destinationAccount,
    })
    .from(payouts)
    .leftJoin(receivedSms, eq(receivedSms.proposedPayoutId, payouts.id))
    .where(
      and(
        eq(payouts.manual, true),
        eq(payouts.status, 'processing'),
        lte(payouts.processingAt, claimedBy),
        eq(payouts.amount, sms.amount),
        isNull(receivedSms.id),
      ),
    )
    .limit(200);
  const proposal = proposePayoutForSms(
    sms,
    candidates.map((c) => ({
      payoutId: c.payoutId,
      amount: c.amount,
      // Wallets in E.164, as a parsed SMS names them.
      destinationAccount: comparableDestination(c.destinationInstitution, c.destinationAccount),
    })),
  );
  if (proposal.type !== 'proposed') {
    const updated = await updateSms(tx, row.id, {
      status: 'ignored_debit',
      statusReason: proposal.type === 'ambiguous' ? 'ambiguous' : proposal.reason,
      updatedAt: now,
    });
    return { sms: updated, outcome: 'ignored_debit' };
  }
  const updated = await updateSms(tx, row.id, {
    status: 'settlement_proposed',
    statusReason: proposal.confidence,
    proposedPayoutId: proposal.payoutId,
    updatedAt: now,
  });
  return { sms: updated, outcome: 'proposed' };
}

export interface IngestSmsInput {
  source: Exclude<SmsSource, 'receipt'>;
  /** The SMS sender address as forwarded ("telebirr", "CBE"); a parsing hint and audit field. */
  sender: string | null;
  text: string;
  /** When the handset says it received the message. */
  deviceReceivedAt?: Date | null;
  /** The collection account (SMS_COLLECTION_ACCOUNTS id) the handset that forwarded it belongs to. */
  collectionAccount?: string | null;
  now: Date;
}

/**
 * Records a forwarded SMS and acts on it, in the caller's transaction:
 * duplicates (the same sender and text, or the same reference) change
 * nothing; an unparsed message waits for staff; a credit is matched against
 * every open SMS deposit created before the money moved (core smsPaidBy)
 * and credited (or flagged, or left for review); a
 * debit proposes the manual payout it paid. Only credits can credit.
 */
export async function ingestSms(tx: DbTransaction, input: IngestSmsInput): Promise<SmsResult> {
  const { now } = input;
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_RAW_LENGTH) {
    throw new RangeError('ingestSms: text must be 1–4000 characters');
  }
  const sender = input.sender?.trim().slice(0, 64) || null;
  const sms = parseSms(text, sender);
  const [inserted] = await tx
    .insert(receivedSms)
    .values({
      source: input.source,
      sender,
      rawText: text,
      textHash: textHash([sender ?? '', text]),
      collectionAccount: input.collectionAccount ?? null,
      institution: sms?.institution ?? null,
      direction: sms?.direction ?? null,
      amount: sms?.amount ?? null,
      reference: sms?.reference ?? null,
      counterpartyName: sms?.counterpartyName ?? null,
      counterpartyPhone: sms?.counterpartyPhone ?? null,
      balance: sms?.balance ?? null,
      occurredAt: sms?.occurredAt ?? null,
      receivedAt: now,
      deviceReceivedAt: input.deviceReceivedAt ?? null,
      status: sms ? 'unmatched' : 'unparsed',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(receivedSms)
      .where(
        or(
          eq(receivedSms.textHash, textHash([sender ?? '', text])),
          sms ? eq(receivedSms.reference, sms.reference) : undefined,
        ),
      )
      .limit(1);
    if (!existing) throw new Error('ingestSms: conflicting row not found');
    return { sms: existing, outcome: 'duplicate' };
  }
  if (!sms) return { sms: inserted, outcome: 'unparsed' };
  if (sms.direction === 'debit') return applyDebit(tx, inserted, sms, now);
  // Only deposits that existed when the money moved: a backlog forwarded after an outage must not
  // pay a newer deposit that was handed the same amount once the first one released it.
  const createdBefore = smsPaidBy({
    occurredAt: sms.occurredAt,
    deviceReceivedAt: input.deviceReceivedAt ?? null,
    now,
  });
  return applyCredit(tx, inserted, sms, await openSmsDeposits(tx, { now, createdBefore }), now);
}

/**
 * - credited: this check credited the player's deposit;
 * - already_credited: the SMS already credited this player;
 * - in_review: the SMS exists but does not fit one of the player's open
 *   deposits (staff will look at it), or it is the player's but flagged;
 * - not_found: no message or receipt we hold has this reference (or it is
 *   someone else's): the caller may ask the institution (receipt path).
 */
export type SmsCheckStatus = 'credited' | 'already_credited' | 'in_review' | 'not_found';

export interface SmsCheckResult {
  status: SmsCheckStatus;
  reference: string | null;
  intent?: PaymentIntent;
  sms?: ReceivedSms;
}

/** Re-matches a held credit row against one player's own open deposits. */
async function rematchForPlayer(
  tx: DbTransaction,
  row: ReceivedSms,
  userId: string,
  createdBefore: Date,
  now: Date,
): Promise<SmsCheckResult> {
  const sms = parsedOf(row);
  if (sms === null || sms.direction !== 'credit')
    return { status: 'not_found', reference: row.reference };
  const open = await openSmsDeposits(tx, { now, userId, createdBefore });
  const result = await applyCredit(tx, row, sms, open, now);
  if (result.outcome === 'credited') {
    return {
      status: 'credited',
      reference: row.reference,
      sms: result.sms,
      ...(result.intent ? { intent: result.intent } : {}),
    };
  }
  return { status: 'in_review', reference: row.reference, sms: result.sms };
}

/**
 * "I paid but my balance has not moved": the player pastes the SMS or the
 * transaction number. The paste is only a lookup key: the stored message
 * (delivered by the gateway, or a receipt the institution served) is
 * re-matched against this player's own open deposits that existed when it
 * arrived, so pasting someone else's reference credits nothing (the
 * reserved amounts are unique, so another player's payment never fits).
 */
export async function checkSmsDepositForPlayer(
  tx: DbTransaction,
  input: { userId: string; text: string; now: Date },
): Promise<SmsCheckResult> {
  const reference = pastedSmsReference(input.text);
  if (reference === null) return { status: 'not_found', reference: null };
  const [found] = await tx
    .select({ id: receivedSms.id })
    .from(receivedSms)
    .where(eq(receivedSms.reference, reference))
    .limit(1);
  if (!found) return { status: 'not_found', reference };
  const row = await lockSms(tx, found.id);
  if (row.direction !== 'credit') return { status: 'not_found', reference };
  if (row.status === 'matched' || row.status === 'credited_by_staff') {
    return {
      status: row.matchedUserId === input.userId ? 'already_credited' : 'not_found',
      reference,
    };
  }
  if (row.status === 'flagged') {
    return { status: row.matchedUserId === input.userId ? 'in_review' : 'not_found', reference };
  }
  if ((row.status === 'unmatched' || row.status === 'ambiguous') && row.resolvedAt === null) {
    return rematchForPlayer(tx, row, input.userId, row.receivedAt, input.now);
  }
  return { status: 'in_review', reference };
}

/** A payment the institution's own receipt page confirmed (receipt verifier, telebirr). */
export interface VerifiedReceiptPayment {
  institution: string;
  reference: string;
  /** Santim, as the receipt states it. */
  amount: bigint;
  payerName: string | null;
  payerPhone: string | null;
  /** The receiving account as printed (one of our collection accounts: the verifier checked). */
  receiver: string;
  /** When the institution says it was paid. */
  paidAt: Date | null;
  /** The first 4 KB the institution served. */
  raw: string;
}

/**
 * The receipt path of the player's check: a reference no gateway message
 * carries (the handset was offline) that the institution's receipt page
 * confirmed as a completed payment to one of our accounts. Recorded as a
 * `receipt` row (unique reference: it can be used once) and matched against
 * the player's own deposits that existed before it was paid (a receipt
 * without a payment time waits for staff).
 */
export async function recordReceiptPaymentForPlayer(
  tx: DbTransaction,
  input: {
    userId: string;
    receipt: VerifiedReceiptPayment;
    /** The collection account the receipt's receiver is (SMS_COLLECTION_ACCOUNTS id), when known. */
    collectionAccount?: string | null;
    now: Date;
  },
): Promise<SmsCheckResult> {
  const { receipt, now } = input;
  assertAmount(receipt.amount, 'receipt amount');
  const summary =
    `receipt ${receipt.institution} ${receipt.reference}: ETB ${toWire(receipt.amount)} santim ` +
    `to ${receipt.receiver}${receipt.payerName ? ` from ${receipt.payerName}` : ''}`;
  const [inserted] = await tx
    .insert(receivedSms)
    .values({
      source: 'receipt',
      collectionAccount: input.collectionAccount ?? null,
      sender: receipt.institution,
      rawText: summary.slice(0, MAX_RAW_LENGTH),
      textHash: textHash(['receipt', receipt.institution, receipt.reference]),
      institution: receipt.institution,
      direction: 'credit',
      amount: receipt.amount,
      reference: receipt.reference,
      counterpartyName: receipt.payerName,
      counterpartyPhone: receipt.payerPhone,
      occurredAt: receipt.paidAt,
      receivedAt: now,
      status: 'unmatched',
      receiptStatus: 'verified',
      receiptReason: 'player_check',
      receiptCheckedAt: now,
      receiptAttempts: 1,
      receiptReceiver: receipt.receiver,
      receiptPayer: receipt.payerName,
      receiptRaw: receipt.raw.slice(0, 4096),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    // The gateway delivered it meanwhile (or another check recorded it).
    return checkSmsDepositForPlayer(tx, { userId: input.userId, text: receipt.reference, now });
  }
  if (receipt.paidAt === null) {
    // Without the time it was paid, any deposit the player opened since (even one handed this
    // amount after its first owner released it) would fit: a person decides.
    const updated = await updateSms(tx, inserted.id, {
      statusReason: 'receipt_without_time',
      updatedAt: now,
    });
    return { status: 'in_review', reference: receipt.reference, sms: updated };
  }
  return rematchForPlayer(
    tx,
    inserted,
    input.userId,
    smsPaidBy({ occurredAt: receipt.paidAt, deviceReceivedAt: null, now }),
    now,
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/** Rows waiting for a person, oldest first: unparsed, unmatched, ambiguous, flagged, receipt alarms. */
export async function listSmsReviewQueue(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<ReceivedSms[]> {
  return exec
    .select()
    .from(receivedSms)
    .where(
      and(
        isNull(receivedSms.resolvedAt),
        or(
          inArray(receivedSms.status, ['unparsed', 'unmatched', 'ambiguous', 'flagged']),
          eq(receivedSms.receiptStatus, 'rejected'),
        ),
      ),
    )
    .orderBy(
      // Receipt alarms first: money credited that the institution disowns.
      desc(sql`(${receivedSms.receiptStatus} IS NOT DISTINCT FROM 'rejected')`),
      asc(receivedSms.receivedAt),
    )
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

/** Received SMS, newest first (the back office's log). */
export async function listReceivedSms(
  exec: DbExecutor,
  options: { status?: ReceivedSmsStatus; limit?: number } = {},
): Promise<ReceivedSms[]> {
  return exec
    .select()
    .from(receivedSms)
    .where(options.status === undefined ? undefined : eq(receivedSms.status, options.status))
    .orderBy(desc(receivedSms.receivedAt), desc(receivedSms.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
}

export async function getReceivedSms(exec: DbExecutor, smsId: string): Promise<ReceivedSms | null> {
  const [row] = await exec.select().from(receivedSms).where(eq(receivedSms.id, smsId)).limit(1);
  return row ?? null;
}

function staffNote(note: string, fn: string): string {
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH);
  if (trimmed.length === 0) throw new RangeError(`${fn}: a note is required`);
  return trimmed;
}

/** Closes the deposit an SMS matched but flagged, when it still waits for staff. */
async function closeFlaggedDepositOf(
  tx: DbTransaction,
  row: ReceivedSms,
  adminId: string,
  note: string,
  now: Date,
  ip: string | null,
): Promise<void> {
  if (row.flaggedIntentId === null) return;
  const [intent] = await tx
    .select({ flaggedAt: paymentIntents.flaggedAt })
    .from(paymentIntents)
    .where(eq(paymentIntents.id, row.flaggedIntentId))
    .limit(1);
  if (!intent || intent.flaggedAt === null) return;
  await resolveFlaggedDeposit(tx, {
    intentId: row.flaggedIntentId,
    adminId,
    resolution: 'close',
    viaSmsQueue: true,
    note: `SMS ${row.reference ?? row.id} resolved from the SMS queue: ${note}`,
    now,
    ip,
  });
}

/**
 * Staff credit an incoming SMS to a player by hand (after checking who
 * paid): unmatched, ambiguous or flagged credits only. The amount credited
 * is what arrived. A deposit the SMS had matched but flagged is closed in
 * the same transaction, and a new, already-credited SMS deposit carries the
 * credit (ledger key `deposit:<new intent id>`, payment event
 * `sms:<row id>:staff`, `payment.deposit_succeeded`), so the money is
 * credited exactly once. Responsible-gambling limits are not applied: the
 * money already left the payer. 409 `sms_not_creditable` otherwise.
 */
export async function creditSmsByStaff(
  tx: DbTransaction,
  input: {
    smsId: string;
    userId: string;
    adminId: string;
    note: string;
    now: Date;
    ip?: string | null;
  },
): Promise<{ sms: ReceivedSms; intent: PaymentIntent }> {
  const { now } = input;
  const note = staffNote(input.note, 'creditSmsByStaff');
  const row = await lockSms(tx, input.smsId);
  if (
    row.direction !== 'credit' ||
    row.amount === null ||
    row.resolvedAt !== null ||
    !['unmatched', 'ambiguous', 'flagged'].includes(row.status)
  ) {
    throw domainConflict('sms_not_creditable', 'This SMS cannot be credited.', {
      status: row.status,
    });
  }
  const [user] = await tx
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  await closeFlaggedDepositOf(tx, row, input.adminId, note, now, input.ip ?? null);

  await lockUser(tx, input.userId);
  const intentId = randomUUID();
  const posting = await postTransaction(tx, {
    type: 'deposit',
    idempotencyKey: depositLedgerKey(intentId),
    refType: 'payment_intent',
    refId: intentId,
    description: `Deposit via ${SMS_PROVIDER} (credited by staff)`,
    actor: { type: 'admin', id: input.adminId },
    entries: depositEntries(SMS_PROVIDER, input.userId, row.amount),
  });
  const [intent] = await tx
    .insert(paymentIntents)
    .values({
      id: intentId,
      userId: input.userId,
      provider: SMS_PROVIDER,
      amount: row.amount,
      requestedAmount: row.amount,
      phone: user.phone,
      status: 'succeeded',
      providerRef: intentId,
      initiationKind: 'transfer',
      idempotencyKey: `staff-sms:${row.id}`,
      ledgerTransactionId: posting.transactionId,
      expiresAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!intent) throw new Error('payment intent insert returned no row');
  await tx.insert(paymentEvents).values({
    provider: SMS_PROVIDER,
    providerEventId: `sms:${row.id}:staff`,
    kind: 'deposit',
    providerRef: intentId,
    status: 'succeeded',
    amount: row.amount,
    currency: 'ETB',
    intentId,
    outcome: 'credited_by_staff',
    payload: { smsId: row.id, reference: row.reference, adminId: input.adminId },
    receivedAt: now,
  });
  await enqueueOutbox(tx, {
    type: DEPOSIT_SUCCEEDED,
    aggregateType: 'payment_intent',
    aggregateId: intentId,
    payload: {
      intentId,
      userId: input.userId,
      provider: SMS_PROVIDER,
      amount: row.amount,
      providerRef: intentId,
    },
  });
  const updated = await updateSms(tx, row.id, {
    status: 'credited_by_staff',
    statusReason: note,
    matchedIntentId: intentId,
    matchedUserId: input.userId,
    resolvedBy: input.adminId,
    resolvedAt: now,
    updatedAt: now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'payment.sms_credited_by_staff',
    targetType: 'received_sms',
    targetId: row.id,
    metadata: {
      userId: input.userId,
      intentId,
      amount: row.amount,
      reference: row.reference,
      previousStatus: row.status,
      note,
    },
    ip: input.ip ?? null,
  });
  return { sms: updated, intent };
}

/**
 * Staff close an SMS that should not credit anyone (not our money, refunded
 * to the sender outside Vamos, a test message…), with a note. A deposit it
 * matched but flagged is closed too. 409 `sms_not_closable` for a message
 * that credited or settled something.
 */
export async function closeSmsByStaff(
  tx: DbTransaction,
  input: { smsId: string; adminId: string; note: string; now: Date; ip?: string | null },
): Promise<ReceivedSms> {
  const note = staffNote(input.note, 'closeSmsByStaff');
  const row = await lockSms(tx, input.smsId);
  if (
    row.resolvedAt !== null ||
    ![
      'unparsed',
      'unmatched',
      'ambiguous',
      'flagged',
      'ignored_debit',
      'settlement_proposed',
    ].includes(row.status)
  ) {
    throw domainConflict('sms_not_closable', 'This SMS cannot be closed.', { status: row.status });
  }
  await closeFlaggedDepositOf(tx, row, input.adminId, note, input.now, input.ip ?? null);
  const updated = await updateSms(tx, row.id, {
    status: 'closed',
    statusReason: note,
    proposedPayoutId: null,
    resolvedBy: input.adminId,
    resolvedAt: input.now,
    updatedAt: input.now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'payment.sms_closed',
    targetType: 'received_sms',
    targetId: row.id,
    metadata: { previousStatus: row.status, reference: row.reference, amount: row.amount, note },
    ip: input.ip ?? null,
  });
  return updated;
}

/**
 * Staff acknowledge a receipt alarm (a credited SMS the institution's
 * receipt contradicts) after investigating: the row leaves the queue. Any
 * correction of the player's balance is a separate, audited adjustment;
 * nothing is reversed here. 409 `sms_no_receipt_alarm` otherwise.
 */
export async function acknowledgeReceiptAlarm(
  tx: DbTransaction,
  input: { smsId: string; adminId: string; note: string; now: Date; ip?: string | null },
): Promise<ReceivedSms> {
  const note = staffNote(input.note, 'acknowledgeReceiptAlarm');
  const row = await lockSms(tx, input.smsId);
  if (row.receiptStatus !== 'rejected' || row.resolvedAt !== null) {
    throw domainConflict('sms_no_receipt_alarm', 'This SMS has no open receipt alarm.');
  }
  const updated = await updateSms(tx, row.id, {
    resolvedBy: input.adminId,
    resolvedAt: input.now,
    updatedAt: input.now,
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: 'payment.sms_receipt_alarm_acknowledged',
    targetType: 'received_sms',
    targetId: row.id,
    metadata: { reference: row.reference, receiptReason: row.receiptReason, note },
    ip: input.ip ?? null,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Receipt audit and balance reconciliation (worker)
// ---------------------------------------------------------------------------

/** Most receipt checks of one message before an inconclusive answer is final. */
export const RECEIPT_MAX_ATTEMPTS = 5;

/**
 * Credited gateway messages from `institutions` (the receipt-verifiable
 * ones) not yet checked against the institution's receipt page, oldest first.
 */
export async function listSmsDueForReceiptCheck(
  exec: DbExecutor,
  options: { institutions: readonly string[]; limit?: number },
): Promise<ReceivedSms[]> {
  if (options.institutions.length === 0) return [];
  return exec
    .select()
    .from(receivedSms)
    .where(
      and(
        eq(receivedSms.status, 'matched'),
        isNull(receivedSms.receiptStatus),
        inArray(receivedSms.source, ['gateway', 'simulator']),
        inArray(receivedSms.institution, [...options.institutions]),
      ),
    )
    .orderBy(asc(receivedSms.receivedAt))
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 200));
}

export type ReceiptCheckStatus = 'verified' | 'rejected' | 'indeterminate' | 'skipped';

/**
 * Records one receipt check of a credited message. `indeterminate` (the page
 * could not be read, the institution was down) is retried until
 * RECEIPT_MAX_ATTEMPTS, then recorded as final. `rejected` puts the message
 * at the top of the review queue; the credit is never reversed here.
 */
export async function recordReceiptCheck(
  tx: DbTransaction,
  input: {
    smsId: string;
    status: ReceiptCheckStatus;
    reason: string | null;
    receiver?: string | null;
    payer?: string | null;
    raw?: string | null;
    now: Date;
  },
): Promise<ReceivedSms> {
  const row = await lockSms(tx, input.smsId);
  if (row.receiptStatus !== null) return row;
  const attempts = row.receiptAttempts + 1;
  const final = input.status !== 'indeterminate' || attempts >= RECEIPT_MAX_ATTEMPTS;
  const updated = await updateSms(tx, row.id, {
    receiptAttempts: attempts,
    receiptStatus: final ? input.status : null,
    receiptReason: input.reason?.slice(0, MAX_NOTE_LENGTH) ?? null,
    receiptCheckedAt: input.now,
    receiptReceiver: input.receiver ?? null,
    receiptPayer: input.payer ?? null,
    receiptRaw: input.raw?.slice(0, 4096) ?? null,
    updatedAt: input.now,
  });
  if (final && input.status === 'rejected') {
    await writeAudit(tx, {
      actorType: 'system',
      action: 'payment.sms_receipt_rejected',
      targetType: 'received_sms',
      targetId: row.id,
      metadata: {
        reference: row.reference,
        amount: row.amount,
        institution: row.institution,
        reason: input.reason,
        matchedIntentId: row.matchedIntentId,
      },
    });
  }
  return updated;
}

/** Messages that state the collection account's balance, for one institution and window. */
export async function listBalanceObservations(
  exec: DbExecutor,
  options: { institution: string; since: Date; until: Date },
): Promise<{ balance: bigint; amount: bigint; direction: 'credit' | 'debit'; at: Date }[]> {
  const rows = await exec
    .select({
      balance: receivedSms.balance,
      amount: receivedSms.amount,
      direction: receivedSms.direction,
      occurredAt: receivedSms.occurredAt,
      receivedAt: receivedSms.receivedAt,
    })
    .from(receivedSms)
    .where(
      and(
        eq(receivedSms.institution, options.institution),
        isNotNull(receivedSms.balance),
        inArray(receivedSms.source, ['gateway', 'simulator']),
        gt(receivedSms.receivedAt, options.since),
        lte(receivedSms.receivedAt, options.until),
      ),
    )
    .orderBy(asc(receivedSms.receivedAt))
    .limit(20_000);
  return rows.flatMap((row) =>
    row.balance === null || row.amount === null || row.direction === null
      ? []
      : [
          {
            balance: row.balance,
            amount: row.amount,
            direction: row.direction === 'debit' ? ('debit' as const) : ('credit' as const),
            at: row.occurredAt ?? row.receivedAt,
          },
        ],
  );
}

/** Institutions that sent balance-bearing messages in the window. */
export async function listBalanceInstitutions(
  exec: DbExecutor,
  options: { since: Date },
): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ institution: receivedSms.institution })
    .from(receivedSms)
    .where(and(isNotNull(receivedSms.balance), gt(receivedSms.receivedAt, options.since)));
  return rows.flatMap((row) => (row.institution === null ? [] : [row.institution]));
}

export interface SmsRailHealth {
  /** The newest message from the handset (gateway), or null. */
  lastGatewaySmsAt: Date | null;
  /** Rows waiting for a person. */
  reviewQueue: number;
  oldestReviewAt: Date | null;
  /** Open receipt alarms (credited, then contradicted by the institution). */
  receiptAlarms: number;
  /** Manual payouts approved or claimed and not yet paid. */
  manualPayoutsOpen: number;
  oldestManualPayoutApprovedAt: Date | null;
}

export async function smsRailHealth(exec: DbExecutor): Promise<SmsRailHealth> {
  const [last] = await exec
    .select({ at: sql<Date | null>`max(${receivedSms.receivedAt})` })
    .from(receivedSms)
    .where(eq(receivedSms.source, 'gateway'));
  const [review] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${receivedSms.receivedAt})`,
      alarms: sql<number>`count(*) FILTER (WHERE ${receivedSms.receiptStatus} = 'rejected')::int`,
    })
    .from(receivedSms)
    .where(
      and(
        isNull(receivedSms.resolvedAt),
        or(
          inArray(receivedSms.status, ['unparsed', 'unmatched', 'ambiguous', 'flagged']),
          eq(receivedSms.receiptStatus, 'rejected'),
        ),
      ),
    );
  const [manual] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${payouts.approvedAt})`,
    })
    .from(payouts)
    .where(and(eq(payouts.manual, true), inArray(payouts.status, ['approved', 'processing'])));
  const toDate = (value: Date | string | null | undefined) =>
    value === null || value === undefined ? null : new Date(value);
  return {
    lastGatewaySmsAt: toDate(last?.at),
    reviewQueue: review?.count ?? 0,
    oldestReviewAt: toDate(review?.oldest),
    receiptAlarms: review?.alarms ?? 0,
    manualPayoutsOpen: manual?.count ?? 0,
    oldestManualPayoutApprovedAt: toDate(manual?.oldest),
  };
}
