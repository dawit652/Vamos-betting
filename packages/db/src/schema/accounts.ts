import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
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
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name'),
  /** Gregorian ISO date (YYYY-MM-DD). */
  dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
  locale: text('locale').notNull().default('am'),
  status: userStatus('status').notNull().default('pending_verification'),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

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

/** Back-office staff (Phase 9 adds the admin UI and TOTP enrolment). */
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: adminRole('role').notNull(),
  /** TOTP secret, encrypted at rest by the API. */
  totpSecretEnc: text('totp_secret_enc'),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
});

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
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('admin_sessions_user_idx').on(t.adminUserId)],
);
