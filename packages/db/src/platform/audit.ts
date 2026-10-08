import type { ActorType, DbExecutor } from '../ledger/types';
import { auditLog } from '../schema/platform';
import { toJsonSafe } from './json';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Appends to the audit trail (append-only; UPDATE/DELETE are rejected by a trigger). */
export async function writeAudit(exec: DbExecutor, entry: AuditEntry): Promise<void> {
  await exec.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata === undefined ? null : toJsonSafe(entry.metadata),
    ip: entry.ip ?? null,
  });
}
