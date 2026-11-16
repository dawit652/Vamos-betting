import Link from 'next/link';
import type { ReactNode } from 'react';
import { BetslipDock } from '@/components/betslip/BetslipDock';
import { getLocale, getT } from '@/i18n/server';
import { getCompetitions, getSports } from '@/lib/api/catalog';
import { localName } from '@/lib/localized';
import { listHref } from './tabs';
import { splitLeagues, type SidebarLeague } from './leagues';
import { routes, SPORTS, type Sport } from '@/lib/routes';

/** System emoji as sport icons: no icon font or image to download. */
const SPORT_ICONS: Record<Sport, string> = {
  football: '⚽',
  basketball: '🏀',
  tennis: '🎾',
  volleyball: '🏐',
};

const STICKY =
  'lg:sticky lg:top-[calc(var(--spacing-chrome)+1rem)] lg:max-h-[calc(100dvh-var(--spacing-chrome)-2rem)]';

/**
 * The frame of every sportsbook page (sport home, live, competition, event).
 * Phones: a sport rail (and, on the sport home, a rail of the featured leagues)
 * above the page.
 * Wide screens: the same links as a left column, the page in the middle and the
 * betslip docked on the right (BetslipDock). The links are rendered once and
 * restyled by `.rail` (globals.css), so phones do not download a second copy;
 * only the dock is a client island.
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
  const { featured, others } = splitLeagues(leagues);
  const leagueLink = (c: SidebarLeague) => (
    <Link
      key={c.slug}
      href={routes.competition(sport, c.slug)}
      prefetch={false}
      aria-current={c.slug === competition ? 'page' : undefined}
      className="chip"
    >
      <span aria-hidden="true">{c.flag}</span>
      <span className="lg:min-w-0 lg:flex-1 lg:truncate">{localName(c.name, locale)}</span>
      <span className="text-xxs tabular-nums opacity-70">{c.eventCount}</span>
    </Link>
  );
  const sportHref = (s: Sport) => (live ? routes.live(s) : routes.sport(s));

  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_21rem] lg:items-start lg:gap-4 lg:px-4 lg:pt-4">
      <aside className={`no-scrollbar lg:flex lg:flex-col lg:gap-3 lg:overflow-y-auto ${STICKY}`}>
        <div className="hidden lg:order-1 lg:block">
          <form method="get" action={routes.search} role="search" className="side-search">
            <label htmlFor="side-q" className="sr-only">
              {t('sportsbook.search.label')}
            </label>
            <input
              id="side-q"
              name="q"
              type="search"
              autoComplete="off"
              placeholder={t('sportsbook.search.sidebarPlaceholder')}
              className="side-search-input"
            />
            <button
              type="submit"
              aria-label={t('sportsbook.search.submit')}
              className="side-search-btn"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>
            </button>
          </form>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Link
              href={listHref(routes.sport(sport), 'highlights')}
              prefetch={false}
              className="side-btn"
            >
              <span aria-hidden="true">🏆</span>
              {t('sportsbook.sidebar.topMatches')}
            </Link>
            <Link
              href={listHref(routes.sport(sport), 'upcoming')}
              prefetch={false}
              className="side-btn"
            >
              <span aria-hidden="true">🕒</span>
              {t('sportsbook.tabs.upcoming')}
            </Link>
          </div>
        </div>
        <nav aria-label={t('common.nav.sports')} className="rail lg:order-3">
          <h2 className="rail-title">{t('common.nav.sports')}</h2>
          {SPORTS.map((s) => {
            const liveCount = counts.get(s)?.liveCount ?? 0;
            const count = live ? liveCount : (counts.get(s)?.upcomingCount ?? 0);
            return (
              <Link
                key={s}
                href={sportHref(s)}
                className="chip"
                aria-current={s === sport ? 'page' : undefined}
              >
                <span aria-hidden="true">{SPORT_ICONS[s]}</span>
                <span className="lg:min-w-0 lg:flex-1 lg:truncate">{t(`common.sports.${s}`)}</span>
                {!live && liveCount > 0 ? (
                  <span className="flex items-center gap-1 text-xxs font-bold text-live tabular-nums">
                    <span aria-hidden="true" className="live-dot" />
                    {liveCount}
                  </span>
                ) : null}
                {count > 0 ? (
                  <span className="text-xxs tabular-nums opacity-70">{count}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        {featured.length > 0 ? (
          <details open className={`rail-panel lg:order-2 ${leagueRail ? '' : 'rail-wide'}`}>
            <summary className="rail-summary">
              <span aria-hidden="true">🏆</span>
              <h2 className="min-w-0 flex-1 truncate">{t('sportsbook.leagues.topLeagues')}</h2>
              <span className="rail-badge">{featured.length}</span>
              <svg
                className="rail-chevron"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <nav aria-label={t('sportsbook.leagues.topLeagues')} className="rail rail-second">
              {featured.map((c) => leagueLink(c))}
            </nav>
          </details>
        ) : null}
        {others.length > 0 ? (
          <nav
            aria-label={t('sportsbook.leagues.moreLeagues')}
            className="rail rail-second hidden lg:order-4 lg:flex"
          >
            <h2 className="rail-title">{t('sportsbook.leagues.moreLeagues')}</h2>
            {others.map((c) => leagueLink(c))}
          </nav>
        ) : null}
      </aside>

      <div className="min-w-0">{children}</div>

      <aside data-slip-dock className={`hidden lg:block ${STICKY}`}>
        <BetslipDock />
      </aside>
    </div>
  );
}
