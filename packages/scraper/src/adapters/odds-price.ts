import { MARKET_ODDS_MAX_MILLI, MARKET_ODDS_MIN_MILLI } from '../types';

/**
 * Bookmaker price formats to integer milli decimal odds (1.85 is 1850), by exact integer
 * arithmetic: no floating point touches a price. The result is always rounded DOWN (the
 * platform rounds against itself nowhere, and a market price is only ever used as a check).
 *
 * A price arrives as a JSON number or a string. A JSON number is read through its shortest
 * decimal text (`String(1.85)` is "1.85"), so 1.85 is exactly 185/100 and never 1.8500000000000001.
 */

export type PriceFormat = 'american' | 'decimal';

export type PriceProblem =
  /** Not a plain decimal number (NaN, an exponent, text, too many digits). */
  | 'unparseable'
  /** American: |price| below 100. */
  | 'american_range'
  /** Decimal: outside 1.01 to 1000. */
  | 'decimal_range'
  /** The converted price is outside 1010 to 1 000 000 milli. */
  | 'milli_range';

export type PriceResult = { ok: true; milli: number } | { ok: false; problem: PriceProblem };

const PLAIN_DECIMAL = /^([+-]?)([0-9]{1,9})(?:\.([0-9]{1,6}))?$/;

/** An exact rational n/d (d > 0) from a number or numeric text, or null. */
export function exactDecimal(value: unknown): { n: bigint; d: bigint } | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const m = PLAIN_DECIMAL.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? '';
  const n = BigInt(`${m[2]}${fraction}`);
  return { n: m[1] === '-' ? -n : n, d: 10n ** BigInt(fraction.length) };
}

function checked(milli: bigint): PriceResult {
  if (milli < BigInt(MARKET_ODDS_MIN_MILLI) || milli > BigInt(MARKET_ODDS_MAX_MILLI)) {
    return { ok: false, problem: 'milli_range' };
  }
  return { ok: true, milli: Number(milli) };
}

/**
 * American odds p (|p| >= 100) to decimal milli, rounded down:
 * p > 0: 1000 + floor(10 p), p < 0: 1000 + floor(100000 / |p|).
 */
export function americanToMilli(value: unknown): PriceResult {
  const x = exactDecimal(value);
  if (x === null) return { ok: false, problem: 'unparseable' };
  const abs = x.n < 0n ? -x.n : x.n;
  if (abs < 100n * x.d) return { ok: false, problem: 'american_range' };
  return checked(x.n > 0n ? 1000n + (10n * x.n) / x.d : 1000n + (100_000n * x.d) / abs);
}

/** Decimal odds (1.01 to 1000) to milli, rounded down. */
export function decimalToMilli(value: unknown): PriceResult {
  const x = exactDecimal(value);
  if (x === null) return { ok: false, problem: 'unparseable' };
  if (x.n * 100n < 101n * x.d || x.n > 1000n * x.d) {
    return { ok: false, problem: 'decimal_range' };
  }
  return checked((1000n * x.n) / x.d);
}

export function priceToMilli(value: unknown, format: PriceFormat): PriceResult {
  return format === 'american' ? americanToMilli(value) : decimalToMilli(value);
}
