import type { CompetitionsResponse } from '@vamos/contracts';
import { leagueBadge, type LeagueMark } from '@/lib/badges';
import { competitionFlag } from '@/lib/flag';

export type FeaturedCompetition = CompetitionsResponse['items'][number]['competitions'][number];

/**
 * The major leagues players look for first, in this order (owner, 16 Nov 2026: "Premier League,
 * LaLiga, Serie A, Bundesliga, Champions League etc. at the top"). A league is recognised by its slug, or by
 * its English name in the right country (so the Ethiopian Premier League is not England's). A
 * major league with matches is a top league even when nobody marked it featured.
 */
const MAJOR_LEAGUES: readonly {
  slugs: readonly string[];
  names: readonly string[];
  country?: string;
}[] = [
  {
    slugs: ['premier-league', 'english-premier-league', 'england-premier-league'],
    names: ['premier league', 'english premier league'],
    country: 'GB-ENG',
  },
  {
    slugs: ['la-liga', 'laliga', 'spain-la-liga', 'primera-division-spain'],
    names: ['laliga', 'la liga'],
    country: 'ES',
  },
  { slugs: ['serie-a', 'italy-serie-a', 'italian-serie-a'], names: ['serie a'], country: 'IT' },
  { slugs: ['bundesliga', 'germany-bundesliga'], names: ['bundesliga'], country: 'DE' },
  {
    slugs: ['uefa-champions-league', 'champions-league'],
    names: ['uefa champions league', 'champions league'],
  },
  { slugs: ['ligue-1', 'france-ligue-1'], names: ['ligue 1'], country: 'FR' },
  {
    slugs: ['uefa-europa-league', 'europa-league'],
    names: ['uefa europa league', 'europa league'],
  },
  {
    slugs: ['uefa-conference-league', 'uefa-europa-conference-league', 'conference-league'],
    names: ['uefa conference league', 'uefa europa conference league'],
  },
  { slugs: ['fifa-world-cup', 'world-cup'], names: ['fifa world cup', 'world cup'] },
  {
    slugs: ['africa-cup-of-nations', 'afcon', 'caf-africa-cup-of-nations'],
    names: ['africa cup of nations'],
  },
  { slugs: ['caf-champions-league'], names: ['caf champions league'] },
  {
    slugs: ['ethiopian-premier-league', 'ethiopia-premier-league'],
    names: ['ethiopian premier league'],
    country: 'ET',
  },
  { slugs: ['eredivisie'], names: ['eredivisie'], country: 'NL' },
  {
    slugs: ['primeira-liga', 'liga-portugal'],
    names: ['primeira liga', 'liga portugal'],
    country: 'PT',
  },
  {
    slugs: ['championship', 'efl-championship'],
    names: ['championship', 'efl championship'],
    country: 'GB-ENG',
  },
  { slugs: ['nba'], names: ['nba'] },
  { slugs: ['euroleague'], names: ['euroleague'] },
];

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The position of a major league in MAJOR_LEAGUES (0 first), or null for any other league. */
export function majorLeagueRank(
  competition: { slug: string; name: { en: string } },
  category: { countryCode: string | null },
): number | null {
  const slug = competition.slug.toLowerCase();
  const name = normalized(competition.name.en);
  const country = category.countryCode?.toUpperCase() ?? null;
  for (const [rank, league] of MAJOR_LEAGUES.entries()) {
    if (league.slugs.includes(slug)) return rank;
    if (
      league.names.includes(name) &&
      (league.country === undefined || league.country === country)
    ) {
      return rank;
    }
  }
  return null;
}

export type SidebarLeague = FeaturedCompetition & LeagueMark;

/** The flag of a competition, and our badge when that flag is no country's (lib/badges). */
export function leagueMark(
  competition: { slug: string; name: { en: string } },
  category: { slug: string; countryCode: string | null },
): LeagueMark {
  const flag = competitionFlag(competition, category);
  return { flag, badge: leagueBadge(competition, flag) };
}

/**
 * The leagues with matches, flag and badge attached, split into the top leagues (the sidebar's Top
 * Leagues, the phone rail and panel, the Leagues tab's first section) and the rest (More
 * leagues). Top leagues: the major leagues first, in MAJOR_LEAGUES order, then the other
 * featured ones in API order. The rest keep the API order.
 */
export function splitLeagues(data: CompetitionsResponse | null | undefined): {
  featured: SidebarLeague[];
  others: SidebarLeague[];
} {
  const major: { rank: number; league: SidebarLeague }[] = [];
  const featured: SidebarLeague[] = [];
  const others: SidebarLeague[] = [];
  for (const { category, competitions } of data?.items ?? []) {
    for (const c of competitions) {
      if (c.eventCount <= 0) continue;
      const league = { ...c, ...leagueMark(c, category) };
      const rank = majorLeagueRank(c, category);
      if (rank !== null) major.push({ rank, league });
      else (c.featured ? featured : others).push(league);
    }
  }
  // Stable: two leagues of one rank (e.g. two "World Cup" competitions) keep the API order.
  major.sort((a, b) => a.rank - b.rank);
  return { featured: [...major.map((m) => m.league), ...featured], others };
}

/** The top leagues with matches (see splitLeagues): the major ones first, then the featured. */
export function featuredCompetitions(
  data: CompetitionsResponse | null | undefined,
): FeaturedCompetition[] {
  return splitLeagues(data).featured;
}

/** Flag and badge by competition slug: the marks of MatchList's league cards. */
export function competitionMarks(
  data: CompetitionsResponse | null | undefined,
): Record<string, LeagueMark> {
  const marks: Record<string, LeagueMark> = {};
  for (const { category, competitions } of data?.items ?? []) {
    for (const competition of competitions)
      marks[competition.slug] = leagueMark(competition, category);
  }
  return marks;
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
