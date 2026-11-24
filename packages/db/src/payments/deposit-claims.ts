import { birr, normalizeEthiopianMsisdn } from '@vamos/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { lockUser } from '../rg/limits';
import { users } from '../schema/accounts';
import { DEPOSIT_CLAIM_METHODS, depositClaims, paymentIntents } from '../schema/payments';
import { receivedSms } from '../schema/smsrail';

/**
 * Deposits that did not arrive (docs/plans/counter-codes-and-deposit-recovery.md, G5.3 and G6).
 *
 * - A logged-in player files a **claim** ("My deposit did not arrive"): method, amount, when, the
 *   transaction id or the bank SMS reference. A claim never credits anything by itself.
 * - The back office's **"Money not credited"** lists the money that arrived but was not credited
 *   (unmatched, ambiguous or flagged incoming SMS; provider payments flagged instead of credited)
 *   and the open claims, each with the players it may belong to and why. An admin credits it with
 *   the existing tools (the SMS credit, the manual deposit), which mark a claim `credited` in the
 *   same transaction, or closes a claim with a note. **Nothing is credited automatically.**
 */

export type DepositClaim = typeof depositClaims.$inferSelect;
export type DepositClaimMethod = (typeof DEPOSIT_CLAIM_METHODS)[number];

export const DEPOSIT_CLAIM_AUDIT = {
  filed: 'payment.deposit_claim_filed',
  credited: 'payment.deposit_claim_credited',
  closed: 'payment.deposit_claim_closed',
} as const;

/** Open claims one player may have at a time. */
export const MAX_OPEN_DEPOSIT_CLAIMS = 3;
/** A claim is for a payment of the last 30 days. */
export const DEPOSIT_CLAIM_MAX_AGE_MS = 30 * 86_400_000;
export const DEPOSIT_CLAIM_MAX_AMOUNT = birr(1_000_000);
/** How long before the money moved a deposit or a claim may be, to be suggested. */
const NEAR_WINDOW_MS = 86_400_000;
const FUTURE_SLACK_MS = 10 * 60_000;
const REFERENCE = /^[A-Za-z0-9._/-]{4,64}$/;

/**
 * Two amounts are near when they differ by at most ETB 1 or 1 % (a payer who left out the santim of
 * an exact SMS amount, or a fee taken on the way).
 */
export function nearAmount(a: bigint, b: bigint): boolean {
  const diff = a > b ? a - b : b - a;
  const big = a > b ? a : b;
  return diff <= 100n || diff * 100n <= big;
}

/** Spaces dropped and upper case: how references are compared. */
export function claimReference(input: string | null | undefined): string | null {
  const value = (input ?? '').replace(/\s+/g, '').toUpperCase();
  return value === '' ? null : value;
}

/**
 * Files a player's claim (409 `too_many_open_claims` at MAX_OPEN_DEPOSIT_CLAIMS, `claim_exists`
 * for an open claim with the same reference; 422 for a bad method, amount, time, reference or
 * phone). Audited.
 */
