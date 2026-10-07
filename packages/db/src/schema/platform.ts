import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { actorType, smsStatus } from './enums';

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
