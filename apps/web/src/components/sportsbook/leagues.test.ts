import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { EUROPE, WORLD, flagEmoji } from '@/lib/flag';
import {
  competitionMarks,
  featuredCompetitions,
  majorLeagueRank,
  orderLeagueCategories,
  splitLeagues,
} from './leagues';

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

describe('splitLeagues', () => {
  it('splits featured from other leagues with matches, keeping order and adding flags', () => {
    const data: CompetitionsResponse = {
      items: [
        category('a', [comp('a1', 2, true), comp('a2', 5, false), comp('a3', 0, true)]),
        category('b', [comp('b1', 1, true), comp('b2', 3, false)]),
      ],
    };
    const { featured, others } = splitLeagues(data);
    expect(featured.map((c) => c.slug)).toEqual(['a1', 'b1']);
    expect(others.map((c) => c.slug)).toEqual(['a2', 'b2']);
    expect(featured[0]?.flag).toBe(WORLD);
    // No country flag and no logo: our drawn badge, the initials of the name.
    expect(featured[0]?.badge).toMatchObject({ kind: 'code', label: 'A1' });
    expect(featured).toHaveLength(featuredCompetitions(data).length);
  });

  it('is empty without data', () => {
    expect(splitLeagues(null)).toEqual({ featured: [], others: [] });
  });
});

describe('competitionMarks', () => {
  it('maps each competition slug to its flag, and a badge where the flag is no country', () => {
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
    expect(competitionMarks(data)).toEqual({
      'premier-league': { flag: flagEmoji('GB-ENG'), badge: null },
      'uefa-champions-league': {
        flag: EUROPE,
        badge: { kind: 'logo', src: '/league-logos/uefa-champions-league.png' },
      },
      'mystery-cup': { flag: WORLD, badge: expect.objectContaining({ kind: 'code', label: 'MC' }) },
    });
    expect(competitionMarks(null)).toEqual({});
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

describe('top leagues: the major ones first', () => {
  const named = (slug: string, en: string, eventCount: number, featured: boolean) => ({
    slug,
    name: { en },
    eventCount,
    featured,
  });
  const country = (code: string | null, competitions: ReturnType<typeof named>[]) => ({
    category: {
      slug: code ?? 'international',
      name: { en: code ?? 'International' },
      countryCode: code,
    },
    competitions,
  });

  it('puts Premier League, LaLiga, Serie A, Bundesliga and the Champions League first, then the other featured', () => {
    const data = {
      items: [
        country('CR', [named('primera-division', 'Primera División', 5, true)]),
        country('ET', [named('ethiopian-premier-league', 'Ethiopian Premier League', 6, true)]),
        country(null, [named('uefa-champions-league', 'UEFA Champions League', 13, true)]),
        country('ES', [named('la-liga', 'LaLiga', 7, true)]),
        country('IT', [named('serie-a', 'Serie A', 9, true)]),
        // Not marked featured, but a major league with matches: a top league anyway.
        country('GB-ENG', [named('premier-league', 'Premier League', 9, false)]),
        country('DE', [named('bundesliga', 'Bundesliga', 4, false)]),
        // No matches: not listed at all.
        country('FR', [named('ligue-1', 'Ligue 1', 0, true)]),
      ],
    };
    const { featured, others } = splitLeagues(data);
    expect(featured.map((c) => c.slug)).toEqual([
      'premier-league',
      'la-liga',
      'serie-a',
      'bundesliga',
      'uefa-champions-league',
      'ethiopian-premier-league',
      'primera-division',
    ]);
    expect(others).toEqual([]);
    // The Leagues tab's first section uses the same order.
    expect(featuredCompetitions(data).map((c) => c.slug)).toEqual(featured.map((c) => c.slug));
  });

  it('recognises a league by slug, or by name in the right country only', () => {
    expect(
      majorLeagueRank({ slug: 'premier-league', name: { en: 'x' } }, { countryCode: null }),
    ).toBe(0);
    expect(
      majorLeagueRank(
        { slug: 'epl-2026', name: { en: 'Premier League' } },
        { countryCode: 'GB-ENG' },
      ),
    ).toBe(0);
    // Another country's "Premier League" is not England's.
    expect(
      majorLeagueRank({ slug: 'eth-pl', name: { en: 'Premier League' } }, { countryCode: 'ET' }),
    ).toBeNull();
    expect(
      majorLeagueRank({ slug: 'bra-a', name: { en: 'Serie A' } }, { countryCode: 'BR' }),
    ).toBeNull();
    expect(
      majorLeagueRank({ slug: 'some-cup', name: { en: 'Some Cup' } }, { countryCode: 'ES' }),
    ).toBeNull();
  });
});
