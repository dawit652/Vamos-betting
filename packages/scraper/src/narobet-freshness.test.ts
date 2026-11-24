import { describe, expect, it } from 'vitest';
import { narobetPricesMaxAgeMs } from './constants';

const MIN = 60_000;
const H = 60 * MIN;
const NOW = new Date('2026-11-21T10:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('how old Narobet prices may be (mr-z re-reads 10 min / 30 min / 6 h)', () => {
  it('follows the time left to the kickoff', () => {
    expect(narobetPricesMaxAgeMs(at(30 * MIN), NOW)).toBe(20 * MIN);
    expect(narobetPricesMaxAgeMs(at(3 * H), NOW)).toBe(20 * MIN);
    expect(narobetPricesMaxAgeMs(at(3 * H + MIN), NOW)).toBe(45 * MIN);
    expect(narobetPricesMaxAgeMs(at(24 * H), NOW)).toBe(45 * MIN);
    expect(narobetPricesMaxAgeMs(at(24 * H + MIN), NOW)).toBe(7 * H);
    expect(narobetPricesMaxAgeMs(at(20 * 24 * H), NOW)).toBe(7 * H);
  });

  it('a kickoff already passed gets the shortest limit', () => {
    expect(narobetPricesMaxAgeMs(at(-H), NOW)).toBe(20 * MIN);
  });
});
