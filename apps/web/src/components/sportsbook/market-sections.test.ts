import type { MarketView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { applyFilter, buildSections, withoutLongShots } from './market-sections';

const market = (
  id: string,
  group: string | undefined,
  odds: number[] = [2000],
  status: MarketView['status'] = 'open',
): MarketView =>
  ({
    id,
    type: 't',
    line: null,
    name: { en: `Market ${id}` },
    ...(group === undefined ? {} : { group }),
    status,
    selections: odds.map((oddsMilli, i) => ({ id: `${id}-${i}`, label: 'x', oddsMilli })),
  }) as unknown as MarketView;

const name = (m: MarketView) => (m.name as { en: string }).en;

describe('buildSections', () => {
  it('puts main first, then groups in the fixed order', () => {
    const sections = buildSections(
      [
        market('a', 'halves'),
        market('b', 'first_half'),
        market('c', undefined),
        market('d', 'full_time'),
      ],
      name,
    );
    expect(sections.map((s) => s.id)).toEqual(['main', 'full_time', 'first_half', 'halves']);
  });

  it('is a single main section without factory markets', () => {
    const sections = buildSections([market('a', undefined), market('b', undefined)], name);
    expect(sections.map((s) => [s.id, s.markets.length])).toEqual([['main', 2]]);
  });

  it('keeps unknown groups last and skips closed markets', () => {
    const sections = buildSections(
      [market('a', 'weird'), market('b', 'teams'), market('c', 'teams', [2000], 'settled')],
      name,
    );
    expect(sections.map((s) => s.id)).toEqual(['teams', 'weird']);
    expect(sections[0]?.markets).toHaveLength(1);
  });

  it('searches market names case-insensitively', () => {
    const sections = buildSections(
      [market('Alpha', 'teams'), market('Beta', 'teams')],
      name,
      '  aLPh ',
    );
    expect(sections[0]?.markets.map((m) => m.id)).toEqual(['Alpha']);
    expect(buildSections([market('Alpha', 'teams')], name, 'zzz')).toEqual([]);
  });

  it('keeps every selection of today’s markets (no group), long shots included', () => {
    const sections = buildSections([market('cs', undefined, [2000, 600_000])], (m) => m.id);
    expect(sections[0]?.markets[0]?.selections.map((s) => s.oddsMilli)).toEqual([2000, 600_000]);
  });

  it('hides selections above 500.00 and markets left empty', () => {
    const sections = buildSections(
      [market('a', 'teams', [2000, 500_000, 500_001]), market('b', 'teams', [600_000])],
      name,
    );
    expect(sections[0]?.markets.map((m) => m.id)).toEqual(['a']);
    expect(sections[0]?.markets[0]?.selections.map((s) => s.oddsMilli)).toEqual([2000, 500_000]);
  });
});

describe('withoutLongShots', () => {
  it('returns the same market when nothing is cut', () => {
    const m = market('a', undefined);
    expect(withoutLongShots(m)).toBe(m);
  });
});

describe('applyFilter', () => {
  const sections = buildSections([market('a', undefined), market('b', 'teams')], name);
  it('shows all or one section', () => {
    expect(applyFilter(sections, 'all')).toHaveLength(2);
    expect(applyFilter(sections, 'teams').map((s) => s.id)).toEqual(['teams']);
    expect(applyFilter(sections, 'halves')).toEqual([]);
  });
});
