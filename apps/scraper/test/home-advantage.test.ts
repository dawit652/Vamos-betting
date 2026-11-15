import { setCompetitionPolicy } from '@vamos/db';
import { FOOTBALL_HOME_ADVANTAGE, learnedHomeAdvantage, priceFixture } from '@vamos/feed';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyConfirmedResult } from '../src/pipeline/promote-results';
import { updateRatingsForResult } from '../src/pipeline/result-ratings';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/** F-07: the competition's home advantage is learned from its finished results. */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

async function createdEvent(): Promise<{ eventId: string; feedRef: string }> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string; feed_ref: string }>(
    `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped'`,
  );
  return { eventId: event!.id, feedRef: event!.feed_ref };
}

/** `count` finished events of the competition with the same score, as stored history. */
async function finishedHistory(
  count: number,
  score: [number, number],
  provider = 'scraped',
): Promise<void> {
  await h.pool.query(
    `INSERT INTO events (game_id, sport_id, competition_id, home_team_id, away_team_id, start_time,
                         status, score_home, score_away, feed_provider, feed_ref, resulted_at)
     SELECT 700000 + g + $7, 'football', $1, $2, $3, now() - interval '30 days', 'finished', $4, $5,
            $6, $6 || '-' || g, now() - interval '30 days'
       FROM generate_series(1, $8::int) AS g`,
    [
      h.premier,
      h.team('Arsenal'),
      h.team('Chelsea'),
      score[0],
      score[1],
      provider,
      provider === 'scraped' ? 0 : 5000,
      count,
    ],
  );
}

const ratingsOf = async (name: string) =>
  (
    await rows<{ ratings: Record<string, number> }>(`SELECT ratings FROM teams WHERE id = $1`, [
      h.team(name),
    ])
  )[0]!.ratings;

const apply = (eventId: string, feedRef: string, home: number, away: number) =>
  applyConfirmedResult(h.ctx, {
    eventId,
    feedRef,
    score: { home, away, htHome: 1, htAway: 0 },
    upstreams: ['openfootball', 'example-api'],
    sources: ['src-a', 'src-b'],
    observations: [],
    via: 'staff',
  });

describe('F-07: home advantage from the competition results', () => {
  it(
    'a competition with too few results keeps the default: no key is written',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      await finishedHistory(10, [3, 0]);
      expect((await apply(eventId, feedRef, 2, 1)).applied).toBe(true);
      for (const name of ['Arsenal', 'Chelsea']) {
        const ratings = await ratingsOf(name);
        expect(ratings).not.toHaveProperty('homeAdvantage');
        expect(ratings.matches).toBe(11);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'after enough results both teams carry the learned value, and it prices the next match',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      // 60 stored results at 3-1 and 100 of another provider at 9-0, which must not count.
      await finishedHistory(60, [3, 1]);
      await finishedHistory(100, [9, 0], 'mock');
      expect((await apply(eventId, feedRef, 2, 1)).applied).toBe(true);

      const expected = learnedHomeAdvantage({
        matches: 61,
        homeGoals: 60 * 3 + 2,
        awayGoals: 60 + 1,
      });
      expect(expected).toBeGreaterThan(1.15);
      for (const name of ['Arsenal', 'Chelsea']) {
        expect((await ratingsOf(name)).homeAdvantage).toBe(expected);
      }
      // The home team's value is what a fixture is priced with.
      const arsenal = await ratingsOf('Arsenal');
      const chelsea = await ratingsOf('Chelsea');
      const learned = priceFixture('football', arsenal, chelsea);
      const { homeAdvantage: _drop, ...plain } = arsenal;
      const flat = priceFixture('football', plain, chelsea);
      const home = (markets: typeof learned): number =>
        markets.find((m) => m.type === '1x2')!.selections.find((s) => s.code === '1')!.oddsMilli;
      expect(home(learned)).toBeLessThan(home(flat));
    },
    TEST_TIMEOUT,
  );

  it(
    'a result applied twice moves the value once, and stored ratings keep it',
    async () => {
      const { eventId, feedRef } = await createdEvent();
      await finishedHistory(60, [3, 1]);
      expect((await apply(eventId, feedRef, 2, 1)).applied).toBe(true);
      const once = await ratingsOf('Arsenal');
      expect((await apply(eventId, feedRef, 2, 1)).applied).toBe(false);
      expect(await ratingsOf('Arsenal')).toEqual(once);
    },
    TEST_TIMEOUT,
  );
});

