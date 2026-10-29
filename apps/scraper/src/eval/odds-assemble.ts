import { out, readJson, writeJson } from './odds-lib';

/**
 * Merges the four result files of the odds evaluation into the small summary
 * published in docs/scraper-evaluation/data/03-odds-accuracy.json.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-assemble.ts <out-dir> <summary.json>
 *
 * <out-dir> holds backtest.json, market.json, integrity.json, volatility.json,
 * written by odds-backtest.ts, odds-market.ts, odds-integrity.ts and odds-volatility.ts.
 */

const [dir, target] = process.argv.slice(2);
if (dir === undefined || target === undefined) {
  throw new Error('usage: odds-assemble.ts <out-dir> <summary.json>');
}

type Obj = Record<string, unknown>;
const read = (name: string): Obj => readJson(`${dir}/${name}`) as Obj;

const backtest = read('backtest.json');
const runs = backtest.runs as Obj;
const keptRuns: Obj = {};
for (const [key, value] of Object.entries(runs)) {
  const [set, , world] = key.split('|');
  // The "visible" world (goalless draws the scraper cannot read are not learned) is kept for the
  // Premier League 2025-26 and the pool only.
  if (world === 'visible' && set !== 'PL2526' && set !== 'POOL') continue;
  keptRuns[key] = value;
}

const market = read('market.json');
const vs = market.vsMarket as Obj;
const keptMarket: Obj = {};
for (const [key, value] of Object.entries(vs)) {
  if (key.startsWith('bet365|power') || key.startsWith('pinnacle|power')) continue;
  keptMarket[key] = value;
}

writeJson(target, {
  title: 'Odds accuracy and price integrity: summary data',
  produced: 'apps/scraper/src/eval/odds-*.ts, run 2026-10-29',
  note: 'Intervals are 95% percentile bootstrap over matches (2000 resamples, fixed seeds) unless stated.',
  backtest: {
    dataInfo: backtest.dataInfo,
    groundTruthCheck: backtest.groundTruthCheck,
    runs: keptRuns,
  },
  market: {
    source: market.source,
    join: market.join,
    overrounds: market.overrounds,
    vsMarket: keptMarket,
    overUnder25: market.overUnder25,
  },
  integrity: read('integrity.json'),
  volatility: read('volatility.json'),
});
out(`wrote ${target}`);
