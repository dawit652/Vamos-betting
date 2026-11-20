import { birr, type Santim } from './money';
import type { BetRules } from './rules';

/**
 * Shop tickets (docs/plans/agent-shops.md phase 3): the limits a ticket is sold under and who may
 * cancel it when. Pure; the database applies them (@vamos/db retail/tickets.ts).
 */

/**
 * An admin's ticket limits for one agent (`agents.ticket_limits`): any field left out takes the
 * default. Amounts are santim.
 */
export interface RetailTicketLimits {
  /** Lowest stake per ticket (default: the online minimum). */
  minStake?: Santim;
  /** Highest stake per ticket (default ETB 100,000). */
  maxStake?: Santim;
  /** Highest gross payout per ticket; anything above is capped (default ETB 500,000). */
  maxWin?: Santim;
  /** Most matches on one ticket (default: as online). */
  maxLegs?: number;
  /** Lowest odds of a match on a ticket, milli (default: as online). */
  minLegOddsMilli?: number;
  /** Most stake an agent sells in one day, cancelled tickets left out; null: no limit (default). */
  dailySales?: Santim | null;
  /** Minutes after the sale in which the cashier may cancel (default 5). */
  cancelMinutes?: number;
  /** A payout above this waits for head office (phase 4; default ETB 10,000). */
  hqApprovalAbove?: Santim;
  /** Days after its last match an unpaid winning ticket expires (phase 4; default 30). */
  expiryDays?: number;
}

/** Every limit, defaults filled in. */
export type ResolvedRetailTicketLimits = Required<RetailTicketLimits>;

/** The defaults that are not taken from the online bet rules. */
export const DEFAULT_RETAIL_TICKET_LIMITS = {
  maxStake: birr(100_000),
  maxWin: birr(500_000),
  dailySales: null,
  cancelMinutes: 5,
  hqApprovalAbove: birr(10_000),
  expiryDays: 30,
} as const satisfies Partial<ResolvedRetailTicketLimits>;

/** The limits of an agent: its overrides over the defaults (online rules for the rest). */
export function resolveRetailTicketLimits(
  betRules: BetRules,
  overrides: RetailTicketLimits,
): ResolvedRetailTicketLimits {
  return {
    minStake: overrides.minStake ?? betRules.minStake,
    maxStake: overrides.maxStake ?? DEFAULT_RETAIL_TICKET_LIMITS.maxStake,
    maxWin: overrides.maxWin ?? DEFAULT_RETAIL_TICKET_LIMITS.maxWin,
    maxLegs: overrides.maxLegs ?? betRules.maxLegs,
    minLegOddsMilli: overrides.minLegOddsMilli ?? betRules.minLegOddsMilli,
    dailySales:
      overrides.dailySales === undefined
        ? DEFAULT_RETAIL_TICKET_LIMITS.dailySales
        : overrides.dailySales,
    cancelMinutes: overrides.cancelMinutes ?? DEFAULT_RETAIL_TICKET_LIMITS.cancelMinutes,
    hqApprovalAbove: overrides.hqApprovalAbove ?? DEFAULT_RETAIL_TICKET_LIMITS.hqApprovalAbove,
    expiryDays: overrides.expiryDays ?? DEFAULT_RETAIL_TICKET_LIMITS.expiryDays,
  };
}

/**
 * The bet rules a shop ticket is placed under: the online rules with the agent's stake, win, match
 * and odds limits. The bet keeps them in its terms, so settlement caps its payout by the same
 * maximum win.
 */
export function retailBetRules(betRules: BetRules, limits: ResolvedRetailTicketLimits): BetRules {
  // A stake above the maximum win could never pay its own stake back: the win caps the stake.
  const maxStake = limits.maxStake < limits.maxWin ? limits.maxStake : limits.maxWin;
  return {
    ...betRules,
    minStake: limits.minStake < maxStake ? limits.minStake : maxStake,
    maxStake,
    maxPayout: limits.maxWin,
    maxLegs: limits.maxLegs,
    minLegOddsMilli: limits.minLegOddsMilli,
  };
}

