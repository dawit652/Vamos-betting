import type { ClosePriceEvent, StoredClosePrice } from '@vamos/db';
import { describe, expect, it } from 'vitest';
import { rng } from './odds-lib';
import { computeScorecard } from './scorecard';

const AT = new Date('2026-11-01T12:00:00Z');

function row(
  eventId: string,
  market: '1x2' | 'ou',
  selection: StoredClosePrice['selection'],
  extra: Partial<StoredClosePrice> = {},
): StoredClosePrice {
  return {
    eventId,
    capturedAt: AT,
    market,
    line: market === 'ou' ? '2.5' : null,
    selection,
    pricingSource: 'market',
    ourOddsMilli: null,
    consensusPpm: null,
    pinnaclePpm: null,
    bestOddsMilli: null,
    bestBookmaker: null,
    books: 0,
    overroundPpm: null,
    ...extra,
  };
}

/** Three 1X2 rows from per-selection fields. */
function oneXTwo(
  eventId: string,
  fields: {
    odds?: number[];
    consensus?: number[];
    pinnacle?: number[];
    best?: number[];
    source?: 'model' | 'market';
    overround?: number;
  },
): StoredClosePrice[] {
  return (['1', 'X', '2'] as const).map((selection, k) =>
    row(eventId, '1x2', selection, {
      pricingSource: fields.source ?? 'market',
      ourOddsMilli: fields.odds?.[k] ?? null,
      consensusPpm: fields.consensus?.[k] ?? null,
      pinnaclePpm: fields.pinnacle?.[k] ?? null,
      bestOddsMilli: fields.best?.[k] ?? null,
      overroundPpm: fields.overround ?? null,
    }),
  );
}

function event(
  eventId: string,
  status: string,
  score: [number, number] | null,
  competitionName = 'League A',
): ClosePriceEvent {
  return {
    eventId,
    competitionId: competitionName,
    competitionName,
    status,
    scoreHome: score?.[0] ?? null,
    scoreAway: score?.[1] ?? null,
    resultedAt: score === null ? null : AT,
  };
}

