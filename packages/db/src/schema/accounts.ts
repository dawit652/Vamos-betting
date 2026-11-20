import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  adminRole,
  kycStatus,
  otpPurpose,
  rgExclusionKind,
  rgLimitKind,
  rgLimitPeriod,
  userStatus,
} from './enums';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Players. Identified by their Ethiopian mobile number in E.164 (+2519…/+2517…). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name'),
    /** Gregorian ISO date (YYYY-MM-DD). */
    // Optional at registration (the player confirms 21+); KYC sets the verified date.
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    locale: text('locale').notNull().default('am'),
    status: userStatus('status').notNull().default('pending_verification'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    /**
     * SHA-256 of the token handed to whoever last submitted the registration of
     * a pending account. Verifying the phone requires it, so only the person who
     * chose the password can activate the account. Cleared on verification.
     */
    registrationTokenHash: text('registration_token_hash'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }).notNull(),
    /**
     * When the player opted out of marketing SMS (by texting STOP); null =
     * opted in. Service messages (bet replies, OTPs, payments) are still sent.
     */
    smsMarketingOptOutAt: timestamp('sms_marketing_opt_out_at', { withTimezone: true }),
    ...timestamps,
  },
  // Back-office player list (newest first) and the dashboard's registrations.
  (t) => [index('users_created_idx').on(t.createdAt, t.id)],
);

/** Player sessions. Only a SHA-256 of the bearer token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** SHA-256 of the CSRF token bound to this session (double-submit check). */
    csrfHash: text('csrf_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time passwords sent by SMS. Only an HMAC of the code is stored. */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Rate-limit key of the client address that asked for the code (an IPv4
     * address or an IPv6 /64). The resend cooldown and the hourly cap count
     * per (phone, purpose, requester), under a higher per-number ceiling, so
     * a stranger cannot use up the owner's codes. Null on older rows.
     */
    requesterKey: text('requester_key'),
    /**
     * What the code authorises, when the purpose names something beyond the
     * phone (`payout_account`: `payout_account:<id>`). consumeOtp compares
     * it, so a code sent while adding one account cannot confirm another.
     */
    binding: text('binding'),
  },
  (t) => [index('otp_phone_purpose_idx').on(t.phone, t.purpose, t.createdAt)],
);

/**
 * Identity verification (Fayda national ID). The ID number itself is stored
 * only as a keyed hash (for one-account-per-person checks) plus its last 4 digits.
 */
