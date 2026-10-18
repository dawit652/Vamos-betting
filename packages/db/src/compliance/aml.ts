import {
  amlLookbackMs,
  evaluateAmlActivity,
  evaluateDepositThenWithdraw,
  type AmlHit,
  type AmlRules,
} from '@vamos/core';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { domainBadRequest, domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { BET_CASHED_OUT } from '../betting/events';
import { DEPOSIT_SUCCEEDED, WITHDRAWAL_HELD, WITHDRAWAL_REQUESTED } from '../payments/events';
import { lockUser } from '../rg/limits';
import { betCashouts, bets } from '../schema/betting';
import { amlFlags } from '../schema/compliance';
import { jackpotEntries } from '../schema/jackpots';
import { paymentIntents, payouts } from '../schema/payments';
import { loadComplianceSettings } from './settings';

/**
 * AML rules (Phase 10; maths in @vamos/core aml, thresholds in the
 * `aml_rules` setting, defaults to confirm with counsel): deposit and
 * withdrawal velocity, structuring below the reporting threshold, deposit
 * then withdraw with little betting, rapid cash-out churn. Accounts sharing
 * a device or IP are out of scope (no device data).
 *
 * A player is evaluated when money moves (the worker, on the outbox events
 * in AML_TRIGGER_TYPES), in requestWithdrawal itself when the caller passes
 * the rules (so a withdrawal that breaks a rule is held before any payout
 * job can send it), and by the daily sweep. A hit becomes one aml_flags row
 * per player, rule and window (dedupe on the unique key), with the outbox
 * event compliance.aml_flagged and the audit record `aml.flag_raised`.
 *
 * Withdrawal hold (rules.holdWithdrawalsOnHighSeverity): while a player
 * has an open or escalated high-severity flag every new withdrawal waits
 * for staff (review_reason `aml_review`), and when such a flag is raised the
 * player's approved withdrawals not yet sent go back to review
 * (payment.withdrawal_held). Compliance staff review flags (aml.review):
 * open → reviewed | dismissed | escalated, escalated → reviewed | dismissed.
 * Flags are never shown to the player.
 */

export type AmlFlag = typeof amlFlags.$inferSelect;
export type AmlFlagStatus = AmlFlag['status'];
export type AmlFlagSource = 'event' | 'sweep' | 'withdrawal';

/** Outbox event of a new AML flag. Payload { flagId, userId, rule, severity, windowKey, triggeredAt }. */
export const AML_FLAG_RAISED = 'compliance.aml_flagged';

/** The outbox types after which the worker evaluates the player (payload carries userId). */
export const AML_TRIGGER_TYPES: readonly string[] = [
  DEPOSIT_SUCCEEDED,
  WITHDRAWAL_REQUESTED,
  BET_CASHED_OUT,
];

/** Review reason of a withdrawal held for an AML flag (payouts.review_reason). */
export const AML_REVIEW_REASON = 'aml_review';

const UNRESOLVED: AmlFlagStatus[] = ['open', 'escalated'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the player has an open or escalated high-severity flag. */
export async function hasUnresolvedHighAmlFlag(exec: DbExecutor, userId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: amlFlags.id })
    .from(amlFlags)
    .where(
      and(
        eq(amlFlags.userId, userId),
        eq(amlFlags.severity, 'high'),
        inArray(amlFlags.status, UNRESOLVED),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The player's movements within the look-back window (business clock: the rows' own times). */
async function loadActivity(tx: DbTransaction, userId: string, from: Date, to: Date) {
  const deposits = await tx
    .select({
      id: paymentIntents.id,
      at: paymentIntents.completedAt,
      amount: paymentIntents.amount,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.userId, userId),
        eq(paymentIntents.status, 'succeeded'),
        gt(paymentIntents.completedAt, from),
        lte(paymentIntents.completedAt, to),
      ),
    );
  const withdrawals = await tx
    .select({ id: payouts.id, at: payouts.requestedAt })
    .from(payouts)
    .where(
      and(eq(payouts.userId, userId), gt(payouts.requestedAt, from), lte(payouts.requestedAt, to)),
    );
  const cashOuts = await tx
    .select({ at: betCashouts.createdAt, placedAt: bets.placedAt })
    .from(betCashouts)
    .innerJoin(bets, eq(bets.id, betCashouts.betId))
    .where(
      and(
        eq(betCashouts.userId, userId),
        gt(betCashouts.createdAt, from),
        lte(betCashouts.createdAt, to),
      ),
    );
  return { deposits, withdrawals, cashOuts };
}

/** The deposit-then-withdraw hit of one withdrawal request, if any. */
async function depositThenWithdrawHit(
  tx: DbTransaction,
  rules: AmlRules,
  userId: string,
  requestedAt: Date,
): Promise<AmlHit | null> {
  if (!rules.depositThenWithdraw.enabled) return null;
  const [deposit] = await tx
    .select({
      id: paymentIntents.id,
      at: paymentIntents.completedAt,
      amount: paymentIntents.amount,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.userId, userId),
        eq(paymentIntents.status, 'succeeded'),
        lte(paymentIntents.completedAt, requestedAt),
      ),
    )
    .orderBy(desc(paymentIntents.completedAt), desc(paymentIntents.id))
    .limit(1);
  if (deposit === undefined || deposit.at === null) return null;
  const [betStakes] = await tx
    .select({ total: sql<string>`COALESCE(sum(${bets.stake}), 0)::text` })
    .from(bets)
    .where(
      and(
        eq(bets.userId, userId),
        ne(bets.status, 'rejected'),
        gte(bets.placedAt, deposit.at),
        lte(bets.placedAt, requestedAt),
      ),
    );
  const [entries] = await tx
    .select({ total: sql<string>`COALESCE(sum(${jackpotEntries.cost}), 0)::text` })
    .from(jackpotEntries)
    .where(
      and(
        eq(jackpotEntries.userId, userId),
        gte(jackpotEntries.placedAt, deposit.at),
        lte(jackpotEntries.placedAt, requestedAt),
      ),
    );
  return evaluateDepositThenWithdraw(rules.depositThenWithdraw, {
    deposit: deposit.amount,
    stakesSince: BigInt(betStakes?.total ?? '0') + BigInt(entries?.total ?? '0'),
    depositRef: deposit.id,
    atMs: requestedAt.getTime(),
  });
}

