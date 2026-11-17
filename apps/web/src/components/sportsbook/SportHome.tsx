import type { EventSummary } from '@vamos/contracts';
import Link from 'next/link';
import type { Locale } from '@vamos/i18n';
import type { Translator } from '@vamos/i18n/translate';
import { getCompetitions, getEvents } from '@/lib/api/catalog';
import { getLocale, getT } from '@/i18n/server';
import type { LeagueMark } from '@/lib/badges';
import { flagEmoji } from '@/lib/flag';
import { formatDayMonth, formatTime, formatWeekday, relativeDay } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes, type Sport } from '@/lib/routes';
import { dayChips } from './day-chips';
import { eventRef, monogram, oddsMarket } from './events';
import { LeagueIcon } from './LeagueIcon';
import {
  competitionMarks,
  isBigMatch,
  leagueMark,
  orderLeagueCategories,
  topLeagues,
  type FeaturedCompetition,
} from './leagues';
import { LiveClock, LiveScore } from './LiveMatch';
import { MarketOdds } from './MarketOdds';
import { MatchList } from './MatchList';
import { SportsbookFrame } from './SportsbookFrame';
import {
  LIST_MARKETS,
  LIST_TABS,
  listHref,
  parseCountry,
  parseCursor,
  parseDay,
  parseMarket,
  parseTab,
  parseWithin,
  STARTS_WITHIN_HOURS,
  type ListFilters,
  type ListMarket,
  type ListTab,
} from './tabs';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Rows per page: each row costs about 0.3 KB brotli of HTML + RSC payload. 12
 * since the redesign (was 20): the featured poster and promo cards sit above the
 * list and the first load must stay within the page-weight budget
 * (e2e/tests/budget.spec.ts); "Next page" loads the rest.
 */
const PAGE_SIZE = 12;

/**
 * A sport's home (`/` for football, `/sport/[sport]`): Highlights / Today /
 * Upcoming / Leagues tabs (`?tab=`), with day chips, country chips and the
 * 1X2 / double chance switch (`?day=`, `?country=`, `?market=`), all rendered on
 * the server. The first page of Highlights opens with the featured-match poster
 * and the promo cards; the featured leagues are SportsbookFrame's leagues rail.
 */
export async function SportHome({
  sport,
  searchParams,
}: {
  sport: Sport;
  searchParams: SearchParams;
}) {
  const t = await getT();
  const tab = parseTab(searchParams.tab);
  const cursor = parseCursor(searchParams.cursor);
  const path = routes.sport(sport);
  const filters: ListFilters = {
    within: parseWithin(searchParams.within),
    day: parseDay(searchParams.day, new Date()),
    country: parseCountry(searchParams.country),
    market: parseMarket(searchParams.market),
  };
  return (
    <SportsbookFrame sport={sport} leagueRail>
      <h1 className="sr-only">
        {t(`common.sports.${sport}`)} · {t(`sportsbook.tabs.${tab}`)}
      </h1>
      {tab === 'leagues' ? (
        <>
          <ListTabs path={path} current={tab} filters={filters} />
          <Leagues sport={sport} />
        </>
      ) : (
        <EventsTab sport={sport} tab={tab} cursor={cursor} path={path} filters={filters} />
      )}
    </SportsbookFrame>
  );
}

/** Pill tabs; the active one is `aria-current="page"`. */
async function ListTabs({
  path,
  current,
  filters,
}: {
  path: string;
  current: ListTab;
  filters: ListFilters;
}) {
  const t = await getT();
  return (
    <nav
      aria-label={t('sportsbook.tabs.label')}
      className="mx-3 mb-3 flex gap-1 rounded-full border border-line bg-surface p-1 text-[0.8125rem] font-bold lg:mx-0"
    >
      {LIST_TABS.map((tab) => (
        <Link
          key={tab}
          href={listHref(path, tab, undefined, tabFilters(tab, filters))}
          prefetch={false}
          aria-current={tab === current ? 'page' : undefined}
          className={`flex-1 truncate rounded-full px-1 py-1.5 text-center ${
            tab === current ? 'bg-brand text-brand-ink' : 'text-muted'
          }`}
        >
          {t(`sportsbook.tabs.${tab}`)}
        </Link>
      ))}
    </nav>
  );
}