export const kycProfiles = pgTable(
  'kyc_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: kycStatus('status').notNull().default('unverified'),
    provider: text('provider'),
    idNumberHash: text('id_number_hash'),
    idNumberLast4: text('id_number_last4'),
    verifiedName: text('verified_name'),
    verifiedDateOfBirth: date('verified_date_of_birth', { mode: 'string' }),
    providerReference: text('provider_reference'),
    rejectionReason: text('rejection_reason'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('kyc_id_number_hash_uq')
      .on(t.idNumberHash)
      .where(sql`${t.idNumberHash} IS NOT NULL AND ${t.status} <> 'rejected'`),
    // The back office's KYC review queue.
    index('kyc_pending_idx')
      .on(t.submittedAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Responsible-gambling limits as an append-only history. The active limit for
 * a (kind, period) is the newest row with effective_from <= now(). A NULL
 * amount removes the limit. Decreases apply immediately; increases and
 * removals apply after a cooling-off delay.
 */
export const rgLimits = pgTable(
  'rg_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: rgLimitKind('kind').notNull(),
    period: rgLimitPeriod('period').notNull(),
    amount: bigint('amount', { mode: 'bigint' }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rg_limits_user_idx').on(t.userId, t.kind, t.period, t.effectiveFrom)],
);

/** Cool-off and self-exclusion periods. They cannot be shortened by the player. */
export const rgExclusions = pgTable(
  'rg_exclusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: rgExclusionKind('kind').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    /** NULL = permanent self-exclusion. */
    endsAt: timestamp('ends_at', { withTimezone: true }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rg_exclusions_user_idx').on(t.userId, t.startsAt)],
);

/**
 * Back-office staff. They sign in with email, password and a TOTP code
 * (packages/db/src/backoffice/staff-auth.ts). Emails are stored lowercased.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * Mobile number (E.164, `+2519…`): required for new cashiers (and agent owners), optional for
     * office staff (owner, 19 Nov 2026: every agent's people have a name and a phone number).
     */
    phone: text('phone'),
    role: adminRole('role').notNull(),
    /**
     * TOTP secret, AES-256-GCM encrypted with ADMIN_TOTP_KEY and bound to the
     * row's id (encryptTotpSecret); null until enrolled.
     */
    totpSecretEnc: text('totp_secret_enc'),
    /** When the current TOTP secret was issued. */
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
    /**
     * The TOTP time step (unix time / 30 s) of the last code accepted: a code
     * is only accepted for a later step, so a code cannot be used twice.
     */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    /** Counted failed sign-ins (from any address) since the last success or unlock. */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    /**
     * Sign-in refused from every address until then: the exponential backoff
     * once failedLoginAttempts reaches STAFF_ACCOUNT_BACKOFF_THRESHOLD (the
     * short lockout per address is in admin_login_throttles).
     */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * Set when someone else chose the password (account creation, reset by
     * staff): only the session and /admin/me routes work until the staff
     * member sets a password of their own.
     */
    passwordChangeRequired: boolean('password_change_required').notNull().default(false),
    /**
     * A TOTP secret being enrolled by the staff member themselves (encrypted
     * like totp_secret_enc): it replaces the current one once confirmed with
     * a code from it, within STAFF_TOTP_PENDING_MS of totp_pending_at.
     */
    totpPendingSecretEnc: text('totp_pending_secret_enc'),
    totpPendingAt: timestamp('totp_pending_at', { withTimezone: true }),
    /**
     * When a password someone else chose (account creation, reset by staff)
     * stops working if the staff member has not replaced it by then
     * (STAFF_INITIAL_PASSWORD_TTL_MS; ASVS 2.3.1); null for a password of
     * their own.
     */
    passwordExpiresAt: timestamp('password_expires_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check('admin_users_email_lower', sql`${t.email} = lower(${t.email})`),
    check('admin_users_failed_attempts', sql`${t.failedLoginAttempts} >= 0`),
    check(
      'admin_users_phone_format',
      sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+251[79][0-9]{8}$'`,
    ),
  ],
);

/**
 * Failed staff sign-ins per (account, client address): STAFF_LOCKOUT_THRESHOLD
 * in a row lock that address out of that account for STAFF_LOCKOUT_MS, so a
 * stranger guessing passwords cannot lock the staff member out everywhere.
 */
export const adminLoginThrottles = pgTable(
  'admin_login_throttles',
  {
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    /** The client address (an IPv4 address or an IPv6 /64), '' when unknown. */
    clientKey: text('client_key').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.adminUserId, t.clientKey] }),
    check('admin_login_throttles_failed_attempts', sql`${t.failedAttempts} >= 0`),
  ],
);

/**
 * Staff sessions (cookie only, never a bearer token). Only SHA-256 hashes of
 * the session and CSRF tokens are stored. A session ends at expires_at
 * (absolute, 12 h after sign-in), after 30 min without a request
 * (last_seen_at), on sign-out or when revoked.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    csrfHash: text('csrf_hash').notNull(),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last authenticated request (written at most once a minute). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * Where the session works: `admin` (the back office, signed in with a TOTP code) or `shop` (the
     * shop app, signed in on an approved shop device; docs/plans/agent-shops.md phase 1b). A session
     * never works on the other side.
     */
    channel: text('channel').notNull().default('admin'),
    /** The approved shop device a `shop` session was opened on (shop_devices.id). */
    deviceId: uuid('device_id'),
  },
  (t) => [
    index('admin_sessions_user_idx').on(t.adminUserId),
    check('admin_sessions_channel', sql`${t.channel} IN ('admin', 'shop')`),
    // A cashier's shop session carries its approved device; an agent owner's (password and
    // authenticator) has none; a back-office session never has one.
    check('admin_sessions_shop_device', sql`${t.channel} = 'shop' OR ${t.deviceId} IS NULL`),
  ],
);
