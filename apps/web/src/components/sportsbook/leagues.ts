import type { CompetitionsResponse } from '@vamos/contracts';
import { leagueBadge, type LeagueMark } from '@/lib/badges';
import { competitionFlag } from '@/lib/flag';
import type { Sport } from '@/lib/routes';

export type FeaturedCompetition = CompetitionsResponse['items'][number]['competitions'][number];

interface TopLeague {
  slugs: readonly string[];
  names: readonly string[];
  country?: string;
}

/**
 * The left column's Top Leagues: always these, in this order, even when a league has no match
 * right now (owner, 16 Nov 2026, showing Hulusport's column: "top leagues should exist even if
 * they don't have matches", every other league out of the column; Premier League, LaLiga, Serie A,
 * Bundesliga and the Champions League first, as asked earlier). A league is found in the
 * catalogue by its slug, or by its English name in the right country (so Greece's Super League is
 * not Switzerland's, nor Saudi Arabia's Pro League Belgium's). One the catalogue does not have
 * (Superettan until the Hulusport board brings a match) is left out. A sport without a list here
 * shows its featured leagues that have matches.
 */
const TOP_LEAGUES: Partial<Record<Sport, readonly TopLeague[]>> = {
  football: [
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
    {
      slugs: ['uefa-europa-league', 'europa-league'],
      names: ['uefa europa league', 'europa league'],
    },
    { slugs: ['ligue-1', 'france-ligue-1'], names: ['ligue 1'], country: 'FR' },
    { slugs: ['eredivisie'], names: ['eredivisie'], country: 'NL' },
    {
      slugs: ['primeira-liga', 'liga-portugal'],
      names: ['primeira liga', 'liga portugal'],
      country: 'PT',
    },
    {
      slugs: ['belgian-pro-league', 'jupiler-pro-league', 'pro-league'],
      names: ['pro league', 'belgian pro league', 'jupiler pro league'],
      country: 'BE',
    },
    {
      slugs: ['swiss-super-league', 'super-league-switzerland'],
      names: ['super league', 'swiss super league'],
      country: 'CH',
    },
    { slugs: ['superettan'], names: ['superettan'], country: 'SE' },
  ],
  basketball: [
    { slugs: ['nba'], names: ['nba'] },
    { slugs: ['euroleague'], names: ['euroleague'] },
  ],
};

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The position of a competition in the sport's Top Leagues (0 first) and whether it was found by
 * slug, or null when it is not a top league.
 */
export function topLeagueRank(
  sport: Sport,
  competition: { slug: string; name: { en: string } },
  category: { countryCode: string | null },
): { rank: number; bySlug: boolean } | null {
  const slug = competition.slug.toLowerCase();
  const name = normalized(competition.name.en);
  const country = category.countryCode?.toUpperCase() ?? null;
  for (const [rank, league] of (TOP_LEAGUES[sport] ?? []).entries()) {
    if (league.slugs.includes(slug)) return { rank, bySlug: true };
    if (
      league.names.includes(name) &&
      (league.country === undefined || league.country === country)
    ) {
      return { rank, bySlug: false };
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
 * The sport's Top Leagues, flag and badge attached: the left column, the phone panel and the
 * Leagues tab's first section. With a list in TOP_LEAGUES, exactly those leagues in that order,
 * with or without matches (one per entry: a slug match wins over a name match, then the first in
 * API order). Without one, the featured leagues that have matches, in API order.
 */
export function topLeagues(
  data: CompetitionsResponse | null | undefined,
  sport: Sport,
): SidebarLeague[] {
  const fixed = TOP_LEAGUES[sport] !== undefined;
  const found = new Map<number, { league: SidebarLeague; bySlug: boolean }>();
  const featured: SidebarLeague[] = [];
  for (const { category, competitions } of data?.items ?? []) {
    for (const c of competitions) {
      if (!fixed) {
        if (c.featured && c.eventCount > 0) featured.push({ ...c, ...leagueMark(c, category) });
        continue;
      }
      const top = topLeagueRank(sport, c, category);
      if (top === null) continue;
      const held = found.get(top.rank);
      if (held === undefined || (top.bySlug && !held.bySlug)) {
        found.set(top.rank, { league: { ...c, ...leagueMark(c, category) }, bySlug: top.bySlug });
      }
    }
  }
  if (!fixed) return featured;
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, { league }]) => league);
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
