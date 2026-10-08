import { formatBirr, toWire } from '@vamos/core';
import { asc, eq } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import { depositTotalSince, netLossSince } from '../ledger/queries';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { rgLimits, users } from '../schema/accounts';
import type { rgLimitKind, rgLimitPeriod } from '../schema/enums';
import { assertCanGamble } from './exclusions';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type LimitKind = (typeof rgLimitKind.enumValues)[number];
export type LimitPeriod = (typeof rgLimitPeriod.enumValues)[number];
/** The periods measured over a rolling window (every period except `bet`). */
export type RollingPeriod = Exclude<LimitPeriod, 'bet'>;

/** Rolling windows: a "day" is the last 24 hours, a "week" 7 days, a "month" 30 days. */
export const ROLLING_WINDOW_MS: Record<RollingPeriod, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};
export const ROLLING_PERIODS: readonly RollingPeriod[] = ['day', 'week', 'month'];

/** One value per limit slot, in the shape of the RG contracts. */
export interface LimitShape<T> {
  deposit: { day: T; week: T; month: T };
  loss: { day: T; week: T; month: T };
  stake: { bet: T };
}

/** Limits in force (santim); null = no limit. */
export type ActiveLimits = LimitShape<bigint | null>;

export interface LimitSlot {
  kind: LimitKind;
  period: LimitPeriod;
}

/** Every limit slot, in contract order. */
export const LIMIT_SLOTS: readonly LimitSlot[] = [
  { kind: 'deposit', period: 'day' },
  { kind: 'deposit', period: 'week' },
  { kind: 'deposit', period: 'month' },
  { kind: 'loss', period: 'day' },
  { kind: 'loss', period: 'week' },
  { kind: 'loss', period: 'month' },
  { kind: 'stake', period: 'bet' },
];

/** Builds a LimitShape by calling `value` for every slot. */
export function shapeLimits<T>(value: (kind: LimitKind, period: LimitPeriod) => T): LimitShape<T> {
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

/** 'deposit.day', 'stake.bet', … */
export const limitSlotKey = (kind: LimitKind, period: LimitPeriod) => `${kind}.${period}`;

/** The value of one slot of a LimitShape. */
export function limitSlotOf<T>(shape: LimitShape<T>, kind: LimitKind, period: LimitPeriod): T {
  const group = shape[kind] as Partial<Record<LimitPeriod, T>>;
  const value = group[period];
  if (value === undefined) throw new Error(`unknown limit slot ${limitSlotKey(kind, period)}`);
  return value;
}

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

/** Every limit change of the player, in request order (oldest first). */
export async function loadLimitRows(exec: DbExecutor, userId: string): Promise<LimitRow[]> {
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

/** Resolves rows from loadLimitRows into the state of every slot at `now`. */
export function resolveLimitRows(rows: readonly LimitRow[], now: Date): LimitShape<LimitSlotState> {
  const bySlot = new Map<string, LimitRow[]>();
  for (const row of rows) {
    const key = limitSlotKey(row.kind, row.period);
    const list = bySlot.get(key);
    if (list) list.push(row);
    else bySlot.set(key, [row]);
  }
  return shapeLimits((kind, period) =>
    resolveLimitSlot(bySlot.get(limitSlotKey(kind, period)) ?? [], now),
  );
}

/** Active and pending state of every limit slot of the player at `now`. */
export async function getLimitStates(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<LimitShape<LimitSlotState>> {
  return resolveLimitRows(await loadLimitRows(exec, userId), now);
}

/** The limits in force for the player at `now` (santim, null = none). */
export async function getActiveLimits(
  exec: DbExecutor,
  userId: string,
  now: Date,
): Promise<ActiveLimits> {
  const states = await getLimitStates(exec, userId, now);
  return shapeLimits((kind, period) => limitSlotOf(states, kind, period).active?.amount ?? null);
}

/**
 * Takes the player's row lock (FOR NO KEY UPDATE) so RG changes, and checks
 * such as assertDepositAllowed made under it, are serialised per player.
 * Throws 404 when the user does not exist.
 */
export async function lockUser(tx: DbTransaction, userId: string): Promise<void> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');
  if (!row) throw domainNotFound('User');
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
 * transaction that records the deposit, after `lockUser`, so concurrent
 * deposits cannot both slip under the limit.
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
      throw domainUnprocessable(
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
 * loss limit (open stakes count as lost until settled). Amounts in details
 * are santim strings. Run it in the bet-placement transaction after `lockUser`.
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
    throw domainUnprocessable(
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
      throw domainUnprocessable(
        'loss_limit_exceeded',
        `This bet could take you over your ${periodLabel(period)} loss limit of ETB ${formatBirr(limit)}.`,
        { period, limit: toWire(limit), used: toWire(used) },
      );
    }
  }
}
