import type { CompetitionsResponse } from '@vamos/contracts';
import { competitionFlag } from '@/lib/flag';

export type FeaturedCompetition = CompetitionsResponse['items'][number]['competitions'][number];

/** Featured competitions with matches, in the order the API returns them. */
export function featuredCompetitions(
  data: CompetitionsResponse | null | undefined,
): FeaturedCompetition[] {
  return (data?.items ?? []).flatMap((category) =>
    category.competitions.filter((c) => c.featured && c.eventCount > 0),
  );
}

export type SidebarLeague = FeaturedCompetition & { flag: string };

/**
 * The sidebar's leagues with matches, flag attached, split into the featured
 * ones (Top Leagues, and the phone rail) and the rest (More leagues, column only).
 * Both keep the API order.
 */
export function splitLeagues(data: CompetitionsResponse | null | undefined): {
  featured: SidebarLeague[];
  others: SidebarLeague[];
} {
  const featured: SidebarLeague[] = [];
  const others: SidebarLeague[] = [];
  for (const { category, competitions } of data?.items ?? []) {
    for (const c of competitions) {
      if (c.eventCount <= 0) continue;
      (c.featured ? featured : others).push({ ...c, flag: competitionFlag(c, category) });
    }
  }
  return { featured, others };
}

/** Flag emoji by competition slug: the flags of MatchList's league cards. */
export function competitionFlags(
  data: CompetitionsResponse | null | undefined,
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const { category, competitions } of data?.items ?? []) {
    for (const competition of competitions)
      flags[competition.slug] = competitionFlag(competition, category);
  }
  return flags;
}

type LeagueCategory = CompetitionsResponse['items'][number];

const INTERNATIONAL_SLUGS = new Set([
  'international',
  'world',
  'europe',
  'africa',
  'south-america',
  'asia',
]);

function isInternational(category: LeagueCategory['category']): boolean {
  return category.countryCode === null || INTERNATIONAL_SLUGS.has(category.slug.toLowerCase());
}

function collatorFor(locale: string): Intl.Collator {
  try {
    return new Intl.Collator(locale);
  } catch {
    return new Intl.Collator('en');
  }
}

/**
 * Categories for the Leagues tab: Ethiopia first, then international ones, then
 * every other country A-Z by its name in `locale`. Categories without matches
 * are dropped; competitions keep the API's order, which is the editorial tier order.
 */
export function orderLeagueCategories(
  items: readonly LeagueCategory[],
  locale: string,
): LeagueCategory[] {
  const collator = collatorFor(locale);
  const name = (c: LeagueCategory) => c.category.name[locale as 'en'] ?? c.category.name.en;
  const rank = (c: LeagueCategory) =>
    c.category.countryCode === 'ET' ? 0 : isInternational(c.category) ? 1 : 2;
  return items
    .map((c) => ({ ...c, competitions: c.competitions.filter((x) => x.eventCount > 0) }))
    .filter((c) => c.competitions.length > 0)
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      // Ethiopia and international groups keep the API order (stable sort).
      return rank(a) === 2 ? collator.compare(name(a), name(b)) : 0;
    });
}