describe('computeScorecard', () => {
  it('scores a perfect forecast with Brier 0 and log-loss near 0', () => {
    // A price of 1.000 on the home win and absurdly long prices on the others.
    const rows = oneXTwo('e1', {
      odds: [1000, 1e12, 1e12],
      consensus: [1_000_000, 0, 0],
    });
    const card = computeScorecard(rows, [event('e1', 'finished', [2, 0])]);
    const { ours, consensus } = card.overall.oneXTwo.oursVsConsensus;
    expect(consensus?.brier).toBe(0);
    expect(consensus?.rps).toBe(0);
    expect(consensus?.logLoss).toBeCloseTo(0, 12);
    expect(ours?.brier).toBeLessThan(1e-5);
    expect(ours?.logLoss).toBeLessThan(1e-5);
  });

  it('takes our probabilities from the odds, normalised by our overround', () => {
    // Odds 1.6 / 3.2 / 3.2 imply 0.625, 0.3125, 0.3125 (overround 1.25): fair 0.5, 0.25, 0.25.
    const rows = oneXTwo('e1', {
      odds: [1600, 3200, 3200],
      consensus: [500_000, 250_000, 250_000],
    });
    const card = computeScorecard(rows, [event('e1', 'finished', [1, 0])]);
    const { ours, consensus } = card.overall.oneXTwo.oursVsConsensus;
    expect(ours?.brier).toBeCloseTo(consensus?.brier ?? -1, 12);
    expect(ours?.logLoss).toBeCloseTo(-Math.log(0.5), 12);
    expect(ours?.rps).toBeCloseTo(consensus?.rps ?? -1, 12);
    expect(card.overall.prices.overround.oneXTwo.oursMean).toBeCloseTo(1.25, 12);
  });

  it('needs all three selections of a forecaster, and compares only matched samples', () => {
    const complete = oneXTwo('e1', {
      odds: [2000, 3500, 4000],
      consensus: [480_000, 280_000, 240_000],
      pinnacle: [500_000, 260_000, 240_000],
    });
    const noPinnacle = oneXTwo('e2', {
      odds: [2000, 3500, 4000],
      consensus: [480_000, 280_000, 240_000],
    });
    const missingOne = oneXTwo('e3', {
      odds: [2000, 3500, 4000],
      consensus: [480_000, 280_000, 240_000],
    }).slice(0, 2);
    const card = computeScorecard(
      [...complete, ...noPinnacle, ...missingOne],
      [
        event('e1', 'finished', [1, 0]),
        event('e2', 'finished', [0, 0]),
        event('e3', 'finished', [0, 1]),
      ],
    );
    expect(card.overall.sample).toEqual({ events: 3, settled: 3, void: 0, pending: 0 });
    expect(card.overall.oneXTwo.oursVsConsensus.n).toBe(2);
    const w = card.overall.oneXTwo.withPinnacle;
    expect(w.n).toBe(1);
    expect(w.pinnacle?.logLoss).toBeCloseTo(-Math.log(0.5), 12);
    expect(w.relLogLossVsPinnacle).toBeCloseTo((w.ours?.logLoss ?? 0) / -Math.log(0.5) - 1, 12);
  });

  it('scores over/under 2.5 from over + under normalised', () => {
    const ou = (eventId: string): StoredClosePrice[] => [
      row(eventId, 'ou', 'over', {
        ourOddsMilli: 1600,
        consensusPpm: 600_000,
        pinnaclePpm: 610_000,
      }),
      row(eventId, 'ou', 'under', {
        ourOddsMilli: 2400,
        consensusPpm: 400_000,
        pinnaclePpm: 390_000,
      }),
    ];
    // Implied 0.625 and 0.4167: fair over = 0.625 / 1.04167 = 0.6.
    const card = computeScorecard(ou('e1'), [event('e1', 'finished', [2, 1])]);
    const o = card.overall.overUnder.oursVsConsensus;
    expect(o.n).toBe(1);
    expect(o.ours?.brier).toBeCloseTo(0.16, 10);
    expect(o.ours?.logLoss).toBeCloseTo(-Math.log(0.6), 10);
    expect(o.consensus?.brier).toBeCloseTo(0.16, 10);
    expect(card.overall.overUnder.withPinnacle.pinnacle?.brier).toBeCloseTo(0.39 ** 2, 10);
    // Two goals is under 2.5.
    const under = computeScorecard(ou('e1'), [event('e1', 'finished', [1, 1])]);
    expect(under.overall.overUnder.oursVsConsensus.ours?.brier).toBeCloseTo(0.36, 10);
  });

  it('computes the bettor edge, its median and share above zero', () => {
    const rows = oneXTwo('e1', { odds: [2000, 3000, 5000], pinnacle: [510_000, 340_000, 150_000] });
    const edges = [2 * 0.51 - 1, 3 * 0.34 - 1, 5 * 0.15 - 1]; // 0.02, 0.02, -0.25
    const stats = computeScorecard(rows, [event('e1', 'scheduled', null)]).overall.prices
      .edgeVsPinnacle;
    expect(stats.n).toBe(3);
    expect(stats.mean).toBeCloseTo((edges[0]! + edges[1]! + edges[2]!) / 3, 12);
    expect(stats.median).toBeCloseTo(0.02, 12);
    expect(stats.shareAboveZero).toBeCloseTo(2 / 3, 12);
    const none = computeScorecard(rows, []).overall.prices.edgeVsConsensus;
    expect(none).toEqual({ n: 0, mean: null, median: null, shareAboveZero: null });
  });

  it('counts the shares of selections where we pay more than the best book', () => {
    const rows = oneXTwo('e1', { odds: [2000, 3500, 4000], best: [1900, 3500, 4200] });
    const best = computeScorecard(rows, []).overall.prices.bestPrice;
    expect(best.n).toBe(3);
    expect(best.shareAbove).toBeCloseTo(1 / 3, 12);
    expect(best.shareAtLeast).toBeCloseTo(2 / 3, 12);
  });

  it('puts probability bin edges in the upper bin and 1.0 in the last', () => {
    // Fair 0.1 / 0.4 / 0.5 (exact sums): 0.1 belongs in the second bin, the home win is 0.1.
    const edge = computeScorecard(oneXTwo('e1', { odds: [10_000, 2500, 2000] }), [
      event('e1', 'finished', [1, 0]),
    ]);
    expect(edge.overall.calibration.map((b) => b.n)).toEqual([0, 1, 0, 0, 1, 1, 0, 0, 0, 0]);
    expect(edge.overall.calibration[1]?.observed).toBe(1);
    expect(edge.overall.calibration[1]?.meanPredicted).toBeCloseTo(0.1, 12);
    expect(edge.overall.calibration[4]?.observed).toBe(0);
    // A certain home win has probability exactly 1.0, which goes in the last bin.
    const sure = computeScorecard(oneXTwo('e2', { odds: [1000, 1e20, 1e20] }), [
      event('e2', 'finished', [1, 0]),
    ]);
    expect(sure.overall.calibration.map((b) => b.n)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(sure.overall.calibration[9]?.meanPredicted).toBe(1);
    expect(sure.overall.calibration[9]?.observed).toBe(1);
  });

  it('counts void and pending events but scores only settled ones', () => {
    const odds = { odds: [2000, 3500, 4000], consensus: [480_000, 280_000, 240_000] };
    const rows = ['s', 'v1', 'v2', 'v3', 'p1', 'p2', 'p3'].flatMap((id) => oneXTwo(id, odds));
    const card = computeScorecard(rows, [
      event('s', 'finished', [1, 0]),
      event('v1', 'cancelled', null),
      event('v2', 'abandoned', [0, 0]),
      event('v3', 'postponed', null),
      event('p1', 'scheduled', null),
      event('p2', 'live', [1, 0]),
      event('p3', 'finished', null),
    ]);
    expect(card.overall.sample).toEqual({ events: 7, settled: 1, void: 3, pending: 3 });
    expect(card.overall.oneXTwo.oursVsConsensus.n).toBe(1);
    // Prices are measured on every captured selection, settled or not.
    expect(card.overall.prices.overround.oneXTwo.oursN).toBe(7);
  });

  it('groups per competition and per pricing source', () => {
    const base = { odds: [2000, 3500, 4000], consensus: [480_000, 280_000, 240_000] };
    const rows = [
      ...oneXTwo('a1', { ...base, source: 'model' }),
      ...oneXTwo('a2', { ...base, source: 'market' }),
      ...oneXTwo('b1', { ...base, source: 'market' }),
    ];
    const card = computeScorecard(rows, [
      event('a1', 'finished', [1, 0], 'League A'),
      event('a2', 'scheduled', null, 'League A'),
      event('b1', 'finished', [0, 2], 'League B'),
    ]);
    expect(card.byCompetition.map((g) => [g.competition, g.section.sample.events])).toEqual([
      ['League A', 2],
      ['League B', 1],
    ]);
    expect(card.byCompetition[0]?.section.sample).toEqual({
      events: 2,
      settled: 1,
      void: 0,
      pending: 1,
    });
    expect(card.byPricingSource.map((g) => [g.source, g.section.sample.events])).toEqual([
      ['market', 2],
      ['model', 1],
    ]);
    expect(card.byPricingSource[0]?.section.sample.settled).toBe(1);
  });

  it('returns null values, not NaN, for an empty sample', () => {
    const card = computeScorecard([], []);
    expect(card.overall.sample).toEqual({ events: 0, settled: 0, void: 0, pending: 0 });
    expect(card.overall.oneXTwo.oursVsConsensus).toEqual({ n: 0, ours: null, consensus: null });
    expect(card.overall.oneXTwo.withPinnacle.relLogLossVsPinnacle).toBeNull();
    expect(card.overall.prices.bestPrice).toEqual({ n: 0, shareAbove: null, shareAtLeast: null });
    expect(card.overall.calibration.every((b) => b.n === 0 && b.observed === null)).toBe(true);
    expect(card.byCompetition).toEqual([]);
  });

  // fast-check is not a dependency of this app: a seeded generator (rng, odds-lib) draws the cases.
  it('keeps every score within its bounds for any valid forecast (property)', () => {
    const rand = rng(20261110);
    const draw = (): number => 1 + Math.floor(rand() * 1_000_000);
    const scores: [number, number][] = [
      [2, 0],
      [1, 1],
      [0, 3],
    ];
    for (let i = 0; i < 500; i++) {
      const w = [draw(), draw(), draw()];
      const sum = w[0]! + w[1]! + w[2]!;
      const ppm = w.map((x) => Math.max(1, Math.round((x / sum) * 1_000_000)));
      const odds = w.map((x) => Math.max(1000, Math.round((sum / x) * 1000)));
      const card = computeScorecard(oneXTwo('e', { odds, consensus: ppm, pinnacle: ppm }), [
        event('e', 'finished', scores[i % 3]!),
      ]);
      const w3 = card.overall.oneXTwo.withPinnacle;
      for (const s of [w3.ours, w3.consensus, w3.pinnacle]) {
        expect(s).not.toBeNull();
        expect(s!.rps).toBeGreaterThanOrEqual(0);
        expect(s!.rps).toBeLessThanOrEqual(1);
        expect(s!.brier).toBeGreaterThanOrEqual(0);
        expect(s!.brier).toBeLessThanOrEqual(2);
        expect(s!.logLoss).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
