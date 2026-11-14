import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { LiveProvider } from '@/components/sportsbook/LiveProvider';
import { MatchList } from '@/components/sportsbook/MatchList';
import { Pager } from '@/components/sportsbook/SportHome';
import { listHref, parseCursor } from '@/components/sportsbook/tabs';
import { monogram, streamEventIds } from '@/components/sportsbook/events';
import { SportsbookFrame } from '@/components/sportsbook/SportsbookFrame';
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

  const heading = (id: string, text: string, tone: string) => (
    <h2
      id={id}
      className={`flex items-center gap-1.5 px-3 pt-4 pb-2 text-xxs font-bold tracking-wider uppercase lg:px-0 ${tone}`}
    >
      {text}
    </h2>
  );

  return (
    <SportsbookFrame sport={sport} competition={competition.slug}>
      <header className="poster mx-3 mt-1 flex items-center gap-3 p-4 lg:mx-0 lg:mt-0">
        <span aria-hidden="true" className="crest h-12 w-12 text-sm">
          {monogram(category.name.en)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xxs font-semibold text-white/75">{localName(category.name, locale)}</p>
          <h1 className="truncate text-lg leading-tight font-extrabold">
            {localName(competition.name, locale)}
          </h1>
        </div>
        <Link
          href={listHref(routes.sport(sport), 'leagues')}
          prefetch={false}
          className="flex-none rounded-full bg-white/15 px-3 py-1.5 text-xxs font-bold"
        >
          ‹ {t('sportsbook.competition.allLeagues')}
        </Link>
      </header>
      {liveEvents.length > 0 ? (
        <section aria-labelledby="competition-live">
          {heading('competition-live', t('sportsbook.competition.live'), 'text-live')}
          <LiveProvider eventIds={streamEventIds(liveEvents.map((e) => e.id))}>
            <MatchList events={liveEvents} grouped={false} />
          </LiveProvider>
        </section>
      ) : null}
      <section aria-labelledby="competition-upcoming">
        {heading('competition-upcoming', t('sportsbook.competition.upcoming'), 'text-muted')}
        {upcoming.items.length === 0 ? (
          <p className="card mx-3 text-center text-muted lg:mx-0">{t('sportsbook.list.empty')}</p>
        ) : (
          <MatchList events={upcoming.items} grouped={false} />
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
    </SportsbookFrame>
  );
}
