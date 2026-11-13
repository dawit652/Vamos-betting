import { describe, expect, it } from 'vitest';
import {
  buildWeeklyReport,
  isoWeekId,
  lastCompleteWeek,
  parseWeekId,
  weeklyMeasures,
  type WeeklyInputs,
} from './weekly-report';

const week = parseWeekId('2026-W44')!;
const base: WeeklyInputs = {
  week,
  generatedAt: new Date('2026-11-04T08:00:00Z'),
  catalogue: { competitionsWithMatches: 67, matchesListed: 900 },
  options: { factoryCompetitions: 3, matches: 40, typicalPerMatch: 520 },
  reviewOpen: 0,
  settlement: { finished: 100, onRungA: 96, due48h: 120, settledOrVoid48h: 120 },
  audit: { count: 100, mismatches: 0, medianLatencyMinutes: 12.5 },
  scorecard: {
    events: 50,
    oneXTwoPinnacleN: 50,
    relLogLossVsPinnacle: 0.004,
    bestPriceN: 400,
    bestPriceShareAbove: 0,
  },
  trust: [{ upstream: 'openfootball', compared: 80, agreed: 80, trust: 'trusted' }],
  shadow: [{ label: 'B apply', decisions: 4, agreed: 4, disagreed: 0, pending: 0 }],
};
const row = (input: WeeklyInputs, id: string) => weeklyMeasures(input).find((m) => m.id === id)!;

