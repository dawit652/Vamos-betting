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
