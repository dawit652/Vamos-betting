import type { EventSummary } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { groupByCompetition } from './groups';

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
