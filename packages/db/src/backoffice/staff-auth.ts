import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { DomainError, domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { adminSessions, adminUsers } from '../schema/accounts';
import { adminRole } from '../schema/enums';
import { decryptTotpSecret, encryptTotpSecret, TotpSecretError } from './secret-box';
import { base32Encode, TOTP_SECRET_BYTES, totpUri, verifyTotp } from './totp';

/**
 * Back-office staff accounts and sessions (Phase 9).
 *
 * Sign-in takes the email, the password and a TOTP code together:
 * - passwords are hashed by the injected PasswordHasher (argon2id, like the
 *   players'; see @vamos/db/passwords);
 * - TOTP secrets are encrypted at rest (secret-box.ts) with ADMIN_TOTP_KEY;
 *   a code is accepted one 30-second step either side of now, and only for
 *   a step later than the last code accepted (admin_users.totp_last_step),
 *   so a code cannot be replayed;
 * - every failure (unknown email, wrong password, wrong or replayed code,
 *   disabled or locked account) gets the same 401 `invalid_credentials`;
 *   STAFF_LOCKOUT_THRESHOLD failures in a row lock the account for
 *   STAFF_LOCKOUT_MS; every attempt is audited;
 * - a session is a random cookie token (only its SHA-256 is stored), valid
 *   for STAFF_SESSION_ABSOLUTE_MS after sign-in and STAFF_SESSION_IDLE_MS
 *   after the last request. Its CSRF token is an HMAC of the session token,
 *   so the API can hand it out again (GET /admin/session) and check it on
 *   unsafe methods. Staff sessions live in admin_sessions only: a player
 *   token never authenticates staff and a staff token never a player.
 */

export type StaffRole = (typeof adminRole.enumValues)[number];
export const STAFF_ROLES: readonly StaffRole[] = adminRole.enumValues;

/** Failed sign-ins in a row that lock an account. */
export const STAFF_LOCKOUT_THRESHOLD = 5;
/** How long a locked account refuses sign-in. */
export const STAFF_LOCKOUT_MS = 15 * 60_000;
/** A session ends after this long without a request. */
export const STAFF_SESSION_IDLE_MS = 30 * 60_000;
/** A session ends this long after sign-in, whatever the activity. */
export const STAFF_SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
/** last_seen_at is written at most this often per session. */
export const STAFF_SESSION_TOUCH_MS = 60_000;
export const STAFF_PASSWORD_MIN_LENGTH = 12;
export const STAFF_PASSWORD_MAX_LENGTH = 128;
export const STAFF_EMAIL_MAX_LENGTH = 254;
export const STAFF_DISPLAY_NAME_MAX_LENGTH = 100;
/** Issuer shown by authenticator apps. */
export const STAFF_TOTP_ISSUER = 'Vamos Back Office';

/** Hashes and checks passwords (argon2id; see @vamos/db/passwords and the API's lib/passwords). */
export interface PasswordHasher {
  hash: (password: string) => Promise<string>;
  /** True when `password` matches; false (never a throw) for a malformed hash. */
  verify: (storedHash: string, password: string) => Promise<boolean>;
}

export interface StaffAuthDeps {
  db: Database;
  clock: () => Date;
  randomBytes: (size: number) => Buffer;
  /** ADMIN_TOTP_KEY (config.admin.totpKey): 32 bytes. */
  totpKey: Buffer;
  passwords: PasswordHasher;
}

/** Who changes a staff account: an admin in the back office, or the CLI / seed. */
export type StaffAccountActor =
  { type: 'admin'; adminId: string; ip?: string | null } | { type: 'system'; via: string };

/** A staff account as the back office shows it (never the password hash or the secret). */
export interface StaffUserView {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  totpEnrolledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The signed-in staff member behind a valid session. */
export interface StaffPrincipal {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  sessionId: string;
  /** The session's CSRF token (send it back in the staff CSRF header on unsafe methods). */
  csrfToken: string;
  /** Absolute end of the session. */
  expiresAt: Date;
  /** When the session ends without further requests. */
  idleExpiresAt: Date;
}

export interface IssuedStaffSession {
  id: string;
  /** The cookie value; only its SHA-256 is stored. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

/** A new TOTP secret to enrol in an authenticator app (shown once). */
export interface TotpEnrolment {
  /** Base32, for typing in by hand. */
  secret: string;
  /** otpauth:// URI (render as a QR code). */
  uri: string;
}

export interface StaffLoginInput {
  email: string;
  password: string;
  /** The 6-digit TOTP code. */
  code: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface StaffLoginResult {
  staff: StaffPrincipal;
  session: IssuedStaffSession;
}

/** 401 `invalid_credentials`: the one answer to every failed sign-in. */
export function staffInvalidCredentialsError(): DomainError {
  return new DomainError(
    401,
    'invalid_credentials',
    'Sign-in failed. Check your email, password and authenticator code. ' +
      `After ${STAFF_LOCKOUT_THRESHOLD} failed attempts the account is locked for ` +
      `${STAFF_LOCKOUT_MS / 60_000} minutes.`,
  );
}

/** Lowercased, trimmed email (staff emails are stored this way). */
export function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkedEmail(email: string): string {
  const normalized = normalizeStaffEmail(email);
  if (normalized.length > STAFF_EMAIL_MAX_LENGTH || !EMAIL_RE.test(normalized)) {
    throw domainUnprocessable('invalid_staff_email', 'Enter a valid email address.');
  }
  return normalized;
}

function checkedDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > STAFF_DISPLAY_NAME_MAX_LENGTH) {
    throw domainUnprocessable(
      'invalid_staff_name',
      `The display name must have 1 to ${STAFF_DISPLAY_NAME_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function checkedRole(role: string): StaffRole {
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    throw domainUnprocessable('invalid_staff_role', `Unknown staff role "${role}".`);
  }
  return role as StaffRole;
}

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'letmein12345',
]);

/** Why `password` is unacceptable for the staff account `email`, or null. */
export function staffPasswordWeakness(password: string, email: string): string | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
    return `Use at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > STAFF_PASSWORD_MAX_LENGTH) {
    return `Use at most ${STAFF_PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'This password is too common.';
  if (new Set(password).size < 4) return 'This password repeats too few characters.';
  const normalizedEmail = normalizeStaffEmail(email);
  const local = normalizedEmail.split('@')[0] ?? '';
  if (lower === normalizedEmail || (local.length >= 4 && lower.includes(local))) {
    return 'Do not use your email address in your password.';
  }
  return null;
}

function assertStaffPassword(password: string, email: string): void {
  const problem = staffPasswordWeakness(password, email);
  if (problem !== null) throw domainUnprocessable('weak_password', problem);
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** The CSRF token of a session: an HMAC keyed by the (secret, httpOnly) session token. */
export function staffCsrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('vamos:staff-csrf:v1').digest('base64url');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length * 2 !== a.length || right.length * 2 !== b.length) return false;
  return timingSafeEqual(left, right);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function staffView(row: typeof adminUsers.$inferSelect): StaffUserView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    disabledAt: row.disabledAt,
    lastLoginAt: row.lastLoginAt,
    lockedUntil: row.lockedUntil,
    failedLoginAttempts: row.failedLoginAttempts,
    totpEnrolledAt: row.totpEnrolledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One throwaway hash per hash function (stable even when the hasher object is rebuilt). */
const dummyHashes = new WeakMap<PasswordHasher['hash'], Promise<string>>();

/** Verifies against a throwaway hash, so a failure costs the same whatever its cause. */
async function dummyVerify(passwords: PasswordHasher, password: string): Promise<void> {
  let dummy = dummyHashes.get(passwords.hash);
  if (dummy === undefined) {
    dummy = passwords.hash(randomUUID());
    dummyHashes.set(passwords.hash, dummy);
  }
  await passwords.verify(await dummy, password);
}

/** Computes the dummy hash ahead of the first sign-in, so its cost is not observable. */
export async function warmUpStaffPasswordHashing(passwords: PasswordHasher): Promise<void> {
  await dummyVerify(passwords, randomUUID());
}

function newEnrolment(
  deps: Pick<StaffAuthDeps, 'randomBytes' | 'totpKey'>,
  adminUserId: string,
  email: string,
): { stored: string; enrolment: TotpEnrolment } {
  const secret = deps.randomBytes(TOTP_SECRET_BYTES);
  if (secret.length !== TOTP_SECRET_BYTES)
    throw new RangeError('randomBytes returned the wrong size');
  return {
    stored: encryptTotpSecret(deps.totpKey, secret, adminUserId, deps.randomBytes),
    enrolment: {
      secret: base32Encode(secret),
      uri: totpUri({ secret, account: email, issuer: STAFF_TOTP_ISSUER }),
    },
  };
}

function auditActor(actor: StaffAccountActor): {
  actorType: 'admin' | 'system';
  actorId: string | null;
  ip: string | null;
} {
  if (actor.type === 'admin') {
    if (typeof actor.adminId !== 'string' || actor.adminId.length === 0) {
      throw new RangeError('an admin actor needs the admin id');
    }
    return { actorType: 'admin', actorId: actor.adminId, ip: actor.ip ?? null };
  }
  return { actorType: 'system', actorId: null, ip: null };
}

/** A random password for accounts created without one (shown once). */
export function generateStaffPassword(randomBytes: (size: number) => Buffer): string {
  return randomBytes(18).toString('base64url');
}

export interface CreateStaffUserInput {
  email: string;
  displayName: string;
  role: StaffRole;
  /** Omitted: a random password is generated and returned. */
  password?: string;
  actor: StaffAccountActor;
}

export interface CreateStaffUserResult {
  user: StaffUserView;
  /** Set when the password was generated (show it once). */
  generatedPassword: string | null;
  /** The TOTP secret to enrol (show it once). */
  totp: TotpEnrolment;
}

/**
 * Creates a staff account with a fresh TOTP secret (enrolled at once:
 * sign-in needs the code from the start). 422 `invalid_staff_email` /
 * `invalid_staff_name` / `invalid_staff_role` / `weak_password`, 409
 * `staff_email_taken`. Audited as `staff.created`.
 */
export async function createStaffUser(
  deps: StaffAuthDeps,
  input: CreateStaffUserInput,
): Promise<CreateStaffUserResult> {
  const email = checkedEmail(input.email);
  const displayName = checkedDisplayName(input.displayName);
  const role = checkedRole(input.role);
  const actor = auditActor(input.actor);
  const generatedPassword =
    input.password === undefined ? generateStaffPassword(deps.randomBytes) : null;
  const password = input.password ?? generatedPassword ?? '';
  assertStaffPassword(password, email);
  const passwordHash = await deps.passwords.hash(password);
  const id = randomUUID();
  const { stored, enrolment } = newEnrolment(deps, id, email);
  const now = deps.clock();
  const user = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(adminUsers)
      .values({
        id,
        email,
        passwordHash,
        displayName,
        role,
        totpSecretEnc: stored,
        totpEnrolledAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: adminUsers.email })
      .returning();
    if (row === undefined) {
      throw domainConflict('staff_email_taken', 'A staff account with this email already exists.');
    }
    await writeAudit(tx, {
      ...actor,
      action: 'staff.created',
      targetType: 'admin_user',
      targetId: id,
      metadata: {
        email,
        role,
        displayName,
        ...(input.actor.type === 'system' ? { via: input.actor.via } : {}),
      },
    });
    return row;
  });
  return { user: staffView(user), generatedPassword, totp: enrolment };
}

/** Every staff account, by email. */
export async function listStaffUsers(exec: DbExecutor): Promise<StaffUserView[]> {
  const rows = await exec.select().from(adminUsers).orderBy(asc(adminUsers.email));
  return rows.map(staffView);
}

/** One staff account, or null. */
export async function getStaffUser(exec: DbExecutor, id: string): Promise<StaffUserView | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  return row === undefined ? null : staffView(row);
}

async function lockStaffUser(
  tx: DbTransaction,
  id: string,
): Promise<typeof adminUsers.$inferSelect> {
  if (!UUID_RE.test(id)) throw domainNotFound('Staff account');
  const [row] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).for('update');
  if (row === undefined) throw domainNotFound('Staff account');
  return row;
}

/**
 * Serialises changes that could leave no enabled admin, then refuses (409
 * `last_admin`) when the account is the only enabled admin left.
 */
async function assertNotLastAdmin(
  tx: DbTransaction,
  user: typeof adminUsers.$inferSelect,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vamos:staff-admins'))`);
  if (user.role !== 'admin' || user.disabledAt !== null) return;
  const [other] = await tx
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(eq(adminUsers.role, 'admin'), isNull(adminUsers.disabledAt), ne(adminUsers.id, user.id)),
    )
    .limit(1);
  if (other === undefined) {
    throw domainConflict(
      'last_admin',
      'This is the only enabled admin account. Make another admin first.',
    );
  }
}

/** Revokes every live session of the staff account; returns how many. */
export async function revokeAllStaffSessions(
  exec: DbExecutor,
  adminUserId: string,
  now: Date,
): Promise<number> {
  const rows = await exec
    .update(adminSessions)
    .set({ revokedAt: now })
    .where(and(eq(adminSessions.adminUserId, adminUserId), isNull(adminSessions.revokedAt)))
    .returning({ id: adminSessions.id });
  return rows.length;
}

/**
 * Changes a staff account's role and / or display name (staff.manage).
 * 409 `last_admin` when it would leave no enabled admin. A role change
 * revokes the account's sessions (they carry the old permissions). Audited
 * as `staff.updated` with the values before and after.
 */
export async function updateStaffUser(
  tx: DbTransaction,
  input: {
    adminUserId: string;
    role?: StaffRole;
    displayName?: string;
    actor: StaffAccountActor;
    now: Date;
  },
): Promise<StaffUserView> {
  const actor = auditActor(input.actor);
  const role = input.role === undefined ? undefined : checkedRole(input.role);
  const displayName =
    input.displayName === undefined ? undefined : checkedDisplayName(input.displayName);
  const user = await lockStaffUser(tx, input.adminUserId);
  const roleChanged = role !== undefined && role !== user.role;
  const nameChanged = displayName !== undefined && displayName !== user.displayName;
  if (!roleChanged && !nameChanged) return staffView(user);
  if (roleChanged) await assertNotLastAdmin(tx, user);
  const [row] = await tx
    .update(adminUsers)
    .set({
      ...(roleChanged ? { role } : {}),
      ...(nameChanged ? { displayName } : {}),
      updatedAt: input.now,
    })
    .where(eq(adminUsers.id, user.id))
    .returning();
  if (row === undefined) throw domainNotFound('Staff account');
  const revoked = roleChanged ? await revokeAllStaffSessions(tx, user.id, input.now) : 0;
  await writeAudit(tx, {
    ...actor,
    action: 'staff.updated',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: {
      before: { role: user.role, displayName: user.displayName },
      after: { role: row.role, displayName: row.displayName },
      revokedSessions: revoked,
    },
  });
  return staffView(row);
}

/**
 * Disables (revoking every session) or re-enables a staff account. 409
 * `last_admin` when disabling the only enabled admin. Repeating it changes
 * nothing. Audited as `staff.disabled` / `staff.enabled`.
 */
export async function setStaffDisabled(
  tx: DbTransaction,
  input: { adminUserId: string; disabled: boolean; actor: StaffAccountActor; now: Date },
): Promise<StaffUserView> {
  const actor = auditActor(input.actor);
  const user = await lockStaffUser(tx, input.adminUserId);
  if ((user.disabledAt !== null) === input.disabled) return staffView(user);
  if (input.disabled) await assertNotLastAdmin(tx, user);
  const [row] = await tx
    .update(adminUsers)
    .set({ disabledAt: input.disabled ? input.now : null, updatedAt: input.now })
    .where(eq(adminUsers.id, user.id))
    .returning();
  if (row === undefined) throw domainNotFound('Staff account');
  const revoked = input.disabled ? await revokeAllStaffSessions(tx, user.id, input.now) : 0;
  await writeAudit(tx, {
    ...actor,
    action: input.disabled ? 'staff.disabled' : 'staff.enabled',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: { email: user.email, revokedSessions: revoked },
  });
  return staffView(row);
}

/**
 * Issues a new TOTP secret (the old one stops working), clears the replay
 * guard and the lockout, and revokes every session. Audited as
 * `staff.totp_reset`. Returns the secret to enrol (show it once).
 */
export async function resetStaffTotp(
  tx: DbTransaction,
  deps: Pick<StaffAuthDeps, 'randomBytes' | 'totpKey'>,
  input: { adminUserId: string; actor: StaffAccountActor; now: Date },
): Promise<TotpEnrolment> {
  const actor = auditActor(input.actor);
  const user = await lockStaffUser(tx, input.adminUserId);
  const { stored, enrolment } = newEnrolment(deps, user.id, user.email);
  await tx
    .update(adminUsers)
    .set({
      totpSecretEnc: stored,
      totpEnrolledAt: input.now,
      totpLastStep: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedAt: input.now,
    })
    .where(eq(adminUsers.id, user.id));
  const revoked = await revokeAllStaffSessions(tx, user.id, input.now);
  await writeAudit(tx, {
    ...actor,
    action: 'staff.totp_reset',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: { email: user.email, revokedSessions: revoked },
  });
  return enrolment;
}

/**
 * Sets a new password (staff.manage), clears the lockout and revokes every
 * session. 422 `weak_password`. Audited as `staff.password_reset`.
 */
export async function resetStaffPassword(
  deps: StaffAuthDeps,
  input: { adminUserId: string; password: string; actor: StaffAccountActor },
): Promise<StaffUserView> {
  const actor = auditActor(input.actor);
  const existing = await getStaffUser(deps.db, input.adminUserId);
  if (existing === null) throw domainNotFound('Staff account');
  assertStaffPassword(input.password, existing.email);
  const passwordHash = await deps.passwords.hash(input.password);
  const now = deps.clock();
  return deps.db.transaction(async (tx) => {
    const user = await lockStaffUser(tx, input.adminUserId);
    const [row] = await tx
      .update(adminUsers)
      .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(eq(adminUsers.id, user.id))
      .returning();
    if (row === undefined) throw domainNotFound('Staff account');
    const revoked = await revokeAllStaffSessions(tx, user.id, now);
    await writeAudit(tx, {
      ...actor,
      action: 'staff.password_reset',
      targetType: 'admin_user',
      targetId: user.id,
      metadata: { email: user.email, revokedSessions: revoked },
    });
    return staffView(row);
  });
}

/** Lifts a lockout before it ends (staff.manage). Audited as `staff.unlocked` when it changed anything. */
export async function unlockStaffUser(
  tx: DbTransaction,
  input: { adminUserId: string; actor: StaffAccountActor; now: Date },
): Promise<StaffUserView> {
  const actor = auditActor(input.actor);
  const user = await lockStaffUser(tx, input.adminUserId);
  if (user.lockedUntil === null && user.failedLoginAttempts === 0) return staffView(user);
  const [row] = await tx
    .update(adminUsers)
    .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: input.now })
    .where(eq(adminUsers.id, user.id))
    .returning();
  if (row === undefined) throw domainNotFound('Staff account');
  await writeAudit(tx, {
    ...actor,
    action: 'staff.unlocked',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: { email: user.email, lockedUntil: user.lockedUntil },
  });
  return staffView(row);
}

