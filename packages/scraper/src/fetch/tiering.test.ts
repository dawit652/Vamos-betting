import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coverageMatrix, type CoverageEntry } from '../adapters/capabilities';
import { DAY_MS, HOUR_MS, MIN_INDEPENDENT_SOURCES, MINUTE_MS } from '../constants';
import { estimateOddsReadsPerDay } from './budget';
import { marketOddsPollIntervalMs } from './cadence';
import { CREDIT_GUARD_MODES, type CreditGuardMode } from './credit-guard';
import { competitionTier, redundantScoresSource, type ScoresCandidate } from './tiering';

const now = new Date('2026-11-07T10:00:00Z');
const at = (h: number) => new Date(now.getTime() + h * HOUR_MS);

describe('competitionTier (C-2)', () => {
  it('is priority for everything while no priority list is set (as before C-2)', () => {
    expect(competitionTier(['la-liga'], null)).toBe('priority');
    expect(competitionTier(['la-liga'], [])).toBe('priority');
  });

  it('is standard only for resolved competitions none of which is listed', () => {
    const list = ['premier-league', ' La-Liga '];
    expect(competitionTier(['premier-league'], list)).toBe('priority');
    expect(competitionTier(['la-liga'], list)).toBe('priority');
    expect(competitionTier(['serie-a'], list)).toBe('standard');
    expect(competitionTier(['serie-a', 'la-liga'], list)).toBe('priority');
    // Unknown competition or no competition: never slowed down by mistake.
    expect(competitionTier([null], list)).toBe('priority');
    expect(competitionTier(['serie-a', null], list)).toBe('priority');
    expect(competitionTier([], list)).toBe('priority');
  });
});

describe('marketOddsPollIntervalMs with a tier (C-2)', () => {
  it('reads a standard competition 30 min / 2 h / 170 min / 6 h in the same bands', () => {
    expect(marketOddsPollIntervalMs(now, at(2), 'normal', 'standard')).toBe(30 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'normal', 'standard')).toBe(2 * HOUR_MS);
    expect(marketOddsPollIntervalMs(now, at(24 * 10), 'normal', 'standard')).toBe(170 * 60_000);
    expect(marketOddsPollIntervalMs(now, null, 'normal', 'standard')).toBe(6 * HOUR_MS);
    // The default (no tier) and priority are today's schedule.
    expect(marketOddsPollIntervalMs(now, at(2), 'normal')).toBe(10 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(2), 'normal', 'priority')).toBe(10 * MINUTE_MS);
  });

  it('keeps the guard on top: economy, minimal and stop never read a standard league more often', () => {
    expect(marketOddsPollIntervalMs(now, at(2), 'economy', 'standard')).toBe(30 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'economy', 'standard')).toBe(2 * HOUR_MS);
    expect(marketOddsPollIntervalMs(now, at(2), 'minimal', 'standard')).toBe(30 * MINUTE_MS);
    expect(marketOddsPollIntervalMs(now, at(20), 'minimal', 'standard')).toBeNull();
    expect(marketOddsPollIntervalMs(now, at(1), 'stop', 'standard')).toBeNull();
  });

  const kickoffArb = fc.option(fc.integer({ min: -2 * 3600, max: 40 * 24 * 3600 }), { nil: null });
  const modeArb = fc.constantFrom<CreditGuardMode>(...CREDIT_GUARD_MODES);
  const kick = (s: number | null) => (s === null ? null : new Date(now.getTime() + s * 1000));
  const inf = (v: number | null) => v ?? Number.POSITIVE_INFINITY;

  it('a standard competition is never read more often than a priority one, nor than the guard allows (property)', () => {
    fc.assert(
      fc.property(kickoffArb, modeArb, (s, mode) => {
        const priority = inf(marketOddsPollIntervalMs(now, kick(s), mode, 'priority'));
        const standard = inf(marketOddsPollIntervalMs(now, kick(s), mode, 'standard'));
        expect(standard).toBeGreaterThanOrEqual(priority);
        // At most four times slower (30 min -> 2 h): it stays a read schedule, never a stop.
        if (Number.isFinite(priority)) expect(standard).toBeLessThanOrEqual(4 * priority);
        else expect(standard).toBe(Number.POSITIVE_INFINITY);
      }),
    );
  });

  it('the budget estimate of a standard competition never exceeds the priority one (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 14 * 24 }), { maxLength: 6 }), (hours) => {
        const kickoffs = hours.map((h) => at(h));
        const sum = (tier: 'priority' | 'standard') =>
          estimateOddsReadsPerDay({ now, kickoffs, days: 15, horizonMs: 15 * DAY_MS, tier }).reduce(
            (a, b) => a + b,
            0,
          );
        expect(sum('standard')).toBeLessThanOrEqual(sum('priority'));
      }),
      { numRuns: 50 },
    );
  });
});