export async function fileDepositClaim(
  tx: DbTransaction,
  input: {
    userId: string;
    method: string;
    amount: bigint;
    paidAt: Date;
    reference?: string | null;
    payerPhone?: string | null;
    note?: string | null;
    /** `telegram`: filed through the bot (kept 90 days, decision O3). Default `app`. */
    source?: 'app' | 'telegram';
    now: Date;
    ip?: string | null;
  },
): Promise<DepositClaim> {
  const { now } = input;
  const source = input.source ?? 'app';
  if (!(DEPOSIT_CLAIM_METHODS as readonly string[]).includes(input.method)) {
    throw domainUnprocessable('claim_method_invalid', 'Choose how you paid.');
  }
  if (input.amount <= 0n || input.amount > DEPOSIT_CLAIM_MAX_AMOUNT) {
    throw domainUnprocessable('claim_amount_invalid', 'Enter the amount you sent.');
  }
  if (input.paidAt.getTime() > now.getTime() + FUTURE_SLACK_MS) {
    throw domainUnprocessable('claim_time_invalid', 'The payment time is in the future.');
  }
  if (input.paidAt.getTime() < now.getTime() - DEPOSIT_CLAIM_MAX_AGE_MS) {
    throw domainUnprocessable(
      'claim_too_old',
      'A claim is for a payment of the last 30 days. For an older one, contact support.',
    );
  }
  const reference = claimReference(input.reference);
  if (reference !== null && !REFERENCE.test(reference)) {
    throw domainUnprocessable(
      'claim_reference_invalid',
      'Enter the transaction id or the SMS reference as it is written (4 to 64 letters or digits).',
    );
  }
  let payerPhone: string | null = null;
  if (input.payerPhone !== undefined && input.payerPhone !== null && input.payerPhone.trim()) {
    payerPhone = normalizeEthiopianMsisdn(input.payerPhone.trim());
    if (payerPhone === null) {
      throw domainUnprocessable('claim_phone_invalid', 'Enter the phone number that paid.');
    }
  }
  const note = (input.note ?? '').trim().slice(0, 300) || null;

  // One player's claims queue here, so the open-claim count is read under the same lock.
  await lockUser(tx, input.userId);
  const open = await tx
    .select({ id: depositClaims.id, reference: depositClaims.reference })
    .from(depositClaims)
    .where(and(eq(depositClaims.userId, input.userId), eq(depositClaims.status, 'open')));
  if (reference !== null && open.some((c) => c.reference === reference)) {
    throw domainConflict('claim_exists', 'You already reported this payment. We are checking it.');
  }
  if (open.length >= MAX_OPEN_DEPOSIT_CLAIMS) {
    throw domainConflict(
      'too_many_open_claims',
      'You have reported several payments already. We will answer them first.',
    );
  }
  const [claim] = await tx
    .insert(depositClaims)
    .values({
      userId: input.userId,
      method: input.method,
      amount: input.amount,
      paidAt: input.paidAt,
      reference,
      payerPhone,
      note,
      source,
      createdAt: now,
    })
    .returning();
  if (!claim) throw new Error('deposit claim insert returned no row');
  await writeAudit(tx, {
    actorType: 'user',
    actorId: input.userId,
    action: DEPOSIT_CLAIM_AUDIT.filed,
    targetType: 'deposit_claim',
    targetId: claim.id,
    // A Telegram claim's reference and phone stay only in the claim (pruned after 90 days, O3).
    metadata:
      source === 'telegram'
        ? { method: claim.method, amount: claim.amount, source }
        : { method: claim.method, amount: claim.amount, reference, payerPhone, source },
    ip: input.ip ?? null,
  });
  return claim;
}

/** A player's own claims, newest first. */
export async function listPlayerDepositClaims(
  exec: DbExecutor,
  userId: string,
  limit = 20,
): Promise<DepositClaim[]> {
  return exec
    .select()
    .from(depositClaims)
    .where(eq(depositClaims.userId, userId))
    .orderBy(desc(depositClaims.createdAt), desc(depositClaims.id))
    .limit(limit);
}

async function lockOpenClaim(tx: DbTransaction, claimId: string): Promise<DepositClaim> {
  const [claim] = await tx
    .select()
    .from(depositClaims)
    .where(eq(depositClaims.id, claimId))
    .for('update');
  if (!claim) throw domainNotFound('Claim');
  if (claim.status !== 'open') {
    throw domainConflict('claim_not_open', 'This claim was answered already.', {
      status: claim.status,
    });
  }
  return claim;
}

/**
 * Marks a claim credited by the deposit an admin just credited for its player, in the same
 * transaction as that credit (the SMS credit or the manual deposit): 409 `claim_other_player`
 * when the money went to another player than the claimant, `claim_not_open` when it was answered.
 */
export async function creditDepositClaim(
  tx: DbTransaction,
  input: {
    claimId: string;
    userId: string;
    intentId: string;
    adminId: string;
    now: Date;
    ip?: string | null;
  },
): Promise<DepositClaim> {
  const claim = await lockOpenClaim(tx, input.claimId);
  if (claim.userId !== input.userId) {
    throw domainConflict('claim_other_player', 'This claim is another player’s.');
  }
  const [updated] = await tx
    .update(depositClaims)
    .set({
      status: 'credited',
      creditedIntentId: input.intentId,
      resolvedBy: input.adminId,
      resolvedAt: input.now,
      resolutionNote: 'Credited',
    })
    .where(eq(depositClaims.id, claim.id))
    .returning();
  if (!updated) throw new Error('deposit claim update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: DEPOSIT_CLAIM_AUDIT.credited,
    targetType: 'deposit_claim',
    targetId: claim.id,
    metadata: { intentId: input.intentId, amount: claim.amount },
    ip: input.ip ?? null,
  });
  return updated;
}

