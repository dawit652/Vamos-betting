import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { EUROPE, WORLD, flagEmoji } from '@/lib/flag';
import { competitionFlags, featuredCompetitions, orderLeagueCategories } from './leagues';

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

describe('orderLeagueCategories', () => {
  const cat = (slug: string, countryCode: string | null, name: string, counts: number[] = [1]) => ({
    category: { slug, name: { en: name }, countryCode },
    competitions: counts.map((n, i) => comp(`${slug}-${i}`, n, false)),
  });

  it('puts Ethiopia first, international next, then the rest A-Z', () => {
    const items = [
      cat('spain', 'ES', 'Spain'),
      cat('england', 'GB-ENG', 'England'),
      cat('europe', 'EU', 'Europe'),
      cat('world', null, 'World'),
      cat('ethiopia', 'ET', 'Ethiopia'),
      cat('brazil', 'BR', 'Brazil'),
    ];
    expect(orderLeagueCategories(items, 'en').map((c) => c.category.slug)).toEqual([
      'ethiopia',
      'europe',
      'world',
      'brazil',
      'england',
      'spain',
    ]);
  });

  it('keeps competition order and drops categories with no matches', () => {
    const items = [cat('italy', 'IT', 'Italy', [3, 1, 2]), cat('peru', 'PE', 'Peru', [0])];
    const out = orderLeagueCategories(items, 'en');
    expect(out.map((c) => c.category.slug)).toEqual(['italy']);
    expect(out[0]?.competitions.map((c) => c.slug)).toEqual(['italy-0', 'italy-1', 'italy-2']);
  });

  it('falls back to en for an invalid locale and handles empty input', () => {
    expect(orderLeagueCategories([], 'en')).toEqual([]);
    const items = [cat('b', 'BB', 'B'), cat('a', 'AA', 'A')];
    expect(orderLeagueCategories(items, 'not a locale').map((c) => c.category.slug)).toEqual([
      'a',
      'b',
    ]);
  });
});