type LoginFailureReason =
  | 'unknown_email'
  | 'disabled'
  | 'locked'
  | 'password'
  | 'totp_not_enrolled'
  | 'totp_unreadable'
  | 'totp_invalid'
  | 'totp_replay';

/** Reasons that count toward the lockout. */
const COUNTED_FAILURES: ReadonlySet<LoginFailureReason> = new Set([
  'password',
  'totp_invalid',
  'totp_replay',
]);

/**
 * Signs a staff member in with email, password and TOTP code, and opens a
 * session. Every failure is recorded (counters, lockout, audit) in its own
 * committed transaction and then thrown as 401 `invalid_credentials`; see
 * the module comment for the rules. Audited as `staff.login` /
 * `staff.login_failed` (with the reason) / `staff.locked`.
 */
export async function loginStaff(
  deps: StaffAuthDeps,
  input: StaffLoginInput,
): Promise<StaffLoginResult> {
  const email = typeof input.email === 'string' ? normalizeStaffEmail(input.email) : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const ip = input.ip ?? null;
  const now = deps.clock();

  const outcome = await deps.db.transaction(
    async (tx): Promise<{ ok: true; result: StaffLoginResult } | { ok: false }> => {
      const [user] =
        email.length === 0 || email.length > STAFF_EMAIL_MAX_LENGTH
          ? []
          : await tx.select().from(adminUsers).where(eq(adminUsers.email, email)).for('update');
      const fail = async (reason: LoginFailureReason): Promise<{ ok: false }> => {
        await recordLoginFailure(tx, { user, email, reason, now, ip });
        return { ok: false };
      };

      if (user === undefined) {
        await dummyVerify(deps.passwords, password);
        return fail('unknown_email');
      }
      if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
        await dummyVerify(deps.passwords, password);
        return fail('locked');
      }
      const passwordOk = await deps.passwords.verify(user.passwordHash, password);
      if (user.disabledAt !== null) return fail('disabled');
      if (!passwordOk) return fail('password');
      if (user.totpSecretEnc === null) return fail('totp_not_enrolled');

      let secret: Buffer;
      try {
        secret = decryptTotpSecret(deps.totpKey, user.totpSecretEnc, user.id);
      } catch (error) {
        if (error instanceof TotpSecretError) return fail('totp_unreadable');
        throw error;
      }
      const step = verifyTotp(secret, code, now.getTime(), { afterStep: user.totpLastStep });
      if (step === null) {
        const replay = verifyTotp(secret, code, now.getTime()) !== null;
        return fail(replay ? 'totp_replay' : 'totp_invalid');
      }

      await tx
        .update(adminUsers)
        .set({
          failedLoginAttempts: 0,
          lockedUntil: null,
          totpLastStep: step,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(adminUsers.id, user.id));
      const session = await createStaffSession(tx, deps, {
        adminUserId: user.id,
        now,
        ip,
        userAgent: input.userAgent ?? null,
      });
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: user.id,
        action: 'staff.login',
        targetType: 'admin_user',
        targetId: user.id,
        metadata: { sessionId: session.id },
        ip,
      });
      return {
        ok: true,
        result: {
          session,
          staff: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            sessionId: session.id,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
            idleExpiresAt: session.idleExpiresAt,
          },
        },
      };
    },
  );
  if (!outcome.ok) throw staffInvalidCredentialsError();
  return outcome.result;
}

