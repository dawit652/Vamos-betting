import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TeamRatings } from '../types';
import { FOOTBALL_HOME_ADVANTAGE } from './football';
import {
  HOME_ADVANTAGE_KEY,
  HOME_ADVANTAGE_MAX,
  HOME_ADVANTAGE_MIN,
  type HomeAdvantageEvidence,
  homeAdvantageOf,
  learnedHomeAdvantage,
  setsHomeAdvantage,
} from './homeadvantage';
import { matchStrengths } from './index';
import { ratingsAfterResult, updateFootballRatings } from './ratings';

/** P-8: only league results write the home advantage; a cup result never overwrites it. */

const ratingsArb: fc.Arbitrary<TeamRatings> = fc.record(
  {
    attack: fc.double({ min: 0.3, max: 3, noNaN: true }),
    defence: fc.double({ min: 0.3, max: 3, noNaN: true }),
    matches: fc.integer({ min: 0, max: 400 }),
    manual: fc.constantFrom(0, 1),
    homeAdvantage: fc.double({ min: HOME_ADVANTAGE_MIN, max: HOME_ADVANTAGE_MAX, noNaN: true }),
  },
  { requiredKeys: ['attack', 'defence', 'matches'] },
);
const optionalRatingsArb = fc.option(ratingsArb, { nil: null });
const scoreArb = fc.record({
  home: fc.integer({ min: 0, max: 9 }),
  away: fc.integer({ min: 0, max: 9 }),
});
const evidenceArb: fc.Arbitrary<HomeAdvantageEvidence | null> = fc.option(
  fc.integer({ min: 0, max: 2000 }).chain((matches) =>
    fc.record({
      matches: fc.constant(matches),
      homeGoals: fc.integer({ min: 0, max: matches * 5 }),
      awayGoals: fc.integer({ min: 0, max: matches * 5 }),
    }),
  ),
  { nil: null },
);

const stored = (ratings: TeamRatings | null): number | undefined =>
  ratings !== null && Object.hasOwn(ratings, HOME_ADVANTAGE_KEY)
    ? ratings[HOME_ADVANTAGE_KEY]
    : undefined;

