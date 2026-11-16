import type { CompetitionsResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { splitLeagues } from './leagues';
import { panelLeagues } from './panel';

const data: CompetitionsResponse = {
  items: [
    {
      category: { slug: 'england', name: { en: 'England' }, countryCode: 'GB' },
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
  it('matches the desktop split and order, with links, counts and localized names', () => {
    const rows = panelLeagues(data, 'football', 'am');
    const split = splitLeagues(data);
    expect(rows.featured.map((r) => r.slug)).toEqual(split.featured.map((c) => c.slug));
    expect(rows.others.map((r) => r.slug)).toEqual(split.others.map((c) => c.slug));
    expect(rows.featured[0]).toMatchObject({
      href: '/sport/football/premier-league',
      name: 'ፕሪሚየር ሊግ',
      count: 10,
      flag: split.featured[0]!.flag,
    });
  });

  it('is empty without data', () => {
    expect(panelLeagues(null, 'football', 'en')).toEqual({ featured: [], others: [] });
  });
});