async function recordLoginFailure(
  tx: DbTransaction,
  input: {
    user: typeof adminUsers.$inferSelect | undefined;
    email: string;
    reason: LoginFailureReason;
    now: Date;
    ip: string | null;
  },
): Promise<void> {
  const { user, reason, now, ip } = input;
  if (user === undefined) {
    await writeAudit(tx, {
      actorType: 'system',
      action: 'staff.login_failed',
      targetType: 'admin_user',
      metadata: { reason, email: input.email.slice(0, STAFF_EMAIL_MAX_LENGTH) },
      ip,
    });
    return;
  }
  let attempts = user.failedLoginAttempts;
  let lockedUntil: Date | null = null;
  if (COUNTED_FAILURES.has(reason)) {
    attempts += 1;
    if (attempts >= STAFF_LOCKOUT_THRESHOLD) {
      lockedUntil = new Date(now.getTime() + STAFF_LOCKOUT_MS);
    }
    await tx
      .update(adminUsers)
      .set(
        lockedUntil === null
          ? { failedLoginAttempts: attempts, updatedAt: now }
          : { failedLoginAttempts: 0, lockedUntil, updatedAt: now },
      )
      .where(eq(adminUsers.id, user.id));
  }
  await writeAudit(tx, {
    actorType: 'system',
    action: 'staff.login_failed',
    targetType: 'admin_user',
    targetId: user.id,
    metadata: { reason, attempts },
    ip,
  });
  if (lockedUntil !== null) {
    await writeAudit(tx, {
      actorType: 'system',
      action: 'staff.locked',
      targetType: 'admin_user',
      targetId: user.id,
      metadata: { lockedUntil, attempts },
      ip,
    });
  }
}