/** P-8: only league results write the home advantage; cups and European competitions do not. */
describe('P-8: a cup result does not overwrite the league home advantage', () => {
  const competition = (slug: string): string => {
    const id = h.ids.competitions.get(`football/${slug}`);
    if (id === undefined) throw new Error(`no competition ${slug}`);
    return id;
  };

  /** `count` finished scraped events of another competition, as its stored results. */
  async function cupHistory(
    competitionId: string,
    count: number,
    score: [number, number],
  ): Promise<void> {
    await h.pool.query(
      `INSERT INTO events (game_id, sport_id, competition_id, home_team_id, away_team_id, start_time,
                           status, score_home, score_away, feed_provider, feed_ref, resulted_at)
       SELECT 800000 + g, 'football', $1, $2, $3, now() - interval '20 days', 'finished', $4, $5,
              'scraped', 'cup-' || g, now() - interval '20 days'
         FROM generate_series(1, $6::int) AS g`,
      [competitionId, h.team('Chelsea'), h.team('Arsenal'), score[0], score[1], count],
    );
  }

  /** A finished tie of `competitionId` rated as the result pipeline rates it (gate or hand). */
  const rateTie = (feedRef: string, competitionId: string, home: number, away: number) =>
    h.ctx.db.transaction((tx) =>
      updateRatingsForResult(tx, {
        feedRef,
        competitionId,
        homeTeamId: h.team('Arsenal'),
        awayTeamId: h.team('Chelsea'),
        score: { home, away },
      }),
    );

  /** A league result through the gate with 60 stored results at 3-1: the learned league value. */
  async function leagueValue(): Promise<number> {
    const { eventId, feedRef } = await createdEvent();
    await finishedHistory(60, [3, 1]);
    expect((await apply(eventId, feedRef, 2, 1)).applied).toBe(true);
    const expected = learnedHomeAdvantage({ matches: 61, homeGoals: 182, awayGoals: 61 });
    expect(expected).not.toBe(FOOTBALL_HOME_ADVANTAGE);
    for (const name of ['Arsenal', 'Chelsea']) {
      expect((await ratingsOf(name)).homeAdvantage).toBe(expected);
    }
    return expected;
  }

  it(
    'a league result updates it; a cup result with few or many results of its own leaves it',
    async () => {
      const league = await leagueValue();
      // A cup with too few results (before P-8 the default 1.15 was written over the league value).
      const before = await ratingsOf('Arsenal');
      expect(await rateTie('fa-cup-tie-1', competition('fa-cup'), 0, 2)).toBe(true);
      const afterFew = await ratingsOf('Arsenal');
      expect(afterFew.homeAdvantage).toBe(league);
      expect((await ratingsOf('Chelsea')).homeAdvantage).toBe(league);
      // The cup result still taught attack, defence and matches.
      expect(afterFew.matches).toBe(before.matches! + 1);
      expect(afterFew.attack).toBeLessThan(before.attack!);

      // A European competition with plenty of results and a home edge of its own (1-1 every time,
      // a learned value unlike the league's) writes nothing either.
      const ucl = competition('uefa-champions-league');
      await cupHistory(ucl, 200, [1, 1]);
      expect(learnedHomeAdvantage({ matches: 201, homeGoals: 201, awayGoals: 201 })).not.toBe(
        league,
      );
      expect(await rateTie('ucl-tie-1', ucl, 1, 1)).toBe(true);
      for (const name of ['Arsenal', 'Chelsea']) {
        expect((await ratingsOf(name)).homeAdvantage).toBe(league);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'a competition whose policy has extra time on counts as a cup, whatever its slug',
    async () => {
      const league = await leagueValue();
      const championship = competition('championship');
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, championship, { extraTime: true }, { system: 'test' }),
      );
      await cupHistory(championship, 100, [0, 2]);
      expect(await rateTie('champ-playoff-1', championship, 0, 1)).toBe(true);
      expect((await ratingsOf('Arsenal')).homeAdvantage).toBe(league);
    },
    TEST_TIMEOUT,
  );

  it(
    'pricing of the next league match uses the league value after a cup result',
    async () => {
      const league = await leagueValue();
      expect(await rateTie('fa-cup-tie-2', competition('fa-cup'), 3, 0)).toBe(true);
      const arsenal = await ratingsOf('Arsenal');
      const chelsea = await ratingsOf('Chelsea');
      const priced = priceFixture('football', arsenal, chelsea);
      expect(priced).toEqual(
        priceFixture('football', { ...arsenal, homeAdvantage: league }, chelsea),
      );
      // Not the default a cup without results of its own wrote before P-8.
      expect(priced).not.toEqual(
        priceFixture('football', { ...arsenal, homeAdvantage: FOOTBALL_HOME_ADVANTAGE }, chelsea),
      );
    },
    TEST_TIMEOUT,
  );
});
