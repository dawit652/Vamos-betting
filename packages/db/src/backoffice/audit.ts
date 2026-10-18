import { and, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm';
import { domainBadRequest } from '../errors';
import type { ActorType, DbExecutor } from '../ledger/types';
import { adminUsers } from '../schema/accounts';
import { auditLog } from '../schema/platform';
import { pageLimit, type Page } from './common';

/**
 * The audit log viewer (audit.view): newest first, filtered by actor,
 * action, target and time, paged by an opaque cursor (the last entry's
 * id). Admin actors carry the staff member's email and name.
 */

export interface AuditLogEntry {
  /** bigint as a decimal string (ids grow with time). */
  id: string;
  actorType: ActorType;
  actorId: string | null;
  /** For staff actors: their email and display name (null for others). */
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: Date;
}

export interface AuditLogFilter {
  actorType?: ActorType;
  actorId?: string;
  /** An exact action, or a prefix ending in '.' or '*' (e.g. `staff.`, `payment.*`). */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** createdAt window [from, to). */
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

const CURSOR_RE = /^\d{1,19}$/;

function decodeAuditCursor(cursor: string): bigint {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!CURSOR_RE.test(text)) {
    throw domainBadRequest('invalid_cursor', 'This page cursor is not valid.');
  }
  return BigInt(text);
}

function encodeAuditCursor(id: bigint): string {
  return Buffer.from(id.toString(), 'utf8').toString('base64url');
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Audit entries, newest first. 400 `invalid_cursor` for a cursor it did not hand out. */
export async function listAuditLog(
  exec: DbExecutor,
  filter: AuditLogFilter = {},
): Promise<Page<AuditLogEntry>> {
  const limit = pageLimit(filter.limit, 50, 200);
  const conditions: SQL[] = [];
  if (filter.actorType !== undefined) conditions.push(eq(auditLog.actorType, filter.actorType));
  if (filter.actorId !== undefined) conditions.push(eq(auditLog.actorId, filter.actorId));
  const action = filter.action?.trim();
  if (action !== undefined && action.length > 0) {
    if (action.endsWith('*') || action.endsWith('.')) {
      const prefix = action.endsWith('*') ? action.slice(0, -1) : action;
      conditions.push(like(auditLog.action, `${escapeLike(prefix)}%`));
    } else {
      conditions.push(eq(auditLog.action, action));
    }
  }
  if (filter.targetType !== undefined) conditions.push(eq(auditLog.targetType, filter.targetType));
  if (filter.targetId !== undefined) conditions.push(eq(auditLog.targetId, filter.targetId));
  if (filter.from !== undefined) conditions.push(gte(auditLog.createdAt, filter.from));
  if (filter.to !== undefined) conditions.push(lt(auditLog.createdAt, filter.to));
  if (filter.cursor !== undefined)
    conditions.push(lt(auditLog.id, decodeAuditCursor(filter.cursor)));
  const rows = await exec
    .select({
      id: auditLog.id,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      actorEmail: adminUsers.email,
      actorName: adminUsers.displayName,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
      ip: auditLog.ip,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(
      adminUsers,
      and(eq(auditLog.actorType, 'admin'), sql`${adminUsers.id}::text = ${auditLog.actorId}`),
    )
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({ ...row, id: row.id.toString() })),
    nextCursor: rows.length > limit && last !== undefined ? encodeAuditCursor(last.id) : null,
  };
}
