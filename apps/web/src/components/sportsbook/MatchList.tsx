import type { EventSummary } from '@vamos/contracts';
import Link from 'next/link';
import { getLocale, getT } from '@/i18n/server';
import { flagEmoji } from '@/lib/flag';
import { formatDayMonth, formatTime } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { groupByCompetition } from './groups';
import { eventRef, oddsMarket } from './events';
import { LiveClock, LiveScore } from './LiveMatch';
import { MarketOdds } from './MarketOdds';

/**
 * Server-rendered compact match rows (Betika style): Game ID, kick-off (East
 * Africa Time) or live clock, teams (with the score when live), the main
 * market's odds buttons and a "+N" link to the event page. Only the odds
 * buttons and the live clock/score are client islands.
 */
export async function MatchList({
  events,
  showCompetition = true,
  grouped = false,
  flags = {},
}: {
  events: readonly EventSummary[];
  showCompetition?: boolean;
  /** Collapsible league headers (flag, name, count) over runs of the same competition. */
  grouped?: boolean;
  /** Country code by competition slug, for the group headers' flags. */
  flags?: Readonly<Record<string, string | null>>;
}) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const rows = (list: readonly EventSummary[], withCompetition: boolean) => (
    <ul>
      {list.map((event) => {
        const href = routes.event(event.id);
        const live = event.status === 'live';
        const home = localName(event.home.name, locale);
        const away = localName(event.away.name, locale);
        return (
          <li key={event.id} className="list-row">
            <div className="flex min-w-0 items-center gap-1.5 text-xxs whitespace-nowrap text-muted">
              {live ? (
                <LiveClock
                  eventId={event.id}
                  sport={event.sport}
                  status={event.status}
                  minute={event.liveMinute}
                  period={event.period}
                />
              ) : (
                <span className="font-semibold text-ink tabular-nums">
                  {formatDayMonth(event.startTime)} {formatTime(event.startTime, locale)}
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {t('sportsbook.list.gameId', { id: event.gameId })}
              </span>
              {withCompetition ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="min-w-0 truncate">
                    {localName(event.competition.category, locale)} ·{' '}
                    {localName(event.competition.name, locale)}
                  </span>
                </>
              ) : null}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Link href={href} prefetch={false} className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 leading-5 font-semibold">
                  <span className="block truncate">{home}</span>
                  <span className="block truncate">{away}</span>
                </span>
                {live ? (
                  <span className="flex flex-col text-right leading-5 font-bold text-live tabular-nums">
                    <LiveScore eventId={event.id} side="home" initial={event.score?.home ?? null} />
                    <LiveScore eventId={event.id} side="away" initial={event.score?.away ?? null} />
                  </span>
                ) : null}
              </Link>
              <div className="flex w-[11.5rem] flex-none items-stretch gap-1">
                {event.mainMarket !== null ? (
                  <MarketOdds
                    event={eventRef(event)}
                    market={oddsMarket(event.mainMarket)}
                    layout="row"
                  />
                ) : (
                  <span className="flex flex-1 items-center justify-center rounded-sm bg-line text-xxs text-muted">
                    {t('sportsbook.markets.suspended')}
                  </span>
                )}
                <Link
                  href={href}
                  prefetch={false}
                  className="flex w-8 flex-none items-center justify-center rounded-sm border border-line text-xxs font-bold text-brand"
                  aria-label={t('sportsbook.markets.more', { count: event.marketCount })}
                >
                  {event.marketCount > 0 ? `+${event.marketCount}` : '›'}
                </Link>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
  if (!grouped) return rows(events, showCompetition);
  return (
    <div>
      {groupByCompetition(events).map((group, index) => {
        const name = localName(group.name, locale);
        return (
          <details key={`${group.slug}-${index}`} open className="group">
            <summary
              aria-label={t('sportsbook.controls.league', { count: group.events.length, name })}
              className="flex min-h-11 cursor-pointer list-none items-center gap-2 border-b border-line bg-page px-3 text-xs font-bold [&::-webkit-details-marker]:hidden"
            >
              <span aria-hidden="true">{flagEmoji(flags[group.slug])}</span>
              <span className="min-w-0 flex-1 truncate">
                {localName(group.category, locale)} · {name}
              </span>
              <span className="flex-none text-xxs font-normal text-muted tabular-nums">
                {group.events.length}
              </span>
              <span
                aria-hidden="true"
                className="flex-none text-muted transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </summary>
            {rows(group.events, false)}
          </details>
        );
      })}
    </div>
  );
}
