import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FIRST_AGENT_NUMBER,
  formatBpsPercent,
  formatShopLabel,
  nextAgentNumber,
  parsePercentBps,
  parseShopLabel,
} from './retail';

describe('shop labels', () => {
  it('prints the agent number and a two-digit shop number', () => {
    expect(formatShopLabel(1000, 1)).toBe('1000-01');
    expect(formatShopLabel(1001, 12)).toBe('1001-12');
    expect(formatShopLabel(123456, 999)).toBe('123456-999');
  });

  it('refuses numbers out of range', () => {
    expect(() => formatShopLabel(999, 1)).toThrow(RangeError);
    expect(() => formatShopLabel(1001, 0)).toThrow(RangeError);
    expect(() => formatShopLabel(1001, 1000)).toThrow(RangeError);
    expect(() => formatShopLabel(1001.5, 1)).toThrow(RangeError);
  });

  it('reads only the printed spelling', () => {
    expect(parseShopLabel(' 1001-01 ')).toEqual({ agentNumber: 1001, shopNumber: 1 });
    expect(parseShopLabel('1001-120')).toEqual({ agentNumber: 1001, shopNumber: 120 });
    for (const bad of ['1001-1', '1001-001', '01001-01', '999-01', '1001-00', 'main', '1001_01']) {
      expect(parseShopLabel(bad)).toBeNull();
    }
  });

  it('round-trips every valid pair', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 999_999 }),
        fc.integer({ min: 1, max: 999 }),
        (a, s) => {
          expect(parseShopLabel(formatShopLabel(a, s))).toEqual({ agentNumber: a, shopNumber: s });
        },
      ),
    );
  });
});

describe('agent numbers', () => {
  it('starts at 1001 and counts up', () => {
    expect(nextAgentNumber(null)).toBe(FIRST_AGENT_NUMBER);
    expect(nextAgentNumber(1000)).toBe(1001);
    expect(nextAgentNumber(1001)).toBe(1002);
    expect(() => nextAgentNumber(999_999)).toThrow(RangeError);
  });
});

describe('commission percent', () => {
  it('reads percents into basis points without floating point', () => {
    expect(parsePercentBps('10')).toBe(1000);
    expect(parsePercentBps('12.5')).toBe(1250);
    expect(parsePercentBps('7.25')).toBe(725);
    expect(parsePercentBps('0')).toBe(0);
    expect(parsePercentBps('100')).toBe(10_000);
    for (const bad of ['', '-1', '100.01', '101', '1.234', 'ten', '1,5']) {
      expect(parsePercentBps(bad)).toBeNull();
    }
  });

  it('prints basis points back as the shortest percent', () => {
    expect(formatBpsPercent(1000)).toBe('10');
    expect(formatBpsPercent(1250)).toBe('12.5');
    expect(formatBpsPercent(725)).toBe('7.25');
    expect(formatBpsPercent(5)).toBe('0.05');
  });

  it('round-trips every basis point value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (bps) => {
        expect(parsePercentBps(formatBpsPercent(bps))).toBe(bps);
      }),
    );
  });
});
