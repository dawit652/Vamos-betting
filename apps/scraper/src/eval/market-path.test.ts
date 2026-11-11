import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baseRate3,
  evaluateMarketPath,
  logLossCategorical,
  readMatch,
  readMatches,
  relativeDifference,
  scoreMatch,
  score2,
  score3,
} from './market-path';
import { parseCsv, rng, type Outcome, type Probs3 } from './odds-lib';

const FIXTURE = readFileSync(
  join(__dirname, '../../test/fixtures/football-data-sample.csv'),
  'utf8',
);

describe('parseCsv', () => {
  it('reads headers, quotes and a leading BOM', () => {
    const rows = parseCsv('﻿a,b\n1,"x,y"\r\n2,z\n');
    expect(rows).toEqual([
      { a: '1', b: 'x,y' },
      { a: '2', b: 'z' },
    ]);
  });
});

describe('metric helpers', () => {
  it('scores a constant 1X2 forecast', () => {
    const p: Probs3 = [0.5, 0.3, 0.2];
    const s = score3([p, p], [0, 2])!;
    expect(s.n).toBe(2);
    expect(s.logLoss).toBeCloseTo((-Math.log(0.5) - Math.log(0.2)) / 2, 12);
    expect(s.brier).toBeCloseTo((0.25 + 0.09 + 0.04 + (0.25 + 0.09 + 0.64)) / 2, 12);
    expect(score3([], [])).toBeNull();
  });

  it('scores a binary forecast', () => {
    const s = score2([0.8, 0.4], [true, false])!;
    expect(s.logLoss).toBeCloseTo((-Math.log(0.8) - Math.log(0.6)) / 2, 12);
    expect(s.brier).toBeCloseTo((0.04 + 0.16) / 2, 12);
    expect(score2([], [])).toBeNull();
  });

  it('scores categorical forecasts, a missing category at the floor', () => {
    expect(logLossCategorical({ '1-0': 0.1 }, '1-0')).toBeCloseTo(-Math.log(0.1), 12);
    expect(logLossCategorical({ '1-0': 0.1 }, 'other')).toBeCloseTo(-Math.log(1e-12), 9);
  });

  it('base rate sums to 1 and is the best constant forecast (seeded)', () => {
    const rand = rng(3);
    for (let t = 0; t < 40; t++) {
      const n = 5 + Math.floor(rand() * 60);
      const outcomes = Array.from({ length: n }, () => Math.floor(rand() * 3) as Outcome);
      const base = baseRate3(outcomes)!;
      expect(base[0] + base[1] + base[2]).toBeCloseTo(1, 12);
      const other: Probs3 = [1 / 3, 1 / 3, 1 / 3];
      const ll = (p: Probs3) =>
        score3(
          outcomes.map(() => p),
          outcomes,
        )!.logLoss;
      expect(ll(base)).toBeLessThanOrEqual(ll(other) + 1e-12);
    }
    expect(baseRate3([])).toBeNull();
  });

  it('relative difference is 0 for equal losses and null when empty', () => {
    const a = [0.5, 0.7, 0.9, 0.6];
    expect(relativeDifference(a, a)!.value).toBe(0);
    expect(
      relativeDifference(
        a.map((x) => x * 1.1),
        a,
      )!.value,
    ).toBeCloseTo(0.1, 12);
    expect(relativeDifference([], [])).toBeNull();
  });
});

