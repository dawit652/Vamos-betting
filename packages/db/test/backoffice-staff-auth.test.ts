import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argon2PasswordHasher } from '../src/backoffice/argon2';
import { DomainError } from '../src/errors';
import {
  authenticateStaffSession,
  base32Decode,
  createStaffUser,
  DEMO_STAFF_ACCOUNTS,
  DEMO_STAFF_PASSWORD,
  DEMO_STAFF_TOTP_SECRET,
  decryptTotpSecret,
  isStaffSessionActive,
  loginStaff,
  logoutStaff,
  resetStaffPassword,
  resetStaffTotp,
  seedDemoStaff,
  setStaffDisabled,
  STAFF_LOCKOUT_MS,
  STAFF_SESSION_ABSOLUTE_MS,
  STAFF_SESSION_IDLE_MS,
  totpCode,
  unlockStaffUser,
  updateStaffUser,
  type StaffAuthDeps,
  type StaffLoginResult,
  type StaffRole,
} from '../src/index';
import { adminSessions, adminUsers, auditLog, sessions } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { createUser, dropTestDatabase } from './helpers';

const KEY = Buffer.alloc(32, 0x5a);
const PASSWORD = 'correct horse battery staple';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let now = new Date('2026-10-18T08:00:00.000Z');
const clock = () => now;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

function deps(): StaffAuthDeps {
  return { db: handle.db, clock, randomBytes, totpKey: KEY, passwords: argon2PasswordHasher };
}

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

let emailCounter = 0;

interface TestStaff {
  id: string;
  email: string;
  secret: Buffer;
}

async function newStaff(role: StaffRole = 'trader', email?: string): Promise<TestStaff> {
  emailCounter += 1;
  const created = await createStaffUser(deps(), {
    email: email ?? `staff${emailCounter}@vamos.test`,
    displayName: `Staff ${emailCounter}`,
    role,
    password: PASSWORD,
    actor: { type: 'system', via: 'test' },
  });
  return {
    id: created.user.id,
    email: created.user.email,
    secret: base32Decode(created.totp.secret),
  };
}

/** The code of the next 30-second step (each test signs in on a step of its own). */
function nextCode(staff: TestStaff): string {
  advance(30_000);
  return totpCode(staff.secret, now.getTime());
}

/** Advances one step and returns a 6-digit code that is not valid in the window around now. */
function wrongCode(staff: TestStaff): string {
  advance(30_000);
  const valid = new Set(
    [-1, 0, 1].map((offset) => totpCode(staff.secret, now.getTime() + offset * 30_000)),
  );
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

async function login(staff: TestStaff, code = nextCode(staff)): Promise<StaffLoginResult> {
  return loginStaff(deps(), { email: staff.email, password: PASSWORD, code, ip: '10.0.0.1' });
}

async function expectInvalidCredentials(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the sign-in to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  const domain = error as DomainError;
  expect(domain.status).toBe(401);
  expect(domain.code).toBe('invalid_credentials');
  return domain;
}

async function loginFailures(adminUserId: string) {
  const rows = await handle.db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, 'admin_user'), eq(auditLog.targetId, adminUserId)))
    .orderBy(auditLog.id);
  return rows
    .filter((row) => row.action === 'staff.login_failed')
    .map((row) => (row.metadata as { reason: string }).reason);
}

async function userRow(id: string) {
  const [row] = await handle.db.select().from(adminUsers).where(eq(adminUsers.id, id));
  if (row === undefined) throw new Error(`no staff ${id}`);
  return row;
}

const check = (token: string, csrfToken?: string | null, checkCsrf = false) =>
  authenticateStaffSession(deps(), { token, csrfToken: csrfToken ?? null, checkCsrf });