const SANTIM_RE = /^\d{1,15}$/;

function santimOf(value: unknown, name: string): Santim {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${name} must not be negative`);
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && SANTIM_RE.test(value)) return BigInt(value);
  throw new RangeError(`${name} must be a whole number of santim`);
}

function wholeOf(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * Reads `agents.ticket_limits` (JSON; santim as decimal strings or safe integers): the overrides
 * it holds. RangeError on anything malformed, an unknown field, a stake of 0, a minimum above the
 * maximum, or odds below 1.00.
 */
export function parseRetailTicketLimits(raw: unknown): RetailTicketLimits {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RangeError('ticket limits must be an object');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set([
    'minStake',
    'maxStake',
    'maxWin',
    'maxLegs',
    'minLegOddsMilli',
    'dailySales',
    'cancelMinutes',
    'hqApprovalAbove',
    'expiryDays',
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new RangeError(`unknown ticket limit: ${key}`);
  }
  const out: RetailTicketLimits = {};
  if (input.minStake !== undefined) out.minStake = santimOf(input.minStake, 'minStake');
  if (input.maxStake !== undefined) out.maxStake = santimOf(input.maxStake, 'maxStake');
  if (input.maxWin !== undefined) out.maxWin = santimOf(input.maxWin, 'maxWin');
  if (input.maxLegs !== undefined) out.maxLegs = wholeOf(input.maxLegs, 'maxLegs', 1, 100);
  if (input.minLegOddsMilli !== undefined) {
    out.minLegOddsMilli = wholeOf(input.minLegOddsMilli, 'minLegOddsMilli', 1000, 1_000_000);
  }
  if (input.dailySales !== undefined) {
    out.dailySales = input.dailySales === null ? null : santimOf(input.dailySales, 'dailySales');
  }
  if (input.cancelMinutes !== undefined) {
    out.cancelMinutes = wholeOf(input.cancelMinutes, 'cancelMinutes', 0, 1440);
  }
  if (input.hqApprovalAbove !== undefined) {
    out.hqApprovalAbove = santimOf(input.hqApprovalAbove, 'hqApprovalAbove');
  }
  if (input.expiryDays !== undefined) {
    out.expiryDays = wholeOf(input.expiryDays, 'expiryDays', 1, 3650);
  }
  for (const key of ['minStake', 'maxStake', 'maxWin', 'dailySales'] as const) {
    const value = out[key];
    if (value !== undefined && value !== null && value <= 0n) {
      throw new RangeError(`${key} must be above zero`);
    }
  }
  if (out.minStake !== undefined && out.maxStake !== undefined && out.minStake > out.maxStake) {
    throw new RangeError('minStake must not be above maxStake');
  }
  return out;
}

/** The JSON stored in `agents.ticket_limits` for these overrides (santim as decimal strings). */
export function serializeRetailTicketLimits(limits: RetailTicketLimits): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out;
}

/** Who asks to cancel a shop ticket. */
export type RetailCancelRole = 'cashier' | 'owner' | 'admin';

/** Why a cancel is refused. */
export type RetailCancelRefusal = 'not_open' | 'match_started' | 'cancel_window_passed';

/**
 * Whether a ticket may be cancelled now (null) or why not. Never once a match on it has kicked
 * off, nor once it is no longer open; the cashier only within `cancelMinutes` of the sale, the
 * agent owner and an admin at any time before that.
 */
export function retailCancelRefusal(input: {
  role: RetailCancelRole;
  open: boolean;
  soldAt: Date;
  firstKickoff: Date;
  now: Date;
  cancelMinutes: number;
}): RetailCancelRefusal | null {
  if (!input.open) return 'not_open';
  if (input.now.getTime() >= input.firstKickoff.getTime()) return 'match_started';
  if (
    input.role === 'cashier' &&
    input.now.getTime() > input.soldAt.getTime() + input.cancelMinutes * 60_000
  ) {
    return 'cancel_window_passed';
  }
  return null;
}
