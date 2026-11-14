import Link from 'next/link';
import type { ReactNode } from 'react';
import { BetslipDock } from '@/components/betslip/BetslipDock';
import { getLocale, getT } from '@/i18n/server';
import { getCompetitions, getSports } from '@/lib/api/catalog';
import { localName } from '@/lib/localized';
import { routes, SPORTS, type Sport } from '@/lib/routes';
import { monogram } from './events';

/** System emoji as sport icons: no icon font or image to download. */
const SPORT_ICONS: Record<Sport, string> = {
  football: '⚽',
  basketball: '🏀',
  tennis: '🎾',
  volleyball: '🏐',
};

/** Leagues in the phone rail (the desktop sidebar lists all of them). */
const RAIL_LEAGUES = 8;

const STICKY =
  'sticky top-[calc(var(--spacing-chrome)+1rem)] max-h-[calc(100dvh-var(--spacing-chrome)-2rem)]';

/**
 * The frame of every sportsbook page (sport home, live, competition, event).
 * Phones: a sport rail (and, on the sport home, a top-leagues rail) above the page.
 * Wide screens: sports and leagues in a left column, the page in the middle and
 * the betslip docked on the right (BetslipDock). All of it is server-rendered
 * links; only the dock is a client island.
 */
export async function SportsbookFrame({
  sport,
  live = false,
  competition,
  leagueRail = false,
  children,
}: {
  sport: Sport;
  /** The live lists: sport links stay on the live side and show live counts. */
  live?: boolean;
  /** Slug of the competition being viewed, highlighted in the sidebar. */
  competition?: string;
  leagueRail?: boolean;
  children: ReactNode;
}) {
  // The navigation is an extra: when its data fails the page itself still renders.
  const [t, locale, sports, leagues] = await Promise.all([
    getT(),
    getLocale(),
    getSports().catch(() => null),
    getCompetitions(sport).catch(() => null),
  ]);
  const counts = new Map((sports?.items ?? []).map((item) => [item.id, item]));
  const categories = (leagues?.items ?? [])
    .map((category) => ({
      ...category,
      tag: monogram(category.category.name.en),
      competitions: category.competitions.filter((c) => c.eventCount > 0),
    }))
    .filter((category) => category.competitions.length > 0);
  const top = categories
    .flatMap((category) => category.competitions.map((c) => ({ ...c, tag: category.tag })))
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, RAIL_LEAGUES);
  const sportHref = (s: Sport) => (live ? routes.live(s) : routes.sport(s));
  const sportCount = (s: Sport) =>
    (live ? counts.get(s)?.liveCount : counts.get(s)?.upcomingCount) ?? 0;

  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_21rem] lg:items-start lg:gap-4 lg:px-4 lg:pt-4">
      <aside className={`no-scrollbar hidden space-y-3 overflow-y-auto lg:block ${STICKY}`}>
        <nav aria-label={t('common.nav.sports')} className="panel p-1.5">
          <h2 className="px-2.5 pt-1.5 pb-1 text-xxs font-bold tracking-wider text-muted uppercase">
            {t('common.nav.sports')}
          </h2>
          {SPORTS.map((s) => {
            const liveCount = counts.get(s)?.liveCount ?? 0;
            return (
              <Link
                key={s}
                href={sportHref(s)}
                aria-current={s === sport ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 font-semibold ${
                  s === sport ? 'bg-brand-soft text-brand' : 'hover:bg-raised'
                }`}
              >
                <span aria-hidden="true" className="text-base">
                  {SPORT_ICONS[s]}
                </span>
                <span className="min-w-0 flex-1 truncate">{t(`common.sports.${s}`)}</span>
                {liveCount > 0 ? (
                  <span className="flex items-center gap-1 text-xxs font-bold text-live tabular-nums">
                    <span aria-hidden="true" className="live-dot" />
                    {liveCount}
                  </span>
                ) : null}
                <span className="text-xxs font-semibold text-muted tabular-nums">
                  {counts.get(s)?.upcomingCount ?? 0}
                </span>
              </Link>
            );
          })}
        </nav>
        {categories.length > 0 ? (
          <nav aria-label={t('sportsbook.leagues.top')} className="panel p-1.5">
            <h2 className="px-2.5 pt-1.5 pb-1 text-xxs font-bold tracking-wider text-muted uppercase">
              {t('sportsbook.leagues.top')}
            </h2>
            {categories.map((category) =>
              category.competitions.map((c) => (
                <Link
                  key={c.slug}
                  href={routes.competition(sport, c.slug)}
                  prefetch={false}
                  aria-current={c.slug === competition ? 'page' : undefined}
                  title={localName(category.category.name, locale)}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] font-semibold ${
                    c.slug === competition ? 'bg-brand-soft text-brand' : 'hover:bg-raised'
                  }`}
                >
                  <span aria-hidden="true" className="tag">
                    {category.tag}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{localName(c.name, locale)}</span>
                  <span className="text-xxs text-muted tabular-nums">{c.eventCount}</span>
                </Link>
              )),
            )}
          </nav>
        ) : null}
      </aside>

      <div className="min-w-0">
        <nav
          aria-label={t('common.nav.sports')}
          className="no-scrollbar flex gap-2 overflow-x-auto px-3 py-2.5 lg:hidden"
        >
          {SPORTS.map((s) => (
            <Link
              key={s}
              href={sportHref(s)}
              className="chip"
              aria-current={s === sport ? 'page' : undefined}
            >
              <span aria-hidden="true">{SPORT_ICONS[s]}</span>
              {t(`common.sports.${s}`)}
              {sportCount(s) > 0 ? (
                <span className="text-xxs tabular-nums opacity-70">{sportCount(s)}</span>
              ) : null}
            </Link>
          ))}
        </nav>
        {leagueRail && top.length > 1 ? (
          <nav
            aria-label={t('sportsbook.leagues.top')}
            className="no-scrollbar flex gap-2 overflow-x-auto px-3 pb-2.5 lg:hidden"
          >
            {top.map((c) => (
              <Link
                key={c.slug}
                href={routes.competition(sport, c.slug)}
                prefetch={false}
                className="chip pl-1.5"
              >
                <span aria-hidden="true" className="tag">
                  {c.tag}
                </span>
                {localName(c.name, locale)}
              </Link>
            ))}
          </nav>
        ) : null}
        {children}
      </div>

      <aside data-slip-dock className={`hidden lg:block ${STICKY}`}>
        <BetslipDock />
      </aside>
    </div>
  );
}
