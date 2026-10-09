import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { actorType, operatingMode, smsStatus } from './enums';

/**
 * Transactional outbox: business events written in the same transaction as
 * the change they describe. The worker publishes them to the regulator
 * reporter, SMS notifications and analytics. Payload money values are
 * santim strings.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** After a failed publish: not claimed again before this time (null = due now). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /**
     * Random per row: part of the BullMQ job id, so job ids never repeat
     * across database rebuilds or restores (the id sequence can restart) or
     * between stacks sharing a Redis. A redrive draws a new one.
     */
    jobKey: uuid('job_key').notNull().defaultRandom(),
  },
  (t) => [
    index('outbox_unpublished_idx').on(t.publishedAt, t.id),
    index('outbox_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);

/** Append-only audit trail of security- and money-relevant actions. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_target_idx').on(t.targetType, t.targetId),
    index('audit_actor_idx').on(t.actorType, t.actorId),
  ],
);

/** Business settings editable in the back office (limits, tax, bonus ladder…). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

/** Outgoing SMS. The mock provider only records rows here (dev inbox). */
export const smsMessages = pgTable(
  'sms_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    to: text('to').notNull(),
    body: text('body').notNull(),
    template: text('template').notNull(),
    provider: text('provider').notNull(),
    status: smsStatus('status').notNull().default('queued'),
    providerReference: text('provider_reference'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('sms_to_idx').on(t.to, t.createdAt)],
);

/**
 * Which operating mode this database belongs to: a single row, written by
 * the first API start (or seed) and never changed afterwards (UPDATE/DELETE
 * are rejected by a trigger). A demo database, whose balances are play
 * money, can therefore never be started in licensed (real-money) mode, nor
 * the other way round. In a licensed database, triggers also refuse
 * `demo_topup` transactions and the `house_demo_funding` account.
 */
export const databaseIdentity = pgTable(
  'database_identity',
  {
    id: boolean('id').primaryKey().default(true),
    operatingMode: operatingMode('operating_mode').notNull(),
    /** Random identity of this database (the worker binds its queue prefix to it). */
    installationId: uuid('installation_id').notNull().defaultRandom(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('database_identity_singleton', sql`${t.id}`)],
);
