import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideDeskPinReset,
  findOpenDeskPinReset,
  issueDeskPinReset,
  listOpenDeskPinResets,
  PIN_RESET_ISSUE_WINDOW_MS,
  requestDeskPinReset,
} from '../src/cashier/index';
import { DomainError } from '../src/errors';
import { adminUsers, auditLog, kycProfiles } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, NOW } from './payments-fixtures';

/** Cashier phase "assisted PIN reset": the ID check, four eyes, one open request, the issue window. */

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
async function verifiedPlayer(idHash: string): Promise<string> {
  const { userId } = await createPlayer(handle.db, { kyc: 'verified', name: 'Abebe K.' });
  await handle.db
    .update(kycProfiles)
    .set({ idNumberHash: idHash })
    .where(eq(kycProfiles.userId, userId));
  return userId;
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

const ask = (userId: string, staffId: string, idNumberHash: string) =>
  handle.db.transaction((tx) =>
    requestDeskPinReset(tx, { userId, staffId, shopId: null, idNumberHash, now: NOW }),
  );

describe('assisted PIN reset at the desk', () => {
  it('checks the ID, needs another supervisor, then issues once within the window', async () => {
    const cashier = await staff();
    const supervisor = await staff('compliance');
    const hash = `id-${randomUUID()}`;
    const userId = await verifiedPlayer(hash);

    // A wrong ID number is refused (the API puts it on record, outside this transaction).
    expect(await refusal(ask(userId, cashier, 'id-other'))).toEqual({
      status: 422,
      code: 'id_mismatch',
    });

    const asked = await ask(userId, cashier, hash);
    expect(asked.status).toBe('requested');
    expect(await refusal(ask(userId, cashier, hash))).toEqual({
      status: 409,
      code: 'pin_reset_open',
    });
    expect((await findOpenDeskPinReset(handle.db, userId))?.id).toBe(asked.id);
    expect((await listOpenDeskPinResets(handle.db)).map((r) => r.id)).toContain(asked.id);

    // Not issued before approval; the cashier who asked cannot approve.
    const issue = (staffId: string, now = NOW, supervisorFlag = false) =>
      handle.db.transaction((tx) =>
        issueDeskPinReset(tx, { resetId: asked.id, staffId, supervisor: supervisorFlag, now }),
      );
    expect(await refusal(issue(cashier))).toEqual({ status: 409, code: 'pin_reset_not_approved' });
    const decide = (supervisorId: string) =>
      handle.db.transaction((tx) =>
        decideDeskPinReset(tx, { resetId: asked.id, supervisorId, approve: true, now: NOW }),
      );
    expect(await refusal(decide(cashier))).toEqual({ status: 403, code: 'cashier_four_eyes' });
    expect((await decide(supervisor)).status).toBe('approved');

    // Another cashier cannot issue it; the one who asked can, once, with the player's phone.
    expect(await refusal(issue(await staff()))).toEqual({ status: 404, code: 'not_found' });
    const issued = await issue(cashier);
    if (issued.outcome !== 'issued') throw new Error('expected issued');
    expect(issued.reset.status).toBe('issued');
    const audits = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, userId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'cashier.pin_reset_requested',
        'cashier.pin_reset_approved',
        'cashier.pin_reset_issued',
      ]),
    );
    expect(issued.phone).toMatch(/^\+251/);
    expect(await refusal(issue(cashier))).toEqual({ status: 409, code: 'pin_reset_not_approved' });
    expect(await findOpenDeskPinReset(handle.db, userId)).toBeNull();
  });

  it('refuses a player without a verified ID, and lets an approval expire', async () => {
    const cashier = await staff();
    const supervisor = await staff('finance');
    const { userId: unverified } = await createPlayer(handle.db);
    expect(await refusal(ask(unverified, cashier, 'id-x'))).toEqual({
      status: 422,
      code: 'kyc_not_verified',
    });

    const hash = `id-${randomUUID()}`;
    const userId = await verifiedPlayer(hash);
    const asked = await ask(userId, cashier, hash);
    await handle.db.transaction((tx) =>
      decideDeskPinReset(tx, {
        resetId: asked.id,
        supervisorId: supervisor,
        approve: true,
        now: NOW,
      }),
    );
    const late = new Date(NOW.getTime() + PIN_RESET_ISSUE_WINDOW_MS + 60_000);
    expect(
      await handle.db.transaction((tx) =>
        issueDeskPinReset(tx, {
          resetId: asked.id,
          staffId: cashier,
          supervisor: false,
          now: late,
        }),
      ),
    ).toEqual({ outcome: 'expired' });
    // Expired, so a new request may be asked.
    expect((await ask(userId, cashier, hash)).status).toBe('requested');
  });
});
