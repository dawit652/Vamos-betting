import type { EventSummary } from '@vamos/contracts';
import type { Locale } from '@vamos/i18n';
import type { Translator } from '@vamos/i18n/translate';
import Link from 'next/link';
import { getLocale, getT } from '@/i18n/server';
import type { LeagueMark } from '@/lib/badges';
import { flagEmoji } from '@/lib/flag';
import { formatDayMonth, formatTime, relativeDay } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { eventRef, monogram, oddsMarket } from './events';
import { groupByCompetition } from './groups';
import { LeagueIcon } from './LeagueIcon';
import { leagueMark } from './leagues';
import { teamFlagCodes } from './team-marks';
import { Chevron } from './Chevron';
import { LiveClock, LiveScore } from './LiveMatch';
import { MarketOdds } from './MarketOdds';

/**
 * Server-rendered match rows: kick-off (East Africa Time, "Today" / "Tomorrow")
 * or live clock, Game ID, a "+N" link to the event page, teams (with the score
 * when live) and the main market's odds buttons (1X2 or double chance, as the
 * list asked the API for). Only the odds buttons and the live clock/score are
 * client islands.
 *
 * `grouped` puts collapsible league cards (flag, name, count; native <details>)
 * over runs of the same competition, keeping the page order; otherwise the rows
 * sit in one card, with the competition on each row unless `showCompetition` is
 * false (a competition page, where the league is the page).
 */
export async function MatchList({
  events,
  showCompetition = true,
  grouped = false,
  marks = {},
}: {
  events: readonly EventSummary[];
  showCompetition?: boolean;
  /** Collapsible league cards (flag, name, count) over runs of the same competition. */
  grouped?: boolean;
  /** Flag or badge by competition slug, for the league cards (competitionMarks). */
  marks?: Readonly<Record<string, LeagueMark>>;
}) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const now = new Date();
  const rows = (list: readonly EventSummary[], withCompetition: boolean) =>
    list.map((event) => (
      <MatchRow
        key={event.id}
        event={event}
        withCompetition={withCompetition}
        t={t}
        locale={locale}
        now={now}
      />
    ));
  if (!grouped) {
    return <ul className="panel mx-3 lg:mx-0">{rows(events, showCompetition)}</ul>;
  }
  return (
    <div className="space-y-3 px-3 lg:px-0">
      {groupByCompetition(events).map((group, index) => {
        const name = localName(group.name, locale);
        return (
          <details key={`${group.slug}-${index}`} open className="group panel">
            <summary
              aria-label={t('sportsbook.controls.league', { count: group.events.length, name })}
              className="flex min-h-11 items-center gap-2 border-b border-line bg-raised px-3"
            >
              <LeagueIcon
                {...(marks[group.slug] ??
                  leagueMark(
                    { slug: group.slug, name: group.name },
                    { slug: '', countryCode: null },
                  ))}
                className="text-2xl leading-none"
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-xs text-muted">{localName(group.category, locale)} · </span>
                <span className="font-bold">{name}</span>
              </span>
              <span className="rounded-full bg-surface px-2 text-xxs font-bold text-muted tabular-nums">
                {group.events.length}
              </span>
              <Chevron />
            </summary>
            <ul>{rows(group.events, false)}</ul>
          </details>
        );
      })}
    </div>
  );
}

function MatchRow({
  event,
  withCompetition,
  t,
  locale,
  now,
}: {
  event: EventSummary;
  withCompetition: boolean;
  t: Translator;
  locale: Locale;
  now: Date;
}) {
  const href = routes.event(event.id);
  const live = event.status === 'live';
  const day = relativeDay(event.startTime, now);
  const optionCount = event.optionCount ?? 0;
  const flags = teamFlagCodes(event);
  return (
    <li className="list-row">
      <div className="flex min-w-0 items-center gap-1.5 text-xxs whitespace-nowrap text-muted">
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
                ? t('sportsbook.controls.today')
                : day === 'tomorrow'
                  ? t('sportsbook.controls.tomorrow')
                  : formatDayMonth(event.startTime)}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{t('sportsbook.list.gameId', { id: event.gameId })}</span>
        {withCompetition ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {localName(event.competition.category, locale)} ·{' '}
              {localName(event.competition.name, locale)}
            </span>
          </>
        ) : null}
        <Link
          href={href}
          prefetch={false}
          className="ml-auto flex-none rounded-full bg-raised px-2 font-bold text-brand"
          aria-label={
            optionCount > 0
              ? t('sportsbook.markets.moreOptions', { count: optionCount })
              : t('sportsbook.markets.more', { count: event.marketCount })
          }
        >
          {optionCount > 0
            ? `${optionCount}+ ›`
            : event.marketCount > 0
              ? `+${event.marketCount} ›`
              : '›'}
        </Link>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Link href={href} prefetch={false} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 leading-7 font-semibold">
            <TeamLine team={event.home} code={flags[0]} locale={locale} />
            <TeamLine team={event.away} code={flags[1]} locale={locale} />
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

/** A team's name with its flag (national teams) or its initials crest (clubs) right after it. */
function TeamLine({
  team,
  code,
  locale,
}: {
  team: EventSummary['home'];
  code: string | null;
  locale: Locale;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{localName(team.name, locale)}</span>
      {code !== null ? (
        <span aria-hidden="true" className="flex-none text-xl leading-none">
          {flagEmoji(code)}
        </span>
      ) : (
        <span aria-hidden="true" className="crest h-6 w-6 flex-none text-[0.5rem]">
          {monogram(team.shortName)}
        </span>
      )}
    </span>
  );
}
