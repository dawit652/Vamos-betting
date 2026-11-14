import Link from 'next/link';
import type { ReactNode } from 'react';
import { BetslipDock } from '@/components/betslip/BetslipDock';
import { getLocale, getT } from '@/i18n/server';
import { getCompetitions, getSports } from '@/lib/api/catalog';
import { flagEmoji } from '@/lib/flag';
import { localName } from '@/lib/localized';
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
  const categories = (leagues?.items ?? [])
    .map((category) => ({
      ...category,
      flag: flagEmoji(category.category.countryCode),
      competitions: category.competitions.filter((c) => c.eventCount > 0),
    }))
    .filter((category) => category.competitions.length > 0);
  // Phones list only the featured leagues (the sidebar on a wide screen lists all of them).
  const hasFeatured = categories.some((category) => category.competitions.some((c) => c.featured));
  const sportHref = (s: Sport) => (live ? routes.live(s) : routes.sport(s));

  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)_21rem] lg:items-start lg:gap-4 lg:px-4 lg:pt-4">
      <aside className={`no-scrollbar lg:space-y-3 lg:overflow-y-auto ${STICKY}`}>
        <nav aria-label={t('common.nav.sports')} className="rail">
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
        {categories.length > 0 ? (
          <nav
            aria-label={t('sportsbook.leagues.topLeagues')}
            className={`rail rail-second ${leagueRail && hasFeatured ? '' : 'rail-wide'}`}
          >
            <h2 className="rail-title">{t('sportsbook.leagues.topLeagues')}</h2>
            {categories.map((category) =>
              category.competitions.map((c) => (
                <Link
                  key={c.slug}
                  href={routes.competition(sport, c.slug)}
                  prefetch={false}
                  aria-current={c.slug === competition ? 'page' : undefined}
                  title={localName(category.category.name, locale)}
                  className={`chip ${c.featured ? '' : 'rail-wide'}`}
                >
                  <span aria-hidden="true">{category.flag}</span>
                  <span className="lg:min-w-0 lg:flex-1 lg:truncate">
                    {localName(c.name, locale)}
                  </span>
                  <span className="text-xxs tabular-nums opacity-70">{c.eventCount}</span>
                </Link>
              )),
            )}
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
