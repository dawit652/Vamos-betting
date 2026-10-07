import { type Santim, assertNonNegative, formatBirr, maxSantim, minSantim } from './money';
import { computeMultiBonus } from './multibonus';
import {
  type OddsMilli,
  MAX_ODDS_MILLI,
  ODDS_SCALE,
  VOID_ODDS_MILLI,
  formatOdds,
  grossReturn,
  isValidOddsMilli,
  productOddsMilli,
} from './odds';
import type { BetRules, MultiBonusConfig, TaxConfig } from './rules';
import { computeWinningsTax } from './tax';

/**
 * Betika-style betslip: pre-placement validation, the payout breakdown shared
 * by quoting and settlement, and the quote shown to the punter.
 */

export type SlipErrorCode =
  | 'no_selections'
  | 'too_many_legs'
  | 'duplicate_event'
  | 'duplicate_selection'
  | 'invalid_odds'
  | 'odds_below_minimum'
  | 'invalid_stake'
  | 'stake_below_minimum'
  | 'stake_above_maximum'
  | 'total_odds_above_maximum';

export interface SlipError {
  code: SlipErrorCode;
  /** Plain-English message suitable for showing to the punter. */
  message: string;
  selectionId?: string;
  eventId?: string;
}

export interface SlipLeg {
  selectionId: string;
  eventId: string;
  oddsMilli: OddsMilli;
}

/**
 * Validates a betslip and returns every applicable error (empty when the slip
 * can be placed). Rules: at least one and at most `rules.maxLegs` selections;
 * one selection per event; no selection twice; valid odds of at least
 * `rules.minLegOddsMilli` on every leg; stake in [minStake, maxStake]; total
 * odds not above `rules.maxTotalOddsMilli`.
 */
export function validateSlip(input: {
  stake: Santim;
  legs: readonly SlipLeg[];
  rules: BetRules;
}): SlipError[] {
  const { stake, legs, rules } = input;
  const errors: SlipError[] = [];

  if (legs.length === 0) {
    errors.push({ code: 'no_selections', message: 'Add at least one selection to your betslip.' });
  }
  if (legs.length > rules.maxLegs) {
    errors.push({
      code: 'too_many_legs',
      message: `A betslip can have at most ${rules.maxLegs} selections; this one has ${legs.length}.`,
    });
  }

  const seenSelections = new Map<string, number>();
  const selectionsByEvent = new Map<string, Set<string>>();
  let allOddsValid = true;

  for (const leg of legs) {
    const { selectionId, eventId, oddsMilli } = leg;

    const timesSeen = (seenSelections.get(selectionId) ?? 0) + 1;
    seenSelections.set(selectionId, timesSeen);
    if (timesSeen === 2) {
      errors.push({
        code: 'duplicate_selection',
        message: 'This selection is already on your betslip.',
        selectionId,
        eventId,
      });
    }

    const eventSelections = selectionsByEvent.get(eventId) ?? new Set<string>();
    const sizeBefore = eventSelections.size;
    eventSelections.add(selectionId);
    selectionsByEvent.set(eventId, eventSelections);
    if (sizeBefore === 1 && eventSelections.size === 2) {
      errors.push({
        code: 'duplicate_event',
        message: 'Only one selection per match is allowed on a betslip.',
        selectionId,
        eventId,
      });
    }

    const oddsValid = isValidOddsMilli(oddsMilli);
    if (!oddsValid) allOddsValid = false;
    // A repeated selection is already reported above; do not repeat its odds errors.
    if (timesSeen > 1) continue;

    if (!oddsValid) {
      errors.push({
        code: 'invalid_odds',
        message: 'The odds for this selection are not valid. Please refresh your betslip.',
        selectionId,
        eventId,
      });
    } else if (oddsMilli < rules.minLegOddsMilli) {
      errors.push({
        code: 'odds_below_minimum',
        message: `Odds of ${formatOdds(oddsMilli)} are below the minimum of ${formatOdds(rules.minLegOddsMilli)} per selection.`,
        selectionId,
        eventId,
      });
    }
  }

  if (stake <= 0n) {
    errors.push({ code: 'invalid_stake', message: 'Enter a stake greater than zero.' });
  } else if (stake < rules.minStake) {
    errors.push({
      code: 'stake_below_minimum',
      message: `The minimum stake is ${formatBirr(rules.minStake, { currency: true })}.`,
    });
  } else if (stake > rules.maxStake) {
    errors.push({
      code: 'stake_above_maximum',
      message: `The maximum stake is ${formatBirr(rules.maxStake, { currency: true })}.`,
    });
  }

  // Total odds are only meaningful when every leg has valid odds (already reported otherwise).
  if (legs.length > 0 && allOddsValid) {
    const totalOdds = productOddsMilli(legs.map((leg) => leg.oddsMilli));
    if (totalOdds > rules.maxTotalOddsMilli) {
      errors.push({
        code: 'total_odds_above_maximum',
        message: `Total odds of ${formatTotalOdds(totalOdds)} are above the maximum of ${formatTotalOdds(rules.maxTotalOddsMilli)}.`,
      });
    }
  }

  return errors;
}

