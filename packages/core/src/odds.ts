import { type Santim, floorDiv } from './money';

/**
 * Decimal odds stored as an integer number of thousandths ("milli"):
 * 1.85 → 1850, 2.00 → 2000. Valid range 1.001 – 1000.000.
 */
export type OddsMilli = number;

export const ODDS_SCALE = 1000n;
export const MIN_ODDS_MILLI = 1001;
export const MAX_ODDS_MILLI = 1_000_000;
/** Odds of 1.00 – used for void legs at settlement. */
export const VOID_ODDS_MILLI = 1000;

const ODDS_PATTERN = /^(\d{1,4})(?:\.(\d{1,3}))?$/;

export function isValidOddsMilli(odds: number): boolean {
  return Number.isSafeInteger(odds) && odds >= MIN_ODDS_MILLI && odds <= MAX_ODDS_MILLI;
}

export function assertValidOdds(odds: number): OddsMilli {
  if (!isValidOddsMilli(odds)) throw new RangeError(`invalid odds (milli): ${odds}`);
  return odds;
}

/** Parses decimal odds ("1.85", 1.85) into milli. At most three decimals. */
export function parseOdds(decimal: string | number): OddsMilli {
  const text = typeof decimal === 'number' ? String(decimal) : decimal.trim();
  const match = ODDS_PATTERN.exec(text);
  if (!match) throw new RangeError(`invalid decimal odds: "${text}"`);
  const [, whole = '0', fraction = ''] = match;
  return assertValidOdds(Number(whole) * 1000 + Number(fraction.padEnd(3, '0') || '0'));
}

/**
 * Display format. Two decimals when the odds are a whole hundredth
 * (1850 → "1.85"), otherwise three (1855 → "1.855").
 */
export function formatOdds(odds: OddsMilli): string {
  const whole = Math.trunc(odds / 1000);
  const fraction = odds % 1000;
  if (fraction % 10 === 0) return `${whole}.${String(fraction / 10).padStart(2, '0')}`;
  return `${whole}.${String(fraction).padStart(3, '0')}`;
}

/**
 * Combined odds of an accumulator in milli, rounded down:
 * floor(Π oddsᵢ / 1000ⁿ⁻¹). An empty list gives 1.000.
 */
export function productOddsMilli(odds: readonly OddsMilli[]): bigint {
  let numerator = 1n;
  for (const o of odds) numerator *= BigInt(o);
  if (odds.length === 0) return ODDS_SCALE;
  return floorDiv(numerator, ODDS_SCALE ** BigInt(odds.length - 1));
}

/**
 * Stake × combined odds in santim, rounded down, computed exactly from the
 * individual legs (no intermediate rounding of the combined odds):
 * floor(stake × Π oddsᵢ / 1000ⁿ).
 */
export function grossReturn(stake: Santim, odds: readonly OddsMilli[]): Santim {
  let numerator = stake;
  for (const o of odds) numerator *= BigInt(o);
  return floorDiv(numerator, ODDS_SCALE ** BigInt(odds.length));
}

/** Implied probability (0–1) of decimal odds. Float – for pricing/display only, never money. */
export function impliedProbability(odds: OddsMilli): number {
  return 1000 / odds;
}

/**
 * Prices a probability into odds with a bookmaker margin, rounded DOWN to a
 * whole hundredth and clamped to [1.01, 1000]: odds = 1 / (p × (1 + margin)).
 */
export function oddsFromProbability(probability: number, marginBps = 0): OddsMilli {
  if (!(probability > 0) || probability > 1 || !Number.isFinite(probability)) {
    throw new RangeError(`probability must be in (0, 1], got ${probability}`);
  }
  const raw = 1000 / (probability * (1 + marginBps / 10_000));
  // The tiny epsilon keeps float noise (2.9999999…) from dropping a hundredth.
  const hundredths = Math.floor(raw / 10 + 1e-9) * 10;
  return Math.min(MAX_ODDS_MILLI, Math.max(1010, hundredths));
}
