import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  familyHistoryVerdict,
  historyTestPassedAt,
  HISTORY_MIN_SELECTION_N,
  selectionFairYield,
  suggestFamilyMarginBps,
  type SelectionHistory,
} from './family-history';
import { MAX_FAMILY_MARGIN_BPS } from './market-families';

/** A selection priced at `p` every time, winning `wins` of `n`. */
function priced(key: string, p: number, n: number, wins: number): SelectionHistory {
  return {
    key,
    n,
    wins,
    sumP: p * n,
    sumRatio: wins / p,
    sumRatioSq: wins / (p * p),
  };
}

const DAY = 86_400_000;
const NOW = new Date('2026-11-13T12:00:00Z');

describe('selectionFairYield', () => {
  it('is zero for a selection that wins exactly as often as priced', () => {
    const fy = selectionFairYield(priced('a', 0.5, 1000, 500))!;
    expect(fy.yield).toBeCloseTo(0, 12);
    expect(fy.lower).toBeLessThan(0);
  });

  it('says nothing below the sample floor', () => {
    expect(selectionFairYield(priced('a', 0.5, HISTORY_MIN_SELECTION_N - 1, 150))).toBeNull();
  });

  it('is positive when it wins more often than priced', () => {
    const fy = selectionFairYield(priced('a', 0.4, 2000, 1000))!;
    expect(fy.yield).toBeCloseTo(0.25, 12);
    expect(fy.lower).toBeGreaterThan(0.2);
  });
});

describe('suggestFamilyMarginBps', () => {
  it('keeps the class margin when the model is right', () => {
    expect(suggestFamilyMarginBps([priced('a', 0.5, 1000, 500)], 700)).toBe(700);
  });

  it('raises to the worst significant fair yield, rounded up to a whole point', () => {
    // Fair yield 0.25 with a small standard error: the lower bound is about 0.22.
    const s = priced('a', 0.4, 4000, 2000);
    const lower = selectionFairYield(s)!.lower;
    expect(suggestFamilyMarginBps([s], 700)).toBe(Math.ceil((lower * 10_000) / 100) * 100);
  });

  it('ignores thin selections and caps at the maximum margin', () => {
    expect(suggestFamilyMarginBps([priced('thin', 0.01, 50, 50)], 600)).toBe(600);
    expect(suggestFamilyMarginBps([priced('crazy', 0.05, 5000, 5000)], 600)).toBe(
      MAX_FAMILY_MARGIN_BPS,
    );
  });

  it('is never below the class margin, never above the cap, and a whole point above it (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            p: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
            n: fc.integer({ min: 1, max: 5000 }),
            share: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 3000 }),
        (rows, classMargin) => {
          const sels = rows.map((r, i) => priced(String(i), r.p, r.n, Math.floor(r.n * r.share)));
          const m = suggestFamilyMarginBps(sels, classMargin);
          expect(m).toBeGreaterThanOrEqual(Math.min(classMargin, MAX_FAMILY_MARGIN_BPS));
          expect(m).toBeLessThanOrEqual(Math.max(classMargin, MAX_FAMILY_MARGIN_BPS));
          if (m > classMargin && m < MAX_FAMILY_MARGIN_BPS) expect(m % 100).toBe(0);
          // Adding a selection that wins exactly as priced never lowers it.
          expect(
            suggestFamilyMarginBps([...sels, priced('fair', 0.5, 1000, 500)], classMargin),
          ).toBe(m);
        },
      ),
    );
  });
});

describe('familyHistoryVerdict', () => {
  it('passes a family the model prices right that kept money', () => {
    const v = familyHistoryVerdict({
      family: 'h1_ou',
      matches: 1000,
      selections: [priced('0.5|over', 0.5, 1000, 500), priced('0.5|under', 0.5, 1000, 500)],
      marginBps: 700,
      stakes: 2000,
      returns: 1870,
    });
    expect(v).toMatchObject({
      passed: true,
      suggestedMarginBps: 700,
      holdBps: 650,
      selections: 2000,
    });
  });

  it('fails a family with an under-priced selection, and names it', () => {
    const v = familyHistoryVerdict({
      family: 'h1_ou',
      matches: 4000,
      selections: [priced('0.5|over', 0.4, 4000, 2000), priced('0.5|under', 0.6, 4000, 2000)],
      marginBps: 700,
      stakes: 8000,
      returns: 7900,
    });
    expect(v.passed).toBe(false);
    expect(v.suggestedMarginBps).toBeGreaterThan(700);
    expect(v.worst?.key).toBe('0.5|over');
  });

  it('fails a family that lost money even when no selection stands out', () => {
    const v = familyHistoryVerdict({
      family: 'x',
      matches: 10,
      selections: [priced('a', 0.5, 10, 6)],
      marginBps: 700,
      stakes: 10,
      returns: 11,
    });
    expect(v.holdBps).toBe(-1000);
    expect(v.passed).toBe(false);
  });
});

describe('historyTestPassedAt', () => {
  const verdict = { suggestedMarginBps: 900, selections: 5000 };
  it('passes at or above the suggested margin, for a recent test', () => {
    expect(historyTestPassedAt(verdict, 900, new Date(NOW.getTime() - DAY), NOW)).toBe(true);
    expect(historyTestPassedAt(verdict, 1100, new Date(NOW.getTime() - DAY), NOW)).toBe(true);
  });

  it('fails below it, without a test, with an empty sample, or with an old or future test', () => {
    expect(historyTestPassedAt(verdict, 800, new Date(NOW.getTime() - DAY), NOW)).toBe(false);
    expect(historyTestPassedAt(undefined, 2000, NOW, NOW)).toBe(false);
    expect(historyTestPassedAt(verdict, 2000, null, NOW)).toBe(false);
    expect(historyTestPassedAt({ suggestedMarginBps: 0, selections: 0 }, 2000, NOW, NOW)).toBe(
      false,
    );
    expect(historyTestPassedAt(verdict, 2000, new Date(NOW.getTime() - 401 * DAY), NOW)).toBe(
      false,
    );
    expect(historyTestPassedAt(verdict, 2000, new Date(NOW.getTime() + DAY), NOW)).toBe(false);
  });
});
