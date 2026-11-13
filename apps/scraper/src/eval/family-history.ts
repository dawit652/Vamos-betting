import {
  DEFAULT_MARKET_FAMILIES,
  FACTORY_MARKETS,
  fairBook,
  familyHistoryVerdict,
  familyMarginBps,
  factoryPricingPlan,
  isMarketFamily,
  marketConsensus,
  resolveFactorySelection,
  type FactoryMarket,
  type FamilyHistoryVerdict,
  type MarketFamilySettings,
  type SelectionHistory,
} from '@vamos/core';
import {
  DEFAULT_MAX_LISTED_ODDS_MILLI,
  DEFAULT_MIN_FAVOURITE_ODDS_MILLI,
  MAX_MARKET_FIT_RESIDUAL,
  prematchFactoryGrids,
  priceBook,
  priceFootballFromMarket,
  type PrematchGridOptions,
} from '@vamos/feed';
import type { MatchInput } from './market-path';

/**
 * The history test of the market factory's families (check 0.6, task A2). For every match of
 * football-data.co.uk files: the closing 1X2 and over/under 2.5 of several books give the market
 * consensus, `priceFootballFromMarket` fits the expected goals exactly as production does, and every
 * factory-only market is priced from them (`fairBook`, `priceBook` at the family's margin, with
 * production's pruning: a market whose favourite pays under 1.02 is not offered, a selection over
 * 500.0 is not listed). Each listed selection is then settled by the same rule on the real score.
 *
 * Per family the evaluator keeps the stakes and returns of one unit on every listed selection at our
 * price (the hold) and, per selection, the statistics of won / p that `familyHistoryVerdict` turns
 * into a suggested margin. Measurement only: production code never imports it.
 */

export interface FamilyHistoryReport {
  matches: number;
  /** Matches skipped: no consensus or no totals, a fit residual over the limit, or no half time. */
  skipped: { noFit: number; residual: number; noHalfTime: number };
  families: FamilyHistoryVerdict[];
}

interface FamilyAcc {
  matches: number;
  stakes: number;
  returns: number;
  selections: Map<string, SelectionHistory>;
}

const FAMILY_MARKETS: readonly FactoryMarket[] = FACTORY_MARKETS.filter((m) =>
  isMarketFamily(m.type),
);

/**
 * The history test over `matches`, at the margins of `settings` (the defaults when omitted).
 * `grids` are the pricing switches of task 2.2 (first-half share, draw correction), off by default
 * as in production; set, they measure what switching them on would change.
 */
export function familyHistoryTest(
  matches: readonly MatchInput[],
  settings: MarketFamilySettings = DEFAULT_MARKET_FAMILIES,
  grids: PrematchGridOptions = {},
): FamilyHistoryReport {
  const plan = factoryPricingPlan(settings, new Map());
  const acc = new Map<string, FamilyAcc>();
  const skipped = { noFit: 0, residual: 0, noHalfTime: 0 };
  let used = 0;
  for (const m of matches) {
    const consensus = marketConsensus(m.rows);
    const fit = priceFootballFromMarket(consensus);
    if (fit === null || !consensus.some((c) => c.market === '1x2')) {
      skipped.noFit += 1;
      continue;
    }
    if (fit.residual > MAX_MARKET_FIT_RESIDUAL) {
      skipped.residual += 1;
      continue;
    }
    const hasHalf = m.hthg !== null && m.htag !== null && m.hthg <= m.hg && m.htag <= m.ag;
    if (!hasHalf) skipped.noHalfTime += 1;
    used += 1;
    const scoreGrids = prematchFactoryGrids(fit.lambdaHome, fit.lambdaAway, grids);
    const score = {
      home: m.hg,
      away: m.ag,
      ...(hasHalf ? { htHome: m.hthg, htAway: m.htag } : {}),
    };
    const seen = new Set<string>();
    for (const market of FAMILY_MARKETS) {
      if (market.basis !== 'ft' && !hasHalf) continue;
      const book = fairBook(market, scoreGrids);
      if (!book.priceable) continue;
      const margin = familyMarginBps(plan, market.type);
      const prices = priceBook(book.probabilities, margin);
      if (prices === null || Math.min(...prices) < DEFAULT_MIN_FAVOURITE_ODDS_MILLI) continue;
      let family = acc.get(market.type);
      if (family === undefined) {
        family = { matches: 0, stakes: 0, returns: 0, selections: new Map() };
        acc.set(market.type, family);
      }
      if (!seen.has(market.type)) {
        seen.add(market.type);
        family.matches += 1;
      }
      market.selections.forEach((code, i) => {
        const odds = prices[i]!;
        const p = book.probabilities[i]!;
        if (odds > DEFAULT_MAX_LISTED_ODDS_MILLI || !(p > 0)) return;
        const result = resolveFactorySelection(market, code, { status: 'finished', score });
        family.stakes += 1;
        if (result === 'void') {
          family.returns += 1;
          return;
        }
        const won = result === 'won';
        if (won) family.returns += odds / 1000;
        const key = `${market.line ?? '-'}|${code}`;
        let s = family.selections.get(key);
        if (s === undefined) {
          s = { key, n: 0, wins: 0, sumP: 0, sumRatio: 0, sumRatioSq: 0 };
          family.selections.set(key, s);
        }
        const ratio = won ? 1 / p : 0;
        s.n += 1;
        s.wins += won ? 1 : 0;
        s.sumP += p;
        s.sumRatio += ratio;
        s.sumRatioSq += ratio * ratio;
      });
    }
  }
  const families = [...acc]
    .map(([family, a]) =>
      familyHistoryVerdict({
        family,
        matches: a.matches,
        selections: [...a.selections.values()],
        marginBps: familyMarginBps(plan, family),
        stakes: a.stakes,
        returns: a.returns,
      }),
    )
    .sort((x, y) => Number(x.passed) - Number(y.passed) || x.family.localeCompare(y.family));
  return { matches: used, skipped, families };
}