/** Closes a claim without crediting (the money never arrived, a duplicate…), with a note. */
export async function closeDepositClaim(
  tx: DbTransaction,
  input: { claimId: string; note: string; adminId: string; now: Date; ip?: string | null },
): Promise<DepositClaim> {
  const note = input.note.trim();
  if (note.length < 3) {
    throw domainUnprocessable('reason_required', 'Write down why (at least 3 characters).');
  }
  const claim = await lockOpenClaim(tx, input.claimId);
  const [updated] = await tx
    .update(depositClaims)
    .set({
      status: 'closed',
      resolvedBy: input.adminId,
      resolvedAt: input.now,
      resolutionNote: note.slice(0, 300),
    })
    .where(eq(depositClaims.id, claim.id))
    .returning();
  if (!updated) throw new Error('deposit claim update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: DEPOSIT_CLAIM_AUDIT.closed,
    targetType: 'deposit_claim',
    targetId: claim.id,
    metadata: { note: updated.resolutionNote, amount: claim.amount },
    ip: input.ip ?? null,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// "Money not credited"
// ---------------------------------------------------------------------------

/**
 * Why a player is suggested for money that arrived: the deposit the SMS matched but flagged
 * (`flagged_deposit`), the player's own flagged provider deposit (`own_deposit`), the payer's phone
 * is theirs (`payer_phone`), they had an open or expired deposit of a near amount in the day
 * before (`near_deposit`), their claim has the same reference (`claim_reference`) or a near
 * amount in the same day (`claim_amount`).
 */
export type MoneySuggestionReason =
  | 'flagged_deposit'
  | 'own_deposit'
  | 'payer_phone'
  | 'near_deposit'
  | 'claim_reference'
  | 'claim_amount';

const REASON_WEIGHT: Record<MoneySuggestionReason, number> = {
  flagged_deposit: 5,
  own_deposit: 5,
  claim_reference: 5,
  payer_phone: 3,
  near_deposit: 2,
  claim_amount: 2,
};

export interface MoneySuggestion {
  userId: string;
  phone: string;
  name: string | null;
  reasons: MoneySuggestionReason[];
  /** The player's open claim that pairs with this money, if any. */
  claimId: string | null;
}

export interface MoneyNotCreditedItem {
  kind: 'sms' | 'provider';
  /** The SMS's id or the deposit's (payment intent's) id. */
  id: string;
  amount: bigint;
  /** When the money moved (the SMS's time, the provider's flag time). */
  at: Date;
  /** The institution (SMS) or the provider. */
  source: string;
  reference: string | null;
  payerPhone: string | null;
  payerName: string | null;
  /** The SMS's status (unmatched, ambiguous, flagged) or `flagged` for a provider deposit. */
  status: string;
  reason: string | null;
  /** Strongest first. */
  suggestions: MoneySuggestion[];
}

export interface MoneyNotCreditedClaim {
  claim: DepositClaim;
  phone: string;
  name: string | null;
  /** The money this claim pairs with (an item of `items`). */
  pairs: Array<{ kind: 'sms' | 'provider'; id: string; reason: MoneySuggestionReason }>;
}

export interface MoneyNotCredited {
  items: MoneyNotCreditedItem[];
  claims: MoneyNotCreditedClaim[];
  /** The money waiting (items only; claims are what players say). */
  waiting: { count: number; amount: bigint; oldestAt: Date | null };
}

const LIST_LIMIT = 100;

/** The back office's "Money not credited": oldest first, at most LIST_LIMIT of each kind. */
export async function listMoneyNotCredited(exec: DbExecutor): Promise<MoneyNotCredited> {
  const sms = await exec
    .select()
    .from(receivedSms)
    .where(
      and(
        isNull(receivedSms.resolvedAt),
        eq(receivedSms.direction, 'credit'),
        inArray(receivedSms.status, ['unmatched', 'ambiguous', 'flagged']),
        isNotNull(receivedSms.amount),
      ),
    )
    .orderBy(asc(receivedSms.receivedAt))
    .limit(LIST_LIMIT);
  const flagged = await exec
    .select()
    .from(paymentIntents)
    .where(
      and(
        isNotNull(paymentIntents.flaggedAt),
        ne(paymentIntents.status, 'succeeded'),
        ne(paymentIntents.provider, 'sms'),
      ),
    )
    .orderBy(asc(paymentIntents.flaggedAt))
    .limit(LIST_LIMIT);
  const openClaims = await exec
    .select()
    .from(depositClaims)
    .where(eq(depositClaims.status, 'open'))
    .orderBy(asc(depositClaims.createdAt))
    .limit(LIST_LIMIT);

  // Who the payers' phones and the flagged SMS deposits belong to.
  const phones = [
    ...new Set(sms.flatMap((s) => (s.counterpartyPhone ? [s.counterpartyPhone] : []))),
  ];
  const byPhone = new Map<string, string>();
  if (phones.length > 0) {
    for (const row of await exec
      .select({ id: users.id, phone: users.phone })
      .from(users)
      .where(inArray(users.phone, phones))) {
      byPhone.set(row.phone, row.id);
    }
  }
  const flaggedSmsIntents = [
    ...new Set(sms.flatMap((s) => (s.flaggedIntentId ? [s.flaggedIntentId] : []))),
  ];
  const intentOwner = new Map<string, string>();
  if (flaggedSmsIntents.length > 0) {
    for (const row of await exec
      .select({ id: paymentIntents.id, userId: paymentIntents.userId })
      .from(paymentIntents)
      .where(inArray(paymentIntents.id, flaggedSmsIntents))) {
      intentOwner.set(row.id, row.userId);
    }
  }

  type Draft = Omit<MoneyNotCreditedItem, 'suggestions'> & {
    candidates: Map<string, { reasons: Set<MoneySuggestionReason>; claimId: string | null }>;
  };
  const add = (
    draft: Draft,
    userId: string | undefined,
    reason: MoneySuggestionReason,
    claimId: string | null = null,
  ) => {
    if (userId === undefined) return;
    const entry = draft.candidates.get(userId) ?? { reasons: new Set(), claimId: null };
    entry.reasons.add(reason);
    if (claimId !== null) entry.claimId = claimId;
    draft.candidates.set(userId, entry);
  };
  const pairClaims = (draft: Draft) => {
    const ref = claimReference(draft.reference);
    for (const claim of openClaims) {
      if (ref !== null && claim.reference === ref) {
        add(draft, claim.userId, 'claim_reference', claim.id);
      } else if (
        nearAmount(claim.amount, draft.amount) &&
        Math.abs(claim.paidAt.getTime() - draft.at.getTime()) <= NEAR_WINDOW_MS
      ) {
        add(draft, claim.userId, 'claim_amount', claim.id);
      }
    }
  };

  const drafts: Draft[] = [];
  for (const row of sms) {
    const at = row.occurredAt ?? row.receivedAt;
    const draft: Draft = {
      kind: 'sms',
      id: row.id,
      amount: row.amount!,
      at,
      source: row.institution ?? row.sender ?? 'sms',
      reference: row.reference,
      payerPhone: row.counterpartyPhone,
      payerName: row.counterpartyName,
      status: row.status,
      reason: row.statusReason,
      candidates: new Map(),
    };
    if (row.flaggedIntentId) add(draft, intentOwner.get(row.flaggedIntentId), 'flagged_deposit');
    if (row.counterpartyPhone) add(draft, byPhone.get(row.counterpartyPhone), 'payer_phone');
    // An SMS deposit of a near amount, opened in the day before the money moved.
    const amount = row.amount!;
    const slack = amount / 100n > 100n ? amount / 100n : 100n;
    const near = await exec
      .selectDistinct({ userId: paymentIntents.userId })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.provider, 'sms'),
          inArray(paymentIntents.status, ['created', 'pending', 'expired']),
          isNull(paymentIntents.flaggedAt),
          gte(paymentIntents.amount, amount - slack),
          lte(paymentIntents.amount, amount + slack),
          gte(paymentIntents.createdAt, new Date(at.getTime() - NEAR_WINDOW_MS)),
          lte(paymentIntents.createdAt, at),
        ),
      )
      .limit(5);
    for (const n of near) add(draft, n.userId, 'near_deposit');
    pairClaims(draft);
    drafts.push(draft);
  }
  for (const intent of flagged) {
    const draft: Draft = {
      kind: 'provider',
      id: intent.id,
      amount: intent.amount,
      at: intent.flaggedAt!,
      source: intent.provider,
      reference: intent.providerRef,
      payerPhone: null,
      payerName: null,
      status: 'flagged',
      reason: intent.flagReason,
      candidates: new Map(),
    };
    add(draft, intent.userId, 'own_deposit');
    // Only the deposit's own player's claims pair with it.
    const ref = claimReference(draft.reference);
    for (const claim of openClaims) {
      if (claim.userId !== intent.userId) continue;
      const byRef = ref !== null && claim.reference === ref;
      if (byRef || nearAmount(claim.amount, intent.amount)) {
        add(draft, claim.userId, byRef ? 'claim_reference' : 'claim_amount', claim.id);
      }
    }
    drafts.push(draft);
  }

  // The players named anywhere: their phone and name.
  const ids = [
    ...new Set([
      ...drafts.flatMap((d) => [...d.candidates.keys()]),
      ...openClaims.map((c) => c.userId),
    ]),
  ];
  const people = new Map<string, { phone: string; name: string | null }>();
  if (ids.length > 0) {
    for (const row of await exec
      .select({ id: users.id, phone: users.phone, name: users.fullName })
      .from(users)
      .where(inArray(users.id, ids))) {
      people.set(row.id, { phone: row.phone, name: row.name });
    }
  }

  const items: MoneyNotCreditedItem[] = drafts.map(({ candidates, ...item }) => ({
    ...item,
    suggestions: [...candidates.entries()]
      .map(([userId, entry]) => ({
        userId,
        phone: people.get(userId)?.phone ?? '',
        name: people.get(userId)?.name ?? null,
        reasons: [...entry.reasons].sort((a, b) => REASON_WEIGHT[b] - REASON_WEIGHT[a]),
        claimId: entry.claimId,
      }))
      .sort(
        (a, b) =>
          b.reasons.reduce((s, r) => s + REASON_WEIGHT[r], 0) -
          a.reasons.reduce((s, r) => s + REASON_WEIGHT[r], 0),
      ),
  }));
  const claims: MoneyNotCreditedClaim[] = openClaims.map((claim) => ({
    claim,
    phone: people.get(claim.userId)?.phone ?? '',
    name: people.get(claim.userId)?.name ?? null,
    pairs: items.flatMap((item) =>
      item.suggestions
        .filter((s) => s.claimId === claim.id)
        .map((s) => ({
          kind: item.kind,
          id: item.id,
          reason: s.reasons.includes('claim_reference')
            ? ('claim_reference' as const)
            : ('claim_amount' as const),
        })),
    ),
  }));
  const amount = items.reduce((sum, item) => sum + item.amount, 0n);
  const oldestAt = items.reduce<Date | null>(
    (oldest, item) => (oldest === null || item.at < oldest ? item.at : oldest),
    null,
  );
  return { items, claims, waiting: { count: items.length, amount, oldestAt } };
}

/** How long a claim filed through the Telegram bot is kept (decision O3: 90 days). */
export const TELEGRAM_CLAIM_RETENTION_MS = 90 * 86_400_000;

/** Deletes the Telegram claims filed before `before` (decision O3); returns how many. */
export async function pruneTelegramDepositClaims(
  exec: DbExecutor,
  input: { before: Date },
): Promise<number> {
  const deleted = await exec
    .delete(depositClaims)
    .where(and(eq(depositClaims.source, 'telegram'), lt(depositClaims.createdAt, input.before)))
    .returning({ id: depositClaims.id });
  return deleted.length;
}

/** The player whose registered phone this is (E.164), or null. */
export async function userIdByPhone(exec: DbExecutor, phone: string): Promise<string | null> {
  const [row] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  return row?.id ?? null;
}
