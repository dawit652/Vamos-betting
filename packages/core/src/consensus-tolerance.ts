/**
 * Is our price close to the bookmaker consensus, after our margin? Used by the bulk "open betting"
 * route of the back office (plan A-4). Pure: no I/O, no money moves here (the comparison is on
 * probabilities, floating point is fine for a yes/no test, never for a price).
 *
 * Formula, for one selection with fair (no-vig) consensus probability p:
 *
 *   ourImplied = 1000 / oddsMilli                 (the probability our price asks for)
 *   expected   = p × (1 + marginBps / 10000)      (what the consensus gives once our margin is added)
 *   deviation  = ourImplied / expected − 1
 *   within     ⇔ |deviation| ≤ toleranceBps / 10000
 *
 * Equivalently our odds lie in [fair / (1 + m) / (1 + tol), fair / (1 + m) / (1 − tol)], where fair
 * is the no-vig consensus odds 1000 / p. With the default 6% margin and 3% tolerance a fair price
 * of 2.00 is accepted from about 1.83 to 1.94.
 */

/** The tolerance the bulk open uses: 3% of the margin-adjusted consensus probability. */
export const OPEN_TOLERANCE_BPS = 300;

export interface ConsensusToleranceInput {
  /** Our price in milli (1.85 → 1850). */
  oddsMilli: number;
  /** The consensus's fair probability of the selection, in (0, 1). */
  probability: number;
  /** Our margin in basis points, 0 or more. */
  marginBps: number;
  /** The allowed relative deviation in basis points (default OPEN_TOLERANCE_BPS). */
  toleranceBps?: number;
}

/**
 * The signed relative deviation of our price from the margin-adjusted consensus (positive: our
 * price asks for more probability than the consensus, that is, it is shorter, worse for the
 * customer); NaN when an input is not usable.
 */
export function consensusDeviation(input: ConsensusToleranceInput): number {
  const { oddsMilli, probability, marginBps } = input;
  if (
    !Number.isFinite(oddsMilli) ||
    oddsMilli <= 0 ||
    !Number.isFinite(probability) ||
    probability <= 0 ||
    probability >= 1 ||
    !Number.isFinite(marginBps) ||
    marginBps < 0
  ) {
    return Number.NaN;
  }
  const expected = probability * (1 + marginBps / 10_000);
  return 1000 / oddsMilli / expected - 1;
}

/** True when |consensusDeviation| ≤ tolerance; false for an unusable input. */
export function withinConsensusTolerance(input: ConsensusToleranceInput): boolean {
  const tol = input.toleranceBps ?? OPEN_TOLERANCE_BPS;
  if (!Number.isFinite(tol) || tol < 0) return false;
  const deviation = consensusDeviation(input);
  // A hair of slack so a price exactly on the boundary is not lost to float rounding.
  return Number.isFinite(deviation) && Math.abs(deviation) <= tol / 10_000 + 1e-12;
}
