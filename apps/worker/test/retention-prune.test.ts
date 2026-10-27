import { randomBytes, randomUUID } from 'node:crypto';
import { OTP_RETENTION_MS, SESSION_RETENTION_MS } from '@vamos/db';
import * as schema from '@vamos/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetentionPrune } from '../src/tasks/retention-prune';
import { createWorkerTestContext, SETUP_TIMEOUT, type WorkerTestContext } from './helpers';

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

const DAY_MS = 24 * 3_600_000;
const hash = () => randomBytes(32).toString('hex');

describe('retention-prune (ASVS 8.3.8)', () => {
  it('deletes sessions and one-time codes past their retention, and keeps the rest', async () => {
    const now = t.ctx.clock();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const phone = `+2519${String(Date.now()).slice(-8)}`;
    const [user] = await t.db.db
      .insert(schema.users)
      .values({
        phone,
        passwordHash: 'x',
        dateOfBirth: '1990-01-01',
        status: 'active',
        termsAcceptedAt: now,
      })
      .returning({ id: schema.users.id });
    const session = (createdAt: Date, expiresAt: Date, revokedAt: Date | null) => ({
      userId: user!.id,
      tokenHash: hash(),
      csrfHash: hash(),
      ip: '196.188.1.1',
      userAgent: 'test',
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
      revokedAt,
    });
    const old = ago(SESSION_RETENTION_MS + DAY_MS);
    const rows = await t.db.db
      .insert(schema.sessions)
      .values([
        // Expired long ago, revoked long ago: both go.
        session(old, old, null),
        session(old, ago(SESSION_RETENTION_MS - DAY_MS), old),
        // Revoked recently, or still live: both stay.
        session(old, ago(SESSION_RETENTION_MS - DAY_MS), ago(DAY_MS)),
        session(ago(60_000), new Date(now.getTime() + DAY_MS), null),
      ])
      .returning({ id: schema.sessions.id });
    const [staff] = await t.db.db
      .insert(schema.adminUsers)
      .values({
        email: `prune-${randomUUID()}@vamos.test`,
        passwordHash: 'x',
        displayName: 'Prune',
        role: 'support',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.adminUsers.id });
    const staffRows = await t.db.db
      .insert(schema.adminSessions)
      .values(
        [old, new Date(now.getTime() + DAY_MS)].map((expiresAt) => ({
          adminUserId: staff!.id,
          tokenHash: hash(),
          csrfHash: hash(),
          createdAt: old,
          lastSeenAt: old,
          expiresAt,
        })),
      )
      .returning({ id: schema.adminSessions.id });
    const codes = await t.db.db
      .insert(schema.otpChallenges)
      .values(
        [ago(OTP_RETENTION_MS + 60_000), ago(DAY_MS)].map((createdAt) => ({
          phone,
          purpose: 'password_reset' as const,
          codeHash: hash(),
          expiresAt: createdAt,
          createdAt,
        })),
      )
      .returning({ id: schema.otpChallenges.id });

    expect(await runRetentionPrune(t.ctx, { batchSize: 1, maxBatches: 1 })).toEqual({
      sessions: 1,
      staffSessions: 1,
      otpChallenges: 1,
    });
    expect(await runRetentionPrune(t.ctx)).toEqual({
      sessions: 1,
      staffSessions: 0,
      otpChallenges: 0,
    });

    const left = await t.db.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user!.id));
    expect(left.map((row) => row.id).sort()).toEqual([rows[2]!.id, rows[3]!.id].sort());
    const staffLeft = await t.db.db
      .select({ id: schema.adminSessions.id })
      .from(schema.adminSessions)
      .where(eq(schema.adminSessions.adminUserId, staff!.id));
    expect(staffLeft.map((row) => row.id)).toEqual([staffRows[1]!.id]);
    const codesLeft = await t.db.db
      .select({ id: schema.otpChallenges.id })
      .from(schema.otpChallenges)
      .where(
        inArray(
          schema.otpChallenges.id,
          codes.map((row) => row.id),
        ),
      );
    expect(codesLeft.map((row) => row.id)).toEqual([codes[1]!.id]);
  });
});