const entry = (
  competition: string,
  sourceId: string,
  upstream: string,
  fullTime: boolean,
  halfTime: boolean,
): CoverageEntry => ({
  competition,
  sourceId,
  upstream,
  capabilities: { fixtures: true, fullTime, halfTime: fullTime && halfTime, basis: 'declared' },
});

describe('redundantScoresSource (C-2)', () => {
  const scores: ScoresCandidate = {
    sourceId: 'scores-epl',
    upstream: 'TheOddsAPI',
    competition: 'epl',
  };
  const self = entry('epl', 'scores-epl', 'TheOddsAPI', true, false);
  const candidates = new Set(['scores-epl']);

  it('is needed while it is one of the two full-time upstreams (R2)', () => {
    const fd = entry('epl', 'fd', 'football-data.org', true, true);
    expect(redundantScoresSource(scores, [self, fd], candidates)).toBe(false);
    expect(redundantScoresSource(scores, [self], candidates)).toBe(false);
  });

  it('is redundant when two other upstreams give full time and one of them half time', () => {
    const fd = entry('epl', 'fd', 'football-data.org', true, true);
    const of = entry('epl', 'of', 'openfootball', true, false);
    expect(redundantScoresSource(scores, [self, fd, of], candidates)).toBe(true);
    // Without any half time among them it is kept (the plan: football-data.org gives FT and HT).
    const ofNoHt = entry('epl', 'of', 'openfootball', true, false);
    const fdNoHt = entry('epl', 'fd', 'football-data.org', true, false);
    expect(redundantScoresSource(scores, [self, fdNoHt, ofNoHt], candidates)).toBe(false);
  });

  it('counts upstreams, not sources, and never its own upstream, other competitions or candidates', () => {
    const fd1 = entry('epl', 'fd1', 'football-data.org', true, true);
    const fd2 = entry('epl', 'fd2', 'Football-Data.org ', true, true);
    expect(redundantScoresSource(scores, [self, fd1, fd2], candidates)).toBe(false);
    const sameUpstream = entry('epl', 'odds-epl-2', 'theoddsapi', true, false);
    expect(redundantScoresSource(scores, [self, fd1, sameUpstream], candidates)).toBe(false);
    const elsewhere = entry('liga', 'of', 'openfootball', true, true);
    expect(redundantScoresSource(scores, [self, fd1, elsewhere], candidates)).toBe(false);
    const otherCandidate = entry('epl', 'rundown', 'TheRundown', true, false);
    expect(
      redundantScoresSource(
        scores,
        [self, fd1, otherCandidate],
        new Set(['scores-epl', 'rundown']),
      ),
    ).toBe(false);
    // Prices only (no full time) never count.
    const prices = entry('epl', 'odds', 'pinnacle-feed', false, false);
    expect(redundantScoresSource(scores, [self, fd1, prices], candidates)).toBe(false);
  });

  it('is never redundant for an unresolved competition', () => {
    const fd = entry('epl', 'fd', 'football-data.org', true, true);
    const of = entry('epl', 'of', 'openfootball', true, true);
    expect(
      redundantScoresSource({ ...scores, competition: null }, [self, fd, of], candidates),
    ).toBe(false);
  });

  it('skipping every redundant candidate never takes a competition below the full-time upstreams R2 needs (property)', () => {
    const upstreams = ['TheOddsAPI', 'football-data.org', 'openfootball', 'TheRundown', 'site-x'];
    const competitions = ['epl', 'liga'];
    const entryArb = fc.record({
      competition: fc.constantFrom(...competitions),
      upstream: fc.constantFrom(...upstreams),
      fullTime: fc.boolean(),
      halfTime: fc.boolean(),
      candidate: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), (raw) => {
        const entries = raw.map((r, i) =>
          entry(r.competition, `s${i}`, r.upstream, r.fullTime || r.candidate, r.halfTime),
        );
        const cands = new Set(raw.flatMap((r, i) => (r.candidate ? [`s${i}`] : [])));
        const skipped = new Set(
          entries
            .filter((e) => cands.has(e.sourceId))
            .filter((e) =>
              redundantScoresSource(
                { sourceId: e.sourceId, upstream: e.upstream, competition: e.competition },
                entries,
                cands,
              ),
            )
            .map((e) => e.sourceId),
        );
        const before = new Map(coverageMatrix(entries).map((r) => [r.competition, r]));
        const after = new Map(
          coverageMatrix(entries.filter((e) => !skipped.has(e.sourceId))).map((r) => [
            r.competition,
            r,
          ]),
        );
        for (const [competition, row] of before) {
          const left = after.get(competition);
          const ft = left?.fullTimeUpstreams ?? 0;
          expect(ft).toBeGreaterThanOrEqual(
            Math.min(row.fullTimeUpstreams, MIN_INDEPENDENT_SOURCES),
          );
          if (row.halfTimeUpstreams > 0) expect(left?.halfTimeUpstreams ?? 0).toBeGreaterThan(0);
        }
      }),
    );
  });
});
