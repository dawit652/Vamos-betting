import type { EventSummary } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { groupByCompetition, startsNewRound } from './groups';

const event = (id: string, slug: string): EventSummary =>
  ({
    id,
    competition: { slug, name: { en: slug }, category: { en: 'Country' } },
  }) as EventSummary;

describe('groupByCompetition', () => {
  it('returns no groups for no events', () => {
    expect(groupByCompetition([])).toEqual([]);
  });

  it('groups consecutive events of a competition and keeps order', () => {
    const groups = groupByCompetition([
      event('1', 'a'),
      event('2', 'a'),
      event('3', 'b'),
      event('4', 'a'),
    ]);
    expect(groups.map((g) => [g.slug, g.events.map((e) => e.id)])).toEqual([
      ['a', ['1', '2']],
      ['b', ['3']],
      ['a', ['4']],
    ]);
    expect(groups[0]?.name).toEqual({ en: 'a' });
    expect(groups[0]?.category).toEqual({ en: 'Country' });
  });
});

describe('startsNewRound (a gap between matchweeks)', () => {
  const at = (id: string, slug: string, startTime: string): EventSummary => ({
    ...event(id, slug),
    startTime,
  });

  it('splits Serie A of 23 Nov: Monday 30/11 to Friday 04/12, not within the weekend', () => {
    const round = [
      at('a', 'serie-a', '2026-11-27T19:45:00Z'),
      at('b', 'serie-a', '2026-11-29T11:30:00Z'),
      at('c', 'serie-a', '2026-11-30T19:45:00Z'),
      at('d', 'serie-a', '2026-12-04T19:45:00Z'),
    ];
    expect(round.map((e, i) => startsNewRound(round[i - 1], e))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('never splits two competitions, and two days apart is a new round', () => {
    expect(
      startsNewRound(
        at('a', 'serie-a', '2026-11-30T19:45:00Z'),
        at('b', 'laliga', '2026-12-04T19:45:00Z'),
      ),
    ).toBe(false);
    expect(
      startsNewRound(
        at('a', 'epl', '2026-12-26T15:00:00Z'),
        at('b', 'epl', '2026-12-28T15:00:00Z'),
      ),
    ).toBe(true);
  });
});
