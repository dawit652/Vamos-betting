import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argon2PasswordHasher } from '../src/backoffice/argon2';
import {
  base32Decode,
  confirmOwnStaffTotpEnrolment,
  createStaffUser,
  decryptTotpSecret,
  encryptTotpSecret,
  loginStaff,
  rekeyStaffTotpSecrets,
  startOwnStaffTotpEnrolment,
  totpCode,
  TotpSecretError,
  type StaffAuthDeps,
} from '../src/index';
import { adminUsers, auditLog } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

// Its own database: a re-key changes every staff row, which other files' staff would feel.
const OLD_KEY = Buffer.alloc(32, 0x11);
const NEW_KEY = Buffer.alloc(32, 0x22);
const PASSWORD = 'correct horse battery staple';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let now = new Date('2026-10-27T08:00:00.000Z');
const clock = () => now;

function deps(totpKey: Buffer): StaffAuthDeps {
  return { db: handle.db, clock, randomBytes, totpKey, passwords: argon2PasswordHasher };
}

/** The code of the next 30-second step. */
function nextCode(secret: Buffer): string {
  now = new Date(now.getTime() + 30_000);
  return totpCode(secret, now.getTime());
}

async function newStaff(email: string) {
  const created = await createStaffUser(deps(OLD_KEY), {
    email,
    displayName: email,
    role: 'support',
    password: PASSWORD,
    actor: { type: 'system', via: 'test' },
  });
  return { id: created.user.id, email, secret: base32Decode(created.totp.secret) };
}

const storedSecrets = async () =>
  handle.db
    .select({
      id: adminUsers.id,
      current: adminUsers.totpSecretEnc,
      pending: adminUsers.totpPendingSecretEnc,
    })
    .from(adminUsers)
    .orderBy(adminUsers.id);

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

describe('rekeyStaffTotpSecrets (ASVS 1.6.3)', () => {
  it('moves current and pending secrets to the new key in one go, and a repeat changes nothing', async () => {
    const alice = await newStaff('alice@vamos.test');
    const bob = await newStaff('bob@vamos.test');
    // Bob is half way through moving to a new authenticator.
    const enrolment = await startOwnStaffTotpEnrolment(deps(OLD_KEY), {
      adminUserId: bob.id,
      password: PASSWORD,
      code: nextCode(bob.secret),
    });

    expect(
      await rekeyStaffTotpSecrets(handle.db, { oldKey: OLD_KEY, newKey: NEW_KEY, via: 'test' }),
    ).toEqual({ rekeyed: 3, alreadyNew: 0 });

    // The same codes now pass under the new key only.
    const signIn = (key: Buffer, staff: { email: string; secret: Buffer }) =>
      loginStaff(deps(key), {
        email: staff.email,
        password: PASSWORD,
        code: nextCode(staff.secret),
        ip: '10.0.0.9',
      });
    expect((await signIn(NEW_KEY, alice)).staff.id).toBe(alice.id);
    await expect(signIn(OLD_KEY, alice)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    // Bob's pending enrolment survived the move and still confirms.
    const session = await signIn(NEW_KEY, bob);
    await confirmOwnStaffTotpEnrolment(deps(NEW_KEY), {
      adminUserId: bob.id,
      sessionId: session.session.id,
      code: nextCode(base32Decode(enrolment.secret)),
    });

    const before = await storedSecrets();
    expect(
      await rekeyStaffTotpSecrets(handle.db, { oldKey: OLD_KEY, newKey: NEW_KEY, via: 'test' }),
    ).toEqual({ rekeyed: 0, alreadyNew: 2 });
    expect(await storedSecrets()).toEqual(before);

    const audits = await handle.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'staff.totp_rekeyed'));
    expect(audits.map((row) => row.metadata)).toEqual([
      { rekeyed: 3, alreadyNew: 0, via: 'test' },
      { rekeyed: 0, alreadyNew: 2, via: 'test' },
    ]);
  });

  it('changes nothing when one secret decrypts with neither key', async () => {
    const carol = await newStaff('carol@vamos.test');
    await handle.db
      .update(adminUsers)
      .set({
        totpSecretEnc: encryptTotpSecret(Buffer.alloc(32, 0x33), randomBytes(20), carol.id),
      })
      .where(eq(adminUsers.id, carol.id));
    const before = await storedSecrets();

    const error = await rekeyStaffTotpSecrets(handle.db, {
      oldKey: NEW_KEY,
      newKey: Buffer.alloc(32, 0x44),
      via: 'test',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TotpSecretError);
    expect((error as Error).message).toContain(carol.id);
    expect(await storedSecrets()).toEqual(before);
    // The rows under NEW_KEY still decrypt with it.
    const alice = before.find((row) => row.current !== null && row.id !== carol.id)!;
    expect(() => decryptTotpSecret(NEW_KEY, alice.current!, alice.id)).not.toThrow();

    await expect(
      rekeyStaffTotpSecrets(handle.db, { oldKey: NEW_KEY, newKey: NEW_KEY, via: 'test' }),
    ).rejects.toThrow(RangeError);
  });
});
