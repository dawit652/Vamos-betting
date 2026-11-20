import { birr } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_SUSPENDED, setPlayerStatus } from '../src/backoffice/index';
import { DomainError } from '../src/errors';
import { assertDepositAllowed } from '../src/rg/index';
import { adminUsers, auditLog, users } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { createPlayer, NOW } from './payments-fixtures';

/** Blocking and unblocking a player (cashier desk and back office). */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let adminId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: 'status-test@example.com',
      passwordHash: 'not-a-real-hash',
      displayName: 'Status Test',
      role: 'compliance',
    })
    .returning({ id: adminUsers.id });
  adminId = row!.id;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const change = (userId: string, status: 'active' | 'suspended', reason = 'fraud report') =>
  handle.db.transaction((tx) =>
    setPlayerStatus(tx, { userId, status, reason, adminId, via: 'cashier_desk' }),
  );

describe('setPlayerStatus', () => {
  it('blocks a player (no deposits then), audited with the reason, and unblocks', async () => {
    const { userId } = await createPlayer(handle.db);
    expect(await change(userId, 'suspended')).toEqual({ status: 'suspended', changed: true });
    const [audit] = await handle.db
      .select({ metadata: auditLog.metadata, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, PLAYER_SUSPENDED)));
    expect(audit).toMatchObject({
      actorId: adminId,
      metadata: { reason: 'fraud report', from: 'active', via: 'cashier_desk' },
    });
    await expect(
      handle.db.transaction((tx) => assertDepositAllowed(tx, userId, birr(10), NOW)),
    ).rejects.toMatchObject({ status: 403, code: 'account_disabled' });

    // The same status again changes nothing.
    expect(await change(userId, 'suspended')).toEqual({ status: 'suspended', changed: false });
    expect(await change(userId, 'active', 'checked: not fraud')).toEqual({
      status: 'active',
      changed: true,
    });
    await handle.db.transaction((tx) => assertDepositAllowed(tx, userId, birr(10), NOW));
  });

  it('refuses an account being verified or closed, and an empty reason', async () => {
    const { userId } = await createPlayer(handle.db);
    await handle.db
      .update(users)
      .set({ status: 'pending_verification' })
      .where(eq(users.id, userId));
    await expect(change(userId, 'suspended')).rejects.toBeInstanceOf(DomainError);
    await expect(change(userId, 'suspended')).rejects.toMatchObject({
      code: 'player_status_unchangeable',
    });
    await expect(change(userId, 'active', '  ')).rejects.toBeInstanceOf(RangeError);
  });
});
