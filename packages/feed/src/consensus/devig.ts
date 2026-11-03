/**
 * Removing a bookmaker's margin: the fair probabilities its prices imply.
 *
 * Floats are fine here: these are probabilities and prices, never money.
 */

/**
 * - `power` (default): pᵢ = rᵢᵏ with rᵢ = 1/oᵢ and k chosen so that Σ pᵢ = 1.
 *   Bookmakers load more margin onto long shots than onto favourites (the
 *   favourite–longshot bias), and the power method takes it back the same
 *   way, which makes it more accurate than plain normalisation in studies of
 *   football odds.
 * - `multiplicative`: pᵢ = rᵢ / Σ rⱼ (the margin is taken evenly).
 */
export type DevigMethod = 'power' | 'multiplicative';

export const DEVIG_METHODS: readonly DevigMethod[] = Object.freeze(['power', 'multiplicative']);

/** True for a usable decimal price: a finite number above 1. */
export function isValidDecimalPrice(price: number): boolean {
  return Number.isFinite(price) && price > 1;
}

/**
 * The fair probabilities implied by one bookmaker's prices for every outcome
 * of a market (in the same order), summing to 1. Throws a RangeError for
 * fewer than two prices or a price that is not a finite number above 1.
 */
export function fairProbabilities(
  prices: readonly number[],
  method: DevigMethod = 'power',
): number[] {
  if (prices.length < 2) throw new RangeError('a market needs at least two prices');
  for (const price of prices) {
    if (!isValidDecimalPrice(price))
      throw new RangeError(`invalid decimal price: ${String(price)}`);
  }
  const implied = prices.map((price) => 1 / price);
  switch (method) {
    case 'multiplicative':
      return normalised(implied);
    case 'power':
      return normalised(powerFair(implied));
    default:
      throw new RangeError(`unknown de-vig method: ${String(method)}`);
  }
}

/** The book's overround: Σ 1/oᵢ (1.05 for a 5% margin). */
export function overround(prices: readonly number[]): number {
  return prices.reduce((sum, price) => sum + 1 / price, 0);
}

/** Lowest and highest exponent tried; the root always lies inside for real books. */
const MIN_EXPONENT = 1e-6;
const MAX_EXPONENT = 1000;
const EXPONENT_TOLERANCE = 1e-12;

/**
 * rᵢᵏ with Σ rᵢᵏ = 1. Every rᵢ is in (0, 1), so Σ rᵢᵏ falls strictly from n
 * (k → 0) towards 0 as k grows, and bisection finds the single root. k > 1
 * for a book with a margin, k < 1 for one below 100% (an exchange's best
 * prices can be).
 */
function powerFair(implied: readonly number[]): number[] {
  const total = (k: number): number => implied.reduce((sum, r) => sum + r ** k, 0);
  let low = MIN_EXPONENT;
  let high = MAX_EXPONENT;
  for (let i = 0; i < 200 && high - low > EXPONENT_TOLERANCE; i++) {
    const mid = (low + high) / 2;
    if (total(mid) > 1) low = mid;
    else high = mid;
  }
  const k = (low + high) / 2;
  return implied.map((r) => r ** k);
}

function normalised(values: readonly number[]): number[] {
  const sum = values.reduce((acc, value) => acc + value, 0);
  return values.map((value) => value / sum);
}
