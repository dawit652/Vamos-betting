import { listSources } from '@vamos/db';
import {
  halfTimeCoverage,
  halfTimeCovered,
  sourceCapabilities,
  type HalfTimeSource,
} from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { competitionResolver } from '../lib/source-competition';

/** Whether a competition's new prices may include the half-time markets (rule O6). */
export type HalfTimeCheck = (competitionId: string) => boolean;

const EVERYWHERE: HalfTimeCheck = () => true;

/**
 * Rule O6 for one pass (docs/scraper.md 6.5): with SCRAPER_HALF_TIME_MARKETS `all` every
 * competition may have the half-time markets (no read); with `covered` only those where an
 * ENABLED source gives half-time scores, from the source configs (sourceCapabilities, the coverage
 * matrix of `sources coverage`) and the competition labels resolved as the scheduler resolves them.
 * A source whose config the adapter refuses is skipped (it cannot run). Read once per pass, so a
 * source switched on or off takes effect at the next pass.
 *
 * This only says what NEW prices of the competition contain: priceEvent keeps the half-time
 * markets of an event that already has one.
 */
export async function halfTimeCheck(ctx: ScraperContext): Promise<HalfTimeCheck> {
  if (ctx.config.scraper.halfTimeMarkets === 'all') return EVERYWHERE;
  return coveredCompetitions(ctx.db);
}

/** The competitions an enabled half-time source covers, as a check. */
export async function coveredCompetitions(db: ScraperContext['db']): Promise<HalfTimeCheck> {
  const sources = (await listSources(db)).filter((s) => s.enabled);
  const resolve = await competitionResolver(db);
  const entries: HalfTimeSource[] = [];
  for (const source of sources) {
    const result = sourceCapabilities(source);
    if (!result.ok) continue;
    const ids = result.capabilities.competitions.flatMap((label) => {
      const id = resolve(source, label).id;
      return id === null ? [] : [id];
    });
    entries.push({ capabilities: result.capabilities, competitionIds: ids });
  }
  const coverage = halfTimeCoverage(entries);
  return (competitionId) => halfTimeCovered(coverage, competitionId);
}
