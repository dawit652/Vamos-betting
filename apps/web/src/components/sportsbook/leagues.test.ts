import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { EUROPE, WORLD, flagEmoji } from '@/lib/flag';
import { competitionMarks, orderLeagueCategories, topLeagueRank, topLeagues } from './leagues';

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

describe('topLeagues: a sport without a fixed list', () => {
  it('shows the featured leagues that have matches, in API order across categories', () => {
    const data: CompetitionsResponse = {
      items: [
        category('a', [comp('a1', 2, true), comp('a2', 5, false), comp('a3', 0, true)]),
        category('b', [comp('b1', 1, true)]),
      ],
    };
    const top = topLeagues(data, 'tennis');
    expect(top.map((c) => c.slug)).toEqual(['a1', 'b1']);
    expect(top[0]?.flag).toBe(WORLD);
    // No country flag and no logo: our drawn badge, the initials of the name.
    expect(top[0]?.badge).toMatchObject({ kind: 'code', label: 'A1' });
  });

  it('is empty without data', () => {
    expect(topLeagues(null, 'tennis')).toEqual([]);
    expect(topLeagues({ items: [] }, 'football')).toEqual([]);
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

describe('topLeagues: football, a fixed list like the Hulusport column', () => {
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

  it('always lists the top leagues in order, with or without matches, and nothing else', () => {
    const data = {
      items: [
        country('CR', [named('primera-division', 'Primera División', 5, true)]),
        country('ET', [named('ethiopian-premier-league', 'Ethiopian Premier League', 6, true)]),
        country(null, [
          named('uefa-champions-league', 'UEFA Champions League', 13, true),
          named('uefa-europa-league', 'UEFA Europa League', 0, false),
          named('caf-champions-league', 'CAF Champions League', 8, true),
        ]),
        country('ES', [named('laliga', 'LaLiga', 7, true)]),
        country('IT', [named('serie-a', 'Serie A', 9, true)]),
        country('GB-ENG', [
          named('premier-league', 'Premier League', 0, false),
          named('championship', 'EFL Championship', 12, true),
        ]),
        country('DE', [named('bundesliga', 'Bundesliga', 4, false)]),
        country('FR', [named('ligue-1', 'Ligue 1', 0, true)]),
        country('NL', [named('eredivisie', 'Eredivisie', 0, false)]),
        country('PT', [named('primeira-liga', 'Primeira Liga', 3, false)]),
        country('BE', [named('belgian-pro-league', 'Belgian Pro League', 0, false)]),
        country('CH', [named('swiss-super-league', 'Swiss Super League', 2, false)]),
        // A board league the catalogue got from Hulusport: found by name in its country.
        country('SE', [named('hl-1234', 'Superettan', 1, false)]),
      ],
    };
    const top = topLeagues(data, 'football');
    expect(top.map((c) => c.slug)).toEqual([
      'premier-league',
      'laliga',
      'serie-a',
      'bundesliga',
      'uefa-champions-league',
      'uefa-europa-league',
      'ligue-1',
      'eredivisie',
      'primeira-liga',
      'belgian-pro-league',
      'swiss-super-league',
      'hl-1234',
    ]);
    // No matches right now, still listed, with its count.
    expect(top[0]).toMatchObject({ slug: 'premier-league', eventCount: 0 });
    // Featured or busy leagues outside the list stay out of the column.
    for (const slug of ['ethiopian-premier-league', 'primera-division', 'championship']) {
      expect(top.map((c) => c.slug)).not.toContain(slug);
    }
  });

  it('leaves out a top league the catalogue does not have', () => {
    const data = { items: [country('ES', [named('laliga', 'LaLiga', 0, false)])] };
    expect(topLeagues(data, 'football').map((c) => c.slug)).toEqual(['laliga']);
  });

  it('takes one competition per top league, a slug match before a name match', () => {
    const data = {
      items: [
        country('GB-ENG', [named('hl-77', 'Premier League', 3, false)]),
        country('GB-ENG', [named('premier-league', 'Premier League', 0, false)]),
      ],
    };
    expect(topLeagues(data, 'football').map((c) => c.slug)).toEqual(['premier-league']);
  });

  it('recognises a league by slug, or by name in the right country only', () => {
    expect(
      topLeagueRank(
        'football',
        { slug: 'premier-league', name: { en: 'x' } },
        { countryCode: null },
      ),
    ).toEqual({ rank: 0, bySlug: true });
    expect(
      topLeagueRank(
        'football',
        { slug: 'epl-2026', name: { en: 'Premier League' } },
        { countryCode: 'GB-ENG' },
      ),
    ).toEqual({ rank: 0, bySlug: false });
    // Another country's league of the same name is not a top league.
    for (const [name, code] of [
      ['Premier League', 'ET'],
      ['Serie A', 'BR'],
      ['Super League', 'GR'],
      ['Pro League', 'SA'],
    ] as const) {
      expect(
        topLeagueRank('football', { slug: 'x', name: { en: name } }, { countryCode: code }),
        `${name} ${code}`,
      ).toBeNull();
    }
    expect(
      topLeagueRank(
        'football',
        { slug: 'some-cup', name: { en: 'Some Cup' } },
        { countryCode: 'ES' },
      ),
    ).toBeNull();
  });

  it('basketball has its own list: NBA and Euroleague', () => {
    const data = {
      items: [
        country('US', [named('nba', 'NBA', 0, false), named('ncaa', 'NCAA', 5, true)]),
        country(null, [named('euroleague', 'Euroleague', 2, false)]),
      ],
    };
    expect(topLeagues(data, 'basketball').map((c) => c.slug)).toEqual(['nba', 'euroleague']);
  });
});
