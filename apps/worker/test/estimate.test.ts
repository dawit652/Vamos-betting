import { describe, expect, it } from 'vitest';
import {
  estimateLeagueCredits,
  factorToFit,
  type LeagueCalendar,
} from '../src/tasks/oddsapi/estimate';

/**
 * What the schedule costs on the 20 000-credit plan with football first
 * (ODDS_API_SPORT_SHARES football:90): four weeks of typical fixtures.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = new Date('2026-11-02T00:00:00Z'); // a Monday
const SPAN = { from: FROM, to: new Date(FROM.getTime() + 28 * DAY_MS) };
const perMonth = (credits: number): number => Math.round((credits * 30) / 28);

/** Kick-offs on (day of week from Monday, "HH:MM" UTC) in the given weeks of the span. */
function weekly(slots: Array<[number, string]>, weeks = [0, 1, 2, 3]): Date[] {
  return weeks
    .flatMap((week) =>
      slots.map(([day, time]) => {
        const [hours = 0, minutes = 0] = time.split(':').map(Number);
        return new Date(
          FROM.getTime() + (week * 7 + day) * DAY_MS + (hours * 60 + minutes) * 60_000,
        );
      }),
    )
    .sort((a, b) => a.getTime() - b.getTime());
}

const football = (kickoffs: Date[]): LeagueCalendar => ({
  kickoffs,
  oddsCost: 2,
  matchMs: 115 * 60_000,
});
/** A domestic league's round: Saturday 12:30, 15:00, 17:30; Sunday 14:00, 16:30; Monday 20:00. */
const domestic = football(
  weekly([
    [5, '12:30'],
    [5, '15:00'],
    [5, '17:30'],
    [6, '14:00'],
    [6, '16:30'],
    [7, '20:00'],
  ]),
);
/** Champions League nights every other week; Europa / Conference League Thursdays. */
const championsLeague = football(
  weekly(
    [
      [1, '17:45'],
      [1, '20:00'],
      [2, '17:45'],
      [2, '20:00'],
    ],
    [0, 2],
  ),
);
const thursdayCup = football(
  weekly(
    [
      [3, '17:45'],
      [3, '20:00'],
    ],
    [0, 2],
  ),
);
/** Nightly NBA games (five tip-off times). */
const nba: LeagueCalendar = {
  kickoffs: weekly(
    [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
      ['00:00', '00:30', '01:00', '02:00', '03:00'].map((time): [number, string] => [day, time]),
    ),
  ),
  oddsCost: 2,
  matchMs: 150 * 60_000,
};
/** The football leagues on by default: nine weekly leagues and three European competitions. */
const defaultFootball = [
  ...Array.from({ length: 9 }, () => domestic),
  championsLeague,
  thursdayCup,
  thursdayCup,
];
const footballShare = (18_000 * 28) / 30;

describe('credits on the 20 000-credit plan', () => {
  it('prices a weekly league for about 2 000 credits a month at full speed', () => {
    const full = estimateLeagueCredits(domestic, { ...SPAN, factor: 1 });
    expect(perMonth(full.total)).toBeGreaterThan(1500);
    expect(perMonth(full.total)).toBeLessThan(2600);
    // Live scores without daysFrom: scores stay a small part of the bill.
    expect(full.scores).toBeLessThan(full.odds / 3);
  });

  it('fits the default football leagues in football’s 90% at almost full speed', () => {
    const factor = factorToFit(defaultFootball, footballShare, SPAN);
    expect(factor).not.toBeNull();
    expect(factor).toBeLessThanOrEqual(1.5);
  });

  it('fits twenty weekly leagues and the European cups by stretching days-ahead polls', () => {
    const many = [
      ...Array.from({ length: 20 }, () => domestic),
      championsLeague,
      thursdayCup,
      thursdayCup,
    ];
    const factor = factorToFit(many, footballShare, SPAN);
    expect(factor).not.toBeNull();
    // The last 6 hours stretch by √factor only: under twice as slow.
    expect(Math.sqrt(factor ?? Infinity)).toBeLessThan(2);
  });

  it('never costs more for a slower schedule, and shows why the NBA gets only a share', () => {
    for (const league of [domestic, championsLeague, nba]) {
      let previous = Infinity;
      for (const factor of [1, 1.5, 2, 4, 8, 24]) {
        const total = estimateLeagueCredits(league, { ...SPAN, factor }).total;
        expect(total).toBeLessThanOrEqual(previous);
        previous = total;
      }
    }
    // Games every night keep the NBA near tip-off all the time.
    expect(perMonth(estimateLeagueCredits(nba, { ...SPAN, factor: 1 }).total)).toBeGreaterThan(
      5000,
    );
  });
});
