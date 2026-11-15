import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { catalogueGaps, type GapObservation } from './gaps';
import { normalizeName } from './name';

const at = (day: number) => new Date(Date.UTC(2030, 0, day));
const obs = (o: Partial<GapObservation> & Pick<GapObservation, 'homeRaw' | 'awayRaw'>) => ({
  sourceId: 's1',
  competition: 'champions-league',
  homeResolved: false,
  awayResolved: false,
  firstSeenAt: at(10),
  ...o,
});

describe('catalogueGaps', () => {
  it('groups spellings by competition and normalised name, with sources, rows and first seen', () => {
    const rows = catalogueGaps([
      obs({
        homeRaw: 'FC Bodø/Glimt',
        awayRaw: 'Arsenal',
        awayResolved: true,
        firstSeenAt: at(12),
      }),
      obs({
        sourceId: 's2',
        homeRaw: 'FC BODØ/GLIMT',
        awayRaw: 'Arsenal',
        awayResolved: true,
        firstSeenAt: at(11),
      }),
      obs({
        sourceId: 's2',
        homeRaw: 'Arsenal',
        homeResolved: true,
        awayRaw: 'FC Bodø/Glimt',
        firstSeenAt: at(14),
      }),
      obs({ competition: 'fa-cup', homeRaw: 'Bodø/Glimt', awayRaw: 'Arsenal', awayResolved: true }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      competition: 'champions-league',
      normalized: normalizeName('FC Bodø/Glimt'),
      sources: ['s1', 's2'],
      rows: 3,
      firstSeen: at(11),
    });
    // The commonest raw form wins (2 to 1).
    expect(rows[0]!.spelling).toBe('FC Bodø/Glimt');
    expect(rows[1]).toMatchObject({ competition: 'fa-cup', rows: 1, sources: ['s1'] });
  });

  it('counts an observation once per spelling even when both sides use it, and ignores resolved sides', () => {
    const rows = catalogueGaps([
      obs({ homeRaw: 'Newbies', awayRaw: 'NEWBIES' }),
      obs({ homeRaw: 'Known', homeResolved: true, awayRaw: 'Known B', awayResolved: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rows: 1 });
  });

  it('keeps only the wanted spellings when given a set', () => {
    const list = [obs({ homeRaw: 'Alpha FC', awayRaw: 'Beta FC' })];
    expect(catalogueGaps(list, { wanted: new Set([normalizeName('Beta FC')]) })).toMatchObject([
      { spelling: 'Beta FC' },
    ]);
    expect(catalogueGaps(list, { wanted: new Set() })).toEqual([]);
    expect(catalogueGaps(list, { wanted: null })).toHaveLength(2);
  });

  it('is empty without observations, and skips names that normalise to nothing', () => {
    expect(catalogueGaps([])).toEqual([]);
    expect(catalogueGaps([obs({ homeRaw: '  ', awayRaw: '.' })])).toEqual([]);
  });

  const arbObs = fc.record({
    sourceId: fc.constantFrom('s1', 's2', 's3'),
    competition: fc.constantFrom('a', 'b'),
    homeRaw: fc.constantFrom('Alpha FC', 'ALPHA fc', 'Beta', 'Gamma United', 'é'),
    awayRaw: fc.constantFrom('Alpha FC', 'Beta', 'Delta', 'Gamma  United'),
    homeResolved: fc.boolean(),
    awayResolved: fc.boolean(),
    firstSeenAt: fc.integer({ min: 1, max: 28 }).map(at),
  });

  it('property: no resolved name is ever listed, rows never exceed observations, order is irrelevant', () => {
    fc.assert(
      fc.property(fc.array(arbObs, { maxLength: 25 }), (list) => {
        const rows = catalogueGaps(list);
        const unresolved = new Set<string>();
        for (const o of list) {
          if (!o.homeResolved) unresolved.add(`${o.competition}|${normalizeName(o.homeRaw)}`);
          if (!o.awayResolved) unresolved.add(`${o.competition}|${normalizeName(o.awayRaw)}`);
        }
        for (const r of rows) {
          expect(unresolved.has(`${r.competition}|${r.normalized}`)).toBe(true);
          expect(r.rows).toBeGreaterThanOrEqual(1);
          expect(r.rows).toBeLessThanOrEqual(list.length);
          expect(r.sources).toEqual([...r.sources].sort());
        }
        expect(new Set(rows.map((r) => `${r.competition}|${r.normalized}`)).size).toBe(rows.length);
        expect(catalogueGaps([...list].reverse())).toEqual(rows);
      }),
    );
  });
});
