import { randomUUID } from 'node:crypto';
import { resolveReviewItem, setCompetitionPolicy, setSourceEnabled, upsertSource } from '@vamos/db';
import {
  MIN_MATCH_DURATION_MS,
  theOddsApiUrl,
  TheOddsApiConfigSchema,
  UNVERIFIED_AFTER_MS,
} from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyStaffConfirmations, promoteResults } from '../src/pipeline/promote-results';
import {
  ARSENAL_CHELSEA_JSON,
  createHarness,
  finishedJson,
  HOUR,
  jsonDoc,
  KICKOFF,
  MINUTE,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_B,
  type Harness,
} from './helpers';

/**
 * S-4 (docs/feed-quality-plan.md section 7): The Odds API's /scores never says whether a cup match
 * went to extra time or penalties, so a cup score of it has basis `unknown` (adapter rule A10)
 * whatever its source config says, and it never settles a bet by itself (R10). League scores are
 * unchanged. The cup competition here has auto results ON and extra time OFF: the worst case, a
 * person forgot the switch.
 *
 * - a Premier League match, json source (with half time) + The Odds API: applied as before;
 * - FA Cup 1, The Odds API only: `score_basis_unknown`, never applied, not even after R6's wait;
 * - FA Cup 2, football-data.org REGULAR + an agreeing The Odds API score: the unknown score is not
 *   a second upstream, so `score_basis_unknown` at once and `result_unverified` (football-data.org's
 *   score only) after R6's wait, which a person can confirm.
 */

const SECRET = 'SCRAPER_SECRET_THEODDSAPI';
const actor = { system: 'test' };

const scoresConfig = (sportKey: string, competition: string) => ({
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET,
  sport: 'football',
  sportKey,
  competition,
  mode: 'scores',
  // What every repository scores file said before S-4, cups included: the adapter decides for a cup.
  scoreBasis: 'regular_time',
});
const EPL_SCORES = scoresConfig('soccer_epl', 'Premier League');
const CUP_SCORES = scoresConfig('soccer_fa_cup', 'FA Cup');
const EPL_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(EPL_SCORES));
const CUP_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(CUP_SCORES));

/** football-data.org's v4 matches, as source-footballdata-cl.json reads them (basis per match). */
const FD_URL = 'https://api.football-data.org/v4/competitions/FAC/matches';
const FD_CUP_SOURCE = {
  allowedHosts: ['api.football-data.org'],
  requests: [{ url: FD_URL, purpose: 'both' }],
  sport: 'football',
  recordsPath: 'matches',
  fields: {
    home: 'homeTeam.name',
    away: 'awayTeam.name',
    competition: { fixed: 'FA Cup' },
    kickoff: { path: 'utcDate', format: 'iso' },
    externalRef: 'id',
    status: { path: 'status', map: { TIMED: 'scheduled', FINISHED: 'finished' } },
    score: {
      homePath: 'score.fullTime.home',
      awayPath: 'score.fullTime.away',
      htHomePath: 'score.halfTime.home',
      htAwayPath: 'score.halfTime.away',
    },
    scoreBasis: {
      path: 'score.duration',
      map: {
        REGULAR: 'regular_time',
        EXTRA_TIME: 'includes_extra_time',
        PENALTY_SHOOTOUT: 'includes_extra_time',
      },
    },
  },
  scoreBasis: 'unknown',
};

interface Match {
  id: number;
  /** As the sources spell them. */
  home: string;
  away: string;
  /** The catalogue's short names. */
  short: [home: string, away: string];
}
const CUP1: Match = {
  id: 101,
  home: 'Liverpool',
  away: 'Everton',
  short: ['Liverpool', 'Everton'],
};
const CUP2: Match = {
  id: 102,
  home: 'Tottenham Hotspur',
  away: 'Newcastle United',
  short: ['Tottenham', 'Newcastle'],
};

type Goals = [number, number];
const fdDoc = (matches: Array<{ m: Match; ft?: Goals; ht?: Goals }>) =>
  JSON.stringify({
    matches: matches.map(({ m, ft, ht }) => ({
      id: m.id,
      utcDate: KICKOFF.toISOString(),
      status: ft === undefined ? 'TIMED' : 'FINISHED',
      homeTeam: { name: m.home },
      awayTeam: { name: m.away },
      score: {
        duration: 'REGULAR',
        fullTime: { home: ft?.[0] ?? null, away: ft?.[1] ?? null },
        halfTime: { home: ht?.[0] ?? null, away: ht?.[1] ?? null },
      },
    })),
  });
