import { readFileSync } from 'node:fs';
import { selectionsFor } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseHulusportCoredata,
  parseHulusportMatch,
  parseHulusportMatchList,
  parseMrxBoard,
} from './index';

const FIXTURE = readFileSync(
  new URL('./__fixtures__/hulusport-match.json', import.meta.url),
  'utf8',
);
type Doc = {
  items: Array<{
    bet_group: { name: string };
    specifier: Record<string, unknown>;
    odds: Array<{ bet_type: { name: string }; odd: unknown; is_available: boolean }>;
  }>;
} & Record<string, unknown>;
const fixture = (): Doc => JSON.parse(FIXTURE) as Doc;
const parse = (doc: unknown) => parseHulusportMatch(JSON.stringify(doc));

describe('parseHulusportMatch', () => {
  it('reads the match and maps the supported markets onto Vamos types', () => {
    const match = parseHulusportMatch(FIXTURE)!;
    expect(match).toMatchObject({
      id: 2281709,
      home: 'Netherlands',
      away: 'Greece',
      leagueId: 10156,
      leagueName: 'UEFA Nations League',
      sportTypeId: 79,
      expired: false,
      dropped: 0,
    });
    expect(match.kickoff.toISOString()).toBe('2026-11-13T19:45:00.000Z');
    const keys = match.markets.map((m) => `${m.type}:${m.line ?? ''}`).sort();
    expect(keys).toEqual(
      [
        '1x2:',
        'btts:',
        'dc:',
        'dnb:',
        'eh:-1',
        'eh:-2',
        'eh:-3',
        'eh:1',
        'eh:2',
        'ht_1x2:',
        'ou:0.5',
        'ou:1.5',
        'ou:2.5',
        'ou:3.5',
        'ou:4.5',
        'ou:5.5',
      ].sort(),
    );
    // Correct score and odd/even are not offered from this source.
    expect(match.markets.some((m) => m.type === 'cs')).toBe(false);
  });

  it('keeps every selection in Vamos display order with Hulusport prices in milli', () => {
    const match = parseHulusportMatch(FIXTURE)!;
    const x12 = match.markets.find((m) => m.type === '1x2')!;
    expect(x12.prices).toEqual([
      { code: '1', priceMilli: 1480 },
      { code: 'X', priceMilli: 4700 },
      { code: '2', priceMilli: 5800 },
    ]);
    for (const market of match.markets) {
      expect(market.prices.map((p) => p.code)).toEqual(selectionsFor(market.type));
    }
  });

  it('reads "a:b" as the home side starting a goals ahead, so 0:1 is home -1', () => {
    const match = parseHulusportMatch(FIXTURE)!;
    const minusOne = match.markets.find((m) => m.type === 'eh' && m.line === '-1')!;
    const x12 = match.markets.find((m) => m.type === '1x2')!;
    // Giving a goal away makes the home win dearer.
    expect(minusOne.prices[0]!.priceMilli).toBeGreaterThan(x12.prices[0]!.priceMilli);
  });

  it('drops a market with an unavailable, missing or unpriced selection', () => {
    for (const spoil of [
      (o: Doc['items'][number]['odds'][number]) => (o.is_available = false),
      (o: Doc['items'][number]['odds'][number]) => (o.odd = 'n/a'),
      (o: Doc['items'][number]['odds'][number]) => (o.odd = 1),
    ]) {
      const doc = fixture();
      const item = doc.items.find((i) => i.bet_group.name === '3 Way')!;
      spoil(item.odds[0]!);
      const match = parse(doc)!;
      expect(match.markets.some((m) => m.type === '1x2')).toBe(false);
      expect(match.dropped).toBe(1);
    }
    const doc = fixture();
    doc.items.find((i) => i.bet_group.name === 'Both teams to score')!.odds.pop();
    expect(parse(doc)!.markets.some((m) => m.type === 'btts')).toBe(false);
  });

  it('drops whole, quarter and level lines, and both copies of a duplicated market', () => {
    const doc = fixture();
    const ou = doc.items.find((i) => i.bet_group.name === 'Over/Under')!;
    ou.specifier = { total: '2.25' };
    const hcp = doc.items.find((i) => i.bet_group.name === 'Handicap {hcp}')!;
    hcp.specifier = { hcp: '1:1' };
    doc.items.push(structuredClone(doc.items.find((i) => i.bet_group.name === 'Draw no bet')!));
    const match = parse(doc)!;
    expect(match.markets.some((m) => m.type === 'dnb')).toBe(false);
    expect(match.dropped).toBe(4);
  });

  it('marks an expired or inactive match', () => {
    expect(parse({ ...fixture(), expired: true })!.expired).toBe(true);
    expect(parse({ ...fixture(), is_active: false })!.expired).toBe(true);
  });

  it('returns null for anything that is not a match, and never throws', () => {
    expect(parseHulusportMatch('not json')).toBeNull();
    expect(parseHulusportMatch('[]')).toBeNull();
    expect(parse({ ...fixture(), schedule: '13/11/2026' })).toBeNull();
    expect(parse({ ...fixture(), awy: 'Netherlands' })).toBeNull();
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        parseHulusportMatch(JSON.stringify(value));
      }),
    );
  });
});

