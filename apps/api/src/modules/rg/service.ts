import { birr, formatBirr, parseSantim, toWire } from '@vamos/core';
import type {
  CreateExclusionRequest,
  Exclusion,
  RgLimitEntry,
  RgLimitsRequest,
  RgLimitsResponse,
} from '@vamos/contracts';
import {
  depositTotalSince,
  enqueueOutbox,
  netLossSince,
  writeAudit,
  type DbExecutor,
  type DbTransaction,
} from '@vamos/db';
import {
  rgExclusions,
  rgLimits,
  users,
  type rgLimitKind,
  type rgLimitPeriod,
} from '@vamos/db/schema';
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { revokeAllUserSessions } from '../../plugins/session';
import type { RequestMeta } from '../auth/service';
import { assertCanGamble, type ActiveExclusion, type ExclusionKind } from './guard';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type LimitKind = (typeof rgLimitKind.enumValues)[number];
export type LimitPeriod = (typeof rgLimitPeriod.enumValues)[number];
/** The periods measured over a rolling window (every period except `bet`). */
export type RollingPeriod = Exclude<LimitPeriod, 'bet'>;

/** Raising or removing a limit takes effect this long after the request. */
export const LIMIT_INCREASE_DELAY_MS = 24 * HOUR_MS;
/** Smallest and largest limit a player may set (santim). */
export const MIN_LIMIT = birr(1);
export const MAX_LIMIT = birr(10_000_000);
/** Rolling windows: a "day" is the last 24 hours, a "week" 7 days, a "month" 30 days. */
export const ROLLING_WINDOW_MS: Record<RollingPeriod, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};
const ROLLING_PERIODS: readonly RollingPeriod[] = ['day', 'week', 'month'];

/** One value per limit slot, in the shape of the RG contracts. */
export interface LimitShape<T> {
  deposit: { day: T; week: T; month: T };
  loss: { day: T; week: T; month: T };
  stake: { bet: T };
}

/** Limits in force (santim); null = no limit. */
export type ActiveLimits = LimitShape<bigint | null>;

interface LimitSlot {
  kind: LimitKind;
  period: LimitPeriod;
}

const LIMIT_SLOTS: readonly LimitSlot[] = [
  { kind: 'deposit', period: 'day' },
  { kind: 'deposit', period: 'week' },
  { kind: 'deposit', period: 'month' },
  { kind: 'loss', period: 'day' },
  { kind: 'loss', period: 'week' },
  { kind: 'loss', period: 'month' },
  { kind: 'stake', period: 'bet' },
];

function shapeLimits<T>(value: (kind: LimitKind, period: LimitPeriod) => T): LimitShape<T> {
  return {
    deposit: {
      day: value('deposit', 'day'),
      week: value('deposit', 'week'),
      month: value('deposit', 'month'),
    },
    loss: { day: value('loss', 'day'), week: value('loss', 'week'), month: value('loss', 'month') },
    stake: { bet: value('stake', 'bet') },
  };
}

const slotKey = (kind: LimitKind, period: LimitPeriod) => `${kind}.${period}`;

export interface LimitRow {
  kind: LimitKind;
  period: LimitPeriod;
  /** null removes the limit. */
  amount: bigint | null;
  effectiveFrom: Date;
  /** When the change was requested; strictly increasing per player. */
  createdAt: Date;
}

export interface LimitSlotState {
  /** The change in force at `now`, or null when the player never set this limit. */
  active: LimitRow | null;
  /** A requested raise or removal that has not taken effect yet. */
  pending: LimitRow | null;
}

/**
 * Resolves the history of one limit slot (rows in request order, oldest
 * first). The active change is the newest one with effective_from <= now; a
 * pending change is the newest one still in the future. A change that had not
 * taken effect yet when the player made a newer request for the same slot is
 * superseded by it, so a cancelled raise never comes into force later.
 */
export function resolveLimitSlot(rows: readonly LimitRow[], now: Date): LimitSlotState {
  let active: LimitRow | null = null;
  let pending: LimitRow | null = null;
  for (const [index, row] of rows.entries()) {
    const next = rows[index + 1];
    if (next !== undefined && next.createdAt.getTime() < row.effectiveFrom.getTime()) continue;
    if (row.effectiveFrom.getTime() <= now.getTime()) active = row;
    else pending = row;
  }
  if (
    active !== null &&
    pending !== null &&
    pending.createdAt.getTime() < active.createdAt.getTime()
  ) {
    pending = null;
  }
  return { active, pending };
}

async function loadLimitRows(exec: DbExecutor, userId: string): Promise<LimitRow[]> {
  return exec
    .select({
      kind: rgLimits.kind,
      period: rgLimits.period,
      amount: rgLimits.amount,
      effectiveFrom: rgLimits.effectiveFrom,
      createdAt: rgLimits.createdAt,
    })
    .from(rgLimits)
    .where(eq(rgLimits.userId, userId))
    .orderBy(asc(rgLimits.createdAt), asc(rgLimits.effectiveFrom), asc(rgLimits.id));
}

