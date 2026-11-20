import { birr, businessDateOf, toWire } from '@vamos/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { retailAlerts } from '../schema/retail-alerts';

/**
 * Alerts about the agent shops (docs/plans/agent-shops.md, "Phase 5 design", step 4). A worker scan
 * raises each alert once per subject (the dedup key) and logs it as an `alarm` line; staff see the
 * open ones in the back office and acknowledge them (audited). The thresholds below are the plan's
 * defaults.
 */

export type RetailAlert = typeof retailAlerts.$inferSelect;
export type RetailAlertKind = RetailAlert['kind'];

/** The scan's thresholds (RETAIL_ALERT_RULES; tests pass smaller ones). */
export interface RetailAlertRules {
  bigWin: bigint;
  repeatedPicks: { times: number; windowMs: number };
  manyCancels: number;
  lateTicketMs: number;
  lowBalance: bigint;
  payoutWaitingMs: number;
  lookBackMs: number;
}

export const RETAIL_ALERT_RULES: RetailAlertRules = {
  /** A ticket whose possible net win reaches this. */
  bigWin: birr(100_000),
  /** The same selections sold this many times, in at least two shops, within the window. */
  repeatedPicks: { times: 3, windowMs: 2 * 3_600_000 },
  /** Cancels by one cashier in one business day. */
  manyCancels: 5,
  /** A ticket sold this close to its first kick-off. */
  lateTicketMs: 2 * 60_000,
  /** An independent agent's balance below this. */
  lowBalance: birr(1_000),
  /** A payout waiting for HQ's approval longer than this. */
  payoutWaitingMs: 30 * 60_000,
  /** How far back the scan looks at tickets (it runs every few minutes). */
  lookBackMs: 24 * 3_600_000,
};

interface Candidate {
  kind: RetailAlertKind;
  dedupKey: string;
  agentId: string | null;
  shopId: string | null;
  details: Record<string, unknown>;
}

type Row = Record<string, unknown>;

async function rows(exec: DbExecutor, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await exec.execute(query)).rows;
}

const str = (value: unknown): string => String(value);
const santim = (value: unknown): string => toWire(BigInt(String(value)));

/** Every alert the shops' data calls for now (before the dedup keys drop the known ones). */
async function candidates(
  exec: DbExecutor,
  now: Date,
  rules: RetailAlertRules,
): Promise<Candidate[]> {
  const since = new Date(now.getTime() - rules.lookBackMs);
  const day = businessDateOf(now);
  const found: Candidate[] = [];

  for (const r of await rows(
    exec,
    sql`SELECT t.id, t.agent_id, t.shop_id, b.short_id, t.stake, b.potential_net_payout
        FROM retail_tickets t JOIN bets b ON b.id = t.bet_id
        WHERE t.sold_at >= ${since} AND t.status <> 'cancelled'
          AND b.potential_net_payout >= ${rules.bigWin}`,
  )) {
    found.push({
      kind: 'big_win',
      dedupKey: `big_win:${str(r.id)}`,
      agentId: str(r.agent_id),
      shopId: str(r.shop_id),
      details: {
        ticketId: str(r.id),
        number: str(r.short_id),
        stake: santim(r.stake),
        possibleWin: santim(r.potential_net_payout),
      },
    });
  }

  const pickWindow = new Date(now.getTime() - rules.repeatedPicks.windowMs);
  for (const r of await rows(
    exec,
    sql`WITH picks AS (
          SELECT t.id, t.shop_id, t.agent_id,
                 string_agg(l.selection_id::text, ',' ORDER BY l.selection_id) AS signature
          FROM retail_tickets t JOIN bet_legs l ON l.bet_id = t.bet_id
          WHERE t.sold_at >= ${pickWindow} AND t.status <> 'cancelled'
          GROUP BY t.id, t.shop_id, t.agent_id)
        SELECT md5(signature) AS signature, count(*) AS tickets,
               count(DISTINCT shop_id) AS shops, min(agent_id::text) AS agent_id,
               array_agg(id::text) AS ticket_ids
        FROM picks GROUP BY signature
        HAVING count(*) >= ${rules.repeatedPicks.times} AND count(DISTINCT shop_id) >= 2`,
  )) {
    found.push({
      kind: 'repeated_picks',
      dedupKey: `repeated_picks:${str(r.signature)}:${day}`,
      agentId: null,
      shopId: null,
      details: {
        tickets: Number(r.tickets),
        shops: Number(r.shops),
        ticketIds: r.ticket_ids,
      },
    });
  }

  for (const r of await rows(
    exec,
    sql`SELECT t.cancelled_by, min(t.agent_id::text) AS agent_id, min(t.shop_id::text) AS shop_id,
               count(*) AS cancels, u.display_name
        FROM retail_tickets t JOIN admin_users u ON u.id = t.cancelled_by
        WHERE t.cancelled_at >= ${since}
          AND (t.cancelled_at AT TIME ZONE 'Africa/Addis_Ababa')::date = ${day}::date
        GROUP BY t.cancelled_by, u.display_name
        HAVING count(*) >= ${rules.manyCancels}`,
  )) {
    found.push({
      kind: 'many_cancels',
      dedupKey: `many_cancels:${str(r.cancelled_by)}:${day}`,
      agentId: str(r.agent_id),
      shopId: str(r.shop_id),
      details: {
        staffId: str(r.cancelled_by),
        staffName: str(r.display_name),
        cancels: Number(r.cancels),
        day,
      },
    });
  }

  for (const r of await rows(
    exec,
    sql`SELECT t.id, t.agent_id, t.shop_id, b.short_id, t.sold_at, min(e.start_time) AS kickoff
        FROM retail_tickets t
        JOIN bets b ON b.id = t.bet_id
        JOIN bet_legs l ON l.bet_id = t.bet_id
        JOIN events e ON e.id = l.event_id
        WHERE t.sold_at >= ${since}
        GROUP BY t.id, t.agent_id, t.shop_id, b.short_id, t.sold_at
        HAVING min(e.start_time) - t.sold_at <= ${`${rules.lateTicketMs / 1000} seconds`}::interval`,
  )) {
    found.push({
      kind: 'late_ticket',
      dedupKey: `late_ticket:${str(r.id)}`,
      agentId: str(r.agent_id),
      shopId: str(r.shop_id),
      details: {
        ticketId: str(r.id),
        number: str(r.short_id),
        soldAt: new Date(str(r.sold_at)).toISOString(),
        kickoff: new Date(str(r.kickoff)).toISOString(),
      },
    });
  }

  for (const r of await rows(
    exec,
    sql`SELECT g.id, g.number, g.name, coalesce(a.balance, 0) AS balance
        FROM agents g LEFT JOIN ledger_accounts a ON a.agent_id = g.id
        WHERE NOT g.is_house AND g.status = 'active'
          AND coalesce(a.balance, 0) < ${rules.lowBalance}
          AND EXISTS (SELECT 1 FROM cashier_shops s WHERE s.agent_id = g.id AND s.active)`,
  )) {
    found.push({
      kind: 'low_balance',
      dedupKey: `low_balance:${str(r.id)}:${day}`,
      agentId: str(r.id),
      shopId: null,
      details: {
        agentNumber: Number(r.number),
        agentName: str(r.name),
        balance: santim(r.balance),
      },
    });
  }

  const waitingSince = new Date(now.getTime() - rules.payoutWaitingMs);
  for (const r of await rows(
    exec,
    sql`SELECT t.id, t.agent_id, t.shop_id, b.short_id, t.approval_requested_at
        FROM retail_tickets t JOIN bets b ON b.id = t.bet_id
        WHERE t.approval_requested_at IS NOT NULL AND t.approved_at IS NULL
          AND t.status = 'sold' AND t.approval_requested_at < ${waitingSince}`,
  )) {
    found.push({
      kind: 'payout_waiting',
      dedupKey: `payout_waiting:${str(r.id)}`,
      agentId: str(r.agent_id),
      shopId: str(r.shop_id),
      details: {
        ticketId: str(r.id),
        number: str(r.short_id),
        requestedAt: new Date(str(r.approval_requested_at)).toISOString(),
      },
    });
  }

  for (const r of await rows(
    exec,
    sql`SELECT d.id, d.label, d.shop_id, s.agent_id
        FROM shop_devices d JOIN cashier_shops s ON s.id = d.shop_id
        WHERE d.status = 'pending'`,
  )) {
    found.push({
      kind: 'device_waiting',
      dedupKey: `device_waiting:${str(r.id)}`,
      agentId: str(r.agent_id),
      shopId: str(r.shop_id),
      details: { deviceId: str(r.id), label: str(r.label) },
    });
  }
  return found;
}

