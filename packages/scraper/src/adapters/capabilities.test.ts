import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  coverageMatrix,
  sourceCapabilities,
  type BasisKind,
  type CoverageEntry,
  type SourceCapabilities,
} from './capabilities';
import { createAdapter } from './registry';
import type { SourceRow } from './registry';

const file = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../docs/scraper-plan/data/${name}`, import.meta.url), 'utf8'),
  ) as SourceRow;

const caps = (name: string): SourceCapabilities => {
  const result = sourceCapabilities(file(name));
  if (!result.ok) throw new Error(result.errors.join());
  return result.capabilities;
};

describe('sourceCapabilities of the shipped source files', () => {
  it('football-data.org gives fixtures, full time and half time; the cup says extra time per match', () => {
    expect(caps('source-footballdata-en1.json')).toMatchObject({
      competitions: ['English Premier League'],
      fixtures: true,
      fullTime: true,
      halfTime: true,
      basis: 'declared',
      prices: false,
    });
    expect(caps('source-footballdata-cl.json')).toMatchObject({
      fullTime: true,
      halfTime: true,
      basis: 'per-record',
    });
  });

  it('openfootball gives fixtures, full time and half time (ht is read when the dataset has it)', () => {
    expect(caps('source-openfootball-en1.json')).toMatchObject({
      fixtures: true,
      fullTime: true,
      halfTime: true,
      basis: 'per-record',
      prices: false,
    });
  });

  it('The Odds API scores give full time only; its price source gives prices and (set up so) fixtures', () => {
    expect(caps('source-theoddsapi-scores-en1.json')).toMatchObject({
      competitions: ['English Premier League'],
      fixtures: false,
      fullTime: true,
      halfTime: false,
      basis: 'declared',
      prices: false,
    });
    expect(caps('source-theoddsapi-en1.json')).toMatchObject({
      fixtures: true,
      fullTime: false,
      halfTime: false,
      basis: 'none',
      prices: true,
    });
  });

  it('a price source without `fixtures` gives no fixtures', () => {
    const row = file('source-theoddsapi-en1.json');
    const result = sourceCapabilities({
      adapter: row.adapter,
      config: { ...(row.config as object), fixtures: false },
    });
    expect(result.ok && result.capabilities.fixtures).toBe(false);
  });

  it('TheRundown gives full time without half time, and a basis only when finals are regular time', () => {
    const row = file('source-therundown-free.json');
    const regular = sourceCapabilities(row);
    expect(regular.ok && regular.capabilities).toMatchObject({
      fixtures: true,
      fullTime: true,
      halfTime: false,
      basis: 'declared',
      prices: true,
    });
    const longer = sourceCapabilities({
      adapter: row.adapter,
      config: { ...(row.config as object), finalIsRegularTime: false },
    });
    expect(longer.ok && longer.capabilities.basis).toBe('none');
  });

  it('every shipped source file that createAdapter accepts also has capabilities (and the reverse)', () => {
    const names = [
      'source-api-football.json',
      'source-apifootball-bydate.json',
      'source-footballdata-br1.json',
      'source-footballdata-nl1.json',
      'source-openfootball-pt1.json',
      'source-theoddsapi-cdf.json',
      'source-theoddsapi-scores-tr1.json',
      'source-therundown-free.json',
      'source-unafut.json',
    ];
    for (const name of names) {
      const row = file(name);
      const built = createAdapter(row);
      const result = sourceCapabilities(row);
      expect(result.ok, name).toBe(built.ok);
    }
  });

  it('refuses an unknown adapter and a config the adapter would refuse, with errors', () => {
    expect(sourceCapabilities({ adapter: 'nope' as never, config: {} })).toMatchObject({
      ok: false,
    });
    const bad = sourceCapabilities({ adapter: 'openfootball', config: { requests: [] } });
    expect(bad.ok).toBe(false);
  });
});

const entry = (
  competition: string,
  sourceId: string,
  upstream: string,
  c: Partial<CoverageEntry['capabilities']> = {},
): CoverageEntry => ({
  competition,
  sourceId,
  upstream,
  capabilities: { fixtures: false, fullTime: false, halfTime: false, basis: 'none', ...c },
});

describe('coverageMatrix', () => {
  it('counts distinct upstreams per capability and flags a single result upstream', () => {
    const rows = coverageMatrix([
      entry('en1', 'fd', 'football-data.org', {
        fixtures: true,
        fullTime: true,
        halfTime: true,
        basis: 'declared',
      }),
      entry('en1', 'of', 'openfootball', {
        fixtures: true,
        fullTime: true,
        halfTime: true,
        basis: 'per-record',
      }),
      entry('en1', 'odds', 'TheOddsAPI', { fixtures: true }),
      entry('en1', 'scores', ' theoddsapi ', { fullTime: true, basis: 'declared' }),
      entry('xx9', 'fd2', 'football-data.org', { fixtures: true, fullTime: true, halfTime: true }),
      entry('xx9', 'fd3', 'Football-Data.org', { fixtures: true, fullTime: true }),
    ]);
    expect(rows).toEqual([
      {
        competition: 'en1',
        sources: 4,
        upstreams: 3,
        fixtureUpstreams: 3,
        fullTimeUpstreams: 3,
        halfTimeUpstreams: 2,
        basisUpstreams: 3,
        basisKnown: true,
        singleResultUpstream: false,
      },
      {
        competition: 'xx9',
        sources: 2,
        upstreams: 1,
        fixtureUpstreams: 1,
        fullTimeUpstreams: 1,
        halfTimeUpstreams: 1,
        basisUpstreams: 0,
        basisKnown: false,
        singleResultUpstream: true,
      },
    ]);
  });

  it('a prices-only competition has no full-time upstream at all', () => {
    const [row] = coverageMatrix([entry('c', 's', 'TheOddsAPI', { fixtures: true })]);
    expect(row).toMatchObject({ fullTimeUpstreams: 0, singleResultUpstream: true });
  });

  const arbEntry = fc.record({
    competition: fc.constantFrom('a', 'b', 'c'),
    sourceId: fc.constantFrom('s1', 's2', 's3', 's4', 's5'),
    upstream: fc.constantFrom('U1', 'u1', ' U2 ', 'U3'),
    capabilities: fc.record({
      fixtures: fc.boolean(),
      fullTime: fc.boolean(),
      halfTime: fc.boolean(),
      basis: fc.constantFrom<BasisKind>('per-record', 'declared', 'none'),
    }),
  });

  it('property: counts are bounded by upstreams, ordered, and the flag means fewer than two', () => {
    fc.assert(
      fc.property(fc.array(arbEntry, { maxLength: 30 }), (entries) => {
        const rows = coverageMatrix(entries);
        expect(rows.map((r) => r.competition)).toEqual(
          [...new Set(entries.map((e) => e.competition))].sort(),
        );
        for (const r of rows) {
          expect(r.fullTimeUpstreams).toBeLessThanOrEqual(r.upstreams);
          expect(r.fixtureUpstreams).toBeLessThanOrEqual(r.upstreams);
          expect(r.halfTimeUpstreams).toBeLessThanOrEqual(r.fullTimeUpstreams);
          expect(r.basisUpstreams).toBeLessThanOrEqual(r.fullTimeUpstreams);
          expect(r.basisKnown).toBe(r.basisUpstreams > 0);
          expect(r.singleResultUpstream).toBe(r.fullTimeUpstreams < 2);
        }
      }),
    );
  });

  it('property: the order of the entries changes nothing', () => {
    fc.assert(
      fc.property(fc.array(arbEntry, { maxLength: 20 }), (entries) => {
        expect(coverageMatrix([...entries].reverse())).toEqual(coverageMatrix(entries));
      }),
    );
  });
});
