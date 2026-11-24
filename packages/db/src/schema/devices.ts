import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './accounts';
import { cashierShops } from './cashier';

/**
 * Shop devices (docs/plans/agent-shops.md, phase 1b): a counter computer or POS terminal of one
 * shop. A cashier's device asks to be registered; an admin approves or revokes it; the shop app
 * signs a cashier in only on an approved device of their own shop. The device keeps a random
 * secret in a cookie; only its SHA-256 is stored here.
 */
export const shopDeviceStatus = pgEnum('shop_device_status', ['pending', 'approved', 'revoked']);

export const shopDevices = pgTable(
  'shop_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => cashierShops.id, { onDelete: 'restrict' }),
    /** A name the cashier gives it ("Counter PC 1"). */
    label: text('label').notNull(),
    /** SHA-256 (hex) of the device secret; the secret itself is never stored. */
    secretHash: text('secret_hash').notNull(),
    status: shopDeviceStatus('status').notNull().default('pending'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => adminUsers.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent').notNull().default(''),
    /** The admin who approved or revoked it. */
    decidedBy: uuid('decided_by').references(() => adminUsers.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    /** Last request from the device (written at most every few minutes). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('shop_devices_secret_uq').on(t.secretHash),
    index('shop_devices_shop_idx').on(t.shopId, t.status),
    check('shop_devices_label_length', sql`char_length(${t.label}) BETWEEN 1 AND 60`),
    check('shop_devices_secret_hash_format', sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
    check('shop_devices_user_agent_length', sql`char_length(${t.userAgent}) <= 300`),
    check(
      'shop_devices_revoked_consistent',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`,
    ),
    check(
      'shop_devices_approved_consistent',
      sql`${t.status} <> 'approved' OR ${t.approvedAt} IS NOT NULL`,
    ),
    check(
      'shop_devices_pending_consistent',
      sql`${t.status} <> 'pending' OR ${t.approvedAt} IS NULL`,
    ),
  ],
);
