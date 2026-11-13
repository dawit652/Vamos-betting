import { setCompetitionPolicy, setSourceEnabled, upsertSource } from '@vamos/db';
import { theOddsApiUrl, TheOddsApiConfigSchema } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  createHarness,
  HOUR,
  jsonDoc,
  KICKOFF,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_B,
  type Harness,
  type JsonEvent,
} from './helpers';

/**
 * Plan task 1.4: the kickoff of a match is confirmed (C1) from two upstreams with no person, 13
 * days ahead. The two voices are The Odds API's FREE fixture list (`mode: 'events'`, upstream
 * TheOddsAPI) and the API-Football spine; `src-b` (generic-json) stands in for the spine here,
 * declared as upstream 'API-Sports'. Everything is SYNTHETIC. Through the real pipeline.
 */

const SECRET_NAME = 'SCRAPER_SECRET_THEODDSAPI';
const EVENTS_CONFIG = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET_NAME,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  mode: 'events',
};
const EVENTS_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(EVENTS_CONFIG));
const DAY = 24 * HOUR;
const BASE = new Date(KICKOFF.getTime() - 13 * DAY);
/** A match that started 3 days before BASE, long enough ago to count as ended (plus the allowance). */
const OLD_KICK = new Date(BASE.getTime() - 3 * DAY);
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

/** The headers The Odds API sends on /events: the request cost 0 credits. */
const FREE_HEADERS = {
  'x-requests-last': '0',
  'x-requests-used': '96',
  'x-requests-remaining': '19904',
};
const eventsAnswer = (list: Array<{ id: string; kick: Date; home: string; away: string }>) =>
  JSON.stringify(
    list.map((e) => ({
      id: e.id,
      sport_key: 'soccer_epl',
      sport_title: 'EPL',
      commence_time: e.kick.toISOString(),
      home_team: e.home,
      away_team: e.away,
    })),
  );
const ARSENAL_CHELSEA_EVENT = {
  id: 'synthetic-ars-che',
  kick: KICKOFF,
  home: 'Arsenal',
  away: 'Chelsea',
};
const OLD_EVENT = { id: 'synthetic-liv-eve', kick: OLD_KICK, home: 'Liverpool', away: 'Everton' };
const OLD_SPINE: JsonEvent = {
  id: 3,
  kick: OLD_KICK.toISOString(),
  h: 'Liverpool',
  a: 'Everton',
  st: 'FT',
  hs: '1',
  as: '0',
  hth: '0',
  hta: '0',
};

