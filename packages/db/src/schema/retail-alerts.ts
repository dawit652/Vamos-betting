import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminUsers } from './accounts';
import { cashierShops } from './cashier';
import { agents } from './retail';

/**
 * Alerts about the agent shops (docs/plans/agent-shops.md, "Phase 5 design", step 4), raised by a
 * worker scan: each once per subject (`dedup_key`), listed in the back office until staff
 * acknowledge it. Never deleted.
 */
export const retailAlertKind = pgEnum('retail_alert_kind', [
  /** A ticket's possible win is above the alert threshold. */
  'big_win',
  /** The same selections sold several times across shops in a short time. */
  'repeated_picks',
  /** One cashier cancelled many tickets in a day. */
  'many_cancels',
  /** A ticket sold just before its first kick-off. */
  'late_ticket',
  /** An agent's balance below the alert threshold. */
  'low_balance',
  /** A payout above the agent's HQ limit waiting long for approval. */
  'payout_waiting',
  /** A shop device waiting for an admin's approval. */
  'device_waiting',
]);

export const retailAlerts = pgTable(
  'retail_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: retailAlertKind('kind').notNull(),
    /** Once per subject: e.g. `big_win:<ticket>`, `many_cancels:<cashier>:<day>`. */
    dedupKey: text('dedup_key').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    shopId: uuid('shop_id').references(() => cashierShops.id, { onDelete: 'restrict' }),
    /** What the alert is about (ticket, cashier, device ids, amounts), shown to staff. */
    details: jsonb('details').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('retail_alerts_dedup_uq').on(t.dedupKey),
    index('retail_alerts_open_idx')
      .on(t.createdAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  ],
);
