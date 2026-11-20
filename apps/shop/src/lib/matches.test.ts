import type { EventSummary } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { filterMatchesByTeam, sellableMatches } from './matches';

const NOW = Date.parse('2026-11-20T10:00:00Z');

function event(
  id: string,
  home: string,
  away: string,
  startTime: string,
  overrides: Partial<EventSummary> = {},
): EventSummary {
  return {
    id,
    gameId: id,
    sport: 'football',
    competition: { slug: 'x', name: { en: 'League' }, category: { en: 'Land' } },
    home: { id: `${id}h`, name: { en: home }, shortName: home.slice(0, 3) },
    away: { id: `${id}a`, name: { en: away }, shortName: away.slice(0, 3) },
    startTime,
    status: 'scheduled',
    liveMinute: null,
    period: null,
    score: null,
    mainMarket: {
      id: `${id}m`,
      type: '1x2',
      line: null,
      name: { en: '1X2' },
      status: 'open',
      selections: [],
    },
    marketCount: 0,
    ...overrides,
  };
}

describe('sellableMatches', () => {
  it('drops started, live and market-less matches and sorts by kick-off', () => {
    const list = [
      event('late', 'A', 'B', '2026-11-20T15:00:00Z'),
      event('soon', 'C', 'D', '2026-11-20T11:00:00Z'),
      event('started', 'E', 'F', '2026-11-20T09:00:00Z'),
      event('live', 'G', 'H', '2026-11-20T12:00:00Z', { status: 'live' }),
      event('nomarket', 'I', 'J', '2026-11-20T12:00:00Z', { mainMarket: null }),
      event('suspended', 'K', 'L', '2026-11-20T12:00:00Z', {
        mainMarket: { ...event('s', 'a', 'b', 'x').mainMarket!, status: 'suspended' },
      }),
    ];
    expect(sellableMatches(list, NOW).map((e) => e.id)).toEqual(['soon', 'late']);
  });

  it('drops a match that kicks off exactly now', () => {
    expect(sellableMatches([event('n', 'A', 'B', '2026-11-20T10:00:00Z')], NOW)).toEqual([]);
  });
});

describe('filterMatchesByTeam', () => {
  const list = [
    event('1', 'Saint George', 'Arsenal', '2026-11-20T11:00:00Z'),
    event('2', 'Chelsea', 'Fasil Kenema', '2026-11-20T12:00:00Z'),
  ];
  it('matches either team, ignoring case and spaces around', () => {
    expect(filterMatchesByTeam(list, ' george ').map((e) => e.id)).toEqual(['1']);
    expect(filterMatchesByTeam(list, 'FASIL').map((e) => e.id)).toEqual(['2']);
  });
  it('returns everything for an empty search and nothing for no match', () => {
    expect(filterMatchesByTeam(list, '  ')).toHaveLength(2);
    expect(filterMatchesByTeam(list, 'zzz')).toEqual([]);
  });
});