describe('readMatch', () => {
  const row = {
    Div: 'E0',
    FTHG: '2',
    FTAG: '1',
    HTHG: '1',
    HTAG: '0',
    B365CH: '2.0',
    B365CD: '3.5',
    B365CA: '4.0',
    B365H: '1.9',
    B365D: '3.4',
    B365A: '4.2',
    PSCH: '2.05',
    PSCD: '3.6',
    PSCA: '4.1',
    'PC>2.5': '1.9',
    'PC<2.5': '2.0',
    AHCh: '-0.5',
    PCAHH: '1.95',
    PCAHA: '1.95',
  };

  it('reads closing columns, Pinnacle no-vig prices and the handicap line', () => {
    const m = readMatch(row)!;
    expect(m.rows.filter((r) => r.market === '1x2')).toHaveLength(6);
    expect(m.rows.find((r) => r.selection === '1')!.priceMilli).toBe(2000);
    expect(m.pinnacle1x2!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(m.pinnacleOver).toBeCloseTo(2.0 / 3.9, 12);
    expect(m.ah).toEqual({ line: -0.5, pinnacleHome: 0.5 });
    expect(m.average1x2).toBeNull();
  });

  it('reads the opening columns with the opening basis', () => {
    const m = readMatch(row, 'open')!;
    expect(m.rows.map((r) => r.priceMilli)).toEqual([1900, 3400, 4200]);
    expect(m.pinnacle1x2).toBeNull();
    expect(m.ah).toBeNull();
  });

  it('ignores a match without a final score', () => {
    expect(readMatch({ ...row, FTHG: '' })).toBeNull();
  });
});

describe('market path on the sample file', () => {
  const matches = readMatches(FIXTURE);
  const report = evaluateMarketPath(matches, 'close');

  it('reads every match and skips the ones it cannot price', () => {
    expect(matches).toHaveLength(44);
    expect(report.skipped).toEqual({ no_consensus: 1, no_totals: 2 });
    expect(report.overall.matches).toBe(41);
  });

  it('forecasts are probabilities that sum to 1', () => {
    for (const m of matches) {
      const r = scoreMatch(m);
      if ('skipped' in r) continue;
      const { oneXTwo, over25, btts, halfTime, correctScore } = r.scores;
      expect(oneXTwo.ours[0] + oneXTwo.ours[1] + oneXTwo.ours[2]).toBeCloseTo(1, 9);
      for (const p of [over25.ours, btts.ours]) expect(p > 0 && p < 1).toBe(true);
      if (halfTime !== null) {
        expect(halfTime.ours[0] + halfTime.ours[1] + halfTime.ours[2]).toBeCloseTo(1, 9);
      }
      const total = Object.values(correctScore.ours).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 9);
      expect(correctScore.key in correctScore.ours).toBe(true);
    }
  });

  it('prices 1X2 and over/under close to the consensus it was given', () => {
    const { oneXTwo, overUnder25 } = report.overall;
    expect(oneXTwo.ours!.n).toBe(41);
    expect(oneXTwo.consensus!.n).toBe(41);
    // Our fair price is the consensus (margin removed again): the two score alike.
    expect(Math.abs(oneXTwo.ours!.logLoss - oneXTwo.consensus!.logLoss)).toBeLessThan(0.02);
    expect(overUnder25.ours!.n).toBe(41);
    expect(overUnder25.consensus!.n).toBe(41);
  });

  it('compares with Pinnacle where it has prices, and keeps the rest in the counts', () => {
    expect(report.overall.oneXTwo.vsPinnacle!.n).toBe(40);
    const ah = report.overall.asianHandicap;
    expect(ah.scored + ah.push + ah.unpricedLine + ah.none).toBe(41);
    expect(ah.result.ours!.n).toBe(ah.scored);
    expect(ah.unpricedLine).toBeGreaterThan(0);
  });

  it('half time covers the matches that have it; correct score and BTTS cover all', () => {
    expect(report.overall.halfTime1x2.ours!.n).toBe(40);
    expect(report.overall.halfTime1x2.vsPinnacle).toBeUndefined();
    expect(report.overall.correctScore.n).toBe(41);
    expect(report.overall.btts.ours!.n).toBe(41);
    // Correct score never beats the base rate by construction of a 1-line sample: both finite.
    expect(Number.isFinite(report.overall.correctScore.logLoss!)).toBe(true);
  });

  it('splits by division', () => {
    expect(report.byDivision.map((d) => d.division)).toEqual(['X1', 'X2']);
    expect(report.byDivision.reduce((a, d) => a + d.section.matches, 0)).toBe(41);
  });

  it('a file with no odds columns prices nothing', () => {
    const none = evaluateMarketPath(readMatches('FTHG,FTAG\n1,0\n'), 'close');
    expect(none.overall.matches).toBe(0);
    expect(none.skipped.no_consensus).toBe(1);
    expect(none.overall.oneXTwo.ours).toBeNull();
  });
});
