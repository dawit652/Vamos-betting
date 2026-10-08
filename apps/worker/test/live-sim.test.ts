import { randomUUID } from 'node:crypto';
import { resolveSelection, type MarketTypeCode, type ResolutionInput } from '@vamos/core';
import { resultEvent, setMarketStatus, setSelectionOdds, type LiveMessage } from '@vamos/db';
import {
  isSuspended,
  priceState,
  type LiveMatchState,
  type MatchStrengths,
  type MockFeedProvider,
} from '@vamos/feed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryLock } from '../src/lib/lock';
import { createMockFeedProvider } from '../src/tasks/feed-ingest';
import {
  ALWAYS_WRITE_BELOW_MILLI,
  loadSimRecord,
  newSimRecord,
  runLiveSimTick,
  shouldWriteOdds,
  simLockKey,
  simStateKey,
  simulateTo,
  type LiveSimOptions,
  type SimRecord,
} from '../src/tasks/live-sim';
import {
  createWorkerTestContext,
  feedFixture,
  insertFixture,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

let t: WorkerTestContext;
let provider: MockFeedProvider;

beforeAll(async () => {
  t = await createWorkerTestContext();
  provider = await createMockFeedProvider(t.db.db, { rolling: null });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

/** 10 simulated minutes per real second: a football match takes ~11 ticks of 1 s. */
const SIM_SPEED = 10;
const KEY_PREFIX = 'sim:';

function options(feedProvider: string, extra: Partial<LiveSimOptions> = {}): LiveSimOptions {
  return { simSpeed: SIM_SPEED, feedProvider, keyPrefix: KEY_PREFIX, ...extra };
}

interface EventRow {
  status: string;
  live_minute: number | null;
  period: string | null;
  score_home: number | null;
  score_away: number | null;
  ht_score_home: number | null;
  ht_score_away: number | null;
  resulted_at: Date | null;
}

async function eventRow(eventId: string): Promise<EventRow> {
  const { rows } = await t.db.pool.query<EventRow>(
    `SELECT status, live_minute, period, score_home, score_away, ht_score_home, ht_score_away,
            resulted_at
       FROM events WHERE id = $1`,
    [eventId],
  );
  if (!rows[0]) throw new Error(`no event ${eventId}`);
  return rows[0];
}

async function marketStatuses(eventId: string): Promise<Map<string, string>> {
  const { rows } = await t.db.pool.query<{ key: string; status: string }>(
    'SELECT key, status FROM markets WHERE event_id = $1',
    [eventId],
  );
  return new Map(rows.map((row) => [row.key, row.status]));
}

function uniqueProvider(): string {
  return `mock-test-${randomUUID()}`;
}

/** The event's simulator seed (null before kick-off). */
async function seedOf(eventId: string): Promise<string | null> {
  const { rows } = await t.db.pool.query<{ sim_seed: string | null }>(
    'SELECT sim_seed FROM events WHERE id = $1',
    [eventId],
  );
  return rows[0]?.sim_seed ?? null;
}

/** Fixes an event's simulator seed before kick-off, so a test knows how the match goes. */
async function setSeed(eventId: string, seed: string): Promise<void> {
  await t.db.pool.query('UPDATE events SET sim_seed = $2 WHERE id = $1', [eventId, seed]);
}

async function selectionRows(
  eventId: string,
): Promise<Array<{ id: string; key: string; code: string; odds_milli: number; status: string }>> {
  const { rows } = await t.db.pool.query<{
    id: string;
    key: string;
    code: string;
    odds_milli: number;
    status: string;
  }>(
    `SELECT s.id, m.key, s.code, s.odds_milli, m.status
       FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.event_id = $1`,
    [eventId],
  );
  return rows;
}

const trader = { adminId: '00000000-0000-4000-8000-00000000aaaa', reason: 'integrity alert' };

/**
 * Inserts football fixtures until one's simulation (seeded by the test) has a
 * goal within 80 minutes; returns it with the first second the markets are
 * suspended and the first second they are calm again (SIM_SPEED 1).
 */
async function fixtureWithGoal(feedProvider: string, start: Date) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const fixture = feedFixture('football', 'premier-league', 'Man City', 'Burnley', start);
    const eventId = await insertFixture(t, provider, fixture, feedProvider);
    const seed = `goal-test-${eventId}`;
    await setSeed(eventId, seed);
    let record = newSimRecord({ id: eventId, sport: 'football', startTime: start }, seed);
    let goalAt = 0;
    for (let second = 1; second <= 80; second++) {
      record = simulateTo(
        record,
        provider.strengths(fixture),
        new Date(start.getTime() + second * 1000),
        1,
      );
      if (goalAt === 0 && isSuspended(record.state)) goalAt = second;
      if (goalAt !== 0 && !isSuspended(record.state)) {
        return { eventId, fixture, goalAt, calmAt: second };
      }
    }
    await t.db.db.transaction((tx) => resultEvent(tx, eventId, { status: 'cancelled' }));
  }
  throw new Error('no fixture with a goal found');
}

function due(minutesAgo = 0) {
  return new Date(t.clock.now.getTime() - minutesAgo * 60_000);
}

describe('live simulator', () => {
  it(
    'plays a match from kick-off to full time and settles every market by the final score',
    async () => {
      const feedProvider = uniqueProvider();
      const start = new Date(Date.now() + 60_000);
      t.clock.set(new Date(start.getTime() - 1000));
      const fixture = feedFixture('football', 'premier-league', 'Man City', 'Burnley', start);
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      const opts = options(feedProvider);

      let summary = await runLiveSimTick(t.ctx, opts);
      expect(summary.candidates).toBe(0);
      expect((await eventRow(eventId)).status).toBe('scheduled');

      t.clock.set(new Date(start.getTime() + 1000));
      summary = await runLiveSimTick(t.ctx, opts);
      expect(summary.kickedOff).toEqual([eventId]);
      let row = await eventRow(eventId);
      expect(row).toMatchObject({ status: 'live', live_minute: 10, period: '1H' });

      const periods = new Set<string>();
      for (let i = 0; i < 30 && row.status === 'live'; i++) {
        t.clock.advance(1000);
        summary = await runLiveSimTick(t.ctx, opts);
        expect(summary.failed).toEqual([]);
        row = await eventRow(eventId);
        if (row.period !== null) periods.add(row.period);
      }
      expect(row.status).toBe('finished');
      expect(row.resulted_at).toBeInstanceOf(Date);
      expect(summary.finished).toEqual([eventId]);
      expect(periods).toEqual(new Set(['1H', 'HT', '2H', 'FT']));

      // The result is the deterministic simulation of this event from its secret seed.
      const seed = await seedOf(eventId);
      expect(seed).toMatch(/^[0-9a-f]{32}$/);
      const expected = simulateTo(
        newSimRecord({ id: eventId, sport: 'football', startTime: start }, seed!),
        provider.strengths(fixture),
        t.clock.now,
        SIM_SPEED,
      ).state;
      expect(expected.phase).toBe('finished');
      expect([row.score_home, row.score_away, row.ht_score_home, row.ht_score_away]).toEqual([
        expected.home,
        expected.away,
        expected.htHome,
        expected.htAway,
      ]);

      // Every selection is settled consistently with the final score.
      const input: ResolutionInput = {
        status: 'finished',
        score: {
          home: row.score_home!,
          away: row.score_away!,
          htHome: row.ht_score_home,
          htAway: row.ht_score_away,
        },
      };
      const { rows: settled } = await t.db.pool.query<{
        type: string;
        line: string | null;
        market_status: string;
        code: string;
        status: string;
        result: string | null;
      }>(
        `SELECT m.type, m.line, m.status AS market_status, s.code, s.status, s.result
           FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1`,
        [eventId],
      );
      expect(settled.length).toBeGreaterThan(40);
      for (const selection of settled) {
        expect(selection.status).toBe('settled');
        expect(['settled', 'void']).toContain(selection.market_status);
        expect(selection.result).toBe(
          resolveSelection(
            { type: selection.type as MarketTypeCode, line: selection.line },
            selection.code,
            input,
          ),
        );
      }
      const { rows: live } = await t.db.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM odds_history h
           JOIN selections s ON s.id = h.selection_id JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND h.source = 'live'`,
        [eventId],
      );
      expect(Number(live[0]?.n)).toBeGreaterThan(0);

      // The deltas reached the live channel: kick-off, in-play odds, full time, settlement.
      await t.waitForMessages((messages) =>
        messages.some(
          (m) => m.eventId === eventId && m.type === 'match' && m.data.st === 'finished',
        ),
      );
      const mine = t.received.filter((m) => m.eventId === eventId);
      const statuses = mine.flatMap((m) => (m.type === 'match' ? [m.data.st] : []));
      expect(statuses[0]).toBe('live');
      expect(statuses.at(-1)).toBe('finished');
      expect(mine.some((m) => m.type === 'odds')).toBe(true);
      const settledMarkets = new Set(
        mine.flatMap((m) =>
          m.type === 'market' && (m.data.st === 'settled' || m.data.st === 'void')
            ? [m.data.k]
            : [],
        ),
      );
      expect(settledMarkets.size).toBe((await marketStatuses(eventId)).size);

      // A finished match is not looked at again.
      t.clock.advance(1000);
      expect((await runLiveSimTick(t.ctx, opts)).candidates).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'suspends the markets after a goal, closes decided ones and re-opens the rest',
    async () => {
      const feedProvider = uniqueProvider();
      const opts = options(feedProvider, { simSpeed: 1 });
      const start = due(1);
      const { eventId, goalAt, calmAt } = await fixtureWithGoal(feedProvider, start);
      expect(calmAt).toBeGreaterThan(goalAt);

      t.clock.set(new Date(start.getTime() + goalAt * 1000));
      const during = await runLiveSimTick(t.ctx, opts);
      expect(during.processed).toEqual([eventId]);
      const suspended = await marketStatuses(eventId);
      expect(suspended.get('ou:0.5')).toBe('closed');
      expect(suspended.get('1x2')).toBe('suspended');
      expect([...suspended.values()].every((s) => s === 'suspended' || s === 'closed')).toBe(true);

      t.clock.set(new Date(start.getTime() + calmAt * 1000));
      await runLiveSimTick(t.ctx, opts);
      const after = await marketStatuses(eventId);
      expect(after.get('1x2')).toBe('open');
      expect(after.get('ou:0.5')).toBe('closed');
      expect([...after.values()].every((s) => s === 'open' || s === 'closed')).toBe(true);
      for (const status of ['suspended', 'closed', 'open'] as const) {
        await t.waitForMessages((messages) =>
          messages.some(
            (m) => m.eventId === eventId && m.type === 'market' && m.data.st === status,
          ),
        );
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'gives odds deltas the bettability that is committed on suspend and resume ticks (regression)',
    async () => {
      const feedProvider = uniqueProvider();
      const opts = options(feedProvider, { simSpeed: 1 });
      const start = due(1);
      const { eventId, goalAt, calmAt } = await fixtureWithGoal(feedProvider, start);
      const tickAt = async (second: number): Promise<LiveMessage[]> => {
        const from = t.received.length;
        t.clock.set(new Date(start.getTime() + second * 1000));
        const summary = await runLiveSimTick(t.ctx, opts);
        await t.waitForMessages((messages) => messages.length - from >= summary.published);
        return t.received.slice(from).filter((m) => m.eventId === eventId);
      };
      const odds = (messages: LiveMessage[]) =>
        messages.flatMap((m) => (m.type === 'odds' ? [m.data] : []));

      await tickAt(goalAt - 1);
      const goal = await tickAt(goalAt);
      expect(odds(goal).length).toBeGreaterThan(0);
      expect(odds(goal).every((d) => d.st === 'suspended')).toBe(true);
      const calm = await tickAt(calmAt);
      expect(calm.some((m) => m.type === 'market' && m.data.st === 'open')).toBe(true);

      // Every selection of a re-opened market now has a latest delta saying 'open',
      // which agrees with the database (and so with GET /events/:id).
      const latest = new Map<string, string>();
      for (const delta of odds(t.received.filter((m) => m.eventId === eventId))) {
        latest.set(delta.s, delta.st);
      }
      const rows = await selectionRows(eventId);
      const open = rows.filter((row) => row.status === 'open');
      expect(open.length).toBeGreaterThan(0);
      for (const row of open) expect(latest.get(row.id)).toBe('open');
      for (const row of rows.filter((r) => r.status === 'suspended')) {
        expect(latest.get(row.id)).not.toBe('open');
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps a trader's suspension through the simulator's goal suspension (regression)",
    async () => {
      const feedProvider = uniqueProvider();
      const opts = options(feedProvider, { simSpeed: 1 });
      const start = due(1);
      const { eventId, goalAt, calmAt } = await fixtureWithGoal(feedProvider, start);
      t.clock.set(new Date(start.getTime() + 1000));
      await runLiveSimTick(t.ctx, opts);
      const { rows } = await t.db.pool.query<{ id: string }>(
        `SELECT id FROM markets WHERE event_id = $1 AND key = '1x2'`,
        [eventId],
      );
      await t.db.db.transaction((tx) => setMarketStatus(tx, rows[0]!.id, 'suspended', trader));

      for (let second = 2; second <= calmAt; second++) {
        t.clock.set(new Date(start.getTime() + second * 1000));
        expect((await runLiveSimTick(t.ctx, opts)).failed).toEqual([]);
        if (second === goalAt) expect((await marketStatuses(eventId)).get('dc')).toBe('suspended');
      }
      const after = await marketStatuses(eventId);
      expect(after.get('1x2')).toBe('suspended');
      expect(after.get('dc')).toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps a trader's suspension when the simulator state is lost (regression)",
    async () => {
      const feedProvider = uniqueProvider();
      const opts = options(feedProvider, { simSpeed: 1 });
      const start = due(0);
      const fixture = feedFixture('football', 'premier-league', 'Arsenal', 'Wolves', start);
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      t.clock.set(new Date(start.getTime() + 1000));
      await runLiveSimTick(t.ctx, opts);
      const { rows } = await t.db.pool.query<{ id: string }>(
        `SELECT id FROM markets WHERE event_id = $1 AND key = 'btts'`,
        [eventId],
      );
      await t.db.db.transaction((tx) => setMarketStatus(tx, rows[0]!.id, 'suspended', trader));
      const stored = await loadSimRecord(t.redis, simStateKey(eventId, KEY_PREFIX), eventId);
      expect(isSuspended(stored!.state)).toBe(false);

      await t.redis.del(simStateKey(eventId, KEY_PREFIX));
      expect((await runLiveSimTick(t.ctx, opts)).processed).toEqual([eventId]);
      const after = await marketStatuses(eventId);
      expect(after.get('btts')).toBe('suspended');
      expect(after.get('1x2')).toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    'replaces a stale 1.01 when the model shortens a favourite below it (regression)',
    async () => {
      const feedProvider = uniqueProvider();
      const opts = options(feedProvider, { simSpeed: 1 });
      const start = due(2);
      const fixture = feedFixture('football', 'premier-league', 'Everton', 'Fulham', start);
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      const strengths: MatchStrengths = provider.strengths(fixture);
      // 2-0 late on: find a minute where the model prices the leader below 1.01.
      const stateAt = (minute: number): LiveMatchState => ({
        sport: 'football',
        phase: 'second_half',
        minute,
        home: 2,
        away: 0,
        htHome: 1,
        htAway: 0,
        periodLabel: '2H',
        suspendedUntilMinute: null,
        elapsed: minute + 20,
        periodEndsAt: 200,
      });
      const modelPrice = (minute: number) =>
        priceState(stateAt(minute), strengths)
          .find((m) => m.type === '1x2')
          ?.selections.find((s) => s.code === '1')?.oddsMilli;
      let minute = 60;
      while (minute < 96 && !((modelPrice(minute) ?? 0) > 1000 && modelPrice(minute)! < 1010)) {
        minute++;
      }
      const model = modelPrice(minute);
      expect(model).toBeLessThan(1010);

      const seed = `stale-${eventId}`;
      await setSeed(eventId, seed);
      const steps = 120;
      t.clock.set(new Date(start.getTime() + steps * 1000));
      const record: SimRecord = {
        ...newSimRecord({ id: eventId, sport: 'football', startTime: start }, seed),
        steps,
        state: stateAt(minute),
      };
      await t.redis.set(simStateKey(eventId, KEY_PREFIX), JSON.stringify(record));
      const home = (await selectionRows(eventId)).find((r) => r.key === '1x2' && r.code === '1')!;
      await t.db.db.transaction((tx) =>
        setSelectionOdds(tx, [{ selectionId: home.id, oddsMilli: 1010, source: 'live' }]),
      );

      await runLiveSimTick(t.ctx, opts);
      const after = (await selectionRows(eventId)).find((r) => r.id === home.id)!;
      expect(after.odds_milli).toBe(model);
    },
    TEST_TIMEOUT,
  );

  it(
    'draws a secret seed at kick-off, so results cannot be computed from public data',
    async () => {
      const feedProvider = uniqueProvider();
      const start = due(0);
      const fixtures = [
        feedFixture('football', 'premier-league', 'Liverpool', 'Leeds', start),
        feedFixture('football', 'premier-league', 'Brentford', 'Chelsea', start),
      ];
      const ids: string[] = [];
      for (const fixture of fixtures)
        ids.push(await insertFixture(t, provider, fixture, feedProvider));
      expect(await seedOf(ids[0]!)).toBeNull();

      t.clock.set(new Date(start.getTime() + 1000));
      await runLiveSimTick(t.ctx, options(feedProvider));
      const seeds = await Promise.all(ids.map((id) => seedOf(id)));
      for (const [index, seed] of seeds.entries()) {
        expect(seed).toMatch(/^[0-9a-f]{32}$/);
        expect(seed).not.toContain(ids[index]!);
      }
      expect(seeds[0]).not.toBe(seeds[1]);
      // The stored state carries the seed, and a lost state replays with the same one.
      const stored = await loadSimRecord(t.redis, simStateKey(ids[0]!, KEY_PREFIX), ids[0]!);
      expect(stored?.seed).toBe(seeds[0]);
      await t.redis.del(simStateKey(ids[0]!, KEY_PREFIX));
      t.clock.advance(1000);
      await runLiveSimTick(t.ctx, options(feedProvider));
      expect(await seedOf(ids[0]!)).toBe(seeds[0]);
      const replayed = await loadSimRecord(t.redis, simStateKey(ids[0]!, KEY_PREFIX), ids[0]!);
      expect(replayed).toEqual(
        simulateTo(
          newSimRecord({ id: ids[0]!, sport: 'football', startTime: start }, seeds[0]!),
          provider.strengths(fixtures[0]!),
          t.clock.now,
          SIM_SPEED,
        ),
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'kicks off a late event and catches up to full time in one tick',
    async () => {
      const feedProvider = uniqueProvider();
      const fixture = feedFixture('basketball', 'nba', 'Celtics', 'Lakers', due(60));
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      const summary = await runLiveSimTick(t.ctx, options(feedProvider));
      expect(summary.kickedOff).toEqual([eventId]);
      expect(summary.finished).toEqual([eventId]);
      const row = await eventRow(eventId);
      expect(row.status).toBe('finished');
      expect(row.score_home).not.toBe(row.score_away);
      expect([...(await marketStatuses(eventId)).values()].every((s) => s === 'settled')).toBe(
        true,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'never simulates an event whose lock another instance holds',
    async () => {
      const feedProvider = uniqueProvider();
      const fixture = feedFixture('tennis', 'atp-tour', 'Sinner', 'Alcaraz', due(0.05));
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      const other = await tryLock(t.redis, simLockKey(eventId, KEY_PREFIX), 60_000);
      expect(other).not.toBeNull();

      const blocked = await runLiveSimTick(t.ctx, options(feedProvider));
      expect(blocked.busy).toEqual([eventId]);
      expect(blocked.processed).toEqual([]);
      expect((await eventRow(eventId)).status).toBe('scheduled');

      expect(await other!.release()).toBe(true);
      const free = await runLiveSimTick(t.ctx, options(feedProvider));
      expect(free.processed).toEqual([eventId]);
      expect((await eventRow(eventId)).status).toBe('live');
      // The lock is released after the tick.
      expect(await t.redis.get(simLockKey(eventId, KEY_PREFIX))).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'applies each change once when two instances tick at the same time',
    async () => {
      const feedProvider = uniqueProvider();
      const pairs: Array<[string, string]> = [
        ['Arsenal', 'Chelsea'],
        ['Liverpool', 'Everton'],
        ['Fulham', 'Wolves'],
        ['Leeds', 'Brentford'],
      ];
      const eventIds: string[] = [];
      for (const [home, away] of pairs) {
        eventIds.push(
          await insertFixture(
            t,
            provider,
            feedFixture('football', 'premier-league', home, away, due(0.5)),
            feedProvider,
          ),
        );
      }
      const [a, b] = await Promise.all([
        runLiveSimTick(t.ctx, options(feedProvider, { concurrency: 2 })),
        runLiveSimTick(t.ctx, options(feedProvider, { concurrency: 2 })),
      ]);
      expect(a.failed).toEqual([]);
      expect(b.failed).toEqual([]);
      expect(new Set([...a.processed, ...b.processed])).toEqual(new Set(eventIds));
      expect(new Set([...a.kickedOff, ...b.kickedOff]).size).toBe(eventIds.length);
      expect(a.kickedOff.length + b.kickedOff.length).toBe(eventIds.length);

      await t.waitForMessages((messages) =>
        eventIds.every((id) =>
          messages.some((m) => m.eventId === id && m.type === 'match' && m.data.st === 'live'),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const id of eventIds) {
        const kickOffs = t.received.filter(
          (m) => m.eventId === id && m.type === 'match' && m.data.st === 'live',
        );
        expect(kickOffs).toHaveLength(1);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'replays a lost simulator state to the same match',
    async () => {
      const feedProvider = uniqueProvider();
      const start = due(0);
      const fixture = feedFixture('football', 'laliga', 'Barcelona', 'Real Madrid', start);
      const eventId = await insertFixture(t, provider, fixture, feedProvider);
      const opts = options(feedProvider);

      t.clock.set(new Date(start.getTime() + 3000));
      await runLiveSimTick(t.ctx, opts);
      const stored = await loadSimRecord(t.redis, simStateKey(eventId, KEY_PREFIX), eventId);
      expect(stored?.steps).toBe(30);
      await t.redis.del(simStateKey(eventId, KEY_PREFIX));

      t.clock.set(new Date(start.getTime() + 20_000));
      const summary = await runLiveSimTick(t.ctx, opts);
      expect(summary.finished).toEqual([eventId]);
      const expected = simulateTo(
        newSimRecord(
          { id: eventId, sport: 'football', startTime: start },
          (await seedOf(eventId))!,
        ),
        provider.strengths(fixture),
        t.clock.now,
        SIM_SPEED,
      ).state;
      const row = await eventRow(eventId);
      expect([row.score_home, row.score_away]).toEqual([expected.home, expected.away]);
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves other providers and resulted events alone',
    async () => {
      const feedProvider = uniqueProvider();
      const otherProvider = uniqueProvider();
      const mine = await insertFixture(
        t,
        provider,
        feedFixture('football', 'serie-a', 'Inter', 'Napoli', due(1)),
        feedProvider,
      );
      const foreign = await insertFixture(
        t,
        provider,
        feedFixture('football', 'serie-a', 'Juventus', 'Roma', due(1)),
        otherProvider,
      );
      await t.db.db.transaction((tx) => resultEvent(tx, mine, { status: 'postponed' }));
      const summary = await runLiveSimTick(t.ctx, options(feedProvider));
      expect(summary.candidates).toBe(0);
      expect((await eventRow(mine)).status).toBe('postponed');
      expect((await eventRow(foreign)).status).toBe('scheduled');
    },
    TEST_TIMEOUT,
  );
});

describe('simulateTo', () => {
  const strengths = { home: 1.6, away: 1.1 };
  const record = newSimRecord(
    {
      id: '00000000-0000-4000-8000-000000000001',
      sport: 'football',
      startTime: new Date('2026-10-10T12:00:00Z'),
    },
    'test-seed',
  );
  const at = (seconds: number) => new Date(record.kickoffAt + seconds * 1000);

  it('does not start before the start time', () => {
    expect(simulateTo(record, strengths, at(-5), 1)).toBe(record);
  });

  it('plays the same match however the ticks fall', () => {
    const oneGo = simulateTo(record, strengths, at(200), 1);
    let stepped = record;
    for (let second = 0; second <= 200; second += 7) {
      stepped = simulateTo(stepped, strengths, at(second), 1);
    }
    stepped = simulateTo(stepped, strengths, at(200), 1);
    expect(stepped).toEqual(oneGo);
    expect(oneGo.state.phase).toBe('finished');
  });

  it('plays a different match for a different seed of the same event', () => {
    const other = { ...record, seed: 'another-seed' };
    const scores = (r: SimRecord) => {
      const done = simulateTo(r, strengths, at(200), 1).state;
      return [done.home, done.away, done.htHome, done.htAway].join();
    };
    const distinct = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => scores({ ...record, seed })),
    );
    expect(distinct.size).toBeGreaterThan(1);
    expect(scores(other)).toBe(scores({ ...other }));
    expect(() =>
      newSimRecord({ id: record.eventId, sport: 'football', startTime: at(0) }, ''),
    ).toThrow(RangeError);
  });

  it('runs SIM_SPEED simulated minutes per real second', () => {
    expect(simulateTo(record, strengths, at(3), 5).steps).toBe(15);
    expect(simulateTo(record, strengths, at(30), 0.5).steps).toBe(15);
    expect(() => simulateTo(record, strengths, at(3), 0)).toThrow(RangeError);
  });
});

describe('shouldWriteOdds', () => {
  it('writes moves of at least the threshold, and every shortening below 1.10', () => {
    expect(shouldWriteOdds(2000, 2000, 0.01)).toBe(false);
    expect(shouldWriteOdds(2000, 2019, 0.01)).toBe(false);
    expect(shouldWriteOdds(2000, 2020, 0.01)).toBe(true);
    expect(shouldWriteOdds(2000, 1980, 0.01)).toBe(true);
    // 1.01 → 1.001 is under 1% but the stale price would pay more than the model allows.
    expect(shouldWriteOdds(1010, 1001, 0.01)).toBe(true);
    expect(shouldWriteOdds(1105, 1095, 0.01)).toBe(true);
    expect(shouldWriteOdds(ALWAYS_WRITE_BELOW_MILLI + 10, ALWAYS_WRITE_BELOW_MILLI, 0.01)).toBe(
      false,
    );
    // Lengthening below 1.10 favours the house and may wait for the threshold.
    expect(shouldWriteOdds(1001, 1005, 0.01)).toBe(false);
  });
});
