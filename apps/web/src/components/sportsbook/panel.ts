import type { CompetitionsResponse } from '@vamos/contracts';
import type { Locale } from '@vamos/i18n/locales';
import type { LeagueBadge } from '@/lib/badges';
import { localName } from '@/lib/localized';
import { routes, type Sport } from '@/lib/routes';
import { topLeagues } from './leagues';

/** One row of the phone league panel: plain data, so it travels as JSON. */
export interface PanelLeague {
  slug: string;
  href: string;
  flag: string;
  /** Our badge for a competition with no country flag (lib/badges), else null. */
  badge: LeagueBadge | null;
  name: string;
  count: number;
}

export interface PanelData {
  featured: PanelLeague[];
  /** Validated Telegram link, or null. */
  telegram: string | null;
}

/**
 * The phone panel's rows: the same Top Leagues in the same order as the desktop column
 * (`topLeagues`), with names in the player's language and the links of the rail.
 */
export function panelLeagues(
  data: CompetitionsResponse | null | undefined,
  sport: Sport,
  locale: Locale,
): Pick<PanelData, 'featured'> {
  const featured = topLeagues(data, sport);
  const row = (c: (typeof featured)[number]): PanelLeague => ({
    slug: c.slug,
    href: routes.competition(sport, c.slug),
    flag: c.flag,
    badge: c.badge,
    name: localName(c.name, locale),
    count: c.eventCount,
  });
  return { featured: featured.map(row) };
}
