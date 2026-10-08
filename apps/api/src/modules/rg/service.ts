import { birr, formatBirr, parseSantim, toWire } from '@vamos/core';
import type {
  CreateExclusionRequest,
  Exclusion,
  RgLimitEntry,
  RgLimitsRequest,
  RgLimitsResponse,
} from '@vamos/contracts';
import {
  enqueueOutbox,
  getLimitStates,
  LIMIT_SLOTS,
  limitSlotKey as slotKey,
  limitSlotOf as slotOf,
  loadLimitRows,
  lockUser,
  resolveLimitRows,
  shapeLimits,
  writeAudit,
  type DbExecutor,
  type LimitPeriod,
  type LimitSlot,
  type LimitSlotState,
} from '@vamos/db';
import { rgExclusions, rgLimits } from '@vamos/db/schema';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { badRequest, conflict } from '../../lib/errors';
import { revokeAllUserSessions } from '../../plugins/session';
import type { RequestMeta } from '../auth/service';
import type { ActiveExclusion, ExclusionKind } from './guard';

// The limit model and the stake / deposit guards live in @vamos/db (src/rg).
export {
  assertDepositAllowed,
  assertStakeAllowed,
  getActiveLimits,
  getLimitStates,
  lockUser,
  resolveLimitSlot,
  ROLLING_WINDOW_MS,
  type ActiveLimits,
  type LimitKind,
  type LimitPeriod,
  type LimitRow,
  type LimitShape,
  type LimitSlotState,
  type RollingPeriod,
} from '@vamos/db';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Raising or removing a limit takes effect this long after the request. */
export const LIMIT_INCREASE_DELAY_MS = 24 * HOUR_MS;
/** Smallest and largest limit a player may set (santim). */
export const MIN_LIMIT = birr(1);
export const MAX_LIMIT = birr(10_000_000);
const wireAmount = (amount: bigint | null) => (amount === null ? null : toWire(amount));

function limitEntry(state: LimitSlotState): RgLimitEntry {
  return {
    amount: wireAmount(state.active?.amount ?? null),
    pending:
      state.pending === null
        ? null
        : {
            amount: wireAmount(state.pending.amount),
            effectiveFrom: state.pending.effectiveFrom.toISOString(),
          },
  };
}