describe('parseMrxBoard', () => {
  const board = (matches: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      generated_at: '2026-11-13T18:00:00.000Z',
      worker: { last_success_at: '2026-11-13T17:55:00.000Z', backoff_until: null },
      matches,
      ...extra,
    });

  it('reads each match with when mr-x last read its odds, and the league group', () => {
    const match = {
      ...fixture(),
      odds_checked_at: '2026-11-13T17:52:00.000Z',
      league: { id: 10156, name: 'UEFA Nations League', sport_type: 79, group: 'International' },
    };
    const parsed = parseMrxBoard(board([match, { id: 'broken' }]))!;
    expect(parsed.generatedAt.toISOString()).toBe('2026-11-13T18:00:00.000Z');
    expect(parsed.lastSuccessAt?.toISOString()).toBe('2026-11-13T17:55:00.000Z');
    expect(parsed.rejected).toBe(1);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toMatchObject({
      id: 2281709,
      leagueName: 'UEFA Nations League',
      leagueGroup: 'International',
    });
    expect(parsed.matches[0]!.pricesAt?.toISOString()).toBe('2026-11-13T17:52:00.000Z');
    expect(parsed.matches[0]!.markets.length).toBeGreaterThan(10);
  });

  it('has no price time for a match whose odds were never read', () => {
    const parsed = parseMrxBoard(board([{ ...fixture(), odds_checked_at: null }]))!;
    expect(parsed.matches[0]!.pricesAt).toBeNull();
  });

  it('returns null for anything that is not a board', () => {
    expect(parseMrxBoard('[]')).toBeNull();
    expect(parseMrxBoard(JSON.stringify({ matches: [] }))).toBeNull();
    expect(parseMrxBoard(board([], { generated_at: 'yesterday' }))).toBeNull();
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        parseMrxBoard(JSON.stringify(value));
      }),
    );
  });
});

describe('parseHulusportMatchList', () => {
  it('reads an array or a page of results, skipping bad rows', () => {
    const rows = [
      { id: 1, hom: 'A', awy: 'B', schedule: '2026-11-14T16:00:00+03:00', league: { id: 7 } },
      { id: 2, hom: 'C', awy: 'D', schedule: '2026-11-14T18:00:00+03:00', league: 8 },
      { id: 3, hom: 'E', awy: 'E', schedule: '2026-11-14T18:00:00+03:00' },
      { id: 'x', hom: 'F', awy: 'G', schedule: '2026-11-14T18:00:00+03:00' },
    ];
    const list = parseHulusportMatchList(JSON.stringify(rows))!;
    expect(list.map((m) => [m.id, m.leagueId])).toEqual([
      [1, 7],
      [2, 8],
    ]);
    expect(parseHulusportMatchList(JSON.stringify({ results: rows }))).toHaveLength(2);
    expect(parseHulusportMatchList('{"detail":"throttled"}')).toBeNull();
  });
});

describe('parseHulusportCoredata', () => {
  it('finds football and names each league with its group', () => {
    const core = parseHulusportCoredata(
      JSON.stringify({
        sport_types: [
          { id: 227, name: 'American Football' },
          { id: 79, name: 'Soccer' },
        ],
        league_groups: [{ id: 739, name: 'International' }],
        leagues: [
          { id: 10156, name: 'UEFA Nations League', sport_type: 79, league_group: 739 },
          { id: 10280, name: 'NCAA, Regular Season', sport_type: { id: 227 }, league_group: 848 },
          { id: 'bad' },
        ],
      }),
    )!;
    expect(core.footballSportTypeId).toBe(79);
    expect(core.leagues.get(10156)).toEqual({
      id: 10156,
      name: 'UEFA Nations League',
      sportTypeId: 79,
      group: 'International',
    });
    expect(core.leagues.get(10280)).toMatchObject({ sportTypeId: 227, group: null });
    expect(core.leagues.size).toBe(2);
    expect(parseHulusportCoredata('{"leagues":[]}')).toBeNull();
  });
});
