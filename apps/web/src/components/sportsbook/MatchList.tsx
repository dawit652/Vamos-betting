import type { EventSummary } from '@vamos/contracts';
import type { Locale } from '@vamos/i18n';
import type { Translator } from '@vamos/i18n/translate';
import Link from 'next/link';
import { getLocale, getT } from '@/i18n/server';
import { formatDayMonth, formatTime, relativeDay } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { eventRef, groupByCompetition, monogram, oddsMarket } from './events';
import { LiveClock, LiveScore } from './LiveMatch';
import { MarketOdds } from './MarketOdds';

/**
 * Server-rendered match rows: kick-off (East Africa Time) or live clock, Game
 * ID, a "+N" link to the event page, teams (with the score when live) and the
 * main market's odds buttons. By default the rows are grouped into one
 * collapsible card per league (native <details>, no JavaScript); `grouped={false}`
 * gives one flat card (a competition page, where the league is the page).
 * Only the odds buttons and the live clock/score are client islands.
 */
export async function MatchList({
  events,
  grouped = true,
}: {
  events: readonly EventSummary[];
  grouped?: boolean;
}) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const now = new Date();
  const row = (event: EventSummary) => (
    <MatchRow key={event.id} event={event} t={t} locale={locale} now={now} />
  );
  if (!grouped) {
    return <ul className="panel mx-3 lg:mx-0">{events.map(row)}</ul>;
  }
  return (
    <div className="space-y-3 px-3 lg:px-0">
      {groupByCompetition(events).map((group) => (
        <details key={group.slug} open className="group panel">
          <summary className="flex items-center gap-2 border-b border-line bg-raised px-3 py-2">
            <span aria-hidden="true" className="tag">
              {monogram(group.competition.category.en)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-xs text-muted">
                {localName(group.competition.category, locale)} ·{' '}
              </span>
              <Link
                href={routes.competition(group.events[0]?.sport ?? 'football', group.slug)}
                prefetch={false}
                className="font-bold underline-offset-2 hover:underline"
              >
                {localName(group.competition.name, locale)}
              </Link>
            </span>
            <span className="rounded-full bg-raised px-2 text-xxs font-bold text-muted tabular-nums">
              {group.events.length}
            </span>
            <Chevron />
          </summary>
          <ul>{group.events.map(row)}</ul>
        </details>
      ))}
    </div>
  );
}

function MatchRow({
  event,
  t,
  locale,
  now,
}: {
  event: EventSummary;
  t: Translator;
  locale: Locale;
  now: Date;
}) {
  const href = routes.event(event.id);
  const live = event.status === 'live';
  const day = relativeDay(event.startTime, now);
  return (
    <li className="list-row">
      <div className="flex items-center gap-1.5 text-xxs whitespace-nowrap text-muted">
        {live ? (
          <span className="flex items-center gap-1 rounded-full bg-raised px-1.5">
            <span aria-hidden="true" className="live-dot" />
            <LiveClock
              eventId={event.id}
              sport={event.sport}
              status={event.status}
              minute={event.liveMinute}
              period={event.period}
            />
          </span>
        ) : (
          <>
            <span className="text-xs font-bold text-ink tabular-nums">
              {formatTime(event.startTime, locale)}
            </span>
            <span className="tabular-nums">
              {day === 'today'
                ? t('sportsbook.tabs.today')
                : day === 'tomorrow'
                  ? t('sportsbook.list.tomorrow')
                  : formatDayMonth(event.startTime)}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{t('sportsbook.list.gameId', { id: event.gameId })}</span>
        <Link
          href={href}
          prefetch={false}
          className="ml-auto rounded-full bg-raised px-2 font-bold text-brand"
          aria-label={t('sportsbook.markets.more', { count: event.marketCount })}
        >
          {event.marketCount > 0 ? `+${event.marketCount} ›` : '›'}
        </Link>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Link href={href} prefetch={false} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 leading-5 font-semibold">
            <span className="block truncate">{localName(event.home.name, locale)}</span>
            <span className="block truncate">{localName(event.away.name, locale)}</span>
          </span>
          {live ? (
            <span className="flex flex-col text-right leading-5 font-extrabold text-live tabular-nums">
              <LiveScore eventId={event.id} side="home" initial={event.score?.home ?? null} />
              <LiveScore eventId={event.id} side="away" initial={event.score?.away ?? null} />
            </span>
          ) : null}
        </Link>
        <div className="flex w-[10.75rem] flex-none sm:w-60">
          {event.mainMarket !== null ? (
            <MarketOdds
              event={eventRef(event)}
              market={oddsMarket(event.mainMarket)}
              layout="row"
            />
          ) : (
            <span className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-raised text-xxs text-muted">
              {t('sportsbook.markets.suspended')}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** Points down; turns up while its <details class="group"> is open. */
export function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none text-muted transition-transform group-open:rotate-180"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
