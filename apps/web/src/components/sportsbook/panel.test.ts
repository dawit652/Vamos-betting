import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { topLeagues } from './leagues';
import { panelLeagues } from './panel';

const data: CompetitionsResponse = {
  items: [
    {
      category: { slug: 'england', name: { en: 'England' }, countryCode: 'GB-ENG' },
      competitions: [
        {
          slug: 'premier-league',
          name: { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
          eventCount: 10,
          featured: true,
        },
        { slug: 'championship', name: { en: 'Championship' }, eventCount: 4, featured: false },
        { slug: 'empty', name: { en: 'Empty' }, eventCount: 0, featured: true },
      ],
    },
  ],
};

describe('panelLeagues', () => {
  it('matches the desktop Top Leagues and order, with links, counts and localized names', () => {
    const rows = panelLeagues(data, 'football', 'am');
    const top = topLeagues(data, 'football');
    expect(rows.featured.map((r) => r.slug)).toEqual(top.map((c) => c.slug));
    // Only the Top Leagues: no "More leagues" (owner, 16 Nov 2026).
    expect(rows.featured.map((r) => r.slug)).toEqual(['premier-league']);
    expect(rows).not.toHaveProperty('others');
    expect(rows.featured[0]).toMatchObject({
      href: '/sport/football/premier-league',
      name: 'ፕሪሚየር ሊግ',
      count: 10,
      flag: top[0]!.flag,
    });
  });

  it('is empty without data', () => {
    expect(panelLeagues(null, 'football', 'en')).toEqual({ featured: [] });
  });
});