/** GET /me/limits body. */
export async function getLimits(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<RgLimitsResponse> {
  const states = await getLimitStates(exec, userId, now);
  return shapeLimits((kind, period) => limitEntry(slotOf(states, kind, period)));
}

function trySantim(value: string): bigint | null {
  try {
    return parseSantim(value);
  } catch {
    return null;
  }
}

function parseLimitAmount(field: string, value: string): bigint {
  const amount = trySantim(value);
  if (amount === null || amount < MIN_LIMIT || amount > MAX_LIMIT) {
    throw badRequest(
      'invalid_limit',
      `The ${field} limit must be between ETB ${formatBirr(MIN_LIMIT)} and ETB ${formatBirr(MAX_LIMIT)}.`,
      { field, min: toWire(MIN_LIMIT), max: toWire(MAX_LIMIT) },
    );
  }
  return amount;
}

type LimitDecision = 'unchanged' | 'immediate' | 'delayed';

/**
 * How a requested limit applies, given the limit in force and any pending change:
 * - a first limit, or a lower one, applies at once (and cancels a pending change);
 * - a higher limit or a removal applies after LIMIT_INCREASE_DELAY_MS;
 * - repeating the pending value keeps that change (its delay is not restarted);
 * - repeating the active value cancels a pending change.
 */
export function decideLimitChange(
  active: bigint | null,
  pending: { amount: bigint | null } | null,
  requested: bigint | null,
): LimitDecision {
  if (pending !== null && requested === pending.amount) return 'unchanged';
  if (requested === active) return pending === null ? 'unchanged' : 'immediate';
  if (active === null) return 'immediate';
  if (requested === null) return 'delayed';
  return requested < active ? 'immediate' : 'delayed';
}

interface RequestedLimit extends LimitSlot {
  field: string;
  amount: bigint | null;
}

function requestedLimits(input: RgLimitsRequest): RequestedLimit[] {
  const requested: RequestedLimit[] = [];
  for (const { kind, period } of LIMIT_SLOTS) {
    const group: Partial<Record<LimitPeriod, string | null>> | undefined = input[kind];
    const value = group?.[period];
    if (value === undefined) continue;
    const field = slotKey(kind, period);
    requested.push({
      kind,
      period,
      field,
      amount: value === null ? null : parseLimitAmount(field, value),
    });
  }
  return requested;
}

/**
 * PUT /me/limits. Every provided field is validated before anything is
 * written; lowering applies at once, raising or removing after 24 hours.
 * Audited as `rg.limits_changed` when anything changes.
 */
export async function updateLimits(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  input: RgLimitsRequest,
  meta: Pick<RequestMeta, 'ip'>,
): Promise<RgLimitsResponse> {
  const requested = requestedLimits(input);
  const now = deps.clock();

  return deps.db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const rows = await loadLimitRows(tx, userId);
    const states = resolveLimitRows(rows, now);
    // Requests are ordered by created_at, so keep it strictly increasing even
    // when two requests share a clock reading.
    const lastCreatedAt = rows.reduce((max, row) => Math.max(max, row.createdAt.getTime()), 0);
    const createdAt = new Date(Math.max(now.getTime(), lastCreatedAt + 1));

    const inserts: Array<typeof rgLimits.$inferInsert> = [];
    const changes: Array<Record<string, unknown>> = [];
    for (const request of requested) {
      const state = slotOf(states, request.kind, request.period);
      const active = state.active?.amount ?? null;
      const decision = decideLimitChange(active, state.pending, request.amount);
      if (decision === 'unchanged') continue;
      const effectiveFrom =
        decision === 'delayed' ? new Date(now.getTime() + LIMIT_INCREASE_DELAY_MS) : now;
      inserts.push({
        userId,
        kind: request.kind,
        period: request.period,
        amount: request.amount,
        effectiveFrom,
        createdAt,
      });
      changes.push({
        limit: request.field,
        from: active,
        to: request.amount,
        effectiveFrom,
        delayed: decision === 'delayed',
        replacedPending: state.pending !== null,
      });
    }

    if (inserts.length > 0) {
      await tx.insert(rgLimits).values(inserts);
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'rg.limits_changed',
        targetType: 'user',
        targetId: userId,
        metadata: { changes },
        ip: meta.ip,
      });
    }
    return getLimits(tx, userId, now);
  });
}

/** Adds calendar months in UTC, clamping to the end of a shorter month (31 Aug + 6m = 28/29 Feb). */
export function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** End of an exclusion requested at `now`; null = permanent self-exclusion. */
export function exclusionEndsAt(input: CreateExclusionRequest, now: Date): Date | null {
  switch (input.duration) {
    case '24h':
      return new Date(now.getTime() + DAY_MS);
    case '7d':
      return new Date(now.getTime() + 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() + 30 * DAY_MS);
    case '6m':
      return addUtcMonths(now, 6);
    case '1y':
      return addUtcMonths(now, 12);
    case '5y':
      return addUtcMonths(now, 60);
    case 'permanent':
      return null;
  }
}

const KIND_RANK: Record<ExclusionKind, number> = { cool_off: 0, self_exclusion: 1 };

/**
 * True when `next` gives more protection than `current`: it ends later
 * (null = never), or ends at the same time and is a self-exclusion replacing a cool-off.
 */
export function extendsProtection(
  current: Pick<ActiveExclusion, 'kind' | 'endsAt'>,
  next: Pick<ActiveExclusion, 'kind' | 'endsAt'>,
): boolean {
  const currentEnd = current.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const nextEnd = next.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (nextEnd !== currentEnd) return nextEnd > currentEnd;
  return KIND_RANK[next.kind] > KIND_RANK[current.kind];
}