/**
 * Moves the player's approved withdrawals that no worker has taken yet back
 * to staff review (FOR UPDATE, so a payout worker claiming it concurrently
 * either got it first or never sees it approved). Returns their ids.
 */
async function holdApprovedWithdrawals(
  tx: DbTransaction,
  userId: string,
  flag: AmlFlag,
  now: Date,
): Promise<string[]> {
  const approved = await tx
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.userId, userId),
        eq(payouts.status, 'approved'),
        eq(payouts.attempts, 0),
        isNull(payouts.flaggedAt),
      ),
    )
    .for('update');
  const held: string[] = [];
  for (const payout of approved) {
    await tx
      .update(payouts)
      .set({
        status: 'requested',
        reviewReason: AML_REVIEW_REASON,
        approvedBy: null,
        approvedAt: null,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(eq(payouts.id, payout.id));
    const payload = {
      payoutId: payout.id,
      userId,
      provider: payout.provider,
      amount: payout.amount,
      flagId: flag.id,
      rule: flag.rule,
    };
    await enqueueOutbox(tx, {
      type: WITHDRAWAL_HELD,
      aggregateType: 'payout',
      aggregateId: payout.id,
      payload,
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: WITHDRAWAL_HELD,
      targetType: 'payout',
      targetId: payout.id,
      metadata: payload,
    });
    held.push(payout.id);
  }
  return held;
}

export interface EvaluateAmlResult {
  /** Flags this evaluation created (hits whose window was flagged before are not repeated). */
  created: AmlFlag[];
  /** Approved withdrawals sent back to review because of a new high-severity flag. */
  held: string[];
  /** The player now has an open or escalated high-severity flag (and the hold rule is on). */
  holdWithdrawals: boolean;
}

/**
 * Evaluates every rule for one player over the look-back window ending at
 * `now` (twice the longest rule window) in the caller's transaction, after
 * lockUser (serialised with the player's withdrawals). `pendingWithdrawal`
 * is a withdrawal being requested in this transaction (not stored yet): it
 * counts for velocity and is judged by deposit-then-withdraw. `rules`
 * defaults to the `aml_rules` setting.
 */
export async function evaluateAmlForUser(
  tx: DbTransaction,
  input: {
    userId: string;
    now: Date;
    source: AmlFlagSource;
    rules?: AmlRules;
    pendingWithdrawal?: { payoutId: string; requestedAt: Date };
  },
): Promise<EvaluateAmlResult> {
  const { userId, now } = input;
  const rules = input.rules ?? (await loadComplianceSettings(tx)).amlRules;
  const none: EvaluateAmlResult = { created: [], held: [], holdWithdrawals: false };
  if (!rules.enabled) return none;
  await lockUser(tx, userId);
  const from = new Date(now.getTime() - amlLookbackMs(rules));
  const activity = await loadActivity(tx, userId, from, now);
  const withdrawals = activity.withdrawals.map((row) => ({ id: row.id, at: row.at }));
  if (input.pendingWithdrawal !== undefined) {
    withdrawals.push({
      id: input.pendingWithdrawal.payoutId,
      at: input.pendingWithdrawal.requestedAt,
    });
  }
  const hits = evaluateAmlActivity(rules, {
    deposits: activity.deposits
      .filter((row) => row.at !== null)
      .map((row) => ({ atMs: row.at!.getTime(), amount: row.amount })),
    withdrawals: withdrawals.map((row) => ({ atMs: row.at.getTime() })),
    cashOuts: activity.cashOuts.map((row) => ({
      atMs: row.at.getTime(),
      placedAtMs: row.placedAt.getTime(),
    })),
  });
  for (const withdrawal of withdrawals) {
    const hit = await depositThenWithdrawHit(tx, rules, userId, withdrawal.at);
    if (hit !== null) hits.push({ ...hit, details: { ...hit.details, payoutId: withdrawal.id } });
  }

  const created: AmlFlag[] = [];
  for (const hit of hits) {
    const [flag] = await tx
      .insert(amlFlags)
      .values({
        userId,
        rule: hit.rule,
        severity: hit.severity,
        windowKey: hit.windowKey,
        details: hit.details,
        triggeredAt: new Date(hit.atMs),
        source: input.source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [amlFlags.userId, amlFlags.rule, amlFlags.windowKey] })
      .returning();
    if (flag === undefined) continue;
    created.push(flag);
    const payload = {
      flagId: flag.id,
      userId,
      rule: flag.rule,
      severity: flag.severity,
      windowKey: flag.windowKey,
      triggeredAt: flag.triggeredAt,
      source: flag.source,
    };
    await enqueueOutbox(tx, {
      type: AML_FLAG_RAISED,
      aggregateType: 'aml_flag',
      aggregateId: flag.id,
      payload,
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'aml.flag_raised',
      targetType: 'aml_flag',
      targetId: flag.id,
      metadata: { ...payload, details: flag.details },
    });
  }
  const held: string[] = [];
  if (rules.holdWithdrawalsOnHighSeverity) {
    const high = created.find((flag) => flag.severity === 'high');
    if (high !== undefined) held.push(...(await holdApprovedWithdrawals(tx, userId, high, now)));
  }
  return {
    created,
    held,
    holdWithdrawals:
      rules.holdWithdrawalsOnHighSeverity && (await hasUnresolvedHighAmlFlag(tx, userId)),
  };
}

/**
 * The worker's consumer of AML_TRIGGER_TYPES outbox events: evaluates the
 * event's player (payload.userId) in one transaction. Returns null for
 * another type or a payload without a player.
 */
export async function evaluateAmlForEvent(
  db: Database,
  input: { type: string; payload: unknown; now: Date },
): Promise<EvaluateAmlResult | null> {
  if (!AML_TRIGGER_TYPES.includes(input.type)) return null;
  const userId = (input.payload as { userId?: unknown } | null)?.userId;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
  return db.transaction((tx) =>
    evaluateAmlForUser(tx, { userId, now: input.now, source: 'event' }),
  );
}

/**
 * The daily AML sweep: evaluates every player with a deposit, withdrawal
 * request or cash-out in the look-back window (one transaction each, at
 * most `limit` players, those with the latest activity first).
 */
export async function runAmlSweep(
  db: Database,
  input: { now: Date; limit?: number },
): Promise<{ evaluated: number; flagged: number; held: number }> {
  const rules = (await loadComplianceSettings(db)).amlRules;
  if (!rules.enabled) return { evaluated: 0, flagged: 0, held: 0 };
  const from = new Date(input.now.getTime() - amlLookbackMs(rules)).toISOString();
  const to = input.now.toISOString();
  const users = await db.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id, max(at) AS last_at FROM (
      SELECT user_id, completed_at AS at FROM ${paymentIntents}
        WHERE status = 'succeeded' AND completed_at > ${from}::timestamptz AND completed_at <= ${to}::timestamptz
      UNION ALL
      SELECT user_id, requested_at FROM ${payouts}
        WHERE requested_at > ${from}::timestamptz AND requested_at <= ${to}::timestamptz
      UNION ALL
      SELECT user_id, created_at FROM ${betCashouts}
        WHERE created_at > ${from}::timestamptz AND created_at <= ${to}::timestamptz
    ) activity
    GROUP BY user_id
    ORDER BY last_at DESC
    LIMIT ${input.limit ?? 10_000}
  `);
  let flagged = 0;
  let held = 0;
  for (const { user_id: userId } of users.rows) {
    const outcome = await db.transaction((tx) =>
      evaluateAmlForUser(tx, { userId, now: input.now, source: 'sweep', rules }),
    );
    flagged += outcome.created.length;
    held += outcome.held.length;
  }
  return { evaluated: users.rows.length, flagged, held };
}

/** A review decision (aml.review). */
export type AmlReviewDecision = 'reviewed' | 'dismissed' | 'escalated';

/**
 * Records a compliance review of a flag: open → reviewed | dismissed |
 * escalated, escalated → reviewed | dismissed. The same decision again
 * returns `changed: false`; 409 `aml_flag_closed` once reviewed or
 * dismissed (or for escalating twice); 422 `note_required` without a note.
 * Audited as `aml.flag_reviewed` with the note.
 */
export async function reviewAmlFlag(
  tx: DbTransaction,
  input: {
    flagId: string;
    decision: AmlReviewDecision;
    note: string;
    actor: { adminId: string; ip?: string | null };
    now: Date;
  },
): Promise<{ flag: AmlFlag; changed: boolean }> {
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length === 0 || note.length > 2000) {
    throw domainUnprocessable('note_required', 'Write a review note (at most 2000 characters).');
  }
  if (!['reviewed', 'dismissed', 'escalated'].includes(input.decision)) {
    throw domainBadRequest(
      'invalid_decision',
      'The decision must be reviewed, dismissed or escalated.',
    );
  }
  const [flag] = UUID_RE.test(input.flagId)
    ? await tx.select().from(amlFlags).where(eq(amlFlags.id, input.flagId)).for('update')
    : [];
  if (flag === undefined) throw domainNotFound('AML flag');
  if (flag.status === input.decision) return { flag, changed: false };
  const allowed =
    flag.status === 'open' || (flag.status === 'escalated' && input.decision !== 'escalated');
  if (!allowed) {
    throw domainConflict('aml_flag_closed', 'This flag was already closed.', {
      status: flag.status,
    });
  }
  const [updated] = await tx
    .update(amlFlags)
    .set({
      status: input.decision,
      reviewedBy: input.actor.adminId,
      reviewedAt: input.now,
      reviewNote: note,
      updatedAt: input.now,
    })
    .where(eq(amlFlags.id, flag.id))
    .returning();
  if (updated === undefined) throw new Error(`AML flag ${flag.id} vanished`);
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.actor.adminId,
    action: 'aml.flag_reviewed',
    targetType: 'aml_flag',
    targetId: flag.id,
    metadata: {
      userId: flag.userId,
      rule: flag.rule,
      severity: flag.severity,
      from: flag.status,
      to: input.decision,
      note,
    },
    ip: input.actor.ip ?? null,
  });
  return { flag: updated, changed: true };
}

export interface AmlFlagQuery {
  status?: AmlFlagStatus[];
  rule?: string;
  severity?: 'low' | 'medium' | 'high';
  userId?: string;
  limit?: number;
  /** The id of the last flag of the previous page. */
  cursor?: string;
}

/** Flags newest first. */
export async function listAmlFlags(
  exec: DbExecutor,
  query: AmlFlagQuery = {},
): Promise<{ items: AmlFlag[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
  const conditions: SQL[] = [];
  if (query.status !== undefined && query.status.length > 0) {
    conditions.push(inArray(amlFlags.status, query.status));
  }
  if (query.rule !== undefined) conditions.push(eq(amlFlags.rule, query.rule));
  if (query.severity !== undefined) conditions.push(eq(amlFlags.severity, query.severity));
  if (query.userId !== undefined) {
    if (!UUID_RE.test(query.userId)) return { items: [], nextCursor: null };
    conditions.push(eq(amlFlags.userId, query.userId));
  }
  if (query.cursor !== undefined) {
    const [after] = UUID_RE.test(query.cursor)
      ? await exec
          .select({ createdAt: amlFlags.createdAt, id: amlFlags.id })
          .from(amlFlags)
          .where(eq(amlFlags.id, query.cursor))
      : [];
    if (after === undefined)
      throw domainBadRequest('invalid_cursor', 'This page cursor is not valid.');
    conditions.push(
      sql`(${amlFlags.createdAt}, ${amlFlags.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const rows = await exec
    .select()
    .from(amlFlags)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(amlFlags.createdAt), desc(amlFlags.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null };
}

/** One flag, with the player's other flags and the withdrawals waiting for an AML review. */
export async function getAmlFlag(
  exec: DbExecutor,
  flagId: string,
): Promise<{ flag: AmlFlag; otherFlags: AmlFlag[]; heldWithdrawals: string[] }> {
  const [flag] = UUID_RE.test(flagId)
    ? await exec.select().from(amlFlags).where(eq(amlFlags.id, flagId))
    : [];
  if (flag === undefined) throw domainNotFound('AML flag');
  const otherFlags = await exec
    .select()
    .from(amlFlags)
    .where(and(eq(amlFlags.userId, flag.userId), ne(amlFlags.id, flag.id)))
    .orderBy(desc(amlFlags.createdAt))
    .limit(50);
  const held = await exec
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(
        eq(payouts.userId, flag.userId),
        eq(payouts.status, 'requested'),
        eq(payouts.reviewReason, AML_REVIEW_REASON),
      ),
    )
    .orderBy(asc(payouts.requestedAt));
  return { flag, otherFlags, heldWithdrawals: held.map((row) => row.id) };
}
