import type { CompetitionsResponse } from '@vamos/contracts';
import type { Locale } from '@vamos/i18n/locales';
import { localName } from '@/lib/localized';
import { routes, type Sport } from '@/lib/routes';
import { splitLeagues } from './leagues';

/** One row of the phone league panel: plain data, so it travels as JSON. */
export interface PanelLeague {
  slug: string;
  href: string;
  flag: string;
  name: string;
  count: number;
}

export interface PanelData {
  featured: PanelLeague[];
  others: PanelLeague[];
  /** Validated Telegram link, or null. */
  telegram: string | null;
}

/**
 * The phone panel's rows: the same split and order as the desktop column
 * (`splitLeagues`), with names in the player's language and the links of the rail.
 */
export function panelLeagues(
  data: CompetitionsResponse | null | undefined,
  sport: Sport,
  locale: Locale,
): Pick<PanelData, 'featured' | 'others'> {
  const { featured, others } = splitLeagues(data);
  const row = (c: (typeof featured)[number]): PanelLeague => ({
    slug: c.slug,
    href: routes.competition(sport, c.slug),
    flag: c.flag,
    name: localName(c.name, locale),
    count: c.eventCount,
  });
  return { featured: featured.map(row), others: others.map(row) };
}