/** The active exclusion (any kind) that protects the longest, or null. */
async function longestActiveExclusion(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<ActiveExclusion | null> {
  const [row] = await exec
    .select({
      kind: rgExclusions.kind,
      startsAt: rgExclusions.startsAt,
      endsAt: rgExclusions.endsAt,
    })
    .from(rgExclusions)
    .where(
      and(
        eq(rgExclusions.userId, userId),
        lte(rgExclusions.startsAt, now),
        or(isNull(rgExclusions.endsAt), gt(rgExclusions.endsAt, now)),
      ),
    )
    // DESC puts NULL (permanent) first in PostgreSQL.
    .orderBy(desc(rgExclusions.endsAt), desc(sql`${rgExclusions.kind} = 'self_exclusion'`))
    .limit(1);
  return row ?? null;
}

/** Wire form of an exclusion (ExclusionSchema). */
export function exclusionBody(exclusion: Pick<ActiveExclusion, 'kind' | 'startsAt' | 'endsAt'>) {
  return {
    kind: exclusion.kind,
    startsAt: exclusion.startsAt.toISOString(),
    endsAt: exclusion.endsAt?.toISOString() ?? null,
  } satisfies Exclusion;
}

export interface CreatedExclusion {
  id: string;
  exclusion: Exclusion;
  /** Sessions revoked by a self-exclusion (0 for a cool-off). */
  revokedSessions: number;
}

/**
 * POST /me/exclusions. Starts a cool-off or self-exclusion now. It may only
 * extend protection: when an active exclusion lasts at least as long, it is
 * kept and 409 `exclusion_active` is thrown. A self-exclusion revokes every
 * session of the player. Audited and published as `rg.exclusion_started`.
 */
export async function createExclusion(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  input: CreateExclusionRequest,
  meta: Pick<RequestMeta, 'ip'>,
): Promise<CreatedExclusion> {
  const now = deps.clock();
  const endsAt = exclusionEndsAt(input, now);

  return deps.db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const current = await longestActiveExclusion(tx, userId, now);
    if (current !== null && !extendsProtection(current, { kind: input.kind, endsAt })) {
      const until = current.endsAt?.toISOString() ?? null;
      throw conflict(
        'exclusion_active',
        until === null
          ? 'A permanent exclusion is already in place.'
          : `An exclusion is already in place until ${until}. A new one can only extend it.`,
        { kind: current.kind, endsAt: until },
      );
    }

    const [row] = await tx
      .insert(rgExclusions)
      .values({
        userId,
        kind: input.kind,
        startsAt: now,
        endsAt,
        reason: `player_request:${input.duration}`,
        createdAt: now,
      })
      .returning({ id: rgExclusions.id });
    if (!row) throw new Error('rg_exclusions insert returned no row');

    const revokedSessions =
      input.kind === 'self_exclusion' ? await revokeAllUserSessions(tx, userId, now) : 0;
    const details = {
      exclusionId: row.id,
      kind: input.kind,
      duration: input.duration,
      startsAt: now,
      endsAt,
    };
    await writeAudit(tx, {
      actorType: 'user',
      actorId: userId,
      action: 'rg.exclusion_started',
      targetType: 'user',
      targetId: userId,
      metadata: {
        ...details,
        revokedSessions,
        extended: current === null ? null : exclusionBody(current),
      },
      ip: meta.ip,
    });
    await enqueueOutbox(tx, {
      type: 'rg.exclusion_started',
      aggregateType: 'user',
      aggregateId: userId,
      payload: { userId, ...details },
    });

    return {
      id: row.id,
      exclusion: exclusionBody({ kind: input.kind, startsAt: now, endsAt }),
      revokedSessions,
    };
  });
}
