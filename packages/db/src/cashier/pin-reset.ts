import { createHash, randomInt } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../catalog/errors';
import { domainConflict, domainForbidden, domainNotFound, domainTooManyRequests } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { adminUsers, kycProfiles, users } from '../schema/accounts';
import { cashPinResets, cashPinResetTries, pinResetStarts } from '../schema/cashier';

/**
 * Cashier phase "assisted PIN reset" (owner's default of 18 Nov 2026; redesigned after the review of
 * 18 Nov), for a player without SMS or Telegram. The player starts on their own phone ("Forgot
 * PIN", "Reset at a shop"): the browser keeps a random secret, sends only its hash and shows a desk
 * code. The cashier types that desk code and the number on the ID card, which must match the
 * verified KYC record (keyed hash); a supervisor approves (four eyes: not the cashier who asked);
 * then only the browser that proves the secret sets the new PIN. The desk never sees a code that
 * sets a PIN, and never the PIN.
 */
export type DeskPinReset = typeof cashPinResets.$inferSelect;
export type PinResetStart = typeof pinResetStarts.$inferSelect;

export const PIN_RESET_AUDIT = {
  requested: 'cashier.pin_reset_requested',
  /** A desk code or ID number that matched no verified ID of the player (a try of the day). */
  idMismatch: 'cashier.pin_reset_id_mismatch',
  approved: 'cashier.pin_reset_approved',
  rejected: 'cashier.pin_reset_rejected',
  /** The player's browser set the new PIN. */
  issued: 'cashier.pin_reset_issued',
} as const;

/** An approved request is used by the player's browser within this time, or asked again. */
export const PIN_RESET_ISSUE_WINDOW_MS = 30 * 60_000;
/** A request nobody decided within this time expires (a new one may be asked). */
export const PIN_RESET_REQUEST_TTL_MS = 24 * 3_600_000;
/** A start is taken to a shop within this time. */
export const PIN_RESET_START_TTL_MS = 24 * 3_600_000;
/**
 * Starts in a rolling hour: per number and client address, per number, per client address. The
 * last is loose: many phones share one carrier address (CGNAT).
 */
export const PIN_RESET_START_LIMITS = { phoneRequester: 3, phone: 10, requester: 60 } as const;
/** Wrong desk codes or ID numbers per player in a rolling 24 hours (review of 18 Nov). */
export const PIN_RESET_WRONG_TRIES_PER_DAY = 5;

/** SHA-256 (hex) of the browser's secret, as the browser computes it (UTF-8 text). */
export function pinResetSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const startLimit = () =>
  domainTooManyRequests(
    'pin_reset_limit',
    'Too many PIN reset requests for this number. Try again in an hour.',
  );

/**
 * The player starts a PIN reset at a shop on their own phone: stores the hash of the browser's
 * secret and returns the start with its desk code (eight digits, unique among waiting starts).
 * The answer is the same whether or not the number has an account. 429 `pin_reset_limit` past
 * PIN_RESET_START_LIMITS in a rolling hour; 409 `pin_reset_secret_used` when the hash is known.
 */
export async function startShopPinReset(
  tx: DbTransaction,
  input: { phone: string; secretHash: string; requesterKey: string | null; now: Date },
): Promise<PinResetStart> {
  // The number's starts one at a time, so the hourly counts are exact.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pin_reset_start:${input.phone}`}, 0))`,
  );
  const hourAgo = new Date(input.now.getTime() - 3_600_000);
  const recent = async (...conditions: ReturnType<typeof eq>[]) => {
    const [row] = await tx
      .select({ n: count() })
      .from(pinResetStarts)
      .where(and(gt(pinResetStarts.createdAt, hourAgo), ...conditions));
    return row?.n ?? 0;
  };
  if ((await recent(eq(pinResetStarts.phone, input.phone))) >= PIN_RESET_START_LIMITS.phone) {
    throw startLimit();
  }
  if (input.requesterKey !== null) {
    const byRequester = eq(pinResetStarts.requesterKey, input.requesterKey);
    if (
      (await recent(byRequester)) >= PIN_RESET_START_LIMITS.requester ||
      (await recent(byRequester, eq(pinResetStarts.phone, input.phone))) >=
        PIN_RESET_START_LIMITS.phoneRequester
    ) {
      throw startLimit();
    }
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deskCode = String(randomInt(0, 100_000_000)).padStart(8, '0');
    try {
      const [row] = await tx.transaction((sp) =>
        sp
          .insert(pinResetStarts)
          .values({
            phone: input.phone,
            secretHash: input.secretHash,
            deskCode,
            status: 'waiting',
            requesterKey: input.requesterKey,
            createdAt: input.now,
            expiresAt: new Date(input.now.getTime() + PIN_RESET_START_TTL_MS),
          })
          .returning(),
      );
      if (!row) throw new Error('pin reset start insert returned no row');
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'pin_reset_starts_secret_uq')) {
        throw domainConflict('pin_reset_secret_used', 'Start the PIN reset again.');
      }
      if (!isUniqueViolation(error, 'pin_reset_starts_desk_code_uq')) throw error;
      // Taken by a waiting start: an expired one gives the code up; the next try draws anew.
      await tx
        .update(pinResetStarts)
        .set({ status: 'closed' })
        .where(
          and(
            eq(pinResetStarts.deskCode, deskCode),
            eq(pinResetStarts.status, 'waiting'),
            lte(pinResetStarts.expiresAt, input.now),
          ),
        );
    }
  }
  throw new Error('no free desk code after 5 tries');
}

