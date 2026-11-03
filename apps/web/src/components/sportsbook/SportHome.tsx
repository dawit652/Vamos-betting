import Link from 'next/link';
import { getCompetitions, getEvents } from '@/lib/api/catalog';
import { getLocale, getT } from '@/i18n/server';
import { localName } from '@/lib/localized';
import { flagEmoji } from '@/lib/flags';
import { routes, type Sport } from '@/lib/routes';
import { MatchList } from './MatchList';
import { LIST_TABS, listHref, parseCursor, parseTab, type ListTab } from './tabs';

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
  return (
    <>
      <h1 className="sr-only">
        {t(`common.sports.${sport}`)} · {t(`sportsbook.tabs.${tab}`)}
      </h1>
      <ListTabs path={path} current={tab} />
      {tab === 'leagues' ? (
        <Leagues sport={sport} />
      ) : (
        <EventsTab sport={sport} tab={tab} cursor={cursor} path={path} />
      )}
    </>
  );
}

async function ListTabs({ path, current }: { path: string; current: ListTab }) {
  const t = await getT();
  return (
    <nav
      aria-label={t('sportsbook.tabs.label')}
      className="flex border-b border-line bg-surface text-sm font-semibold"
    >
      {LIST_TABS.map((tab) => (
        <Link
          key={tab}
          href={listHref(path, tab)}
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

async function EventsTab({
  sport,
  tab,
  cursor,
  path,
}: {
  sport: Sport;
  tab: Exclude<ListTab, 'leagues'>;
  cursor: string | undefined;
  path: string;
}) {
  const [t, page] = await Promise.all([
    getT(),
    getEvents({
      sport,
      filter: tab,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  ]);
  if (page.items.length === 0) {
    return (
      <div className="card m-3 space-y-2 text-center text-muted">
        <p>{t('sportsbook.list.empty')}</p>
        {cursor !== undefined ? (
          <Link href={listHref(path, tab)} prefetch={false} className="btn btn-outline">
            {t('sportsbook.list.firstPage')}
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <MatchList events={page.items} />
      <Pager
        firstHref={cursor === undefined ? null : listHref(path, tab)}
        nextHref={page.nextCursor === null ? null : listHref(path, tab, page.nextCursor)}
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
