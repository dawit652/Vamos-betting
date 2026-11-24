import Link from 'next/link';
import { getT } from '@/i18n/server';
import { getCompetitions, getEvents } from '@/lib/api/catalog';
import { routes, type Sport } from '@/lib/routes';
import { streamEventIds } from './events';
import { LiveProvider, LiveStatusBar } from './LiveProvider';
import { competitionMarks } from './leagues';
import { MatchList } from './MatchList';
import { SportsbookFrame } from './SportsbookFrame';
import { listHref } from './tabs';

/** The API's page limit and the live stream's filter limit. */
const LIVE_LIMIT = 50;

/**
 * A sport's live matches (`/live`, `/live/[sport]`), rendered on the server and
 * kept current by the live stream (odds, suspensions, clock and score) plus a
 * periodic refresh for matches that start or end.
 */
export async function LiveList({ sport }: { sport: Sport }) {
  const [t, page, competitions] = await Promise.all([
    getT(),
    getEvents({ sport, filter: 'live', limit: LIVE_LIMIT }),
    getCompetitions(sport).catch(() => null),
  ]);
  return (
    <SportsbookFrame sport={sport} live>
      <h1 className="flex items-center gap-2 px-3 pb-3 text-lg font-extrabold lg:px-0">
        <span aria-hidden="true" className="live-dot h-2 w-2" />
        {t('sportsbook.live.title')} · {t(`common.sports.${sport}`)}
      </h1>
      {page.items.length === 0 ? (
        <LiveProvider eventIds={[]}>
          <div className="card mx-3 space-y-3 py-8 text-center lg:mx-0">
            <p className="text-muted">{t('sportsbook.list.emptyLive')}</p>
            <Link
              href={listHref(routes.sport(sport), 'upcoming')}
              prefetch={false}
              className="btn btn-primary"
            >
              {t('sportsbook.list.seeUpcoming')}
            </Link>
          </div>
        </LiveProvider>
      ) : (
        <LiveProvider
          eventIds={streamEventIds(
            page.items.map((event) => event.id),
            LIVE_LIMIT,
          )}
        >
          <LiveStatusBar />
          <MatchList events={page.items} grouped marks={competitionMarks(competitions)} />
        </LiveProvider>
      )}
    </SportsbookFrame>
  );
}
