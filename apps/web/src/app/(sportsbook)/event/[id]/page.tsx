import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { EventMarkets } from '@/components/sportsbook/EventMarkets';
import { LiveClock, LiveScore } from '@/components/sportsbook/LiveMatch';
import { LiveProvider, LiveStatusBar } from '@/components/sportsbook/LiveProvider';
import { getLocale, getT } from '@/i18n/server';
import { getEvent } from '@/lib/api/catalog';
import { formatDayMonth, formatTime } from '@/lib/format';
import { localName } from '@/lib/localized';
import { isSport, routes } from '@/lib/routes';

/** One request per render: generateMetadata and the page share it. */
const loadEvent = cache((id: string) => getEvent(id));

export async function generateMetadata(props: PageProps<'/event/[id]'>): Promise<Metadata> {
  const { id } = await props.params;
  const [event, locale] = await Promise.all([loadEvent(id), getLocale()]);
  if (event === null) return {};
  return {
    title: `${localName(event.home.name, locale)} v ${localName(event.away.name, locale)}`,
  };
}

/** Event page: header with clock and score, then every market in accordions. */
export default async function EventPage(props: PageProps<'/event/[id]'>) {
  const { id } = await props.params;
  const [event, t, locale] = await Promise.all([loadEvent(id), getT(), getLocale()]);
  if (event === null) notFound();

  const live = event.status === 'live';
  const following = live || event.status === 'scheduled';
  const sport = isSport(event.sport) ? event.sport : null;
  const home = localName(event.home.name, locale);
  const away = localName(event.away.name, locale);

  const content = (
    <>
      <header className="bg-brand-strong px-3 py-3 text-brand-ink">
        <p className="flex items-center gap-1.5 text-xxs opacity-90">
          {sport !== null ? (
            <Link
              href={routes.competition(sport, event.competition.slug)}
              prefetch={false}
              className="truncate underline-offset-2 hover:underline"
            >
              {localName(event.competition.category, locale)} ·{' '}
              {localName(event.competition.name, locale)}
            </Link>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="flex-none tabular-nums">
            {t('sportsbook.list.gameId', { id: event.gameId })}
          </span>
        </p>
        <h1 className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center font-bold">
          <span className="break-words">{home}</span>
          <span className="flex flex-col items-center text-lg tabular-nums">
            {event.score !== null || live ? (
              <span>
                <LiveScore eventId={event.id} side="home" initial={event.score?.home ?? 0} /> -{' '}
                <LiveScore eventId={event.id} side="away" initial={event.score?.away ?? 0} />
              </span>
            ) : (
              <span className="text-sm opacity-80">v</span>
            )}
          </span>
          <span className="break-words">{away}</span>
        </h1>
        <p className="mt-1 text-center text-xxs">
          <LiveClock
            eventId={event.id}
            sport={event.sport}
            status={event.status}
            minute={event.liveMinute}
            period={event.period}
            className="rounded-sm bg-surface px-1.5 py-0.5 text-ink"
          >
            <span className="tabular-nums">
              {formatDayMonth(event.startTime)} {formatTime(event.startTime, locale)}
            </span>
          </LiveClock>
          {event.htScore !== null ? (
            <span className="ml-2 opacity-80">
              {t('sportsbook.match.htScore', {
                home: event.htScore.home,
                away: event.htScore.away,
              })}
            </span>
          ) : null}
        </p>
      </header>
      {following ? null : (
        <p className="bg-demo-bg px-3 py-1.5 text-center text-xxs text-demo-ink">
          {t('sportsbook.match.bettingClosed')}
        </p>
      )}
      <EventMarkets event={event} />
    </>
  );

  if (!following) return content;
  return (
    <LiveProvider eventIds={[event.id]} refreshMs={live ? 60_000 : 0}>
      <LiveStatusBar />
      {content}
    </LiveProvider>
  );
}