/**
 * Opens a staff session (sign-in already verified the password and the TOTP
 * code: mfa_verified_at = now), in the caller's transaction.
 */
export async function createStaffSession(
  tx: DbTransaction,
  deps: Pick<StaffAuthDeps, 'randomBytes'>,
  input: { adminUserId: string; now: Date; ip?: string | null; userAgent?: string | null },
): Promise<IssuedStaffSession> {
  const token = deps.randomBytes(32).toString('base64url');
  if (!TOKEN_RE.test(token)) throw new RangeError('randomBytes returned too few bytes');
  const csrfToken = staffCsrfTokenFor(token);
  const { now } = input;
  const expiresAt = new Date(now.getTime() + STAFF_SESSION_ABSOLUTE_MS);
  const [row] = await tx
    .insert(adminSessions)
    .values({
      adminUserId: input.adminUserId,
      tokenHash: sha256Hex(token),
      csrfHash: sha256Hex(csrfToken),
      mfaVerifiedAt: now,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    })
    .returning({ id: adminSessions.id });
  if (row === undefined) throw new Error('admin_sessions insert returned no row');
  return {
    id: row.id,
    token,
    csrfToken,
    expiresAt,
    idleExpiresAt: new Date(Math.min(now.getTime() + STAFF_SESSION_IDLE_MS, expiresAt.getTime())),
  };
}

