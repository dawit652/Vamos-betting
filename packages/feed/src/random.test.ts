import { describe, expect, it } from 'vitest';
import { createRng, fnv1a, mulberry32 } from './random';

function sample(count: number, draw: () => number): { mean: number; variance: number } {
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < count; i++) {
    const x = draw();
    sum += x;
    squares += x * x;
  }
  const mean = sum / count;
  return { mean, variance: squares / count - mean * mean };
}

describe('fnv1a', () => {
  it('matches the reference 32-bit FNV-1a values', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});

describe('createRng', () => {
  it('is reproducible for the same seed and differs between seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    const seqC = Array.from({ length: 20 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('hashes string seeds with FNV-1a', () => {
    const fromString = createRng('premier-league|2026-10-10');
    const fromHash = rngSequence(mulberry32(fnv1a('premier-league|2026-10-10')));
    expect(Array.from({ length: 5 }, () => fromString.next())).toEqual(fromHash);
    expect(createRng('a').next()).not.toBe(createRng('b').next());
  });

  it('hashes non-uint32 numeric seeds instead of truncating them', () => {
    expect(createRng(1.5).next()).not.toBe(createRng(1).next());
    expect(createRng(-1).next()).toBe(createRng(-1).next());
    expect(createRng(2 ** 32).next()).not.toBe(createRng(0).next());
  });

  it('rejects invalid seeds', () => {
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('next() is uniform in [0, 1)', () => {
    const rng = createRng(7);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 50_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      buckets[Math.floor(x * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - 5000)).toBeLessThan(300);
  });

  it('int() covers both inclusive bounds and nothing else', () => {
    const rng = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const x = rng.int(-2, 3);
      expect(Number.isInteger(x)).toBe(true);
      seen.add(x);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2, 3]);
    expect(rng.int(5, 5)).toBe(5);
    expect(() => rng.int(3, 2)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it('pick() returns members and rejects an empty array', () => {
    const rng = createRng(3);
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('shuffle() returns a permutation without touching the input', () => {
    const rng = createRng(9);
    const input = Array.from({ length: 20 }, (_, i) => i);
    const frozen = Object.freeze(input.slice());
    const shuffled = rng.shuffle(frozen);
    expect(shuffled).not.toBe(frozen);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
    expect(shuffled).not.toEqual(input);
    expect(frozen).toEqual(input);
    expect(rng.shuffle([])).toEqual([]);
  });

  it.each([0.02, 0.5, 2.7, 29.9, 45, 220, 20_000])(
    'poisson(%d) has the right mean and variance',
    (lambda) => {
      const rng = createRng(`poisson-${lambda}`);
      const n = lambda > 1000 ? 4000 : 20_000;
      const { mean, variance } = sample(n, () => rng.poisson(lambda));
      // Standard error of the mean is sqrt(λ/n); allow ~5 of them.
      expect(Math.abs(mean - lambda)).toBeLessThan(5 * Math.sqrt(lambda / n) + 1e-9);
      expect(variance / lambda).toBeGreaterThan(0.9);
      expect(variance / lambda).toBeLessThan(1.1);
    },
  );

  it('poisson() returns non-negative integers and handles 0', () => {
    const rng = createRng(11);
    expect(rng.poisson(0)).toBe(0);
    for (let i = 0; i < 1000; i++) {
      const k = rng.poisson(1.3);
      expect(Number.isInteger(k) && k >= 0).toBe(true);
    }
    expect(() => rng.poisson(-1)).toThrow(RangeError);
    expect(() => rng.poisson(Number.NaN)).toThrow(RangeError);
  });

  it('normal() has the requested mean and standard deviation', () => {
    const rng = createRng(5);
    const { mean, variance } = sample(40_000, () => rng.normal(10, 3));
    expect(Math.abs(mean - 10)).toBeLessThan(0.08);
    expect(Math.abs(Math.sqrt(variance) - 3)).toBeLessThan(0.08);
    const standard = sample(40_000, () => rng.normal());
    expect(Math.abs(standard.mean)).toBeLessThan(0.03);
    expect(Math.abs(standard.variance - 1)).toBeLessThan(0.05);
    expect(() => rng.normal(0, -1)).toThrow(RangeError);
  });
});

function rngSequence(next: () => number): number[] {
  return Array.from({ length: 5 }, () => next());
}
