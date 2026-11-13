import { marketNeedsHalfTime } from '@vamos/core';
import type { SourceCapabilities } from '../adapters/capabilities';

/**
 * Rule O6, half-time markets only where a source gives half time (docs/scraper.md 6.5, S-2 of
 * docs/feed-quality-plan.md). Pure: no I/O.
 *
 * A half-time market (`period: 'half_time'` in MARKET_TYPES, today only `ht_1x2`) settles on the
 * half-time score, so an event that has one needs that score before rule R2 applies its result
 * (`needsHalfTimeScore`, derived from the event's stored markets). In a competition no enabled
 * source gives half time, such an event can never pass R2 and always waits for a person (R6, R12).
 * With the setting `covered`, new prices there leave the half-time markets out, so two full-time
 * upstreams suffice. Nothing here removes a stored market: an event that already has a half-time
 * market keeps being priced with it (`offersHalfTimeMarkets`), and a person settles it as before.
 */

/** SCRAPER_HALF_TIME_MARKETS: `all` (every event, the default) or `covered`. */
export type HalfTimeMarketsSetting = 'all' | 'covered';

/** True for a market type settled on the half-time score; an unknown type is not one. */
export function isHalfTimeMarket(type: string): boolean {
  // Today's 'ht_1x2' and every factory market on a half or on both halves (plan task 2.3).
  return typeof type === 'string' && marketNeedsHalfTime(type);
}

/** The markets without the half-time ones, in their order; every other market is kept as it is. */
export function withoutHalfTimeMarkets<T extends { type: string }>(markets: readonly T[]): T[] {
  return markets.filter((market) => !isHalfTimeMarket(market.type));
}

/** One enabled source as rule O6 sees it: what its adapter gives, and its competitions' catalogue ids. */
export interface HalfTimeSource {
  capabilities: Pick<SourceCapabilities, 'fullTime' | 'halfTime' | 'competitionPerRecord'>;
  /** Catalogue ids its configured competition labels resolve to (an unresolved label is left out). */
  competitionIds: readonly string[];
}

/** The competitions where some enabled source gives a half-time score. */
export interface HalfTimeCoverage {
  /**
   * A half-time source names its competition per record (generic adapters without a fixed
   * competition): it may cover any competition, so every competition counts as covered.
   */
  everywhere: boolean;
  competitions: ReadonlySet<string>;
}

/**
 * Which competitions have a half-time source: a source counts when it gives a full-time score
 * with a half time next to it (sourceCapabilities `fullTime && halfTime`, the coverage matrix's
 * "HT" column). Pass ENABLED sources only, with configs the adapter accepts.
 */
export function halfTimeCoverage(sources: readonly HalfTimeSource[]): HalfTimeCoverage {
  const competitions = new Set<string>();
  let everywhere = false;
  for (const source of sources) {
    const caps = source.capabilities;
    if (!caps.fullTime || !caps.halfTime) continue;
    if (caps.competitionPerRecord) everywhere = true;
    for (const id of source.competitionIds) competitions.add(id);
  }
  return { everywhere, competitions };
}

/** True when the competition has a half-time source (rule O6). */
export function halfTimeCovered(coverage: HalfTimeCoverage, competitionId: string): boolean {
  return coverage.everywhere || coverage.competitions.has(competitionId);
}

export interface HalfTimeOfferInput {
  setting: HalfTimeMarketsSetting;
  /** The event's competition has a half-time source (halfTimeCovered). */
  covered: boolean;
  /** The event already has a half-time market (any status): it is never taken away. */
  eventHasHalfTimeMarket: boolean;
}

/** Rule O6: whether an event's prices include the half-time markets. */
export function offersHalfTimeMarkets(input: HalfTimeOfferInput): boolean {
  return input.setting === 'all' || input.covered || input.eventHasHalfTimeMarket;
}
