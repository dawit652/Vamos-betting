import type { CompetitionsResponse } from '@vamos/contracts';

export type FeaturedCompetition = CompetitionsResponse['items'][number]['competitions'][number];

/** Featured competitions with matches, in the order the API returns them. */
export function featuredCompetitions(
  data: CompetitionsResponse | null | undefined,
): FeaturedCompetition[] {
  return (data?.items ?? []).flatMap((category) =>
    category.competitions.filter((c) => c.featured && c.eventCount > 0),
  );
}
