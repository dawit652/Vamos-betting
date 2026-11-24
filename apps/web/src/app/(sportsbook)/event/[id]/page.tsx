import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache, type ReactNode } from 'react';
import { EventMarkets } from '@/components/sportsbook/EventMarkets';
import { teamFlagCodes } from '@/components/sportsbook/team-marks';
import { TeamIcon } from '@/components/sportsbook/TeamIcon';
import { LiveClock, LiveScore } from '@/components/sportsbook/LiveMatch';
import { LiveProvider, LiveStatusBar } from '@/components/sportsbook/LiveProvider';
import { SportsbookFrame } from '@/components/sportsbook/SportsbookFrame';
import { getLocale, getT } from '@/i18n/server';
import { getEvent } from '@/lib/api/catalog';
import { formatDayMonth, formatTime } from '@/lib/format';
import { localName } from '@/lib/localized';
import { isSport, routes } from '@/lib/routes';

/** One request per render: generateMetadata and the page share it. */
const loadEvent = cache((id: string) => getEvent(id));

export async function generateMetadata(props: PageProps<'/event/[id]'>): Promise<Metadata> {
  const { id } = await props.params;
  const [event, locale, t] = await Promise.all([loadEvent(id), getLocale(), getT()]);
  if (event === null) return {};
  return {
    title: t('sportsbook.match.versus', {
      home: localName(event.home.name, locale),
      away: localName(event.away.name, locale),
    }),
  };
}

/** Event page: poster header with clock and score, then every market in filterable cards. */
export default async function EventPage(props: PageProps<'/event/[id]'>) {
  const { id } = await props.params;
  const [event, t, locale] = await Promise.all([loadEvent(id), getT(), getLocale()]);
  if (event === null) notFound();

  const live = event.status === 'live';
  const following = live || event.status === 'scheduled';
  const sport = isSport(event.sport) ? event.sport : null;
  const home = localName(event.home.name, locale);
  const away = localName(event.away.name, locale);

  const flags = teamFlagCodes(event);
  const team = (name: string, side: (typeof event)['home'], code: string | null) => (
    <span className="flex min-w-0 flex-col items-center gap-1.5">
      <TeamIcon team={side} code={code} size="header" />
      <span className="w-full text-sm leading-tight font-bold break-words">{name}</span>
    </span>
  );

  const content = (
    <>
      <header className="poster mx-3 mt-3 p-4 lg:mx-0 lg:mt-0">
        <p className="flex items-center gap-2 text-xxs text-white/70">
          {sport !== null ? (
            <Link
              href={routes.competition(sport, event.competition.slug)}
              prefetch={false}
              className="flex min-w-0 items-center gap-1 font-semibold underline-offset-2 hover:underline"
            >
              <span aria-hidden="true">‹</span>
              <span className="truncate">
                {localName(event.competition.category, locale)} ·{' '}
                {localName(event.competition.name, locale)}
              </span>
            </Link>
          ) : null}
          <span className="ml-auto flex-none tabular-nums">
            {t('sportsbook.list.gameId', { id: event.gameId })}
          </span>
        </p>
        <h1 className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-center">
          {team(home, event.home, flags[0])}
          <span className="px-1 text-3xl leading-none font-black tabular-nums">
            {event.score !== null || live ? (
              <span className="whitespace-nowrap">
                <LiveScore eventId={event.id} side="home" initial={event.score?.home ?? 0} />
                <span className="px-1.5 text-white/70">:</span>
                <LiveScore eventId={event.id} side="away" initial={event.score?.away ?? 0} />
              </span>
            ) : (
              <span className="text-base font-bold text-white/70">{t('sportsbook.match.vs')}</span>
            )}
          </span>
          {team(away, event.away, flags[1])}
        </h1>
        <p className="mt-3 flex items-center justify-center gap-2 text-xxs">
          <LiveClock
            eventId={event.id}
            sport={event.sport}
            status={event.status}
            minute={event.liveMinute}
            period={event.period}
            className="rounded-full bg-white px-2 py-0.5 font-bold text-[#0a100e]"
          >
            <span className="rounded-full bg-white/15 px-2 py-0.5 font-semibold tabular-nums">
              {formatDayMonth(event.startTime)} · {formatTime(event.startTime, locale)}
            </span>
          </LiveClock>
          {event.htScore !== null ? (
            <span className="text-white/70">
              {t('sportsbook.match.htScore', {
                home: event.htScore.home,
                away: event.htScore.away,
              })}
            </span>
          ) : null}
        </p>
      </header>
      {following ? null : (
        <p className="mx-3 mt-3 rounded-xl bg-demo-bg px-3 py-2 text-center text-xs font-semibold text-demo-ink lg:mx-0">
          {t('sportsbook.match.bettingClosed')}
        </p>
      )}
      <EventMarkets event={event} />
    </>
  );

  const frame = (children: ReactNode) =>
    sport === null ? (
      children
    ) : (
      <SportsbookFrame sport={sport} live={live} competition={event.competition.slug}>
        {children}
      </SportsbookFrame>
    );

  if (!following) return frame(content);
  return frame(
    <LiveProvider eventIds={[event.id]} refreshMs={live ? 60_000 : 0}>
      <LiveStatusBar />
      {content}
    </LiveProvider>,
  );
}
