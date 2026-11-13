import type { MarketView } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { isListedMarket } from './events';

/**
 * Pure model of the event page's market sections (no React, no I/O): today's
 * markets first as "main", then one section per market-factory `group`, with
 * the chip filter, the name search and the long-shot cut applied.
 */

/** The factory groups in display order. */
export const FACTORY_GROUPS = [
  'full_time',
  'full_time_combos',
  'first_half',
  'second_half',
  'teams',
  'halves',
] as const;

/** Selections priced above 500.00 are not shown (display only). */
export const MAX_DISPLAY_ODDS_MILLI = 500_000;

export const MAIN_SECTION = 'main';

export type SectionId = string;
/** The chip filter: 'all' (every section) or one section id. */
export type SectionFilter = string;

export interface MarketSection {
  id: SectionId;
  /** Message key of the heading; unknown groups use `fallbackTitle`. */
  titleKey: MessageKey | null;
  fallbackTitle: string;
  markets: MarketView[];
}

const TITLE_KEYS: Record<string, MessageKey> = {
  main: 'sportsbook.markets.group.main',
  full_time: 'sportsbook.markets.group.full_time',
  full_time_combos: 'sportsbook.markets.group.full_time_combos',
  first_half: 'sportsbook.markets.group.first_half',
  second_half: 'sportsbook.markets.group.second_half',
  teams: 'sportsbook.markets.group.teams',
  halves: 'sportsbook.markets.group.halves',
};

/** The market without its long-shot selections, or null when none is left. */
export function withoutLongShots(market: MarketView): MarketView | null {
  const selections = market.selections.filter((s) => s.oddsMilli <= MAX_DISPLAY_ODDS_MILLI);
  if (selections.length === 0) return null;
  return selections.length === market.selections.length ? market : { ...market, selections };
}

/**
 * Listed markets (open or suspended), long shots removed from the factory's
 * grouped markets (today's markets keep every selection, as before) and, when
 * `query` is not blank, only those whose name contains it (case-insensitive),
 * split into sections: "main" first, then the factory groups in order, unknown
 * groups last. Empty sections are dropped.
 */
export function buildSections(
  markets: readonly MarketView[],
  nameOf: (market: MarketView) => string,
  query = '',
): MarketSection[] {
  const needle = query.trim().toLowerCase();
  const byId = new Map<SectionId, MarketView[]>();
  for (const original of markets) {
    if (!isListedMarket(original.status)) continue;
    if (needle !== '' && !nameOf(original).toLowerCase().includes(needle)) continue;
    // Only the factory's markets (they carry a group) list every long shot; today's stay as they are.
    const market = original.group === undefined ? original : withoutLongShots(original);
    if (market === null) continue;
    const id = market.group ?? MAIN_SECTION;
    const list = byId.get(id);
    if (list === undefined) byId.set(id, [market]);
    else list.push(market);
  }
  const known: readonly string[] = [MAIN_SECTION, ...FACTORY_GROUPS];
  const unknown = [...byId.keys()].filter((id) => !known.includes(id));
  return [...known, ...unknown].flatMap((id) => {
    const list = byId.get(id);
    if (list === undefined) return [];
    return [{ id, titleKey: TITLE_KEYS[id] ?? null, fallbackTitle: id, markets: list }];
  });
}

/** Sections shown for a chip: all of them, or just the chosen one. */
export function applyFilter(
  sections: readonly MarketSection[],
  filter: SectionFilter,
): MarketSection[] {
  return filter === 'all' ? [...sections] : sections.filter((s) => s.id === filter);
}