function resolveLimitRows(rows: readonly LimitRow[], now: Date): LimitShape<LimitSlotState> {
  const bySlot = new Map<string, LimitRow[]>();
  for (const row of rows) {
    const key = slotKey(row.kind, row.period);
    const list = bySlot.get(key);
    if (list) list.push(row);
    else bySlot.set(key, [row]);
  }
  return shapeLimits((kind, period) => resolveLimitSlot(bySlot.get(slotKey(kind, period)) ?? [], now));
}

/** Active and pending state of every limit slot of the player at `now`. */
export async function getLimitStates(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<LimitShape<LimitSlotState>> {
  return resolveLimitRows(await loadLimitRows(exec, userId), now);
}

function slotOf<T>(shape: LimitShape<T>, kind: LimitKind, period: LimitPeriod): T {
  const group = shape[kind] as Partial<Record<LimitPeriod, T>>;
  const value = group[period];
  if (value === undefined) throw new Error(`unknown limit slot ${slotKey(kind, period)}`);
  return value;
}

/** The limits in force for the player at `now` (santim, null = none). */
export async function getActiveLimits(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<ActiveLimits> {
  const states = await getLimitStates(exec, userId, now);
  return shapeLimits((kind, period) => slotOf(states, kind, period).active?.amount ?? null);
}

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

function parseLimitAmount(field: string, value: string): bigint {
  let amount: bigint | null = null;
  try {
    amount = parseSantim(value);
  } catch {
    amount = null;
  }
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

/** Takes the player's row lock so RG changes (and checks made under it) are serialised. */
async function lockUser(tx: DbTransaction, userId: string): Promise<void> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (!row) throw notFound('User');
}

interface RequestedLimit extends LimitSlot {
  field: string;
  amount: bigint | null;
}

function requestedLimits(input: RgLimitsRequest): RequestedLimit[] {
  const requested: RequestedLimit[] = [];
  for (const { kind, period } of LIMIT_SLOTS) {
    const group = input[kind] as Partial<Record<LimitPeriod, string | null | undefined>> | undefined;
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

function periodLabel(period: LimitPeriod): string {
  switch (period) {
    case 'day':
      return '24-hour';
    case 'week':
      return '7-day';
    case 'month':
      return '30-day';
    case 'bet':
      return 'per-bet';
  }
}

function windowStart(period: RollingPeriod, now: Date): Date {
  return new Date(now.getTime() - ROLLING_WINDOW_MS[period]);
}

function assertPositive(amount: bigint, label: string): void {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new RangeError(`${label} must be a positive bigint santim amount`);
  }
}

/**
 * Throws 403 when the player may not gamble, or 422 `deposit_limit_exceeded`
 * (details `{ period, limit, used }`, santim strings) when the deposits of a
 * rolling window plus `amount` would exceed a deposit limit. Run it in the
 * transaction that records the deposit, under the player's row lock, so
 * concurrent deposits cannot both slip under the limit.
 */
export async function assertDepositAllowed(
  exec: DbExecutor,
  userId: string,
  amount: bigint,
  now: Date,
): Promise<void> {
  assertPositive(amount, 'deposit amount');
  await assertCanGamble(exec, userId, now);
  const limits = await getActiveLimits(exec, userId, now);
  for (const period of ROLLING_PERIODS) {
    const limit = limits.deposit[period];
    if (limit === null) continue;
    const used = await depositTotalSince(exec, userId, windowStart(period, now));
    if (used + amount > limit) {
      throw unprocessable(
        'deposit_limit_exceeded',
        `This deposit would exceed your ${periodLabel(period)} deposit limit of ETB ${formatBirr(limit)}.`,
        { period, limit: toWire(limit), used: toWire(used) },
      );
    }
  }
}

/**
 * Throws 403 when the player may not gamble, 422 `stake_limit_exceeded`
 * (details `{ period: 'bet', limit, stake }`) when `stake` is above the
 * per-bet limit, or 422 `loss_limit_exceeded` (details `{ period, limit,
 * used }`) when the net loss of a rolling window plus `stake` would exceed a
 * loss limit. Amounts in details are santim strings.
 */
export async function assertStakeAllowed(
  exec: DbExecutor,
  userId: string,
  stake: bigint,
  now: Date,
): Promise<void> {
  assertPositive(stake, 'stake');
  await assertCanGamble(exec, userId, now);
  const limits = await getActiveLimits(exec, userId, now);
  const perBet = limits.stake.bet;
  if (perBet !== null && stake > perBet) {
    throw unprocessable(
      'stake_limit_exceeded',
      `This stake is above your per-bet limit of ETB ${formatBirr(perBet)}.`,
      { period: 'bet', limit: toWire(perBet), stake: toWire(stake) },
    );
  }
  for (const period of ROLLING_PERIODS) {
    const limit = limits.loss[period];
    if (limit === null) continue;
    const used = await netLossSince(exec, userId, windowStart(period, now));
    if (used + stake > limit) {
      throw unprocessable(
        'loss_limit_exceeded',
        `This bet could take you over your ${periodLabel(period)} loss limit of ETB ${formatBirr(limit)}.`,
        { period, limit: toWire(limit), used: toWire(used) },
      );
    }
  }
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
