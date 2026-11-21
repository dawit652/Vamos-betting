import { BPS_DENOMINATOR, type Santim } from './money';

/**
 * Deposit wagering ("turnover") requirement checked before a withdrawal.
 *
 * Definition. Walk the player's cash-account history in ledger order with a
 * running requirement R, starting at 0:
 * - a funding credit F (a deposit, or play money in demo mode) adds
 *   ceil(F × multiplierBps / 10_000) to R;
 * - a counted stake S (a bet stake that was not refunded, i.e. its bet is not
 *   void, rejected or still waiting for live acceptance, and not cashed out)
 *   sets R to max(0, R − S).
 * R is the deposited money not yet played through. Owner's rule (21 Nov 2026): only winnings can
 * be withdrawn, never deposited money, so the player may withdraw up to balance − R
 * (`withdrawableAmount`); R stays in the balance for betting. With R = 0 the whole balance is
 * withdrawable.
 *
 * R never goes below zero, so turnover from before a deposit (or in excess of
 * what was required at the time) never pre-pays a later deposit: every
 * deposit has to be staked after it arrived. This closes the "deposit, then
 * withdraw straight back out" pattern while winnings from wagered deposits
 * stay withdrawable. The requirement is rounded up (in the house's favour
 * only by at most one santim per deposit).
 *
 * Relation to the plain rule "total staked since the first deposit >= total
 * deposited × multiplier": R = 0 implies it, and implies the same from every
 * later deposit on (R_final >= the requirements minus the stakes of any
 * suffix of the history). It is stricter only in that old turnover cannot
 * cover a new deposit.
 */
export type WageringEvent = { kind: 'funding'; amount: Santim } | { kind: 'stake'; amount: Santim };

function assertMultiplier(multiplierBps: number): bigint {
  if (!Number.isSafeInteger(multiplierBps) || multiplierBps < 0) {
    throw new RangeError(
      `wagering multiplier must be a non-negative integer bps (got ${multiplierBps})`,
    );
  }
  return BigInt(multiplierBps);
}

/** ceil(amount × multiplierBps / 10_000) for a non-negative amount. */
export function wageringRequirementOf(amount: Santim, multiplierBps: number): Santim {
  if (amount < 0n) throw new RangeError(`funding amount must not be negative (got ${amount})`);
  const product = amount * assertMultiplier(multiplierBps);
  return (product + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

/** Applies one event to a running requirement (see the module comment). */
export function applyWageringEvent(
  remaining: Santim,
  event: WageringEvent,
  multiplierBps: number,
): Santim {
  if (event.amount < 0n) {
    throw new RangeError(`wagering event amounts must not be negative (got ${event.amount})`);
  }
  if (event.kind === 'funding')
    return remaining + wageringRequirementOf(event.amount, multiplierBps);
  return remaining > event.amount ? remaining - event.amount : 0n;
}

/**
 * The turnover still required before a withdrawal (0 = the requirement is
 * met). `events` must be in ledger order.
 */
export function remainingWagering(events: Iterable<WageringEvent>, multiplierBps: number): Santim {
  assertMultiplier(multiplierBps);
  let remaining = 0n;
  for (const event of events) remaining = applyWageringEvent(remaining, event, multiplierBps);
  return remaining;
}

/**
 * How much of the balance may be withdrawn now (owner, 21 Nov 2026: winnings only, never deposited
 * money): the balance less `remaining`, the deposits not yet played through (remainingWagering),
 * and never below zero. Example: deposit 1,000, stake 200 and win 600: balance 1,400, remaining
 * 800, withdrawable 600.
 */
export function withdrawableAmount(balance: Santim, remaining: Santim): Santim {
  if (remaining < 0n)
    throw new RangeError(`remaining wagering must not be negative (got ${remaining})`);
  return balance > remaining ? balance - remaining : 0n;
}