/** Auto-open on; the events source is added; src-a is off; src-b (the spine) stays on or not. */
async function start(options: { spine: boolean }): Promise<void> {
  h = await createHarness({
    secrets: { [SECRET_NAME]: 'odds-key-for-tests-only' },
    upstreamB: 'API-Sports',
  });
  await h.ctx.db.transaction(async (tx) => {
    await setCompetitionPolicy(tx, h.premier, { autoOpen: true }, actor);
    await setSourceEnabled(tx, 'src-a', false, actor);
    await setSourceEnabled(tx, 'src-b', options.spine, actor);
    await upsertSource(
      tx,
      {
        id: 'src-events',
        name: 'the odds api free events test',
        adapter: 'theoddsapi',
        upstream: 'TheOddsAPI',
        config: EVENTS_CONFIG,
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-events', true, actor);
  });
}

/** The events source sees a match before it starts, then (3 days on) no longer lists it. */
async function eventsSourceSeesAMatchEnd(): Promise<void> {
  h.at(new Date(OLD_KICK.getTime() - 2 * DAY));
  h.serve(EVENTS_URL, { status: 200, body: eventsAnswer([OLD_EVENT]), headers: FREE_HEADERS });
  expect((await h.run('src-events')).status).toBe('ok');
  h.at(BASE);
}

const createdEvent = async () =>
  (
    await rows<{ id: string; feed_ref: string; betting_open: boolean }>(
      `SELECT id, feed_ref, betting_open FROM events WHERE feed_provider = 'scraped'`,
    )
  )[0];
const openItems = (feedRef: string) =>
  rows<{ kind: string; payload: Record<string, unknown> }>(
    `SELECT kind, payload FROM scrape_review_items WHERE status = 'open' AND subject_key LIKE $1`,
    [`${feedRef}%`],
  );

describe('plan task 1.4: kickoff confirmed from two upstreams, no person', () => {
  it(
    'the free fixture list and the spine agree: the event opens by itself 13 days ahead, no kickoff item',
    async () => {
      await start({ spine: true });
      await eventsSourceSeesAMatchEnd();
      h.serve(EVENTS_URL, {
        status: 200,
        body: eventsAnswer([ARSENAL_CHELSEA_EVENT]),
        headers: FREE_HEADERS,
      });
      h.serve(URL_B, jsonDoc([OLD_SPINE, ARSENAL_CHELSEA_JSON]));
      await h.run('src-events');
      await h.run('src-b');
      await runPromotion(h.ctx);

      const event = await createdEvent();
      expect(event!.betting_open).toBe(true);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.fixture.created'`,
      );
      expect(audit!.metadata).toMatchObject({
        bettingOpen: true,
        kickoffConfirmed: true,
        kickoffBasis: 'C1',
      });
      // No review item asks anyone to check the kickoff (nor anything else for this match).
      expect(await openItems(event!.feed_ref)).toEqual([]);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items
            WHERE status = 'open' AND payload->>'reason' = 'kickoff_unconfirmed'`,
        ),
      ).toBe(0);
      // The free list cost nothing: a zero-credit run, and the key went only in the header.
      const request = h.requests.find((r) => r.url === EVENTS_URL);
      expect(request?.headers['x-api-key']).toBe('odds-key-for-tests-only');
      const runs = await rows<{ spent: number | null; status: string }>(
        `SELECT api_credits_spent AS spent, status FROM scrape_runs
          WHERE source_id = 'src-events' AND started_at >= $1`,
        [BASE],
      );
      expect(runs).toEqual([{ spent: 0, status: 'ok' }]);
    },
    TEST_TIMEOUT,
  );

  it(
    'with only one source the event is created closed, asks for a person, and still waits 13 days ahead',
    async () => {
      await start({ spine: false });
      await eventsSourceSeesAMatchEnd();
      h.serve(EVENTS_URL, {
        status: 200,
        body: eventsAnswer([ARSENAL_CHELSEA_EVENT]),
        headers: FREE_HEADERS,
      });
      await h.run('src-events');
      await runPromotion(h.ctx);

      const event = await createdEvent();
      expect(event!.betting_open).toBe(false);
      const items = await openItems(event!.feed_ref);
      expect(items.map((i) => i.kind)).toEqual(['odds_approval']);
      expect(items[0]!.payload).toMatchObject({ reason: 'kickoff_unconfirmed' });
      h.advance(6 * HOUR);
      await h.run('src-events');
      await runPromotion(h.ctx);
      expect((await createdEvent())!.betting_open).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'a new events source that has not yet seen a match end is not fresh: two sources still wait',
    async () => {
      await start({ spine: true });
      h.at(BASE);
      h.serve(EVENTS_URL, {
        status: 200,
        body: eventsAnswer([ARSENAL_CHELSEA_EVENT]),
        headers: FREE_HEADERS,
      });
      h.serve(URL_B, jsonDoc([OLD_SPINE, ARSENAL_CHELSEA_JSON]));
      await h.run('src-events');
      await h.run('src-b');
      await runPromotion(h.ctx);
      const event = await createdEvent();
      expect(event!.betting_open).toBe(false);
      expect((await openItems(event!.feed_ref)).map((i) => i.payload.reason)).toEqual([
        'kickoff_unconfirmed',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'the two sources disagree on the kickoff: no confirmation and no automatic opening',
    async () => {
      await start({ spine: true });
      await eventsSourceSeesAMatchEnd();
      h.serve(
        EVENTS_URL,
        eventsAnswer([{ ...ARSENAL_CHELSEA_EVENT, kick: new Date(KICKOFF.getTime() - 3 * HOUR) }]),
      );
      h.serve(URL_B, jsonDoc([OLD_SPINE, ARSENAL_CHELSEA_JSON]));
      await h.run('src-events');
      await h.run('src-b');
      await runPromotion(h.ctx);
      expect(
        await rows(`SELECT 1 FROM events WHERE feed_provider = 'scraped' AND betting_open`),
      ).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
