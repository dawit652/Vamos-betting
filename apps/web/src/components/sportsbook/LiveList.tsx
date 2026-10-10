import Link from 'next/link';
import { getT } from '@/i18n/server';
import { getEvents } from '@/lib/api/catalog';
import { routes, type Sport } from '@/lib/routes';
import { streamEventIds } from './events';
import { LiveProvider, LiveStatusBar } from './LiveProvider';
import { MatchList } from './MatchList';
import { listHref } from './tabs';

/** The API's page limit and the live stream's filter limit. */
const LIVE_LIMIT = 50;

/**
 * A sport's live matches (`/live`, `/live/[sport]`), rendered on the server and
 * kept current by the live stream (odds, suspensions, clock and score) plus a
 * periodic refresh for matches that start or end.
 */
export async function LiveList({ sport }: { sport: Sport }) {
  const [t, page] = await Promise.all([
    getT(),
    getEvents({ sport, filter: 'live', limit: LIVE_LIMIT }),
  ]);
  return (
    <>
      <h1 className="sr-only">
        {t('sportsbook.live.title')} · {t(`common.sports.${sport}`)}
      </h1>
      {page.items.length === 0 ? (
        <LiveProvider eventIds={[]}>
          <div className="card m-3 space-y-3 text-center">
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
          <MatchList events={page.items} />
        </LiveProvider>
      )}
    </>
  );
}