const oddsDoc = (sportKey: string, games: Array<{ home: string; away: string; ft: Goals }>) =>
  JSON.stringify(
    games.map((g, i) => ({
      id: `${sportKey}-${i}`,
      sport_key: sportKey,
      sport_title: sportKey,
      commence_time: KICKOFF.toISOString(),
      completed: true,
      home_team: g.home,
      away_team: g.away,
      scores: [
        { name: g.home, score: String(g.ft[0]) },
        { name: g.away, score: String(g.ft[1]) },
      ],
      last_update: new Date(KICKOFF.getTime() + 2 * HOUR).toISOString(),
    })),
  );

let h: Harness;
let fa: string;

const eventOf = async (home: string, away: string) =>
  (
    await h.pool.query<{
      id: string;
      competition_id: string;
      status: string;
      score_home: number | null;
      score_away: number | null;
      ht_score_home: number | null;
      ht_score_away: number | null;
    }>(
      `SELECT e.id, e.competition_id, e.status, e.score_home, e.score_away, e.ht_score_home, e.ht_score_away
         FROM events e
        WHERE e.feed_provider = 'scraped' AND e.home_team_id = $1 AND e.away_team_id = $2`,
      [h.team(home), h.team(away)],
    )
  ).rows[0]!;

/** The open items about an event's result (the teams' rating items are not this test's subject). */
const openItems = async (eventId: string) =>
  (
    await h.pool.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `SELECT id, kind, payload FROM scrape_review_items
        WHERE status = 'open' AND payload->>'eventId' = $1
          AND (kind LIKE 'result_%' OR kind IN ('score_basis_unknown', 'cancellation_proposed'))
        ORDER BY kind`,
      [eventId],
    )
  ).rows;

async function runAll(): Promise<void> {
  for (const id of ['src-b', 'src-fd-cup', 'src-odds-epl', 'src-odds-cup']) {
    expect((await h.run(id)).status, id).toBe('ok');
  }
}