describe('ratingsAfterResult (P-8)', () => {
  it('property: a cup result never changes the stored home advantage, and learns like any result', () => {
    fc.assert(
      fc.property(
        optionalRatingsArb,
        optionalRatingsArb,
        scoreArb,
        evidenceArb,
        (home, away, score, evidence) => {
          const next = ratingsAfterResult(home, away, score, { league: false, evidence });
          expect(stored(next.home)).toBe(stored(home));
          expect(stored(next.away)).toBe(stored(away));
          expect(Object.hasOwn(next.home, HOME_ADVANTAGE_KEY)).toBe(
            home !== null && Object.hasOwn(home, HOME_ADVANTAGE_KEY),
          );
          // attack, defence and matches move exactly as for any other result.
          expect(next).toEqual(updateFootballRatings(home, away, score));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: after a league result, any number of cup results keep the league value it priced with', () => {
    fc.assert(
      fc.property(
        ratingsArb,
        ratingsArb,
        scoreArb,
        evidenceArb,
        fc.array(fc.tuple(fc.boolean(), scoreArb, evidenceArb), { maxLength: 10 }),
        (home, away, score, leagueEvidence, cups) => {
          let next = ratingsAfterResult(home, away, score, {
            league: true,
            evidence: leagueEvidence,
          });
          const leagueValue = learnedHomeAdvantage(leagueEvidence);
          for (const [swap, cupScore, cupEvidence] of cups) {
            // Cup ties in either direction (the team at home or away).
            const after = swap
              ? ratingsAfterResult(next.away, next.home, cupScore, {
                  league: false,
                  evidence: cupEvidence,
                })
              : ratingsAfterResult(next.home, next.away, cupScore, {
                  league: false,
                  evidence: cupEvidence,
                });
            next = swap ? { home: after.away, away: after.home } : after;
          }
          for (const team of [next.home, next.away]) {
            expect(homeAdvantageOf(team)).toBe(leagueValue);
          }
          // The next league home match is priced with the league value.
          const strengths = matchStrengths('football', next.home, next.away);
          const withLeague = matchStrengths(
            'football',
            { ...next.home, [HOME_ADVANTAGE_KEY]: leagueValue },
            next.away,
          );
          expect(strengths).toEqual(withLeague);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a league result writes the learned value on both teams; with too few results the default', () => {
    const home = { attack: 1.2, defence: 0.9, matches: 20, homeAdvantage: 1.27 };
    const away = { attack: 0.9, defence: 1.1, matches: 20 };
    const evidence = { matches: 400, homeGoals: 700, awayGoals: 500 };
    const learned = learnedHomeAdvantage(evidence);
    expect(learned).toBeGreaterThan(FOOTBALL_HOME_ADVANTAGE);
    const next = ratingsAfterResult(home, away, { home: 2, away: 1 }, { league: true, evidence });
    expect(next.home.homeAdvantage).toBe(learned);
    expect(next.away.homeAdvantage).toBe(learned);
    // F-07 unchanged for a league: too few results write the default over a stored value...
    const few = ratingsAfterResult(
      home,
      away,
      { home: 2, away: 1 },
      {
        league: true,
        evidence: { matches: 3, homeGoals: 9, awayGoals: 1 },
      },
    );
    expect(few.home.homeAdvantage).toBe(FOOTBALL_HOME_ADVANTAGE);
    // ...and leave ratings without one alone.
    expect(few.away).not.toHaveProperty('homeAdvantage');
  });

  it('the same cup result leaves a stored league value in place (the reported bug)', () => {
    const home = { attack: 1.2, defence: 0.9, matches: 20, homeAdvantage: 1.27 };
    const away = { attack: 0.9, defence: 1.1, matches: 20, homeAdvantage: 1.21 };
    const next = ratingsAfterResult(
      home,
      away,
      { home: 0, away: 3 },
      {
        league: false,
        evidence: { matches: 3, homeGoals: 9, awayGoals: 1 },
      },
    );
    expect(next.home.homeAdvantage).toBe(1.27);
    expect(next.away.homeAdvantage).toBe(1.21);
    expect(next.home.matches).toBe(21);
  });
});

describe('setsHomeAdvantage (P-8)', () => {
  const leagues = [
    'premier-league',
    'championship',
    'league-one',
    'league-two',
    'primera-division',
    'ethiopian-premier-league',
    'laliga',
    'serie-a',
    'bundesliga',
    'ligue-1',
    'eredivisie',
    'belgian-pro-league',
    'primeira-liga',
    'scottish-premiership',
    'brasileirao-serie-a',
    'swiss-super-league',
    'super-lig',
    'saudi-pro-league',
  ];
  const cups = [
    'fa-cup',
    'efl-cup',
    'copa-del-rey',
    'coppa-italia',
    'dfb-pokal',
    'coupe-de-france',
    'uefa-champions-league',
    'uefa-europa-league',
    'uefa-conference-league',
    'caf-champions-league',
    'caf-confederation-cup',
    'community_shield',
    'knvb-beker',
    'eredivisie-playoffs',
    'Copa-Libertadores',
    'club-friendlies',
  ];

  it('the catalogue leagues set it, its cups and club competitions do not', () => {
    for (const slug of leagues) expect(setsHomeAdvantage({ slug, extraTime: false })).toBe(true);
    for (const slug of cups) expect(setsHomeAdvantage({ slug, extraTime: false })).toBe(false);
  });

  it('a competition whose policy has extra time on is a cup whatever its slug', () => {
    for (const slug of [...leagues, ...cups]) {
      expect(setsHomeAdvantage({ slug, extraTime: true })).toBe(false);
    }
  });
});
