/**
 * Seeded pseudo-random numbers for the mock feed and the live simulator.
 *
 * NOT cryptographic: the generator (mulberry32, 32-bit state) only has to give
 * reproducible sequences so that the same seed always yields the same
 * fixtures, odds and match events.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** A uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy of the array (Fisher–Yates); the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /** A Poisson-distributed count with mean `lambda` (≥ 0). */
  poisson(lambda: number): number;
  /** A normally distributed float (Box–Muller), default N(0, 1). */
  normal(mean?: number, sd?: number): number;
}

/** Knuth's multiplication method is exact but O(λ); larger means are split into chunks. */
const KNUTH_MAX_LAMBDA = 30;
/** Above this mean a rounded normal approximation is used (relative error ≪ 1%). */
const NORMAL_APPROX_LAMBDA = 10_000;
const UINT32 = 4_294_967_296;

/** 32-bit FNV-1a hash of a string (UTF-16 code units). */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The mulberry32 generator: returns uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/**
 * Creates a seeded generator. A uint32 number is used as the state directly;
 * any other finite number and every string is hashed with FNV-1a first, so
 * `createRng('premier-league|2026-10-10')` is stable across runs and machines.
 */
export function createRng(seed: number | string): Rng {
  return rngFrom(mulberry32(seedToUint32(seed)));
}

function seedToUint32(seed: number | string): number {
  if (typeof seed === 'string') return fnv1a(seed);
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new RangeError(`rng seed must be a finite number or a string, got ${String(seed)}`);
  }
  if (Number.isInteger(seed) && seed >= 0 && seed < UINT32) return seed;
  return fnv1a(String(seed));
}

function rngFrom(next: () => number): Rng {
  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`int() needs safe integers min <= max, got ${min}..${max}`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const normal = (mean = 0, sd = 1): number => {
    if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd < 0) {
      throw new RangeError(`normal() needs a finite mean and sd >= 0, got ${mean}, ${sd}`);
    }
    // 1 − u lies in (0, 1], so the logarithm is finite.
    const radius = Math.sqrt(-2 * Math.log(1 - next()));
    return mean + sd * radius * Math.cos(2 * Math.PI * next());
  };

  const knuth = (lambda: number): number => {
    const limit = Math.exp(-lambda);
    let count = 0;
    let product = next();
    while (product > limit) {
      count++;
      product *= next();
    }
    return count;
  };

  const poisson = (lambda: number): number => {
    if (!Number.isFinite(lambda) || lambda < 0) {
      throw new RangeError(`poisson() needs a finite lambda >= 0, got ${lambda}`);
    }
    if (lambda === 0) return 0;
    if (lambda > NORMAL_APPROX_LAMBDA) {
      return Math.max(0, Math.round(normal(lambda, Math.sqrt(lambda))));
    }
    // A sum of independent Poisson variables is Poisson with the summed mean.
    let total = 0;
    let rest = lambda;
    while (rest > KNUTH_MAX_LAMBDA) {
      total += knuth(KNUTH_MAX_LAMBDA);
      rest -= KNUTH_MAX_LAMBDA;
    }
    return total + knuth(rest);
  };

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
      return items[int(0, items.length - 1)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i);
        const swap = copy[i] as T;
        copy[i] = copy[j] as T;
        copy[j] = swap;
      }
      return copy;
    },
    poisson,
    normal,
  };
}