beforeAll(async () => {
  h = await createHarness({ secrets: { [SECRET]: 'odds-test-key' } });
  fa = h.ids.competitions.get('football/fa-cup')!;
  expect(fa).toBeTruthy();
  await h.ctx.db.transaction(async (tx) => {
    await setSourceEnabled(tx, 'src-a', false, actor);
    const sources = [
      ['src-fd-cup', 'generic-json', 'football-data.org', FD_CUP_SOURCE],
      ['src-odds-epl', 'theoddsapi', 'TheOddsAPI', EPL_SCORES],
      ['src-odds-cup', 'theoddsapi', 'TheOddsAPI', CUP_SCORES],
    ] as const;
    for (const [id, adapter, upstream, config] of sources) {
      await upsertSource(tx, { id, name: id, adapter, upstream, config }, actor);
      await setSourceEnabled(tx, id, true, actor);
    }
    // The worst case: auto results on and the competition's extra-time switch left off.
    await setCompetitionPolicy(
      tx,
      fa,
      { enabled: true, autoResults: true, extraTime: false },
      actor,
    );
  });

  // Before kickoff: the league match from the json source, both cup ties from football-data.org.
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  h.serve(FD_URL, fdDoc([{ m: CUP1 }, { m: CUP2 }]));
  h.serve(EPL_URL, '[]');
  h.serve(CUP_URL, '[]');
  await runAll();
  expect((await promoteFixtures(h.ctx)).created).toBe(3);
  expect((await eventOf(...CUP1.short)).competition_id).toBe(fa);
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('cup scores of unknown basis (S-4)', () => {
  it(
    'a league match is applied as before; cup scores of The Odds API wait for a person',
    async () => {
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_B, jsonDoc([finishedJson([2, 1], [1, 0])]));
      h.serve(EPL_URL, oddsDoc('soccer_epl', [{ home: 'Arsenal', away: 'Chelsea', ft: [2, 1] }]));
      h.serve(
        CUP_URL,
        oddsDoc('soccer_fa_cup', [
          // Could be 1-1 after 90 minutes and a goal in extra time: The Odds API does not say.
          { home: CUP1.home, away: CUP1.away, ft: [2, 1] },
          { home: CUP2.home, away: CUP2.away, ft: [1, 0] },
        ]),
      );
      // football-data.org has not caught up with tie 1; tie 2 ended in normal time.
      h.serve(FD_URL, fdDoc([{ m: CUP1 }, { m: CUP2, ft: [1, 0], ht: [0, 0] }]));
      await runAll();
      expect((await promoteResults(h.ctx)).applied).toBe(0); // R4: too new

      // The adapter stored the cup scores as unknown basis, the league's as regular time.
      const { rows: stored } = await h.pool.query<{ source_id: string; score_basis: string }>(
        `SELECT source_id, score_basis FROM scrape_observations
          WHERE kind = 'result' ORDER BY source_id, score_basis`,
      );
      expect(stored.map((r) => [r.source_id, r.score_basis])).toEqual([
        ['src-b', 'regular_time'],
        ['src-fd-cup', 'regular_time'],
        ['src-odds-cup', 'unknown'],
        ['src-odds-cup', 'unknown'],
        ['src-odds-epl', 'regular_time'],
      ]);

      h.advance(16 * MINUTE);
      await runAll();
      expect((await promoteResults(h.ctx)).applied).toBe(1);

      // League: two upstreams agree, applied by the scraper (unchanged behaviour).
      const league = await eventOf('Arsenal', 'Chelsea');
      expect(league).toMatchObject({ status: 'finished', score_home: 2, score_away: 1 });
      const { rows: audit } = await h.pool.query<{ metadata: { upstreams: string[] } }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.applied' AND target_id = $1`,
        [league.id],
      );
      expect(audit.map((a) => a.metadata.upstreams)).toEqual([['example-api', 'theoddsapi']]);

      // Cup tie 1: The Odds API alone, basis unknown: a person, never applied.
      const cup1 = await eventOf(...CUP1.short);
      expect(cup1).toMatchObject({ status: 'scheduled', score_home: null });
      expect((await openItems(cup1.id)).map((i) => i.kind)).toEqual(['score_basis_unknown']);

      // Cup tie 2: football-data.org REGULAR plus the agreeing Odds API score is ONE upstream with a
      // known basis: not applied, and the basis notice says why.
      const cup2 = await eventOf(...CUP2.short);
      expect(cup2).toMatchObject({ status: 'scheduled', score_home: null });
      const items2 = await openItems(cup2.id);
      expect(items2.map((i) => i.kind)).toEqual(['score_basis_unknown']);
      expect(JSON.stringify(items2[0]!.payload)).toContain('src-odds-cup:unknown');
      expect(
        await h.count(`SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'after R6’s wait tie 1 still waits; tie 2 offers football-data.org’s score, which a person confirms',
    async () => {
      h.at(new Date(KICKOFF.getTime() + MIN_MATCH_DURATION_MS + UNVERIFIED_AFTER_MS + MINUTE));
      await runAll();
      expect((await promoteResults(h.ctx)).applied).toBe(0);

      const cup1 = await eventOf(...CUP1.short);
      expect(cup1).toMatchObject({ status: 'scheduled', score_home: null });
      // Nothing a person could confirm with one click: they enter the 90-minute score in Trading.
      expect((await openItems(cup1.id)).map((i) => i.kind)).toEqual(['score_basis_unknown']);

      const cup2 = await eventOf(...CUP2.short);
      expect(cup2).toMatchObject({ status: 'scheduled', score_home: null });
      const items2 = await openItems(cup2.id);
      expect(items2.map((i) => i.kind)).toEqual(['result_unverified', 'score_basis_unknown']);
      const unverified = items2[0]!;
      expect(unverified.payload).toMatchObject({
        score: { home: 1, away: 0, htHome: 0, htAway: 0 },
        upstreams: ['football-data.org'],
      });
      expect(
        (unverified.payload.sources as Array<{ sourceId: string }>).map((s) => s.sourceId),
      ).toEqual(['src-fd-cup']);

      // The person confirms: applied on football-data.org's regular-time observation.
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, unverified.id, {
          status: 'resolved',
          resolution: JSON.stringify({ decision: 'apply_result' }),
          actor: { adminId: randomUUID() },
          now: h.now(),
        }),
      );
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 1, rejected: 0 });
      expect(await eventOf(...CUP2.short)).toMatchObject({
        status: 'finished',
        score_home: 1,
        score_away: 0,
        ht_score_home: 0,
        ht_score_away: 0,
      });
      // Tie 1 is still unsettled: the scraper never applies a cup score of unknown basis.
      await promoteResults(h.ctx);
      expect(await eventOf(...CUP1.short)).toMatchObject({ status: 'scheduled' });
      expect(
        await h.count(`SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`),
      ).toBe(2);
    },
    TEST_TIMEOUT,
  );
});
