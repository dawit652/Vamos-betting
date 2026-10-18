import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { resolveFlaggedDeposit, type DepositResolution } from '../payments/deposits';
import type { PaymentIntent, Payout, PayoutStatus } from '../payments/types';
import {
  approveWithdrawal,
  clearPayoutFlag,
  flagPayoutForStaff,
  markPayoutFailed,
  markPayoutPaid,
  rejectWithdrawal,
  type PayoutChange,
} from '../payments/withdrawals';
import { kycProfiles, users } from '../schema/accounts';
import { paymentIntents, payouts } from '../schema/payments';
import {
  afterCursor,
  cursorTime,
  decodeCursor,
  encodeCursor,
  pageLimit,
  type Page,
  type StaffActor,
} from './common';
import type { KycStatus, PlayerStatus } from './players';

/**
 * Withdrawals and flagged payments in the back office (withdrawals.approve
 * for every change; bets.view-level staff may read). Every change goes
 * through the Phase 6 payment services, which post to the ledger, write the
 * outbox event and the audit record (staff actor) in the caller's
 * transaction; these wrappers only check the input and name the staff
 * member. Approved payouts are sent by the payout worker.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 500;

/** The player behind a payment, for the reviewer. */
export interface PaymentPlayer {
  phone: string;
  fullName: string | null;
  status: PlayerStatus;
  kycStatus: KycStatus;
}

export interface StaffPayout extends Payout {
  player: PaymentPlayer;
}

export interface StaffDeposit extends PaymentIntent {
  player: PaymentPlayer;
}

export interface StaffPayoutFilter {
  statuses?: PayoutStatus[];
  /** true: flagged only; false: unflagged only. */
  flagged?: boolean;
  userId?: string;
  /** 'asc' (default, a queue: oldest request first) or 'desc'. */
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

const playerFields = {
  playerPhone: users.phone,
  playerName: users.fullName,
  playerStatus: users.status,
  playerKyc: sql<KycStatus>`COALESCE(${kycProfiles.status}, 'unverified')`,
};

function withPlayer<T extends object>(
  row: T & {
    playerPhone: string;
    playerName: string | null;
    playerStatus: PlayerStatus;
    playerKyc: KycStatus;
  },
): T & { player: PaymentPlayer } {
  const { playerPhone, playerName, playerStatus, playerKyc, ...rest } = row;
  return {
    ...(rest as unknown as T),
    player: {
      phone: playerPhone,
      fullName: playerName,
      status: playerStatus,
      kycStatus: playerKyc,
    },
  };
}

/**
 * Withdrawals for the back office (cursor paging by request time): the
 * review queue is `statuses: ['requested']`, the flagged queue
 * `flagged: true`.
 */
export async function listStaffWithdrawals(
  exec: DbExecutor,
  filter: StaffPayoutFilter = {},
): Promise<Page<StaffPayout>> {
  const limit = pageLimit(filter.limit, 50, 200);
  const desc_ = filter.order === 'desc';
  const conditions: SQL[] = [];
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    conditions.push(inArray(payouts.status, filter.statuses));
  }
  if (filter.flagged === true) conditions.push(isNotNull(payouts.flaggedAt));
  if (filter.flagged === false) conditions.push(sql`${payouts.flaggedAt} IS NULL`);
  if (filter.userId !== undefined) {
    if (!UUID_RE.test(filter.userId)) return { items: [], nextCursor: null };
    conditions.push(eq(payouts.userId, filter.userId));
  }
  if (filter.cursor !== undefined) {
    conditions.push(
      afterCursor(
        payouts.requestedAt,
        payouts.id,
        decodeCursor(filter.cursor),
        desc_ ? 'desc' : 'asc',
      ),
    );
  }
  const rows = await exec
    .select({ payout: payouts, cursorAt: cursorTime(payouts.requestedAt), ...playerFields })
    .from(payouts)
    .innerJoin(users, eq(users.id, payouts.userId))
    .leftJoin(kycProfiles, eq(kycProfiles.userId, payouts.userId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      desc_ ? desc(payouts.requestedAt) : asc(payouts.requestedAt),
      desc_ ? desc(payouts.id) : asc(payouts.id),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ payout, cursorAt: _cursorAt, ...player }) =>
      withPlayer({ ...payout, ...player }),
    ),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.cursorAt, id: last.payout.id })
        : null,
  };
}

/** One withdrawal with its player, or null. */
export async function getStaffWithdrawal(
  exec: DbExecutor,
  payoutId: string,
): Promise<StaffPayout | null> {
  if (!UUID_RE.test(payoutId)) return null;
  const [row] = await exec
    .select({ payout: payouts, ...playerFields })
    .from(payouts)
    .innerJoin(users, eq(users.id, payouts.userId))
    .leftJoin(kycProfiles, eq(kycProfiles.userId, payouts.userId))
    .where(eq(payouts.id, payoutId));
  if (row === undefined) return null;
  const { payout, ...player } = row;
  return withPlayer({ ...payout, ...player });
}

/** Flagged deposits (waiting for staff), oldest flag first. */
export async function listFlaggedDeposits(
  exec: DbExecutor,
  options: { limit?: number } = {},
): Promise<StaffDeposit[]> {
  const rows = await exec
    .select({ intent: paymentIntents, ...playerFields })
    .from(paymentIntents)
    .innerJoin(users, eq(users.id, paymentIntents.userId))
    .leftJoin(kycProfiles, eq(kycProfiles.userId, paymentIntents.userId))
    .where(isNotNull(paymentIntents.flaggedAt))
    .orderBy(asc(paymentIntents.flaggedAt), asc(paymentIntents.id))
    .limit(pageLimit(options.limit, 50, 200));
  return rows.map(({ intent, ...player }) => withPlayer({ ...intent, ...player }));
}

