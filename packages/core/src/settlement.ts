import { type PayoutBreakdown, computePayout } from './betslip';
import { type Santim, assertNonNegative } from './money';
import { type OddsMilli, VOID_ODDS_MILLI } from './odds';
import type { MultiBonusConfig, TaxConfig } from './rules';

/**
 * Bet settlement. Like Betika, an accumulator is lost as soon as any leg is
 * lost; otherwise it settles once no leg is open. Void legs are priced at
 * 1.000 and never count toward the multi bonus; an all-void bet is refunded.
 */

export type LegState = 'open' | 'won' | 'lost' | 'void';

export interface SettlementLeg {
  oddsMilli: OddsMilli;
  state: LegState;
}

export interface BetSettlement extends PayoutBreakdown {
  status: 'won' | 'lost' | 'void';
  /** Odds each leg was settled at (void legs at 1.000); empty for a lost bet. */
  effectiveOddsMilli: OddsMilli[];
}

const LEG_STATES: ReadonlySet<string> = new Set<LegState>(['open', 'won', 'lost', 'void']);

/** True when the bet can be settled now: any leg lost, or no leg still open. */
export function canSettle(legs: readonly SettlementLeg[]): boolean {
  if (legs.length === 0) return false;
  return legs.some((leg) => leg.state === 'lost') || legs.every((leg) => leg.state !== 'open');
}

/**
 * Settles a bet. Throws `RangeError` when there are no legs, a leg has an
 * unknown state, or the bet cannot be settled yet (see `canSettle`).
 */
export function settleBet(input: {
  stake: Santim;
  legs: readonly SettlementLeg[];
  maxPayout: Santim;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
}): BetSettlement {
  const { stake, legs, maxPayout, multiBonus, tax } = input;
  if (legs.length === 0) throw new RangeError('cannot settle a bet without legs');
  for (const leg of legs) {
    if (!LEG_STATES.has(leg.state)) throw new RangeError(`unknown leg state: ${String(leg.state)}`);
  }
  if (!canSettle(legs)) throw new RangeError('cannot settle a bet with open legs');
  assertNonNegative(stake, 'stake');

  if (legs.some((leg) => leg.state === 'lost')) {
    return {
      status: 'lost',
      effectiveOddsMilli: [],
      grossReturn: 0n,
      bonusPercentBps: 0,
      qualifyingLegs: 0,
      bonusAmount: 0n,
      grossPayout: 0n,
      cappedByMaxPayout: false,
      taxAmount: 0n,
      netPayout: 0n,
    };
  }

  if (legs.every((leg) => leg.state === 'void')) {
    return {
      status: 'void',
      effectiveOddsMilli: legs.map(() => VOID_ODDS_MILLI),
      grossReturn: stake,
      bonusPercentBps: 0,
      qualifyingLegs: 0,
      bonusAmount: 0n,
      grossPayout: stake,
      cappedByMaxPayout: false,
      taxAmount: 0n,
      netPayout: stake,
    };
  }

  const effectiveOddsMilli = legs.map((leg) =>
    leg.state === 'won' ? leg.oddsMilli : VOID_ODDS_MILLI,
  );
  const wonLegOdds = legs.filter((leg) => leg.state === 'won').map((leg) => leg.oddsMilli);
  return {
    status: 'won',
    effectiveOddsMilli,
    ...computePayout({
      stake,
      legOdds: effectiveOddsMilli,
      bonusLegOdds: wonLegOdds,
      maxPayout,
      multiBonus,
      tax,
    }),
  };
}

/**
 * What a settled bet has been paid so far: its settlement and every forward correction since
 * (gross, tax and net summed). A lost bet has all three at zero.
 */
export interface PaidSoFar {
  grossPayout: Santim;
  taxAmount: Santim;
  netPayout: Santim;
}

export type ForwardCorrection =
  /** The corrected result pays no more than was paid: nothing moves (nothing is ever taken back). */
  | { action: 'none'; settlement: BetSettlement }
  /**
   * Pay the difference: `extraNet` to the player, `extraTax` to the tax payable account, both
   * from house revenue (`extraGross` = `extraNet` + `extraTax`), so the posting sums to zero.
   */
  | {
      action: 'pay';
      settlement: BetSettlement;
      extraGross: Santim;
      extraTax: Santim;
      extraNet: Santim;
    }
  /**
   * The corrected result pays the player more but would lower the gross or the tax already
   * posted (a payout crossing the tax exemption): reversing a tax posting is not automatic.
   */
  | { action: 'needs_person'; settlement: BetSettlement };

/**
 * A forward-only correction (docs/plans/hulusport-parity-plan.md 4.4, decision D10, task 1.8):
 * re-settles a bet on its corrected legs and pays only what the corrected result adds to what
 * was already paid. Nothing is ever taken back, and a correction applied twice pays once (the
 * second time `paid` already includes the first). Pure: the caller posts the ledger lines and
 * decides whether the correction is in time (72 hours) and agreed by two sources.
 */
export function forwardCorrection(input: {
  stake: Santim;
  legs: readonly SettlementLeg[];
  paid: PaidSoFar;
  maxPayout: Santim;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
}): ForwardCorrection {
  const { paid } = input;
  for (const [what, value] of [
    ['paid gross', paid.grossPayout],
    ['paid tax', paid.taxAmount],
    ['paid net', paid.netPayout],
  ] as const) {
    assertNonNegative(value, what);
  }
  if (paid.grossPayout - paid.taxAmount !== paid.netPayout) {
    throw new RangeError('paid gross − tax must equal paid net');
  }
  const settlement = settleBet(input);
  if (settlement.netPayout <= paid.netPayout) return { action: 'none', settlement };
  const extraGross = settlement.grossPayout - paid.grossPayout;
  const extraTax = settlement.taxAmount - paid.taxAmount;
  const extraNet = settlement.netPayout - paid.netPayout;
  if (extraGross < 0n || extraTax < 0n) return { action: 'needs_person', settlement };
  return { action: 'pay', settlement, extraGross, extraTax, extraNet };
}