export type StaffSessionCheck =
  | { status: 'ok'; staff: StaffPrincipal }
  /** No session, or it is expired (idle or absolute), revoked, or its account disabled. */
  | { status: 'none' }
  /** A valid session whose unsafe request lacks the right CSRF token (403). */
  | { status: 'csrf_invalid' };

/**
 * Resolves a staff session cookie. With `checkCsrf` (unsafe methods) the
 * CSRF token must match the session's (constant-time). A valid session's
 * last_seen_at is moved to now (at most once per STAFF_SESSION_TOUCH_MS),
 * which keeps it from idling out; a CSRF failure does not count as activity.
 */
export async function authenticateStaffSession(
  deps: Pick<StaffAuthDeps, 'db' | 'clock'>,
  input: { token: string | null | undefined; csrfToken?: string | null; checkCsrf: boolean },
): Promise<StaffSessionCheck> {
  const { token } = input;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { status: 'none' };
  const now = deps.clock();
  const [row] = await deps.db
    .select({
      sessionId: adminSessions.id,
      csrfHash: adminSessions.csrfHash,
      mfaVerifiedAt: adminSessions.mfaVerifiedAt,
      lastSeenAt: adminSessions.lastSeenAt,
      expiresAt: adminSessions.expiresAt,
      revokedAt: adminSessions.revokedAt,
      id: adminUsers.id,
      email: adminUsers.email,
      displayName: adminUsers.displayName,
      role: adminUsers.role,
      disabledAt: adminUsers.disabledAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .where(eq(adminSessions.tokenHash, sha256Hex(token)))
    .limit(1);
  if (row === undefined || !isLive(row, now)) return { status: 'none' };

  if (input.checkCsrf) {
    const csrf = typeof input.csrfToken === 'string' ? input.csrfToken : '';
    if (csrf.length === 0 || csrf.length > 128 || !safeEqualHex(sha256Hex(csrf), row.csrfHash)) {
      return { status: 'csrf_invalid' };
    }
  }

  let lastSeenAt = row.lastSeenAt;
  if (now.getTime() - row.lastSeenAt.getTime() >= STAFF_SESSION_TOUCH_MS) {
    await deps.db
      .update(adminSessions)
      .set({ lastSeenAt: now })
      .where(and(eq(adminSessions.id, row.sessionId), isNull(adminSessions.revokedAt)));
    lastSeenAt = now;
  }
  return {
    status: 'ok',
    staff: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      sessionId: row.sessionId,
      csrfToken: staffCsrfTokenFor(token),
      expiresAt: row.expiresAt,
      idleExpiresAt: new Date(
        Math.min(lastSeenAt.getTime() + STAFF_SESSION_IDLE_MS, row.expiresAt.getTime()),
      ),
    },
  };
}

function isLive(
  row: {
    revokedAt: Date | null;
    mfaVerifiedAt: Date | null;
    lastSeenAt: Date;
    expiresAt: Date;
    disabledAt: Date | null;
  },
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    row.revokedAt === null &&
    row.mfaVerifiedAt !== null &&
    row.disabledAt === null &&
    t < row.expiresAt.getTime() &&
    t - row.lastSeenAt.getTime() < STAFF_SESSION_IDLE_MS
  );
}

