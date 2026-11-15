import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type LeagueMetrics,
  type LeagueStage,
  LEAGUE_STAGES,
  leagueClass,
  nextLeagueStage,
  stagePermissions,
} from './stages';

const DAY = 86_400_000;
const NOW = new Date('2026-12-01T03:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const GOOD: LeagueMetrics = {
  bound: true,
  sourcesWritten: true,
  clubsMapped: { hits: 20, total: 20 },
  kickoffAgreement: { hits: 99, total: 100 },
  sharpConsensus: { hits: 95, total: 100 },
  sharpConsensusLastWeek: { hits: 10, total: 10 },
  shadowResultsMatched: 25,
  settledMatches: 45,
  wrongResults: 0,
  medianClv: 0.004,
  pricesAboveBest: 0,
  sourceLostTrust: false,
};

const decide = (stage: LeagueStage, days: number, metrics: Partial<LeagueMetrics> = {}) =>
  nextLeagueStage({ stage, since: daysAgo(days), now: NOW, metrics: { ...GOOD, ...metrics } });

describe('nextLeagueStage', () => {
  it('climbs one stage a night when the gates pass', () => {
    expect(decide('found', 0)).toEqual({
      stage: 'shadow',
      changed: true,
      reasons: ['sources_written'],
    });
    expect(decide('shadow', 14)).toEqual({
      stage: 'open_low',
      changed: true,
      reasons: ['gates_passed'],
    });
    expect(decide('open_low', 28)).toEqual({
      stage: 'normal',
      changed: true,
      reasons: ['gates_passed'],
    });
    expect(decide('normal', 100)).toEqual({ stage: 'normal', changed: false, reasons: [] });
  });

  it('names every gate that still fails', () => {
    expect(
      decide('shadow', 13, {
        clubsMapped: { hits: 19, total: 20 },
        kickoffAgreement: { hits: 97, total: 100 },
        sharpConsensus: { hits: 89, total: 100 },
        shadowResultsMatched: 19,
      }).reasons,
    ).toEqual([
      'shadow_days',
      'clubs_not_all_mapped',
      'kickoff_agreement',
      'sharp_consensus',
      'shadow_results',
    ]);
    expect(
      decide('open_low', 27, { settledMatches: 39, medianClv: null, pricesAboveBest: 1 }).reasons,
    ).toEqual(['open_low_days', 'settled_matches', 'closing_line_value', 'price_above_best']);
    expect(decide('open_low', 30, { medianClv: -0.001 }).stage).toBe('open_low');
  });

  it('goes back to shadow on a wrong result, a weak consensus for a week, or lost trust', () => {
    for (const stage of ['open_low', 'normal'] as const) {
      expect(decide(stage, 50, { wrongResults: 1 })).toEqual({
        stage: 'shadow',
        changed: true,
        reasons: ['wrong_result'],
      });
      expect(decide(stage, 50, { sharpConsensusLastWeek: { hits: 6, total: 10 } }).reasons).toEqual(
        ['sharp_consensus_below_70'],
      );
      expect(decide(stage, 50, { sourceLostTrust: true }).stage).toBe('shadow');
      expect(decide(stage, 50, { bound: false }).reasons).toEqual(['binding_lost']);
    }
  });

  it('fails closed on unreadable shares', () => {
    expect(decide('shadow', 20, { kickoffAgreement: { hits: 0, total: 0 } }).stage).toBe('shadow');
    expect(decide('shadow', 20, { clubsMapped: { hits: 0, total: 0 } }).stage).toBe('shadow');
    expect(decide('shadow', 20, { sharpConsensus: { hits: 101, total: 100 } }).stage).toBe(
      'shadow',
    );
    expect(() =>
      nextLeagueStage({ stage: 'shadow', since: new Date(Number.NaN), now: NOW, metrics: GOOD }),
    ).toThrow(RangeError);
  });

  it('never skips a stage and only goes down to shadow', () => {
    const share = fc.record({
      hits: fc.integer({ min: 0, max: 100 }),
      total: fc.integer({ min: 0, max: 100 }),
    });
    const metrics = fc.record({
      bound: fc.boolean(),
      sourcesWritten: fc.boolean(),
      clubsMapped: share,
      kickoffAgreement: share,
      sharpConsensus: share,
      sharpConsensusLastWeek: share,
      shadowResultsMatched: fc.integer({ min: 0, max: 50 }),
      settledMatches: fc.integer({ min: 0, max: 80 }),
      wrongResults: fc.integer({ min: 0, max: 2 }),
      medianClv: fc.option(fc.double({ min: -0.05, max: 0.05, noNaN: true })),
      pricesAboveBest: fc.integer({ min: 0, max: 2 }),
      sourceLostTrust: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.constantFrom(...LEAGUE_STAGES),
        fc.integer({ min: 0, max: 60 }),
        metrics,
        (stage, days, m) => {
          const decision = nextLeagueStage({ stage, since: daysAgo(days), now: NOW, metrics: m });
          const from = LEAGUE_STAGES.indexOf(stage);
          const to = LEAGUE_STAGES.indexOf(decision.stage);
          if (to > from) expect(to).toBe(from + 1);
          if (to < from) expect(decision.stage).toBe('shadow');
          if (m.wrongResults > 0) expect(to).toBeLessThanOrEqual(LEAGUE_STAGES.indexOf('shadow'));
          expect(decision.changed).toBe(to !== from);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('stagePermissions', () => {
  it('lists, opens and settles only from stage 2, at a quarter of the limits', () => {
    expect(stagePermissions('shadow')).toEqual({
      listed: false,
      autoOpen: false,
      autoResults: false,
      limitShare: 0,
    });
    expect(stagePermissions('open_low').limitShare).toBe(0.25);
    expect(stagePermissions('normal')).toEqual({
      listed: true,
      autoOpen: true,
      autoResults: true,
      limitShare: 1,
    });
  });
});

describe('leagueClass', () => {
  it('is sharp on a sharp consensus, soft only when allowed, else none', () => {
    const sharp = {
      sharpFixtures: { hits: 95, total: 100 },
      softFixtures: { hits: 0, total: 100 },
    };
    const soft = {
      sharpFixtures: { hits: 10, total: 100 },
      softFixtures: { hits: 95, total: 100 },
    };
    expect(leagueClass(sharp, { softAllowed: false })).toBe('sharp');
    expect(leagueClass(soft, { softAllowed: false })).toBe('none');
    expect(leagueClass(soft, { softAllowed: true })).toBe('soft');
    expect(
      leagueClass(
        { sharpFixtures: { hits: 0, total: 0 }, softFixtures: { hits: 0, total: 0 } },
        { softAllowed: true },
      ),
    ).toBe('none');
  });
});