export interface PayoutBreakdown {
  /** stake × Π odds, rounded down (before bonus and cap). */
  grossReturn: Santim;
  bonusPercentBps: number;
  qualifyingLegs: number;
  /** Multi bonus actually paid, after the max-payout cap. */
  bonusAmount: Santim;
  /** min(grossReturn + bonus, maxPayout). */
  grossPayout: Santim;
  cappedByMaxPayout: boolean;
  taxAmount: Santim;
  /** grossPayout − taxAmount: what the punter receives. */
  netPayout: Santim;
}

/**
 * Payout of a winning bet, shared by quoting and settlement. `legOdds` price
 * the return (void legs at 1.000); `bonusLegOdds`, when given, are the legs
 * that count toward the multi bonus (defaults to `legOdds`). The max-payout cap
 * reduces the bonus first. Tax is computed on the capped gross payout.
 */
export function computePayout(args: {
  stake: Santim;
  legOdds: readonly OddsMilli[];
  bonusLegOdds?: readonly OddsMilli[];
  maxPayout: Santim;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
}): PayoutBreakdown {
  const { stake, legOdds, bonusLegOdds, maxPayout, multiBonus, tax } = args;
  assertNonNegative(stake, 'stake');
  assertNonNegative(maxPayout, 'maxPayout');
  for (const odds of legOdds) {
    if (!Number.isSafeInteger(odds) || odds < VOID_ODDS_MILLI || odds > MAX_ODDS_MILLI) {
      throw new RangeError(`invalid leg odds (milli): ${odds}`);
    }
  }

  const gross = grossReturn(stake, legOdds);
  const bonus = computeMultiBonus({
    stake,
    grossReturn: gross,
    legOdds: bonusLegOdds ?? legOdds,
    config: multiBonus,
  });
  const uncapped = gross + bonus.amount;
  const grossPayout = minSantim(uncapped, maxPayout);
  const { amount: taxAmount } = computeWinningsTax({ stake, grossPayout, config: tax });

  return {
    grossReturn: gross,
    bonusPercentBps: bonus.percentBps,
    qualifyingLegs: bonus.qualifyingLegs,
    bonusAmount: maxSantim(0n, grossPayout - gross),
    grossPayout,
    cappedByMaxPayout: uncapped > maxPayout,
    taxAmount,
    netPayout: grossPayout - taxAmount,
  };
}

export interface BetQuote extends PayoutBreakdown {
  betType: 'single' | 'multi';
  legCount: number;
  stake: Santim;
  /** Combined odds in milli, rounded down. */
  totalOddsMilli: bigint;
  /** Validation errors; the bet can be placed only when this is empty. */
  errors: SlipError[];
}

/**
 * Quote for the betslip UI: validation errors plus the potential payout. The
 * payout is computed even when the slip has errors (so the potential win can
 * still be shown), except when there is nothing to price — no legs, a stake of
 * zero or less, or a leg with invalid odds — in which case every money field is
 * 0 and the total odds are 1.000.
 */
export function quoteBet(input: {
  stake: Santim;
  legs: readonly SlipLeg[];
  rules: BetRules;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
}): BetQuote {
  const { stake, legs, rules, multiBonus, tax } = input;
  const errors = validateSlip({ stake, legs, rules });
  const legOdds = legs.map((leg) => leg.oddsMilli);
  const head = {
    betType: legs.length === 1 ? ('single' as const) : ('multi' as const),
    legCount: legs.length,
    stake,
    errors,
  };

  if (legs.length === 0 || stake <= 0n || !legOdds.every((odds) => isValidOddsMilli(odds))) {
    return {
      ...head,
      totalOddsMilli: ODDS_SCALE,
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

  return {
    ...head,
    totalOddsMilli: productOddsMilli(legOdds),
    ...computePayout({ stake, legOdds, maxPayout: rules.maxPayout, multiBonus, tax }),
  };
}

/** Display format for (possibly huge) bigint milli odds: 1234567890n → "1,234,567.89". */
function formatTotalOdds(milli: bigint): string {
  const whole = (milli / ODDS_SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = Number(milli % ODDS_SCALE);
  if (fraction % 10 === 0) return `${whole}.${String(fraction / 10).padStart(2, '0')}`;
  return `${whole}.${String(fraction).padStart(3, '0')}`;
}