describe('staff accounts', () => {
  it('creates an account with a lowercased email, argon2id hash and encrypted TOTP secret', async () => {
    const created = await createStaffUser(deps(), {
      email: '  New.Trader@Vamos.Test ',
      displayName: ' New Trader ',
      role: 'trader',
      password: PASSWORD,
      actor: { type: 'system', via: 'test' },
    });
    expect(created.user.email).toBe('new.trader@vamos.test');
    expect(created.user.displayName).toBe('New Trader');
    expect(created.generatedPassword).toBeNull();
    expect(created.totp.uri).toMatch(
      /^otpauth:\/\/totp\/Vamos%20Back%20Office:new\.trader%40vamos\.test\?secret=/,
    );
    const row = await userRow(created.user.id);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    const secret = base32Decode(created.totp.secret);
    expect(row.totpSecretEnc).not.toContain(created.totp.secret);
    expect(decryptTotpSecret(KEY, row.totpSecretEnc!, row.id).equals(secret)).toBe(true);
    expect(row.totpEnrolledAt?.getTime()).toBe(now.getTime());

    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'staff.created'), eq(auditLog.targetId, created.user.id)));
    expect(audit?.metadata).toMatchObject({
      email: 'new.trader@vamos.test',
      role: 'trader',
      via: 'test',
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain(PASSWORD);

    await expect(
      createStaffUser(deps(), {
        email: 'NEW.TRADER@vamos.test',
        displayName: 'Again',
        role: 'support',
        password: PASSWORD,
        actor: { type: 'system', via: 'test' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'staff_email_taken' });
    for (const [password, email] of [
      ['short', 'a@vamos.test'],
      ['password1234', 'b@vamos.test'],
      ['aaaaaaaaaaaaaaaa', 'c@vamos.test'],
      ['xx-abebe-kebede-xx', 'abebe-kebede@vamos.test'],
    ] as const) {
      await expect(
        createStaffUser(deps(), {
          email,
          displayName: 'Weak',
          role: 'support',
          password,
          actor: { type: 'system', via: 'test' },
        }),
      ).rejects.toMatchObject({ status: 422, code: 'weak_password' });
    }
    await expect(
      createStaffUser(deps(), {
        email: 'not-an-email',
        displayName: 'X',
        role: 'support',
        password: PASSWORD,
        actor: { type: 'system', via: 'test' },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_staff_email' });
  });

  it('generates a password when none is given, and it signs in', async () => {
    const created = await createStaffUser(deps(), {
      email: 'generated@vamos.test',
      displayName: 'Generated',
      role: 'support',
      actor: { type: 'system', via: 'test' },
    });
    expect(created.generatedPassword).toMatch(/^[\w-]{24}$/);
    const secret = base32Decode(created.totp.secret);
    advance(30_000);
    const result = await loginStaff(deps(), {
      email: 'generated@vamos.test',
      password: created.generatedPassword!,
      code: totpCode(secret, now.getTime()),
    });
    expect(result.staff.role).toBe('support');
  });
});

describe('staff sign-in', () => {
  it('signs in with email, password and the current code, and opens a session', async () => {
    const staff = await newStaff('finance');
    const result = await loginStaff(deps(), {
      email: staff.email.toUpperCase(),
      password: PASSWORD,
      code: nextCode(staff),
      ip: '10.0.0.9',
      userAgent: 'vitest',
    });
    expect(result.staff).toMatchObject({ id: staff.id, role: 'finance', email: staff.email });
    expect(result.session.token).toMatch(/^[\w-]{43}$/);
    expect(result.session.expiresAt.getTime()).toBe(now.getTime() + STAFF_SESSION_ABSOLUTE_MS);
    expect(result.session.idleExpiresAt.getTime()).toBe(now.getTime() + STAFF_SESSION_IDLE_MS);

    // Only hashes are stored.
    const [session] = await handle.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, result.session.id));
    expect(session?.tokenHash).toBe(
      createHash('sha256').update(result.session.token).digest('hex'),
    );
    expect(session?.tokenHash).not.toContain(result.session.token);
    expect(session?.ip).toBe('10.0.0.9');

    const checked = await check(result.session.token);
    expect(checked).toMatchObject({
      status: 'ok',
      staff: { id: staff.id, role: 'finance', sessionId: result.session.id },
    });
    if (checked.status === 'ok') expect(checked.staff.csrfToken).toBe(result.session.csrfToken);
    const row = await userRow(staff.id);
    expect(row.lastLoginAt?.getTime()).toBe(now.getTime());
    expect(row.failedLoginAttempts).toBe(0);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'staff.login'), eq(auditLog.targetId, staff.id)));
    expect(audit).toMatchObject({ actorType: 'admin', actorId: staff.id, ip: '10.0.0.9' });
  });

  it('answers every failure with the same 401 and records why', async () => {
    const staff = await newStaff();
    const messages = new Set<string>();
    const wrong = async (input: { email?: string; password?: string; code?: string }) => {
      const error = await expectInvalidCredentials(
        loginStaff(deps(), {
          email: input.email ?? staff.email,
          password: input.password ?? PASSWORD,
          code: input.code ?? nextCode(staff),
        }),
      );
      messages.add(error.message);
    };
    await wrong({ email: 'nobody@vamos.test' });
    await wrong({ password: `${PASSWORD}!` });
    await wrong({ code: wrongCode(staff) });
    await wrong({ code: '12345' });
    await handle.db.transaction((tx) =>
      setStaffDisabled(tx, {
        adminUserId: staff.id,
        disabled: true,
        actor: { type: 'system', via: 'test' },
        now,
      }),
    );
    await wrong({});
    expect(messages.size).toBe(1);
    expect(await loginFailures(staff.id)).toEqual([
      'password',
      'totp_invalid',
      'totp_invalid',
      'disabled',
    ]);
    // The unknown email is audited without a target.
    const unknown = await handle.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'staff.login_failed'));
    expect(
      unknown.some((row) => (row.metadata as { reason: string }).reason === 'unknown_email'),
    ).toBe(true);
  });

  it('refuses a code that was used before, and an older one after a newer was used', async () => {
    const staff = await newStaff();
    const code = nextCode(staff);
    await login(staff, code);
    await expectInvalidCredentials(login(staff, code));
    // The previous step's code is still inside the window but older than the one used.
    const previous = totpCode(staff.secret, now.getTime() - 30_000);
    await expectInvalidCredentials(login(staff, previous));
    // The next step's code works.
    const next = await login(staff, totpCode(staff.secret, now.getTime() + 30_000));
    expect(next.staff.id).toBe(staff.id);
    expect(await loginFailures(staff.id)).toEqual(['totp_replay', 'totp_replay']);
    // Two replays and a success: the counter is back at zero.
    expect((await userRow(staff.id)).failedLoginAttempts).toBe(0);
  });

  it('refuses codes outside one step either side of now', async () => {
    const staff = await newStaff();
    advance(30_000);
    const t = now.getTime();
    await expectInvalidCredentials(login(staff, totpCode(staff.secret, t - 60_000)));
    await expectInvalidCredentials(login(staff, totpCode(staff.secret, t + 60_000)));
    const ok = await login(staff, totpCode(staff.secret, t - 30_000));
    expect(ok.staff.id).toBe(staff.id);
  });

  it('locks the account for 15 minutes after 5 failures in a row', async () => {
    const staff = await newStaff();
    // A success resets the count: 4 failures, a success, 4 failures do not lock.
    for (let i = 0; i < 4; i += 1) {
      await expectInvalidCredentials(
        loginStaff(deps(), {
          email: staff.email,
          password: 'wrong password!',
          code: nextCode(staff),
        }),
      );
    }
    await login(staff);
    for (let i = 0; i < 4; i += 1) {
      await expectInvalidCredentials(
        loginStaff(deps(), {
          email: staff.email,
          password: 'wrong password!',
          code: nextCode(staff),
        }),
      );
    }
    expect((await userRow(staff.id)).lockedUntil).toBeNull();
    // The fifth failure in a row locks it.
    await expectInvalidCredentials(login(staff, wrongCode(staff)));
    const lockedAt = now.getTime();
    const locked = await userRow(staff.id);
    expect(locked.lockedUntil?.getTime()).toBe(lockedAt + STAFF_LOCKOUT_MS);
    // While locked even the right credentials fail, and those attempts do not extend the lock.
    await expectInvalidCredentials(login(staff));
    advance(STAFF_LOCKOUT_MS - 31_000 - (now.getTime() - lockedAt));
    await expectInvalidCredentials(login(staff));
    expect((await userRow(staff.id)).lockedUntil?.getTime()).toBe(lockedAt + STAFF_LOCKOUT_MS);
    // Once the lock has passed, the right credentials work.
    advance(1_000);
    const result = await login(staff);
    expect(result.staff.id).toBe(staff.id);
    const failures = await loginFailures(staff.id);
    expect(failures.filter((reason) => reason === 'locked')).toHaveLength(2);
    const lockAudits = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'staff.locked'), eq(auditLog.targetId, staff.id)));
    expect(lockAudits).toHaveLength(1);
  });

  it('lets staff.manage lift a lockout early', async () => {
    const staff = await newStaff();
    for (let i = 0; i < 5; i += 1) {
      await expectInvalidCredentials(
        loginStaff(deps(), {
          email: staff.email,
          password: 'wrong password!',
          code: nextCode(staff),
        }),
      );
    }
    await expectInvalidCredentials(login(staff));
    const admin = await newStaff('admin');
    await handle.db.transaction((tx) =>
      unlockStaffUser(tx, {
        adminUserId: staff.id,
        actor: { type: 'admin', adminId: admin.id },
        now,
      }),
    );
    expect((await login(staff)).staff.id).toBe(staff.id);
  });
});

