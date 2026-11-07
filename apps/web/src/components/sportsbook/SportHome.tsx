import Link from 'next/link';
import { getCompetitions, getEvents } from '@/lib/api/catalog';
import { getLocale, getT } from '@/i18n/server';
import { localName } from '@/lib/localized';
import { flagEmoji } from '@/lib/flag';
import { routes, type Sport } from '@/lib/routes';
import { featuredCompetitions } from './leagues';
import { MatchList } from './MatchList';
import { dayChips } from './day-chips';
import {
  LIST_MARKETS,
  LIST_TABS,
  listHref,
  parseCountry,
  parseCursor,
  parseDay,
  parseMarket,
  parseTab,
  type ListFilters,
  type ListMarket,
  type ListTab,
} from './tabs';
import { formatWeekday } from '@/lib/format';

type SearchParams = Record<string, string | string[] | undefined>;

/** Rows per page: each row costs about 0.5 KB gzip of HTML + RSC payload. */
const PAGE_SIZE = 20;

/**
 * A sport's home (`/` for football, `/sport/[sport]`): Highlights / Today /
 * Upcoming / Leagues tabs (`?tab=`), each rendered on the server.
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
    day: parseDay(searchParams.day, new Date()),
    country: parseCountry(searchParams.country),
    market: parseMarket(searchParams.market),
  };
  return (
    <>
      <h1 className="sr-only">
        {t(`common.sports.${sport}`)} · {t(`sportsbook.tabs.${tab}`)}
      </h1>
      <TopLeagues sport={sport} />
      <ListTabs path={path} current={tab} filters={filters} />
      {tab === 'leagues' ? (
        <Leagues sport={sport} />
      ) : (
        <>
          <ListControls sport={sport} tab={tab} path={path} filters={filters} />
          <EventsTab sport={sport} tab={tab} cursor={cursor} path={path} filters={filters} />
        </>
      )}
    </>
  );
}

/** Horizontally scrolling shortcuts to the featured competitions that have matches. */
async function TopLeagues({ sport }: { sport: Sport }) {
  const [t, locale, data] = await Promise.all([getT(), getLocale(), getCompetitions(sport)]);
  const featured = featuredCompetitions(data);
  if (featured.length === 0) return null;
  return (
    <nav
      aria-label={t('sportsbook.leagues.topLeagues')}
      className="flex gap-2 overflow-x-auto border-b border-line bg-surface px-3 py-2 text-sm"
    >
      {featured.map((competition) => (
        <Link
          key={competition.slug}
          href={routes.competition(sport, competition.slug)}
          prefetch={false}
          className="flex min-h-11 flex-none items-center gap-1.5 rounded-full border border-line px-3 font-semibold whitespace-nowrap"
        >
          <span>{localName(competition.name, locale)}</span>
          <span className="text-xxs font-normal text-muted">{competition.eventCount}</span>
        </Link>
      ))}
    </nav>
  );
}

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
      className="flex border-b border-line bg-surface text-sm font-semibold"
    >
      {LIST_TABS.map((tab) => (
        <Link
          key={tab}
          href={listHref(path, tab, undefined, tabFilters(tab, filters))}
          prefetch={false}
          aria-current={tab === current ? 'page' : undefined}
          className={`flex-1 border-b-2 py-2 text-center ${
            tab === current ? 'border-brand text-brand' : 'border-transparent text-muted'
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

const CHIP =
  'flex min-h-11 flex-none items-center gap-1.5 rounded-full border px-3 font-semibold whitespace-nowrap';
const chipTone = (active: boolean) =>
  active ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface';

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
  const now = new Date();
  const days = tab === 'today' || tab === 'upcoming' ? dayChips(now) : [];
  const market = filters.market ?? '1x2';
  return (
    <div className="space-y-2 border-b border-line bg-page px-3 py-2 text-sm">
      {days.length > 0 ? (
        <nav aria-label={t('sportsbook.controls.days')} className="flex gap-2 overflow-x-auto">
          {days.map((chip) => {
            // Today's own list is the tab without a day.
            const active =
              filters.day === chip.date || (tab === 'today' && chip.offset === 0 && !filters.day);
            return (
              <Link
                key={chip.date}
                href={href({ day: tab === 'today' && chip.offset === 0 ? undefined : chip.date })}
                prefetch={false}
                aria-current={active ? 'true' : undefined}
                className={`${CHIP} ${chipTone(active)}`}
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
        <nav aria-label={t('sportsbook.controls.countries')} className="flex gap-2 overflow-x-auto">
          <Link
            href={href({ country: undefined })}
            prefetch={false}
            aria-current={filters.country === undefined ? 'true' : undefined}
            className={`${CHIP} ${chipTone(filters.country === undefined)}`}
          >
            {t('sportsbook.controls.all')}
          </Link>
          {countries.map(({ category }) => (
            <Link
              key={category.slug}
              href={href({ country: category.slug })}
              prefetch={false}
              aria-current={filters.country === category.slug ? 'true' : undefined}
              className={`${CHIP} ${chipTone(filters.country === category.slug)}`}
            >
              <span aria-hidden="true">{flagEmoji(category.countryCode)}</span>
              <span>{localName(category.name, locale)}</span>
            </Link>
          ))}
        </nav>
      ) : null}
      {sport === 'football' ? (
        <nav
          aria-label={t('sportsbook.controls.market')}
          className="flex overflow-hidden rounded-full border border-line bg-surface font-semibold"
        >
          {LIST_MARKETS.map((value: ListMarket) => (
            <Link
              key={value}
              href={href({ market: value })}
              prefetch={false}
              aria-current={market === value ? 'true' : undefined}
              className={`flex min-h-11 flex-1 items-center justify-center px-3 text-center ${
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
  const [t, page, competitions] = await Promise.all([
    getT(),
    getEvents({
      sport,
      filter: tab,
      limit: PAGE_SIZE,
      ...(filters.day === undefined ? {} : { day: filters.day }),
      ...(filters.country === undefined ? {} : { country: filters.country }),
      ...(filters.market === 'dc' ? { market: 'dc' as const } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    getCompetitions(sport),
  ]);
  const flags: Record<string, string | null> = {};
  for (const { category, competitions: list } of competitions?.items ?? []) {
    for (const competition of list) flags[competition.slug] = category.countryCode;
  }
  const hrefFor = (next?: string) => listHref(path, tab, next, filters);
  if (page.items.length === 0) {
    return (
      <div className="card m-3 space-y-2 text-center text-muted">
        <p>{t('sportsbook.list.empty')}</p>
        {cursor !== undefined ? (
          <Link href={hrefFor()} prefetch={false} className="btn btn-outline">
            {t('sportsbook.list.firstPage')}
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <MatchList events={page.items} grouped flags={flags} />
      <Pager
        firstHref={cursor === undefined ? null : hrefFor()}
        nextHref={page.nextCursor === null ? null : hrefFor(page.nextCursor)}
      />
    </>
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
  const categories = (data?.items ?? [])
    .map((category) => ({
      ...category,
      competitions: category.competitions.filter((c) => c.eventCount > 0),
    }))
    .filter((category) => category.competitions.length > 0);
  if (categories.length === 0) {
    return <p className="card m-3 text-center text-muted">{t('sportsbook.leagues.empty')}</p>;
  }
  return (
    <div className="space-y-2 py-2">
      {categories.map((category) => (
        <section key={category.category.slug} aria-labelledby={`cat-${category.category.slug}`}>
          <h2
            id={`cat-${category.category.slug}`}
            className="px-3 py-1 text-xxs font-bold text-muted uppercase"
          >
            <span aria-hidden="true">{flagEmoji(category.category.countryCode)}</span>{' '}
            {localName(category.category.name, locale)}
          </h2>
          <ul>
            {category.competitions.map((competition) => (
              <li key={competition.slug}>
                <Link
                  href={routes.competition(sport, competition.slug)}
                  prefetch={false}
                  className="list-row flex items-center justify-between gap-2 font-semibold"
                >
                  <span className="truncate">{localName(competition.name, locale)}</span>
                  <span className="flex-none text-xxs font-normal text-muted">
                    {t('sportsbook.leagues.matches', { count: competition.eventCount })} ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
