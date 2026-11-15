import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { EUROPE, WORLD, flagEmoji } from '@/lib/flag';
import { competitionFlags, featuredCompetitions } from './leagues';

const comp = (slug: string, eventCount: number, featured: boolean) => ({
  slug,
  name: { en: slug },
  eventCount,
  featured,
});
const category = (slug: string, competitions: ReturnType<typeof comp>[]) => ({
  category: { slug, name: { en: slug }, countryCode: null },
  competitions,
});

describe('featuredCompetitions', () => {
  it('keeps featured competitions with matches, in API order across categories', () => {
    const data: CompetitionsResponse = {
      items: [
        category('a', [comp('a1', 2, true), comp('a2', 5, false), comp('a3', 0, true)]),
        category('b', [comp('b1', 1, true)]),
        category('c', [comp('c1', 0, false)]),
      ],
    };
    expect(featuredCompetitions(data).map((c) => c.slug)).toEqual(['a1', 'b1']);
  });

  it('is empty without data', () => {
    expect(featuredCompetitions(null)).toEqual([]);
    expect(featuredCompetitions({ items: [] })).toEqual([]);
  });
});

describe('competitionFlags', () => {
  it('maps each competition slug to its flag emoji', () => {
    const data: CompetitionsResponse = {
      items: [
        {
          category: { slug: 'england', name: { en: 'England' }, countryCode: 'GB-ENG' },
          competitions: [comp('premier-league', 1, true)],
        },
        {
          category: { slug: 'international-clubs', name: { en: 'Clubs' }, countryCode: null },
          competitions: [comp('uefa-champions-league', 1, true)],
        },
        category('misc', [comp('mystery-cup', 1, false)]),
      ],
    };
    expect(competitionFlags(data)).toEqual({
      'premier-league': flagEmoji('GB-ENG'),
      'uefa-champions-league': EUROPE,
      'mystery-cup': WORLD,
    });
    expect(competitionFlags(null)).toEqual({});
  });
});
