import type { FeedLeagueView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { groupBySport, marginToInput, parseMarginInput } from './feed';

describe('league margin input', () => {
  it('reads a percent as basis points, blank as the default', () => {
    expect(parseMarginInput('')).toBeNull();
    expect(parseMarginInput('  ')).toBeNull();
    expect(parseMarginInput('6.5')).toBe(650);
    expect(parseMarginInput('6,5')).toBe(650);
    expect(parseMarginInput('0')).toBe(0);
    expect(parseMarginInput('7')).toBe(700);
    expect(parseMarginInput('4.25')).toBe(425);
    expect(parseMarginInput('30')).toBe(3000);
  });

  it('refuses anything else', () => {
    for (const bad of ['30.01', '31', '-1', 'abc', '1.234', '1e2', '.5', '100']) {
      expect(parseMarginInput(bad), bad).toBeUndefined();
    }
  });

  it('shows basis points as a percent and round-trips', () => {
    expect(marginToInput(null)).toBe('');
    expect(marginToInput(650)).toBe('6.5');
    expect(marginToInput(700)).toBe('7');
    expect(marginToInput(425)).toBe('4.25');
    expect(marginToInput(5)).toBe('0.05');
    expect(marginToInput(0)).toBe('0');
    for (const bps of [0, 5, 50, 425, 650, 1200, 3000]) {
      expect(parseMarginInput(marginToInput(bps))).toBe(bps);
    }
  });
});

describe('groupBySport', () => {
  it('groups by sport id keeping order', () => {
    const league = (sportKey: string, sportId: string) => ({ sportKey, sportId }) as FeedLeagueView;
    const grouped = groupBySport([
      league('a', 'football'),
      league('b', 'tennis'),
      league('c', 'football'),
    ]);
    expect(grouped.map(([sport, list]) => [sport, list.map((l) => l.sportKey)])).toEqual([
      ['football', ['a', 'c']],
      ['tennis', ['b']],
    ]);
  });
});