/** Wrong desk codes or ID numbers for the player in the last 24 hours (on the app's clock). */
async function wrongTriesToday(tx: DbTransaction, userId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(cashPinResetTries)
    .where(
      and(
        eq(cashPinResetTries.userId, userId),
        gt(cashPinResetTries.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The cashier asks a PIN reset for the player in front of them: `deskCode` from the player's phone
 * (a waiting start of the player's number) and `idNumberHash`, the keyed hash of the number on the
 * ID card (the API computes it as KYC does). A wrong desk code, no verified ID and a wrong ID number
 * get one answer, `no_match` (the review of 18 Nov: the desk learns nothing about the KYC record):
 * a try of the day is recorded (audited) and the caller answers 422 `pin_reset_no_match`. 429
 * `pin_reset_limit` after PIN_RESET_WRONG_TRIES_PER_DAY wrong tries in 24 hours; 409
 * `pin_reset_open` when one is waiting. A stale one (approved longer than PIN_RESET_ISSUE_WINDOW_MS
 * ago, or undecided after PIN_RESET_REQUEST_TTL_MS) expires first. Only an active account. Audited.
 */
export async function requestDeskPinReset(
  tx: DbTransaction,
  input: {
    userId: string;
    staffId: string;
    shopId: string | null;
    deskCode: string;
    idNumberHash: string;
    now: Date;
    ip?: string | null;
  },
): Promise<{ outcome: 'requested'; reset: DeskPinReset } | { outcome: 'no_match' }> {
  // The player's row locked: their tries are counted one at a time.
  const [player] = await tx
    .select({ status: users.status, phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update');
  if (!player) throw domainNotFound('Player');
  if (player.status !== 'active') {
    throw domainConflict('account_disabled', 'This account cannot be served.');
  }
  if ((await wrongTriesToday(tx, input.userId, input.now)) >= PIN_RESET_WRONG_TRIES_PER_DAY) {
    throw domainTooManyRequests(
      'pin_reset_limit',
      'Too many wrong desk codes or ID numbers for this player today. Try again tomorrow.',
    );
  }
  await tx
    .update(cashPinResets)
    .set({ status: 'expired' })
    .where(
      and(
        eq(cashPinResets.userId, input.userId),
        or(
          and(
            eq(cashPinResets.status, 'approved'),
            lt(cashPinResets.approvedAt, new Date(input.now.getTime() - PIN_RESET_ISSUE_WINDOW_MS)),
          ),
          and(
            eq(cashPinResets.status, 'requested'),
            lt(cashPinResets.createdAt, new Date(input.now.getTime() - PIN_RESET_REQUEST_TTL_MS)),
          ),
        ),
      ),
    );
  if ((await findOpenDeskPinReset(tx, input.userId)) !== null) {
    throw domainConflict('pin_reset_open', 'A PIN reset is already waiting for this player.');
  }
  const [kyc] = await tx
    .select({ status: kycProfiles.status, idNumberHash: kycProfiles.idNumberHash })
    .from(kycProfiles)
    .where(eq(kycProfiles.userId, input.userId));
  const [start] = await tx
    .select()
    .from(pinResetStarts)
    .where(
      and(
        eq(pinResetStarts.deskCode, input.deskCode),
        eq(pinResetStarts.status, 'waiting'),
        eq(pinResetStarts.phone, player.phone),
        gt(pinResetStarts.expiresAt, input.now),
      ),
    )
    .for('update');
  const verified =
    kyc !== undefined &&
    kyc.status === 'verified' &&
    kyc.idNumberHash !== null &&
    kyc.idNumberHash === input.idNumberHash;
  if (start === undefined || !verified) {
    // Why stays in the record (staff with audit access), never in the desk's answer.
    const reason =
      start === undefined
        ? 'desk_code'
        : kyc === undefined || kyc.status !== 'verified' || kyc.idNumberHash === null
          ? 'no_verified_id'
          : 'id_number';
    await tx.insert(cashPinResetTries).values({
      userId: input.userId,
      staffId: input.staffId,
      shopId: input.shopId,
      reason,
      createdAt: input.now,
    });
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: input.staffId,
      action: PIN_RESET_AUDIT.idMismatch,
      targetType: 'user',
      targetId: input.userId,
      metadata: { reason, shopId: input.shopId },
      ip: input.ip ?? null,
    });
    return { outcome: 'no_match' };
  }
  let created: DeskPinReset | undefined;
  try {
    [created] = await tx.transaction((sp) =>
      sp
        .insert(cashPinResets)
        .values({
          userId: input.userId,
          shopId: input.shopId,
          requestedBy: input.staffId,
          status: 'requested',
          createdAt: input.now,
          startId: start.id,
        })
        .returning(),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'cash_pin_resets_open_uq')) {
      throw domainConflict('pin_reset_open', 'A PIN reset is already waiting for this player.');
    }
    throw error;
  }
  if (!created) throw new Error('pin reset insert returned no row');
  await tx.update(pinResetStarts).set({ status: 'linked' }).where(eq(pinResetStarts.id, start.id));
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: PIN_RESET_AUDIT.requested,
    targetType: 'user',
    targetId: input.userId,
    metadata: { resetId: created.id, shopId: input.shopId, startId: start.id },
    ip: input.ip ?? null,
  });
  return { outcome: 'requested', reset: created };
}

async function lockReset(tx: DbTransaction, resetId: string): Promise<DeskPinReset> {
  const [row] = await tx
    .select()
    .from(cashPinResets)
    .where(eq(cashPinResets.id, resetId))
    .for('update');
  if (!row) throw domainNotFound('PIN reset');
  return row;
}

/**
 * A supervisor approves (`approve: true`) or rejects a waiting request; never the cashier who asked
 * (403 `cashier_four_eyes`); only a `requested` one (409 `pin_reset_not_waiting`). Audited.
 */
export async function decideDeskPinReset(
  tx: DbTransaction,
  input: { resetId: string; supervisorId: string; approve: boolean; now: Date; ip?: string | null },
): Promise<DeskPinReset> {
  const reset = await lockReset(tx, input.resetId);
  if (reset.status !== 'requested') {
    throw domainConflict('pin_reset_not_waiting', 'This PIN reset is not waiting for a decision.');
  }
  if (reset.requestedBy === input.supervisorId) {
    throw domainForbidden('cashier_four_eyes', 'Another supervisor must decide your own request.');
  }
  const [updated] = await tx
    .update(cashPinResets)
    .set(
      input.approve
        ? { status: 'approved', approvedBy: input.supervisorId, approvedAt: input.now }
        : { status: 'rejected', approvedBy: input.supervisorId, approvedAt: input.now },
    )
    .where(eq(cashPinResets.id, reset.id))
    .returning();
  if (!updated) throw new Error('pin reset update returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.supervisorId,
    action: input.approve ? PIN_RESET_AUDIT.approved : PIN_RESET_AUDIT.rejected,
    targetType: 'user',
    targetId: reset.userId,
    metadata: { resetId: reset.id },
    ip: input.ip ?? null,
  });
  return updated;
}

/** What the player's phone shows about its start. */
export type ShopPinResetState =
  'waiting_desk' | 'waiting_approval' | 'approved' | 'rejected' | 'expired' | 'done';

/**
 * Where the start of this secret is (the player's phone polls it), with its desk code and until
 * when the current step lasts; null for an unknown secret.
 */
export async function shopPinResetStatus(
  exec: DbExecutor,
  input: { secretHash: string; now: Date },
): Promise<{
  state: ShopPinResetState;
  deskCode: string;
  until: Date | null;
  /** The number it was started for (never sent to the browser). */
  phone: string;
} | null> {
  const [start] = await exec
    .select()
    .from(pinResetStarts)
    .where(eq(pinResetStarts.secretHash, input.secretHash));
  if (!start) return null;
  const now = input.now.getTime();
  const at = (state: ShopPinResetState, until: Date | null = null) => ({
    state,
    deskCode: start.deskCode,
    until,
    phone: start.phone,
  });
  if (start.status === 'done') return at('done');
  if (start.status === 'closed') return at('expired');
  if (start.status === 'waiting') {
    return start.expiresAt.getTime() > now ? at('waiting_desk', start.expiresAt) : at('expired');
  }
  const [reset] = await exec
    .select()
    .from(cashPinResets)
    .where(eq(cashPinResets.startId, start.id));
  if (!reset) return at('expired');
  switch (reset.status) {
    case 'requested': {
      const until = new Date(reset.createdAt.getTime() + PIN_RESET_REQUEST_TTL_MS);
      return until.getTime() > now ? at('waiting_approval', until) : at('expired');
    }
    case 'approved': {
      const until = new Date(
        (reset.approvedAt ?? reset.createdAt).getTime() + PIN_RESET_ISSUE_WINDOW_MS,
      );
      return until.getTime() > now ? at('approved', until) : at('expired');
    }
    case 'rejected':
      return at('rejected');
    case 'issued':
      return at('done');
    default:
      return at('expired');
  }
}

/**
 * The player's browser, proving the secret, takes its approved reset: within
 * PIN_RESET_ISSUE_WINDOW_MS of the approval, else the reset is marked expired and `expired` is
 * returned (a result, not an error, so the mark commits; the caller answers 409 after). Marks the
 * reset issued and the start done, audited, and returns the player; the caller sets the new PIN in
 * the same transaction. 404 for an unknown secret, 409 `pin_reset_used` once done, 409
 * `pin_reset_not_approved` before the approval or after a rejection.
 */
export async function completeShopPinReset(
  tx: DbTransaction,
  input: { secretHash: string; now: Date; ip?: string | null },
): Promise<
  { outcome: 'ready'; userId: string; phone: string; resetId: string } | { outcome: 'expired' }
> {
  const [start] = await tx
    .select()
    .from(pinResetStarts)
    .where(eq(pinResetStarts.secretHash, input.secretHash))
    .for('update');
  if (!start) throw domainNotFound('PIN reset');
  if (start.status === 'done') {
    throw domainConflict('pin_reset_used', 'This PIN reset was used already.');
  }
  const notApproved = () =>
    domainConflict('pin_reset_not_approved', 'This PIN reset is not approved.');
  if (start.status !== 'linked') throw notApproved();
  const [reset] = await tx
    .select()
    .from(cashPinResets)
    .where(eq(cashPinResets.startId, start.id))
    .for('update');
  if (!reset || reset.status !== 'approved' || reset.approvedAt === null) throw notApproved();
  if (input.now.getTime() - reset.approvedAt.getTime() > PIN_RESET_ISSUE_WINDOW_MS) {
    await tx.update(cashPinResets).set({ status: 'expired' }).where(eq(cashPinResets.id, reset.id));
    return { outcome: 'expired' };
  }
  const [player] = await tx
    .select({ phone: users.phone, status: users.status })
    .from(users)
    .where(eq(users.id, reset.userId))
    .for('update');
  // The number the player started with must still be the account's.
  if (!player || player.status !== 'active' || player.phone !== start.phone) {
    throw domainConflict('account_disabled', 'This account cannot be served.');
  }
  await tx
    .update(cashPinResets)
    .set({ status: 'issued', issuedAt: input.now })
    .where(eq(cashPinResets.id, reset.id));
  await tx
    .update(pinResetStarts)
    .set({ status: 'done', completedAt: input.now })
    .where(eq(pinResetStarts.id, start.id));
  await writeAudit(tx, {
    actorType: 'user',
    actorId: reset.userId,
    action: PIN_RESET_AUDIT.issued,
    targetType: 'user',
    targetId: reset.userId,
    metadata: { resetId: reset.id, startId: start.id, shopId: reset.shopId },
    ip: input.ip ?? null,
  });
  return { outcome: 'ready', userId: reset.userId, phone: player.phone, resetId: reset.id };
}

/** Requests waiting for a decision, or approved and not yet issued, oldest first, with names. */
export async function listOpenDeskPinResets(
  exec: DbExecutor,
): Promise<Array<DeskPinReset & { playerPhone: string; requestedByName: string }>> {
  return exec
    .select({
      id: cashPinResets.id,
      userId: cashPinResets.userId,
      shopId: cashPinResets.shopId,
      requestedBy: cashPinResets.requestedBy,
      status: cashPinResets.status,
      approvedBy: cashPinResets.approvedBy,
      approvedAt: cashPinResets.approvedAt,
      issuedAt: cashPinResets.issuedAt,
      createdAt: cashPinResets.createdAt,
      startId: cashPinResets.startId,
      playerPhone: users.phone,
      requestedByName: adminUsers.displayName,
    })
    .from(cashPinResets)
    .innerJoin(users, eq(users.id, cashPinResets.userId))
    .innerJoin(adminUsers, eq(adminUsers.id, cashPinResets.requestedBy))
    .where(inArray(cashPinResets.status, ['requested', 'approved']))
    .orderBy(asc(cashPinResets.createdAt), asc(cashPinResets.id));
}

/** The player's open request at the desk (requested or approved), if any. */
export async function findOpenDeskPinReset(
  exec: DbExecutor,
  userId: string,
): Promise<DeskPinReset | null> {
  const [row] = await exec
    .select()
    .from(cashPinResets)
    .where(
      and(
        eq(cashPinResets.userId, userId),
        inArray(cashPinResets.status, ['requested', 'approved']),
      ),
    );
  return row ?? null;
}