/**
 * Raises the alerts the shops' data calls for and that were not raised before (once per dedup
 * key). Returns the new ones (the caller logs each as an alarm).
 */
export async function scanRetailAlerts(
  tx: DbTransaction,
  now: Date,
  rules: RetailAlertRules = RETAIL_ALERT_RULES,
): Promise<RetailAlert[]> {
  const raised: RetailAlert[] = [];
  for (const candidate of await candidates(tx, now, rules)) {
    const [row] = await tx
      .insert(retailAlerts)
      .values({ ...candidate, createdAt: now })
      .onConflictDoNothing({ target: retailAlerts.dedupKey })
      .returning();
    if (row !== undefined) raised.push(row);
  }
  return raised;
}

/** Alerts, newest first: the open ones only, or all. */
export async function listRetailAlerts(
  exec: DbExecutor,
  filter: { open: boolean; limit: number },
): Promise<RetailAlert[]> {
  return exec
    .select()
    .from(retailAlerts)
    .where(filter.open ? isNull(retailAlerts.acknowledgedAt) : undefined)
    .orderBy(desc(retailAlerts.createdAt), desc(retailAlerts.id))
    .limit(filter.limit);
}

/** Staff acknowledge an alert (already acknowledged: returned as it is). Audited. */
export async function acknowledgeRetailAlert(
  tx: DbTransaction,
  input: { alertId: string; staffId: string; now: Date; ip?: string | null },
): Promise<RetailAlert> {
  const [alert] = await tx
    .select()
    .from(retailAlerts)
    .where(eq(retailAlerts.id, input.alertId))
    .for('update');
  if (!alert) throw domainNotFound('Alert');
  if (alert.acknowledgedAt !== null) return alert;
  const [after] = await tx
    .update(retailAlerts)
    .set({ acknowledgedAt: input.now, acknowledgedBy: input.staffId })
    .where(and(eq(retailAlerts.id, alert.id), isNull(retailAlerts.acknowledgedAt)))
    .returning();
  if (!after) throw domainNotFound('Alert');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: 'retail.alert_acknowledged',
    targetType: 'retail_alert',
    targetId: alert.id,
    metadata: { kind: alert.kind, dedupKey: alert.dedupKey },
    ip: input.ip ?? null,
  });
  return after;
}