/** The filters a tab keeps: the day only means something on Today and Upcoming. */
function tabFilters(tab: ListTab, filters: ListFilters): ListFilters {
  return tab === 'today' || tab === 'upcoming' ? filters : { ...filters, day: undefined };
}

/** Day chips, country chips and the 1X2 / double chance switch, all plain links. */
async function ListControls({
  sport,
  tab,
  path,
  filters,
}: {
  sport: Sport;
  tab: Exclude<ListTab, 'leagues'>;
  path: string;
  filters: ListFilters;
}) {
  const [t, locale, data] = await Promise.all([getT(), getLocale(), getCompetitions(sport)]);
  const countries = (data?.items ?? []).filter((category) =>
    category.competitions.some((c) => c.eventCount > 0),
  );
  const href = (change: ListFilters) => listHref(path, tab, undefined, { ...filters, ...change });
  const days = tab === 'today' || tab === 'upcoming' ? dayChips(new Date()) : [];
  const market = filters.market ?? '1x2';
  return (
    <div className="mb-3 space-y-2">
      <nav aria-label={t('sportsbook.controls.within')} className="chip-row">
        {STARTS_WITHIN_HOURS.map((hours) => {
          const active = filters.within === hours;
          return (
            <Link
              key={hours}
              href={href({ within: active ? undefined : hours, day: undefined })}
              prefetch={false}
              aria-current={active ? 'true' : undefined}
              className="chip min-h-11"
            >
              {t('sportsbook.controls.withinHours', { hours })}
            </Link>
          );
        })}
      </nav>
      {days.length > 0 ? (
        <nav aria-label={t('sportsbook.controls.days')} className="chip-row">
          {days.map((chip) => {
            // Today's own list is the tab without a day.
            const active =
              filters.day === chip.date || (tab === 'today' && chip.offset === 0 && !filters.day);
            return (
              <Link
                key={chip.date}
                href={href({
                  within: undefined,
                  day: tab === 'today' && chip.offset === 0 ? undefined : chip.date,
                })}
                prefetch={false}
                aria-current={active ? 'true' : undefined}
                className="chip min-h-11"
              >
                {chip.offset === 0
                  ? t('sportsbook.controls.today')
                  : chip.offset === 1
                    ? t('sportsbook.controls.tomorrow')
                    : formatWeekday(chip.date, locale)}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {countries.length > 0 ? (
        <nav aria-label={t('sportsbook.controls.countries')} className="chip-row">
          <Link
            href={href({ country: undefined })}
            prefetch={false}
            aria-current={filters.country === undefined ? 'true' : undefined}
            className="chip min-h-11"
          >
            {t('sportsbook.controls.all')}
          </Link>
          {countries.map(({ category }) => (
            <Link
              key={category.slug}
              href={href({ country: category.slug })}
              prefetch={false}
              aria-current={filters.country === category.slug ? 'true' : undefined}
              className="chip min-h-11"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                {flagEmoji(category.countryCode)}
              </span>
              <span>{localName(category.name, locale)}</span>
            </Link>
          ))}
        </nav>
      ) : null}
      {sport === 'football' ? (
        <nav
          aria-label={t('sportsbook.controls.market')}
          className="mx-3 flex gap-1 rounded-full border border-line bg-surface p-1 text-[0.8125rem] font-bold lg:mx-0"
        >
          {LIST_MARKETS.map((value: ListMarket) => (
            <Link
              key={value}
              href={href({ market: value })}
              prefetch={false}
              aria-current={market === value ? 'true' : undefined}
              className={`flex min-h-9 flex-1 items-center justify-center rounded-full px-3 text-center ${
                market === value ? 'bg-brand text-brand-ink' : 'text-muted'
              }`}
            >
              {t(value === 'dc' ? 'sportsbook.controls.marketDc' : 'sportsbook.controls.market1x2')}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

async function EventsTab({
  sport,
  tab,
  cursor,
  path,
  filters,
}: {
  sport: Sport;
  tab: Exclude<ListTab, 'leagues'>;
  cursor: string | undefined;
  path: string;
  filters: ListFilters;
}) {
  const within = filters.within;
  const firstPage = tab === 'highlights' && cursor === undefined && within === undefined;
  const [t, fetched, competitions, candidates] = await Promise.all([
    getT(),
    getEvents({
      sport,
      filter: within === undefined ? tab : 'upcoming',
      limit: within === undefined ? PAGE_SIZE : 50,
      ...(within === undefined
        ? filters.day === undefined
          ? {}
          : { day: filters.day }
        : { startsWithinHours: within }),
      ...(filters.country === undefined ? {} : { country: filters.country }),
      ...(filters.market === 'dc' ? { market: 'dc' as const } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    getCompetitions(sport),
    firstPage ? bigMatchCandidates(sport) : Promise.resolve([]),
  ]);
  // An older API ignores startsWithinHours: cut the window here too, and stop paging
  // once anything was cut (later pages only start later).
  const limit = within === undefined ? null : Date.now() + within * 3_600_000;
  const items =
    limit === null ? fetched.items : fetched.items.filter((e) => Date.parse(e.startTime) < limit);
  const page = {
    items,
    nextCursor: items.length < fetched.items.length ? null : fetched.nextCursor,
  };
  const hrefFor = (next?: string) => listHref(path, tab, next, filters);
  const marks = competitionMarks(competitions);
  // The featured row: big matches only (top leagues, big nations), live ones first.
  const topSlugs = new Set(topLeagues(competitions, sport).map((c) => c.slug));
  const big = candidates
    .filter((event) => event.mainMarket !== null && isBigMatch(event, topSlugs))
    .slice(0, FEATURED_MAX);
  const events = page.items;
  return (
    <>
      {firstPage ? (
        <>
          {big.length > 0 ? <FeaturedRow events={big} marks={marks} /> : null}
          <div className="mx-3 mb-3 lg:mx-0">
            <Promos />
          </div>
        </>
      ) : null}
      <ListTabs path={path} current={tab} filters={filters} />
      <ListControls sport={sport} tab={tab} path={path} filters={filters} />
      {page.items.length === 0 ? (
        <div className="card mx-3 space-y-2 text-center text-muted lg:mx-0">
          <p>{t('sportsbook.list.empty')}</p>
          {cursor !== undefined ? (
            <Link href={hrefFor()} prefetch={false} className="btn btn-outline">
              {t('sportsbook.list.firstPage')}
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <MatchList events={events} grouped marks={marks} />
          <Pager
            firstHref={cursor === undefined ? null : hrefFor()}
            nextHref={page.nextCursor === null ? null : hrefFor(page.nextCursor)}
          />
        </>
      )}
    </>
  );
}

/** At most this many cards in the featured row (each one weighs on the page). */
const FEATURED_MAX = 8;

/** Live matches first, then the next 48 hours: where the featured row looks for big matches. */
async function bigMatchCandidates(sport: Sport): Promise<EventSummary[]> {
  const [live, upcoming] = await Promise.all([
    getEvents({ sport, filter: 'live', limit: 50 }).catch(() => null),
    getEvents({ sport, filter: 'upcoming', startsWithinHours: 48, limit: 100 }).catch(() => null),
  ]);
  const seen = new Set<string>();
  return [...(live?.items ?? []), ...(upcoming?.items ?? [])].filter((event) =>
    seen.has(event.id) ? false : (seen.add(event.id), true),
  );
}

/**
 * The featured row (owner, 17 Nov 2026): big matches of the top leagues and the big nations as
 * small cards that scroll sideways, instead of one large poster.
 */
async function FeaturedRow({
  events,
  marks,
}: {
  events: readonly EventSummary[];
  marks: Readonly<Record<string, LeagueMark>>;
}) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <section aria-labelledby="featured-title" className="mb-3">
      <h2 className="mx-3 mb-2 text-xxs lg:mx-0">
        <span
          id="featured-title"
          className="inline-block rounded-full bg-accent px-2 py-0.5 font-extrabold tracking-wider text-accent-ink uppercase"
        >
          ★ {t('sportsbook.list.featured')}
        </span>
      </h2>
      <ul className="no-scrollbar flex snap-x snap-mandatory scroll-px-3 gap-3 overflow-x-auto px-3 pb-1 lg:scroll-px-0 lg:px-0">
        {events.map((event) => (
          <FeaturedCard
            key={event.id}
            event={event}
            mark={marks[event.competition.slug]}
            locale={locale}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}

/** One card of the featured row: league, both teams, kick-off or live score, the main market. */
function FeaturedCard({
  event,
  mark,
  locale,
  t,
}: {
  event: EventSummary;
  mark: LeagueMark | undefined;
  locale: Locale;
  t: Translator;
}) {
  const day = relativeDay(event.startTime);
  const team = (side: EventSummary['home']) => (
    <span className="flex min-w-0 flex-col items-center gap-0.5">
      <span aria-hidden="true" className="crest h-7 w-7 text-[0.625rem]">
        {monogram(side.shortName)}
      </span>
      <span className="w-full truncate text-xs font-bold">{localName(side.name, locale)}</span>
    </span>
  );
  return (
    <li className="poster featured-card w-[12.5rem] flex-none snap-start p-2.5 lg:w-[13.5rem]">
      <p className="flex items-center gap-1.5 text-[0.625rem]">
        {mark !== undefined ? (
          <LeagueIcon flag={mark.flag} badge={mark.badge} className="text-xl leading-none" />
        ) : null}
        <span className="truncate font-semibold text-white/75">
          {localName(event.competition.name, locale)}
        </span>
      </p>
      <Link
        href={routes.event(event.id)}
        prefetch={false}
        className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 text-center"
      >
        {team(event.home)}
        {event.status === 'live' ? (
          <span className="px-0.5">
            <span className="block text-base leading-none font-black whitespace-nowrap tabular-nums">
              <LiveScore eventId={event.id} side="home" initial={event.score?.home ?? 0} />
              <span className="px-0.5 text-white/70">:</span>
              <LiveScore eventId={event.id} side="away" initial={event.score?.away ?? 0} />
            </span>
            <LiveClock
              eventId={event.id}
              sport={event.sport}
              status={event.status}
              minute={event.liveMinute}
              period={event.period}
              className="mt-1 inline-block rounded-full bg-white px-1.5 text-xxs font-bold text-[#0a100e]"
            />
          </span>
        ) : (
          <span className="px-0.5">
            <span className="block text-base leading-none font-black tabular-nums">
              {formatTime(event.startTime, locale)}
            </span>
            <span className="text-xxs font-semibold text-white/70">
              {day === 'today'
                ? t('sportsbook.controls.today')
                : day === 'tomorrow'
                  ? t('sportsbook.controls.tomorrow')
                  : formatDayMonth(event.startTime)}
            </span>
          </span>
        )}
        {team(event.away)}
      </Link>
      {event.mainMarket !== null ? (
        <div className="mt-1.5 flex">
          <MarketOdds event={eventRef(event)} market={oddsMarket(event.mainMarket)} layout="row" />
        </div>
      ) : null}
    </li>
  );
}

/** Two promo cards: the jackpot and the multi bonus (both explained on the jackpot page). */
async function Promos() {
  const t = await getT();
  const card = (tone: string, title: string, text: string) => (
    <Link
      href={routes.jackpot}
      prefetch={false}
      className={`poster ${tone} flex min-h-24 flex-col justify-between gap-2 p-3`}
    >
      <span className="text-xxs font-extrabold tracking-wider text-accent uppercase">
        {title} ›
      </span>
      <span className="text-[0.8125rem] leading-snug font-semibold text-white/70">{text}</span>
    </Link>
  );
  return (
    <div className="grid grid-cols-2 gap-3">
      {card('poster-gold', t('account.jackpot.title'), t('account.jackpot.promo.jackpot'))}
      {card('', t('account.jackpot.promo.title'), t('account.jackpot.promo.text'))}
    </div>
  );
}

/** "Back to the start" / "Next page" links of a cursor-paged list. */
export async function Pager({
  firstHref,
  nextHref,
}: {
  /** Set when this is not the first page. */
  firstHref: string | null;
  nextHref: string | null;
}) {
  if (nextHref === null && firstHref === null) return null;
  const t = await getT();
  return (
    <div className="flex justify-center gap-2 p-3">
      {firstHref !== null ? (
        <Link href={firstHref} prefetch={false} className="btn btn-outline">
          {t('sportsbook.list.firstPage')}
        </Link>
      ) : null}
      {nextHref !== null ? (
        <Link href={nextHref} prefetch={false} className="btn btn-primary">
          {t('sportsbook.list.nextPage')}
        </Link>
      ) : null}
    </div>
  );
}

async function Leagues({ sport }: { sport: Sport }) {
  const [t, locale, data] = await Promise.all([getT(), getLocale(), getCompetitions(sport)]);
  const categories = orderLeagueCategories(data?.items ?? [], locale);
  const top = topLeagues(data, sport);
  if (categories.length === 0) {
    return (
      <p className="card mx-3 text-center text-muted lg:mx-0">{t('sportsbook.leagues.empty')}</p>
    );
  }
  return (
    <div className="space-y-3 px-3 lg:px-0">
      {top.length > 0 ? (
        <section aria-labelledby="cat-top" className="panel">
          <h2 id="cat-top" className="border-b border-line bg-raised px-3 py-2 text-xs font-bold">
            {t('sportsbook.leagues.topLeagues')}
          </h2>
          <ul>
            {top.map((competition) => (
              <LeagueRow
                key={competition.slug}
                sport={sport}
                competition={competition}
                mark={competition}
                locale={locale}
                label={t('sportsbook.leagues.matches', { count: competition.eventCount })}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {categories.map((category) => (
        <section
          key={category.category.slug}
          aria-labelledby={`cat-${category.category.slug}`}
          className="panel"
        >
          <h2
            id={`cat-${category.category.slug}`}
            className="flex items-center gap-2 border-b border-line bg-raised px-3 py-2 text-xs font-bold"
          >
            <span aria-hidden="true" className="text-2xl leading-none">
              {flagEmoji(category.category.countryCode)}
            </span>
            {localName(category.category.name, locale)}
          </h2>
          <ul>
            {category.competitions.map((competition) => (
              <LeagueRow
                key={competition.slug}
                sport={sport}
                competition={competition}
                mark={leagueMark(competition, category.category)}
                locale={locale}
                label={t('sportsbook.leagues.matches', { count: competition.eventCount })}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LeagueRow({
  sport,
  competition,
  mark,
  locale,
  label,
}: {
  sport: Sport;
  competition: FeaturedCompetition;
  mark: LeagueMark;
  locale: Locale;
  label: string;
}) {
  return (
    <li>
      <Link
        href={routes.competition(sport, competition.slug)}
        prefetch={false}
        className="list-row flex items-center justify-between gap-2 font-semibold"
      >
        <span className="flex min-w-0 items-center gap-2">
          <LeagueIcon flag={mark.flag} badge={mark.badge} className="text-xl leading-none" />
          <span className="truncate">{localName(competition.name, locale)}</span>
        </span>
        <span className="flex-none text-xxs font-normal text-muted">{label} ›</span>
      </Link>
    </li>
  );
}
