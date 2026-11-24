import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  completeShopPinReset,
  decideDeskPinReset,
  findOpenDeskPinReset,
  listOpenDeskPinResets,
  PIN_RESET_ISSUE_WINDOW_MS,
  PIN_RESET_START_LIMITS,
  PIN_RESET_START_TTL_MS,
  PIN_RESET_WRONG_TRIES_PER_DAY,
  pinResetSecretHash,
  requestDeskPinReset,
  shopPinResetStatus,
  startShopPinReset,
} from '../src/cashier/index';
import { DomainError } from '../src/errors';
import { adminUsers, auditLog, cashPinResets, kycProfiles } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, NOW } from './payments-fixtures';

/**
 * Cashier phase "assisted PIN reset", redesigned after the review of 18 Nov: the player's phone
 * starts (a secret's hash, a desk code), the desk links it with the ID check (one answer for every
 * mismatch, five wrong tries a day), four eyes, and only the secret's browser completes.
 */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function staff(role: 'cashier' | 'finance' | 'compliance' = 'cashier'): Promise<string> {
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `${role}-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: `Test ${role}`,
      role,
    })
    .returning({ id: adminUsers.id });
  return row!.id;
}

/** A verified player whose ID number hashes to `idHash`. */
async function verifiedPlayer(idHash: string): Promise<{ userId: string; phone: string }> {
  const player = await createPlayer(handle.db, { kyc: 'verified', name: 'Abebe K.' });
  await handle.db
    .update(kycProfiles)
    .set({ idNumberHash: idHash })
    .where(eq(kycProfiles.userId, player.userId));
  return player;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.statusCode, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

const start = (phone: string, secret: string, now = NOW, requesterKey: string | null = null) =>
  handle.db.transaction((tx) =>
    startShopPinReset(tx, { phone, secretHash: pinResetSecretHash(secret), requesterKey, now }),
  );

const ask = (userId: string, staffId: string, deskCode: string, idNumberHash: string, now = NOW) =>
  handle.db.transaction((tx) =>
    requestDeskPinReset(tx, { userId, staffId, shopId: null, deskCode, idNumberHash, now }),
  );

const status = (secret: string, now = NOW) =>
  shopPinResetStatus(handle.db, { secretHash: pinResetSecretHash(secret), now });

const complete = (secret: string, now = NOW) =>
  handle.db.transaction((tx) =>
    completeShopPinReset(tx, { secretHash: pinResetSecretHash(secret), now }),
  );

const decide = (resetId: string, supervisorId: string, approve = true) =>
  handle.db.transaction((tx) =>
    decideDeskPinReset(tx, { resetId, supervisorId, approve, now: NOW }),
  );

async function requested(result: Awaited<ReturnType<typeof ask>>) {
  if (result.outcome !== 'requested') throw new Error(`expected requested, got ${result.outcome}`);
  return result.reset;
}

async function mismatchReasons(userId: string): Promise<unknown[]> {
  const rows = await handle.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(eq(auditLog.targetId, userId), eq(auditLog.action, 'cashier.pin_reset_id_mismatch')),
    );
  return rows.map((r) => (r.metadata as { reason: string }).reason);
}

describe('assisted PIN reset at a shop', () => {
  it("links the phone's start at the desk, needs another supervisor, completes once from the secret", async () => {
    const cashier = await staff();
    const supervisor = await staff('compliance');
    const hash = `id-${randomUUID()}`;
    const { userId, phone } = await verifiedPlayer(hash);
    const secret = `secret-${randomUUID()}`;

    const started = await start(phone, secret);
    expect(started.deskCode).toMatch(/^\d{8}$/);
    expect(started.secretHash).toBe(pinResetSecretHash(secret));
    expect(await status(secret)).toEqual({
      state: 'waiting_desk',
      deskCode: started.deskCode,
      until: started.expiresAt,
      phone,
    });
    expect(await status('another secret')).toBeNull();

    // A wrong desk code and a wrong ID number get the same answer, each a try on record.
    const otherCode = started.deskCode === '00000000' ? '00000001' : '00000000';
    expect(await ask(userId, cashier, otherCode, hash)).toEqual({ outcome: 'no_match' });
    expect(await ask(userId, cashier, started.deskCode, 'id-other')).toEqual({
      outcome: 'no_match',
    });
    expect(await mismatchReasons(userId)).toEqual(
      expect.arrayContaining(['desk_code', 'id_number']),
    );

    const reset = await requested(await ask(userId, cashier, started.deskCode, hash));
    expect(reset).toMatchObject({ status: 'requested', startId: started.id });
    expect((await status(secret))?.state).toBe('waiting_approval');
    expect(await refusal(ask(userId, cashier, started.deskCode, hash))).toEqual({
      status: 409,
      code: 'pin_reset_open',
    });
    expect((await findOpenDeskPinReset(handle.db, userId))?.id).toBe(reset.id);
    expect((await listOpenDeskPinResets(handle.db)).map((r) => r.id)).toContain(reset.id);

    // Not before the approval; the cashier who asked cannot approve.
    expect(await refusal(complete(secret))).toEqual({
      status: 409,
      code: 'pin_reset_not_approved',
    });
    expect(await refusal(decide(reset.id, cashier))).toEqual({
      status: 403,
      code: 'cashier_four_eyes',
    });
    expect((await decide(reset.id, supervisor)).status).toBe('approved');
    expect((await status(secret))?.state).toBe('approved');

    // Only the secret completes it, once; the desk never gets anything that sets a PIN.
    expect(await refusal(complete('a guessed secret'))).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await complete(secret)).toEqual({
      outcome: 'ready',
      userId,
      phone,
      resetId: reset.id,
    });
    expect((await status(secret))?.state).toBe('done');
    expect(await refusal(complete(secret))).toEqual({ status: 409, code: 'pin_reset_used' });
    const [row] = await handle.db
      .select()
      .from(cashPinResets)
      .where(eq(cashPinResets.id, reset.id));
    expect(row).toMatchObject({ status: 'issued' });
    const audits = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, userId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'cashier.pin_reset_requested',
        'cashier.pin_reset_approved',
        'cashier.pin_reset_issued',
      ]),
    );
    expect(await findOpenDeskPinReset(handle.db, userId)).toBeNull();
  });

  it('answers a player without a verified ID like a wrong ID; five wrong tries a day', async () => {
    const cashier = await staff();
    const unverified = await createPlayer(handle.db);
    const first = await start(unverified.phone, `secret-${randomUUID()}`);
    expect(await ask(unverified.userId, cashier, first.deskCode, 'id-x')).toEqual({
      outcome: 'no_match',
    });
    expect(await mismatchReasons(unverified.userId)).toEqual(['no_verified_id']);

    const hash = `id-${randomUUID()}`;
    const { userId, phone } = await verifiedPlayer(hash);
    const own = await start(phone, `secret-${randomUUID()}`);
    for (let i = 0; i < PIN_RESET_WRONG_TRIES_PER_DAY; i += 1) {
      expect(await ask(userId, cashier, own.deskCode, `id-wrong-${i}`)).toEqual({
        outcome: 'no_match',
      });
    }
    // Used up: even the right desk code and ID wait for tomorrow.
    expect(await refusal(ask(userId, cashier, own.deskCode, hash))).toEqual({
      status: 429,
      code: 'pin_reset_limit',
    });
    const tomorrow = new Date(NOW.getTime() + 25 * 3_600_000);
    const later = await start(phone, `secret-${randomUUID()}`, tomorrow);
    expect((await ask(userId, cashier, later.deskCode, hash, tomorrow)).outcome).toBe('requested');
  });

  it('lets an approval and a start expire; a start of another number never links', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const hash = `id-${randomUUID()}`;
    const { userId, phone } = await verifiedPlayer(hash);
    const stranger = await createPlayer(handle.db);

    // Someone else's start (another number) cannot be used for this player.
    const theirs = await start(stranger.phone, `secret-${randomUUID()}`);
    expect(await ask(userId, cashier, theirs.deskCode, hash)).toEqual({ outcome: 'no_match' });

    // A start not taken to a shop in time.
    const oldSecret = `secret-${randomUUID()}`;
    const old = await start(phone, oldSecret);
    const afterTtl = new Date(NOW.getTime() + PIN_RESET_START_TTL_MS + 60_000);
    expect((await status(oldSecret, afterTtl))?.state).toBe('expired');
    expect(await ask(userId, cashier, old.deskCode, hash, afterTtl)).toEqual({
      outcome: 'no_match',
    });

    // An approval not used within the window.
    const secret = `secret-${randomUUID()}`;
    const fresh = await start(phone, secret);
    const reset = await requested(await ask(userId, cashier, fresh.deskCode, hash));
    await decide(reset.id, supervisor);
    const late = new Date(NOW.getTime() + PIN_RESET_ISSUE_WINDOW_MS + 60_000);
    expect((await status(secret, late))?.state).toBe('expired');
    expect(await complete(secret, late)).toEqual({ outcome: 'expired' });
    expect((await status(secret, late))?.state).toBe('expired');
    // Expired, so the player may start again.
    const again = await start(phone, `secret-${randomUUID()}`, late);
    expect((await ask(userId, cashier, again.deskCode, hash, late)).outcome).toBe('requested');
  });

  it('a rejected request shows as rejected; starts are limited per hour; a secret is used once', async () => {
    const cashier = await staff();
    const supervisor = await staff('compliance');
    const hash = `id-${randomUUID()}`;
    const { userId, phone } = await verifiedPlayer(hash);
    const secret = `secret-${randomUUID()}`;
    const started = await start(phone, secret, NOW, 'ip:203.0.113.9');
    const reset = await requested(await ask(userId, cashier, started.deskCode, hash));
    await decide(reset.id, supervisor, false);
    expect((await status(secret))?.state).toBe('rejected');
    expect(await refusal(complete(secret))).toEqual({
      status: 409,
      code: 'pin_reset_not_approved',
    });
    expect(await refusal(start(phone, secret))).toEqual({
      status: 409,
      code: 'pin_reset_secret_used',
    });

    // Per number and client address in an hour; another address still may.
    for (let i = 1; i < PIN_RESET_START_LIMITS.phoneRequester; i += 1) {
      await start(phone, `secret-${randomUUID()}`, NOW, 'ip:203.0.113.9');
    }
    expect(await refusal(start(phone, `secret-${randomUUID()}`, NOW, 'ip:203.0.113.9'))).toEqual({
      status: 429,
      code: 'pin_reset_limit',
    });
    expect((await start(phone, `secret-${randomUUID()}`, NOW, 'ip:198.51.100.7')).status).toBe(
      'waiting',
    );
  });
});
