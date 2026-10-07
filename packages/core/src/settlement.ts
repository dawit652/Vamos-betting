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
