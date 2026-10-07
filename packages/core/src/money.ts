/**
 * Money is represented as `bigint` santim (1 ETB = 100 santim). Never use
 * floating point for amounts. All divisions round toward negative infinity
 * (`floorDiv`), so payouts derived from these helpers always round down.
 */
export type Santim = bigint;

export const SANTIM_PER_BIRR = 100n;
/** Basis points denominator: 10_000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000n;

const BIRR_PATTERN = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/;
const SANTIM_PATTERN = /^-?\d{1,20}$/;

/** Integer division rounding toward negative infinity. Throws on division by zero. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('division by zero');
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q;
}

/** floor(a × b / c) without intermediate rounding. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  return floorDiv(a * b, c);
}

/** floor(amount × bps / 10_000). */
export function applyBps(amount: Santim, bps: number | bigint): Santim {
  const b = typeof bps === 'bigint' ? bps : BigInt(assertInteger(bps, 'bps'));
  return mulDivFloor(amount, b, BPS_DENOMINATOR);
}

/**
 * Parses a human birr amount such as "5", "12.5", "1,250.75" into santim.
 * At most two decimal places are accepted; grouping commas are ignored.
 */
export function parseBirr(input: string, options: { allowNegative?: boolean } = {}): Santim {
  const cleaned = input.trim().replace(/,/g, '');
  const match = BIRR_PATTERN.exec(cleaned);
  if (!match) {
    throw new RangeError(`invalid birr amount: "${input}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  if (sign && !options.allowNegative) {
    throw new RangeError(`negative birr amount not allowed: "${input}"`);
  }
  const santim = BigInt(whole) * SANTIM_PER_BIRR + BigInt(fraction.padEnd(2, '0') || '0');
  return sign ? -santim : santim;
}

/**
 * Converts a birr number literal to santim, for constants in code
 * (`birr(5)` → 500n). Rejects values with more than two decimals.
 */
export function birr(amount: number): Santim {
  if (!Number.isFinite(amount)) throw new RangeError(`invalid birr amount: ${amount}`);
  return parseBirr(String(amount), { allowNegative: true });
}

/** Parses a wire-format santim integer string ("12550"). */
export function parseSantim(wire: string): Santim {
  if (!SANTIM_PATTERN.test(wire)) {
    throw new RangeError(`invalid santim amount: "${wire}"`);
  }
  return BigInt(wire);
}

/** Wire format for amounts: the santim integer as a decimal string. */
export function toWire(amount: Santim): string {
  return amount.toString();
}

/** "1250.50" – plain birr with exactly two decimals, no grouping. */
export function santimToBirrString(amount: Santim): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / SANTIM_PER_BIRR;
  const fraction = (abs % SANTIM_PER_BIRR).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** "1,250.50" or "ETB 1,250.50" for display. */
export function formatBirr(
  amount: Santim,
  options: { grouping?: boolean; currency?: boolean } = {},
): string {
  const { grouping = true, currency = false } = options;
  const plain = santimToBirrString(amount);
  const [rawWhole = '0', fraction = '00'] = plain.split('.');
  const negative = rawWhole.startsWith('-');
  const digits = negative ? rawWhole.slice(1) : rawWhole;
  const whole = grouping ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits;
  const text = `${negative ? '-' : ''}${whole}.${fraction}`;
  return currency ? `ETB ${text}` : text;
}

export function sumSantim(amounts: Iterable<Santim>): Santim {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}

export function minSantim(a: Santim, b: Santim): Santim {
  return a < b ? a : b;
}

export function maxSantim(a: Santim, b: Santim): Santim {
  return a > b ? a : b;
}

export function assertNonNegative(amount: Santim, label = 'amount'): Santim {
  if (amount < 0n) throw new RangeError(`${label} must not be negative (got ${amount})`);
  return amount;
}

function assertInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer (got ${value})`);
  return value;
}