function checkedId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw domainNotFound(what);
  return id;
}

function checkedActor(actor: StaffActor): StaffActor {
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a payment change needs the admin id');
  }
  return actor;
}

function requiredNote(text: string | undefined, code: string, message: string): string {
  const note = text?.trim() ?? '';
  if (note.length === 0) throw domainUnprocessable(code, message);
  return note.slice(0, MAX_NOTE_LENGTH);
}

/**
 * Finance approves a withdrawal waiting for review (`requested` →
 * `approved`; the payout worker then sends it). Already approved, being
 * processed or paid: `changed: false`; 409 `payout_not_reviewable` once
 * rejected, cancelled or failed; 409 `aml_review_pending` while the player's
 * withdrawals are held for AML, unless the approver holds aml.review
 * (`amlReviewer`). Audited as `payment.withdrawal_approved`.
 */
export async function staffApproveWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; actor: StaffActor; now: Date; amlReviewer?: boolean },
): Promise<PayoutChange> {
  const actor = checkedActor(input.actor);
  return approveWithdrawal(tx, {
    payoutId: checkedId(input.payoutId, 'Withdrawal'),
    adminId: actor.adminId,
    now: input.now,
    ip: actor.ip ?? null,
    amlReviewer: input.amlReviewer === true,
  });
}

/**
 * Finance rejects a withdrawal that has not been sent (`requested` or
 * `approved`): the hold goes back to the player (`withdrawal_reversal`).
 * 422 `reason_required`; 409 `payout_not_reviewable` once processing.
 * Audited as `payment.withdrawal_rejected`.
 */
export async function staffRejectWithdrawal(
  tx: DbTransaction,
  input: { payoutId: string; reason: string; actor: StaffActor; now: Date },
): Promise<PayoutChange> {
  const actor = checkedActor(input.actor);
  const reason = requiredNote(input.reason, 'reason_required', 'Say why it is rejected.');
  return rejectWithdrawal(tx, {
    payoutId: checkedId(input.payoutId, 'Withdrawal'),
    adminId: actor.adminId,
    reason,
    now: input.now,
    ip: actor.ip ?? null,
  });
}

/**
 * Finance takes an approved or processing payout over (`staff_review`):
 * the worker leaves it alone until it is settled or the flag is cleared.
 * 422 `note_required`.
 */
export async function staffFlagPayout(
  tx: DbTransaction,
  input: { payoutId: string; note: string; actor: StaffActor; now: Date },
): Promise<PayoutChange> {
  const actor = checkedActor(input.actor);
  const note = requiredNote(input.note, 'note_required', 'Add a note for the audit log.');
  return flagPayoutForStaff(tx, {
    payoutId: checkedId(input.payoutId, 'Withdrawal'),
    adminId: actor.adminId,
    note,
    now: input.now,
    ip: actor.ip ?? null,
  });
}

/** Finance clears a payout's flag (an open payout goes back to the worker). 422 `note_required`. */
export async function staffClearPayoutFlag(
  tx: DbTransaction,
  input: { payoutId: string; note: string; actor: StaffActor; now: Date },
): Promise<PayoutChange> {
  const actor = checkedActor(input.actor);
  const note = requiredNote(input.note, 'note_required', 'Add a note for the audit log.');
  return clearPayoutFlag(tx, {
    payoutId: checkedId(input.payoutId, 'Withdrawal'),
    adminId: actor.adminId,
    note,
    now: input.now,
    ip: actor.ip ?? null,
  });
}

/**
 * Finance settles a flagged payout after checking with the provider:
 * `paid` (the hold moves to the provider's clearing account; an optional
 * provider reference must match one already stored) or `failed` (no money
 * left: the hold goes back to the player; a reason is required, 422
 * `reason_required`). A processing payout must be flagged first (409
 * `payout_in_progress`). Repeating it is a no-op.
 */
export async function staffSettlePayout(
  tx: DbTransaction,
  input: {
    payoutId: string;
    outcome: 'paid' | 'failed';
    providerRef?: string;
    reason?: string;
    actor: StaffActor;
    now: Date;
  },
): Promise<PayoutChange> {
  const actor = checkedActor(input.actor);
  const payoutId = checkedId(input.payoutId, 'Withdrawal');
  const admin = { adminId: actor.adminId, ip: actor.ip ?? null };
  if (input.outcome === 'paid') {
    const providerRef = input.providerRef?.trim();
    return markPayoutPaid(tx, {
      payoutId,
      now: input.now,
      admin,
      ...(providerRef === undefined || providerRef.length === 0 ? {} : { providerRef }),
    });
  }
  const reason = requiredNote(input.reason, 'reason_required', 'Say why the payout failed.');
  return markPayoutFailed(tx, { payoutId, reason, now: input.now, admin });
}

/**
 * Finance resolves a flagged deposit (resolveFlaggedDeposit): `credit`
 * when the provider did collect it, `close` otherwise. 422 `note_required`;
 * 409 `deposit_not_flagged` / `deposit_already_credited`.
 */
export async function staffResolveDeposit(
  tx: DbTransaction,
  input: {
    intentId: string;
    resolution: DepositResolution;
    note: string;
    actor: StaffActor;
    now: Date;
  },
): Promise<PaymentIntent> {
  const actor = checkedActor(input.actor);
  const note = requiredNote(input.note, 'note_required', 'Add a note for the audit log.');
  return resolveFlaggedDeposit(tx, {
    intentId: checkedId(input.intentId, 'Deposit'),
    adminId: actor.adminId,
    resolution: input.resolution,
    note,
    now: input.now,
    ip: actor.ip ?? null,
  });
}