/** Whether a staff session still authenticates (long-lived streams poll it). */
export async function isStaffSessionActive(
  deps: Pick<StaffAuthDeps, 'db' | 'clock'>,
  sessionId: string,
): Promise<boolean> {
  if (!UUID_RE.test(sessionId)) return false;
  const [row] = await deps.db
    .select({
      revokedAt: adminSessions.revokedAt,
      mfaVerifiedAt: adminSessions.mfaVerifiedAt,
      lastSeenAt: adminSessions.lastSeenAt,
      expiresAt: adminSessions.expiresAt,
      disabledAt: adminUsers.disabledAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminUserId))
    .where(eq(adminSessions.id, sessionId))
    .limit(1);
  return row !== undefined && isLive(row, deps.clock());
}

/** Ends a staff session (sign-out). Audited as `staff.logout` when it was live. */
export async function logoutStaff(
  deps: Pick<StaffAuthDeps, 'db' | 'clock'>,
  input: { sessionId: string; adminUserId: string; ip?: string | null },
): Promise<boolean> {
  if (!UUID_RE.test(input.sessionId)) return false;
  const now = deps.clock();
  return deps.db.transaction(async (tx) => {
    const revoked = await tx
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(adminSessions.id, input.sessionId),
          eq(adminSessions.adminUserId, input.adminUserId),
          isNull(adminSessions.revokedAt),
        ),
      )
      .returning({ id: adminSessions.id });
    if (revoked.length === 0) return false;
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: input.adminUserId,
      action: 'staff.logout',
      targetType: 'admin_user',
      targetId: input.adminUserId,
      metadata: { sessionId: input.sessionId },
      ip: input.ip ?? null,
    });
    return true;
  });
}
