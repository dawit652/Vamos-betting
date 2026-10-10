import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { LiveProvider } from '@/components/sportsbook/LiveProvider';
import { MatchList } from '@/components/sportsbook/MatchList';
import { Pager } from '@/components/sportsbook/SportHome';
import { listHref, parseCursor } from '@/components/sportsbook/tabs';
import { streamEventIds } from '@/components/sportsbook/events';
import { getLocale, getT } from '@/i18n/server';
import { getCompetitions, getEvents } from '@/lib/api/catalog';
import { localName } from '@/lib/localized';
import { isSport, routes, type Sport } from '@/lib/routes';

const PAGE_SIZE = 20;

/** The competition and its category, or null when the sport has no such competition. */
const findCompetition = cache(async (sport: Sport, slug: string) => {
  const data = await getCompetitions(sport);
  for (const category of data?.items ?? []) {
    const competition = category.competitions.find((c) => c.slug === slug);
    if (competition !== undefined) return { category: category.category, competition };
  }
  return null;
});

async function load(props: PageProps<'/sport/[sport]/[competition]'>) {
  const { sport, competition: slug } = await props.params;
  if (!isSport(sport)) return null;
  const found = await findCompetition(sport, slug);
  return found === null ? null : { sport, ...found };
}

export async function generateMetadata(
  props: PageProps<'/sport/[sport]/[competition]'>,
): Promise<Metadata> {
  const [found, locale] = await Promise.all([load(props), getLocale()]);
  return found === null ? {} : { title: localName(found.competition.name, locale) };
}

/** A competition: its live matches, then upcoming ones (paged with `?cursor=`). */
export default async function CompetitionPage(props: PageProps<'/sport/[sport]/[competition]'>) {
  const [found, searchParams, t, locale] = await Promise.all([
    load(props),
    props.searchParams,
    getT(),
    getLocale(),
  ]);
  if (found === null) notFound();
  const { sport, competition, category } = found;
  const cursor = parseCursor(searchParams.cursor);
  const base = { sport, competition: competition.slug, limit: PAGE_SIZE };
  const [live, upcoming] = await Promise.all([
    cursor === undefined ? getEvents({ ...base, filter: 'live' }) : null,
    getEvents({ ...base, filter: 'upcoming', ...(cursor === undefined ? {} : { cursor }) }),
  ]);
  const path = routes.competition(sport, competition.slug);
  const liveEvents = live?.items ?? [];

  return (
    <>
      <header className="bg-surface px-3 py-2">
        <Link
          href={listHref(routes.sport(sport), 'leagues')}
          prefetch={false}
          className="text-xxs font-semibold text-brand"
        >
          ‹ {t('sportsbook.competition.allLeagues')}
        </Link>
        <p className="text-xxs text-muted uppercase">{localName(category.name, locale)}</p>
        <h1 className="text-base font-bold">{localName(competition.name, locale)}</h1>
      </header>
      {liveEvents.length > 0 ? (
        <section aria-labelledby="competition-live">
          <h2
            id="competition-live"
            className="px-3 pt-3 pb-1 text-xxs font-bold text-live uppercase"
          >
            {t('sportsbook.competition.live')}
          </h2>
          <LiveProvider eventIds={streamEventIds(liveEvents.map((e) => e.id))}>
            <MatchList events={liveEvents} showCompetition={false} />
          </LiveProvider>
        </section>
      ) : null}
      <section aria-labelledby="competition-upcoming">
        <h2
          id="competition-upcoming"
          className="px-3 pt-3 pb-1 text-xxs font-bold text-muted uppercase"
        >
          {t('sportsbook.competition.upcoming')}
        </h2>
        {upcoming.items.length === 0 ? (
          <p className="card m-3 text-center text-muted">{t('sportsbook.list.empty')}</p>
        ) : (
          <MatchList events={upcoming.items} showCompetition={false} />
        )}
        <Pager
          firstHref={cursor === undefined ? null : path}
          nextHref={
            upcoming.nextCursor === null
              ? null
              : `${path}?cursor=${encodeURIComponent(upcoming.nextCursor)}`
          }
        />
      </section>
    </>
  );
}
