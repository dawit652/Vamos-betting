import { DomainError } from '../errors';
import type { ActorType } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import type { DbExecutor } from '../ledger/types';

/**
 * Who made a change: a staff member (`adminId`, with the request ip) or the
 * system (`system`, e.g. 'system:scraper'). Both are written to `updated_by`
 * columns as one string and to the audit log with the right actor type.
 */
export type ScrapeActor = { adminId: string; ip?: string | null } | { system: string };

export function actorLabel(actor: ScrapeActor): string {
  return 'adminId' in actor ? actor.adminId : actor.system;
}

/** Appends an audit record for a scrape change (action names are `scrape.<noun>.<verb>`). */
export async function auditScrape(
  exec: DbExecutor,
  actor: ScrapeActor,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const actorType: ActorType = 'adminId' in actor ? 'admin' : 'system';
  await writeAudit(exec, {
    actorType,
    actorId: actorLabel(actor),
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    ip: 'adminId' in actor ? (actor.ip ?? null) : null,
  });
}

/** An alias would map one (sport, name, source) to two different catalogue rows. */
export class ScrapeAliasConflictError extends DomainError {
  constructor(
    readonly aliasKind: 'team' | 'competition',
    readonly aliasNorm: string,
    readonly sourceId: string | null,
    readonly existingTargetId: string,
  ) {
    super(
      409,
      'scrape_alias_conflict',
      `"${aliasNorm}" already maps to another ${aliasKind} for ${sourceId ?? 'any source'}`,
      { aliasKind, aliasNorm, sourceId, existingTargetId },
    );
    this.name = 'ScrapeAliasConflictError';
  }
}

/** A review item is not in the state the change needs (e.g. resolving one that is already closed). */
export class ScrapeReviewStateError extends DomainError {
  constructor(id: string, status: string) {
    super(409, 'scrape_review_not_open', `review item ${id} is already ${status}`, { id, status });
    this.name = 'ScrapeReviewStateError';
  }
}

/** A run is not running (it was already finished). */
export class ScrapeRunStateError extends DomainError {
  constructor(id: string, status: string) {
    super(409, 'scrape_run_finished', `run ${id} is already ${status}`, { id, status });
    this.name = 'ScrapeRunStateError';
  }
}

/** Largest page a list function returns. */
export const MAX_PAGE_SIZE = 500;

export function clampLimit(limit: number | undefined, fallback = 100, max = MAX_PAGE_SIZE): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('limit must be a positive integer');
  return Math.min(limit, max);
}