describe('staff sessions', () => {
  it('ends after 30 minutes without a request', async () => {
    const staff = await newStaff();
    const { session } = await login(staff);
    advance(STAFF_SESSION_IDLE_MS - 1_000);
    expect((await check(session.token)).status).toBe('ok');
    // That request counted as activity.
    advance(STAFF_SESSION_IDLE_MS - 1_000);
    expect((await check(session.token)).status).toBe('ok');
    expect(await isStaffSessionActive(deps(), session.id)).toBe(true);
    advance(STAFF_SESSION_IDLE_MS);
    expect(await check(session.token)).toEqual({ status: 'none' });
    expect(await isStaffSessionActive(deps(), session.id)).toBe(false);
  });

  it('ends 12 hours after sign-in however active it is', async () => {
    const staff = await newStaff();
    const { session } = await login(staff);
    const signedInAt = now.getTime();
    while (now.getTime() + 20 * 60_000 < signedInAt + STAFF_SESSION_ABSOLUTE_MS) {
      advance(20 * 60_000);
      const checked = await check(session.token);
      expect(checked.status).toBe('ok');
      if (checked.status === 'ok') {
        expect(checked.staff.idleExpiresAt.getTime()).toBeLessThanOrEqual(
          signedInAt + STAFF_SESSION_ABSOLUTE_MS,
        );
      }
    }
    now = new Date(signedInAt + STAFF_SESSION_ABSOLUTE_MS);
    expect(await check(session.token)).toEqual({ status: 'none' });
  });

  it('needs the session CSRF token on unsafe requests', async () => {
    const other = await login(await newStaff());
    const staff = await newStaff();
    const { session } = await login(staff);
    expect((await check(session.token, null, true)).status).toBe('csrf_invalid');
    expect((await check(session.token, 'x'.repeat(43), true)).status).toBe('csrf_invalid');
    expect((await check(session.token, other.session.csrfToken, true)).status).toBe('csrf_invalid');
    expect((await check(session.token, session.csrfToken, true)).status).toBe('ok');
    // A CSRF failure does not keep the session alive.
    advance(STAFF_SESSION_IDLE_MS - 1_000);
    expect((await check(session.token, null, true)).status).toBe('csrf_invalid');
    advance(2_000);
    expect(await check(session.token, session.csrfToken, true)).toEqual({ status: 'none' });
  });

  it('never accepts a player session token or a malformed token', async () => {
    const userId = await createUser(handle.db);
    const playerToken = randomBytes(32).toString('base64url');
    await handle.db.insert(sessions).values({
      userId,
      tokenHash: createHash('sha256').update(playerToken).digest('hex'),
      csrfHash: createHash('sha256').update('csrf').digest('hex'),
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    expect(await check(playerToken)).toEqual({ status: 'none' });
    for (const bad of ['', 'short', 'x'.repeat(200), 'not base64url!'.repeat(4)]) {
      expect(await check(bad), bad).toEqual({ status: 'none' });
    }
  });

  it('ends on sign-out, when disabled, on a role change and on a TOTP or password reset', async () => {
    const admin = await newStaff('admin');
    const actor = { type: 'admin' as const, adminId: admin.id };
    const staff = await newStaff('support');

    const first = await login(staff);
    expect(await logoutStaff(deps(), { sessionId: first.session.id, adminUserId: staff.id })).toBe(
      true,
    );
    expect(await check(first.session.token)).toEqual({ status: 'none' });
    expect(await logoutStaff(deps(), { sessionId: first.session.id, adminUserId: staff.id })).toBe(
      false,
    );

    const second = await login(staff);
    await handle.db.transaction((tx) =>
      updateStaffUser(tx, { adminUserId: staff.id, role: 'kyc', actor, now }),
    );
    expect(await check(second.session.token)).toEqual({ status: 'none' });
    const third = await login(staff);
    expect(third.staff.role).toBe('kyc');

    const enrolment = await handle.db.transaction((tx) =>
      resetStaffTotp(tx, deps(), { adminUserId: staff.id, actor, now }),
    );
    expect(await check(third.session.token)).toEqual({ status: 'none' });
    // The old secret no longer works; the new one does.
    await expectInvalidCredentials(login(staff));
    staff.secret = base32Decode(enrolment.secret);
    const fourth = await login(staff);

    await resetStaffPassword(deps(), {
      adminUserId: staff.id,
      password: 'another long passphrase 42',
      actor,
    });
    expect(await check(fourth.session.token)).toEqual({ status: 'none' });
    await expectInvalidCredentials(login(staff));
    const fifth = await loginStaff(deps(), {
      email: staff.email,
      password: 'another long passphrase 42',
      code: nextCode(staff),
    });

    await handle.db.transaction((tx) =>
      setStaffDisabled(tx, { adminUserId: staff.id, disabled: true, actor, now }),
    );
    expect(await check(fifth.session.token)).toEqual({ status: 'none' });

    const actions = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, staff.id), eq(auditLog.actorId, admin.id)))
      .orderBy(auditLog.id);
    expect(actions.map((row) => row.action)).toEqual([
      'staff.updated',
      'staff.totp_reset',
      'staff.password_reset',
      'staff.disabled',
    ]);
  });

  it('never disables or demotes the last enabled admin', async () => {
    const db = await createTestDatabase();
    try {
      const local: StaffAuthDeps = { ...deps(), db: db.db };
      const created = await createStaffUser(local, {
        email: 'only-admin@vamos.test',
        displayName: 'Only Admin',
        role: 'admin',
        password: PASSWORD,
        actor: { type: 'system', via: 'test' },
      });
      const actor = { type: 'system' as const, via: 'test' };
      await expect(
        db.db.transaction((tx) =>
          setStaffDisabled(tx, { adminUserId: created.user.id, disabled: true, actor, now }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'last_admin' });
      await expect(
        db.db.transaction((tx) =>
          updateStaffUser(tx, { adminUserId: created.user.id, role: 'support', actor, now }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'last_admin' });
    } finally {
      await dropTestDatabase(db);
    }
  });
});

describe('demo staff', () => {
  it('seeds one account per role in demo mode only, signing in with the published secret', async () => {
    const db = await createTestDatabase();
    try {
      const local = { db: db.db, clock, totpKey: KEY, passwords: argon2PasswordHasher };
      expect(await seedDemoStaff(local, { mode: 'licensed', nodeEnv: 'development' })).toEqual({
        created: 0,
        skipped: 'licensed',
      });
      expect(await seedDemoStaff(local, { mode: 'demo', nodeEnv: 'production' })).toEqual({
        created: 0,
        skipped: 'production',
      });
      expect(await db.db.select().from(adminUsers)).toHaveLength(0);

      expect(await seedDemoStaff(local, { mode: 'demo', nodeEnv: 'development' })).toEqual({
        created: DEMO_STAFF_ACCOUNTS.length,
        skipped: null,
      });
      expect(await seedDemoStaff(local, { mode: 'demo', nodeEnv: 'test' })).toEqual({
        created: 0,
        skipped: null,
      });
      const rows = await db.db.select().from(adminUsers);
      expect(new Set(rows.map((row) => row.role))).toEqual(
        new Set(['admin', 'trader', 'finance', 'kyc', 'support', 'compliance']),
      );

      const secret = base32Decode(DEMO_STAFF_TOTP_SECRET);
      advance(30_000);
      for (const account of DEMO_STAFF_ACCOUNTS) {
        const result = await loginStaff(
          { ...deps(), db: db.db },
          {
            email: account.email,
            password: DEMO_STAFF_PASSWORD,
            code: totpCode(secret, now.getTime()),
          },
        );
        expect(result.staff.role).toBe(account.role);
      }
    } finally {
      await dropTestDatabase(db);
    }
  });
});
