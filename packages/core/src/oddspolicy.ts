import { isValidOddsMilli, type OddsMilli } from './odds';

/**
 * What happens when the odds of a selection moved between the moment the
 * punter saw them and the moment the bet is placed (or a live bet is
 * accepted after its delay):
 * - `none`: any change refuses the bet;
 * - `higher`: higher odds are taken, a lower price refuses the bet;
 * - `any`: the current odds are taken, up or down.
 * An accepted bet is always priced at the current odds.
 */
export type OddsChangePolicy = 'none' | 'higher' | 'any';

export const ODDS_CHANGE_POLICIES: readonly OddsChangePolicy[] = ['none', 'higher', 'any'];

export interface OddsCheckLeg {
  selectionId: string;
  /** The odds the punter accepted (on the slip, or the odds the bet was placed at). */
  requestedOddsMilli: OddsMilli;
  /** The selection's odds now. */
  currentOddsMilli: OddsMilli;
}

export interface LegOddsChange {
  selectionId: string;
  requestedOddsMilli: OddsMilli;
  currentOddsMilli: OddsMilli;
  direction: 'up' | 'down';
}

export type OddsPolicyResult =
  | {
      accepted: true;
      /** The odds to price each leg at, in input order (always the current odds). */
      oddsMilli: OddsMilli[];
      /** Every leg whose odds moved. */
      changes: LegOddsChange[];
    }
  | {
      accepted: false;
      /** The changes the policy does not accept (a subset of `changes`). */
      rejected: LegOddsChange[];
      changes: LegOddsChange[];
    };

/**
 * Applies an odds-change policy to a slip. Throws RangeError on an unknown
 * policy or invalid odds (outside 1001..1000000).
 */
export function applyOddsChangePolicy(
  policy: OddsChangePolicy,
  legs: readonly OddsCheckLeg[],
): OddsPolicyResult {
  if (!ODDS_CHANGE_POLICIES.includes(policy)) {
    throw new RangeError(`unknown odds change policy: ${String(policy)}`);
  }
  const changes: LegOddsChange[] = [];
  for (const leg of legs) {
    for (const odds of [leg.requestedOddsMilli, leg.currentOddsMilli]) {
      if (!isValidOddsMilli(odds)) {
        throw new RangeError(`invalid odds (milli) ${odds} for selection ${leg.selectionId}`);
      }
    }
    if (leg.currentOddsMilli === leg.requestedOddsMilli) continue;
    changes.push({
      selectionId: leg.selectionId,
      requestedOddsMilli: leg.requestedOddsMilli,
      currentOddsMilli: leg.currentOddsMilli,
      direction: leg.currentOddsMilli > leg.requestedOddsMilli ? 'up' : 'down',
    });
  }
  const rejected =
    policy === 'none'
      ? changes
      : policy === 'higher'
        ? changes.filter((change) => change.direction === 'down')
        : [];
  if (rejected.length > 0) return { accepted: false, rejected, changes };
  return { accepted: true, oddsMilli: legs.map((leg) => leg.currentOddsMilli), changes };
}