describe('ISO weeks', () => {
  it('names and parses weeks, across the year boundary', () => {
    expect(isoWeekId(new Date('2026-10-29T12:00:00Z'))).toBe('2026-W44');
    expect(isoWeekId(new Date('2026-10-26T00:00:00Z'))).toBe('2026-W44');
    expect(isoWeekId(new Date('2026-10-25T23:59:59Z'))).toBe('2026-W43');
    expect(isoWeekId(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekId(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
    expect(week.from.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(week.to.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(parseWeekId('2026-W53')?.from.toISOString()).toBe('2026-12-28T00:00:00.000Z');
  });

  it('rejects text that is not a week', () => {
    for (const text of ['2026-W00', '2026-W54', '2025-W53', '2026-44', 'W44', '']) {
      expect(parseWeekId(text)).toBeNull();
    }
  });

  it('the last complete week is the one before the week of the clock', () => {
    expect(lastCompleteWeek(new Date('2026-10-29T12:00:00Z')).id).toBe('2026-W43');
    expect(lastCompleteWeek(new Date('2026-11-02T00:00:00Z')).id).toBe('2026-W44');
    expect(lastCompleteWeek(new Date('2027-01-04T10:00:00Z')).id).toBe('2026-W53');
  });
});

describe('weekly measures', () => {
  it('passes every measure that meets its target', () => {
    const marks = Object.fromEntries(weeklyMeasures(base).map((m) => [m.id, m.mark]));
    expect(marks).toMatchObject({
      competitions: 'pass',
      matches_listed: 'pass',
      options_typical: 'pass',
      pinnacle_1x2: 'pass',
      price_above_best: 'pass',
      review_waiting: 'pass',
      rung_a_share: 'pass',
      whistle_to_settled: 'pass',
      settled_48h: 'pass',
      wrong_results: 'pass',
      'trust:openfootball': 'pass',
      'ladder_shadow:B apply': 'pass',
    });
  });

  it('fails a measure that misses its target, at the edges', () => {
    const failing: WeeklyInputs = {
      ...base,
      catalogue: { competitionsWithMatches: 66, matchesListed: 799 },
      options: { factoryCompetitions: 1, matches: 3, typicalPerMatch: 499 },
      reviewOpen: 1,
      settlement: { finished: 100, onRungA: 94, due48h: 120, settledOrVoid48h: 119 },
      audit: { count: 100, mismatches: 1, medianLatencyMinutes: 20.5 },
      scorecard: { ...base.scorecard, relLogLossVsPinnacle: 0.011, bestPriceShareAbove: 0.005 },
      trust: [{ upstream: 'x', compared: 50, agreed: 40, trust: 'second_source' }],
      shadow: [{ label: 'C apply', decisions: 3, agreed: 2, disagreed: 1, pending: 0 }],
    };
    for (const m of weeklyMeasures(failing).filter((r) => r.mark !== 'unknown')) {
      if (m.id === 'price_age') continue;
      expect(m.mark, m.id).toBe('fail');
    }
    expect(row(failing, 'price_above_best').value).toBe('2 of 400');
    expect(row(failing, 'wrong_results').value).toBe('1 of 100');
  });

  it('meets the targets exactly at the edge', () => {
    const edge: WeeklyInputs = {
      ...base,
      catalogue: { competitionsWithMatches: 67, matchesListed: 800 },
      options: { factoryCompetitions: 1, matches: 3, typicalPerMatch: 500 },
      settlement: { finished: 100, onRungA: 95, due48h: 10, settledOrVoid48h: 10 },
      audit: { count: 2000, mismatches: 0, medianLatencyMinutes: 20 },
      scorecard: { ...base.scorecard, relLogLossVsPinnacle: 0.01 },
    };
    expect(row(edge, 'matches_listed').mark).toBe('pass');
    expect(row(edge, 'options_typical').mark).toBe('pass');
    expect(row(edge, 'rung_a_share').mark).toBe('pass');
    expect(row(edge, 'whistle_to_settled').mark).toBe('pass');
    expect(row(edge, 'pinnacle_1x2').mark).toBe('pass');
    // 1 wrong in 2,000 is not fewer than 1 in 2,000.
    expect(
      row(
        { ...edge, audit: { count: 2000, mismatches: 1, medianLatencyMinutes: 20 } },
        'wrong_results',
      ).mark,
    ).toBe('fail');
    expect(
      row(
        { ...edge, audit: { count: 2001, mismatches: 1, medianLatencyMinutes: 20 } },
        'wrong_results',
      ).mark,
    ).toBe('pass');
  });

  it('marks what the data cannot answer unknown, with the reason and no value', () => {
    const empty: WeeklyInputs = {
      ...base,
      options: { factoryCompetitions: 0, matches: 0, typicalPerMatch: null },
      settlement: { finished: 0, onRungA: 0, due48h: 0, settledOrVoid48h: 0 },
      audit: { count: 0, mismatches: 0, medianLatencyMinutes: null },
      scorecard: {
        events: 0,
        oneXTwoPinnacleN: 0,
        relLogLossVsPinnacle: null,
        bestPriceN: 0,
        bestPriceShareAbove: null,
      },
      trust: [{ upstream: 'openfootball', compared: 0, agreed: 0, trust: 'untrusted' }],
      shadow: [],
    };
    const unknownIds = [
      'options_typical',
      'options_top',
      'price_age',
      'pinnacle_1x2',
      'price_above_best',
      'rung_a_share',
      'whistle_to_settled',
      'settled_48h',
      'wrong_results',
      'trust:openfootball',
      'ladder_shadow',
      'hand_steps',
      'feed_cost',
    ];
    for (const id of unknownIds) {
      const m = row(empty, id);
      expect(m.mark, id).toBe('unknown');
      expect(m.value, id).toBeNull();
      expect(m.note.length, id).toBeGreaterThan(10);
    }
    expect(row(empty, 'options_typical').note).toContain('factory');
    // What the data does hold is still marked.
    expect(row(empty, 'competitions').mark).toBe('pass');
    expect(row(empty, 'review_waiting').mark).toBe('pass');
  });

  it('keeps a shadow rung with nothing yet to compare unknown', () => {
    const m = row(
      {
        ...base,
        shadow: [{ label: 'D void x', decisions: 2, agreed: 0, disagreed: 0, pending: 2 }],
      },
      'ladder_shadow:D void x',
    );
    expect(m.mark).toBe('unknown');
    expect(m.note).toContain('2 pending');
  });
});

describe('buildWeeklyReport', () => {
  it('writes a Markdown table with a row per measure, and a JSON twin', () => {
    const { markdown, json } = buildWeeklyReport(base);
    const lines = markdown.split('\n');
    expect(lines[0]).toBe('# Weekly report 2026-W44');
    expect(markdown).toContain('from 2026-10-26T00:00:00.000Z up to 2026-11-02T00:00:00.000Z');
    const header = lines.indexOf('| Measure | Target | This week | Mark | Note |');
    expect(header).toBeGreaterThan(0);
    expect(lines[header + 1]).toBe('| --- | --- | --- | --- | --- |');
    const tableRows = lines.slice(header + 2).filter((l) => l.startsWith('|'));
    expect(tableRows).toHaveLength(json.measures.length);
    expect(tableRows[0]).toBe(
      '| Football competitions with matches | 67 sharp | 67 | PASS | competitions with a match kicking off in the week |',
    );
    expect(markdown).toContain('| unknown |');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(json.week).toEqual({
      id: '2026-W44',
      from: '2026-10-26T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
    });
    expect(json.summary.pass + json.summary.fail + json.summary.unknown).toBe(json.measures.length);
    expect(json.summary.unknown).toBe(4);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('lists the market family moves after the measures, without counting them (task 2.5)', () => {
    expect(buildWeeklyReport(base).json.familyMoves).toBeNull();
    expect(buildWeeklyReport(base).markdown).toContain(
      'The weekly market family job has not run for this week.',
    );
    const none = buildWeeklyReport({ ...base, familyMoves: { ran: true, moves: [] } });
    expect(none.json.familyMoves).toEqual([]);
    expect(none.markdown).toContain('No market family was suspended, returned or turned off');
    const moved = buildWeeklyReport({
      ...base,
      familyMoves: {
        ran: true,
        moves: [
          {
            family: 'htft',
            move: 'suspend',
            marginBps: 1200,
            raisedMarginBps: 1400,
            reason: 'kept less | than expected',
          },
        ],
      },
    });
    expect(moved.markdown).toContain('## Market family moves');
    expect(moved.markdown).toContain(
      '| htft | suspended | 1200 bps | 1400 bps | kept less \\| than expected |',
    );
    expect(moved.json.summary).toEqual(buildWeeklyReport(base).json.summary);
    expect(moved.json.familyMoves).toHaveLength(1);
  });

  it('keeps a pipe in a note from breaking the table', () => {
    const { markdown } = buildWeeklyReport({
      ...base,
      shadow: [{ label: 'a|b', decisions: 1, agreed: 1, disagreed: 0, pending: 0 }],
    });
    expect(markdown).toContain('Ladder shadow, a\\|b');
  });
});
