import { randomUUID } from 'node:crypto';
import {
  MARKET_TYPES,
  resolveSelection,
  selectionsFor,
  SPORT_MARKETS,
  type MarketTypeCode,
  type ResolutionInput,
  type SportCode,
} from '@vamos/core';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @vamos/db does not depend on @vamos/contracts; the source is imported only to
// check that the LiveMessage mirror in src/catalog/live.ts matches the contract.
import {
  LIVE_CHANNEL as CONTRACT_LIVE_CHANNEL,
  LiveMessage as LiveMessageContract,
} from '../../contracts/src/catalog';
import {
  allocateGameId,
  applyLiveState,
  ensureSimulationSeed,
  isSelectionBettable,
  CatalogError,
  CatalogNotFoundError,
  CatalogStateError,
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  GAME_ID_FALLBACK_RANGE,
  GAME_ID_RANGE,
  LIVE_CHANNEL,
  listScheduledEventIds,
  listScheduledFeedEvents,
  listSimulationCandidates,
  loadCatalogIds,
  lockEventForSimulation,
  marketsWithSelections,
  resultEvent,
  resumeEvent,
  setEventBettingOpen,
  setManualOdds,
  setMarketStatus,
  setSelectionOdds,
  suspendEvent,
  upsertFixture,
  type CatalogIds,
  type FixtureMarketInput,
  type LiveMessage,
  type UpsertFixtureInput,
  type UpsertFixtureOptions,
} from '../src/index';
import {
  auditLog,
  events,
  markets,
  oddsHistory,
  outboxEvents,
  selections,
} from '../src/schema/index';
import { seedCatalog } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase, pgCode, sleep } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;
let ids: CatalogIds;
/** Every delta returned in this file, checked against the contract at the end. */
const seen: LiveMessage[] = [];

beforeAll(async () => {
  handle = await createTestDatabase();
  await seedCatalog(handle.db);
  ids = await loadCatalogIds(handle.db);
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const FOOTBALL_LINES = ['0.5', '1.5', '2.5', '3.5', '4.5'];

const TEAMS: Record<SportCode, { competition: string; home: string; away: string }> = {
  football: { competition: 'premier-league', home: 'Arsenal', away: 'Chelsea' },
  basketball: { competition: 'nba', home: 'Celtics', away: 'Lakers' },
  tennis: { competition: 'atp-tour', home: 'Sinner', away: 'Alcaraz' },
  volleyball: { competition: 'volleyball-nations-league', home: 'Poland', away: 'Italy' },
};

function id(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error(`no seeded ${key}`);
  return value;
}

function fixture(sport: SportCode = 'football', overrides: Partial<UpsertFixtureInput> = {}) {
  const teams = TEAMS[sport];
  return {
    feedProvider: 'test-feed',
    feedRef: `test:${randomUUID()}`,
    sport,
    competitionId: id(ids.competitions, `${sport}/${teams.competition}`),
    homeTeamId: id(ids.teams, `${sport}/${teams.home}`),
    awayTeamId: id(ids.teams, `${sport}/${teams.away}`),
    startTime: new Date(Date.now() + 3 * 3600_000),
    ...overrides,
  } satisfies UpsertFixtureInput;
}

/** Every market of the sport with distinct, valid prices. */
function marketsFor(sport: SportCode, lines: readonly string[] = FOOTBALL_LINES) {
  return SPORT_MARKETS[sport].flatMap((type): FixtureMarketInput[] => {
    const typeLines: Array<string | null> = MARKET_TYPES[type].hasLine
      ? type === 'total'
        ? ['215.5']
        : [...lines]
      : [null];
    return typeLines.map((line) => ({
      type,
      line,
      selections: selectionsFor(type).map((code, index) => ({
        code,
        oddsMilli: 1500 + 100 * index,
      })),
    }));
  });
}

function withOdds(
  list: FixtureMarketInput[],
  type: MarketTypeCode,
  code: string,
  oddsMilli: number,
): FixtureMarketInput[] {
  return list.map((market) =>
    market.type !== type
      ? market
      : {
          ...market,
          selections: market.selections.map((s) => (s.code === code ? { ...s, oddsMilli } : s)),
        },
  );
}

async function upsert(
  input: UpsertFixtureInput,
  list: readonly FixtureMarketInput[],
  options?: UpsertFixtureOptions,
) {
  const result = await handle.db.transaction((tx) => upsertFixture(tx, input, list, options));
  seen.push(...result.messages);
  return result;
}

async function tx<T extends { messages: LiveMessage[] }>(
  fn: (t: Parameters<Parameters<TestDb['db']['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  const result = await handle.db.transaction(fn);
  seen.push(...result.messages);
  return result;
}

async function selectionOf(eventId: string, key: string, code: string) {
  const [row] = await handle.db
    .select({
      id: selections.id,
      oddsMilli: selections.oddsMilli,
      status: selections.status,
      result: selections.result,
      marketId: markets.id,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(and(eq(markets.eventId, eventId), eq(markets.key, key), eq(selections.code, code)));
  if (!row) throw new Error(`no selection ${key}/${code}`);
  return row;
}

async function historyCount(eventId: string): Promise<number> {
  const [row] = await handle.db
    .select({ n: count() })
    .from(oddsHistory)
    .innerJoin(selections, eq(selections.id, oddsHistory.selectionId))
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, eventId));
  return row?.n ?? 0;
}

async function outboxFor(eventId: string) {
  return handle.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.aggregateType, 'event'), eq(outboxEvents.aggregateId, eventId)))
    .orderBy(asc(outboxEvents.id));
}

async function eventRow(eventId: string) {
  const [row] = await handle.db.select().from(events).where(eq(events.id, eventId));
  if (!row) throw new Error(`no event ${eventId}`);
  return row;
}

describe('allocateGameId', () => {
  it('returns an unused 4–5 digit id', async () => {
    const drawn = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const gameId = await allocateGameId(handle.db);
      expect(gameId).toBeGreaterThanOrEqual(GAME_ID_RANGE.min);
      expect(gameId).toBeLessThanOrEqual(GAME_ID_RANGE.max);
      drawn.add(gameId);
    }
    expect(drawn.size).toBeGreaterThan(1);
  });

  it('skips taken ids and falls back to 6 digits when the short range is crowded', async () => {
    const taken = await upsert(fixture(), marketsFor('football'), { randomInt: () => 4242 });
    expect(taken.gameId).toBe(4242);

    const fallback = await allocateGameId(handle.db, {
      randomInt: (min) => (min === GAME_ID_RANGE.min ? 4242 : 123_456),
    });
    expect(fallback).toBe(123_456);
    expect(fallback).toBeGreaterThanOrEqual(GAME_ID_FALLBACK_RANGE.min);

    let draws = 0;
    const mixed = await allocateGameId(handle.db, {
      randomInt: () => (draws++ % 2 === 0 ? 4242 : 4243),
    });
    expect(mixed).toBe(4243);
  });

  it('throws when every draw is taken', async () => {
    const crowded = (min: number) => (min === GAME_ID_RANGE.min ? 4242 : 654_321);
    const taken = await upsert(fixture(), marketsFor('football'), { randomInt: crowded });
    expect(taken.gameId).toBe(654_321);
    await expect(allocateGameId(handle.db, { randomInt: crowded })).rejects.toBeInstanceOf(
      CatalogError,
    );
  });

  it('rejects a random source that leaves the range', async () => {
    await expect(allocateGameId(handle.db, { randomInt: () => 99 })).rejects.toThrow(RangeError);
  });

  it('retries with another id when a concurrent insert took the same one', async () => {
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => (releaseA = resolve));
    let aInserted!: () => void;
    const aReady = new Promise<void>((resolve) => (aInserted = resolve));

    const a = handle.db.transaction(async (t) => {
      const result = await upsertFixture(t, fixture(), marketsFor('football'), {
        randomInt: () => 5555,
      });
      aInserted();
      await aMayCommit;
      return result;
    });
    await aReady;

    let bDraws = 0;
    const b = handle.db.transaction((t) =>
      upsertFixture(t, fixture(), marketsFor('football'), {
        randomInt: () => (bDraws++ === 0 ? 5555 : 5556),
      }),
    );
    // Wait until B is blocked on A's uncommitted 5555, then let A commit.
    for (let i = 0; i < 100; i++) {
      const waiting = await handle.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(waiting.rows[0]?.n) > 0) break;
      await sleep(20);
    }
    releaseA();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.gameId).toBe(5555);
    expect(rb.gameId).toBe(5556);
    expect(rb.created).toBe(true);
    // B allocated twice: its first id lost the race.
    expect(bDraws).toBeGreaterThan(24);
  });

  it('keeps game ids unique across many concurrent fixtures', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => upsert(fixture('tennis'), marketsFor('tennis'))),
    );
    expect(new Set(results.map((r) => r.gameId)).size).toBe(12);
  });
});

describe('upsertFixture', () => {
  it('inserts a new fixture with its markets, selections and opening odds history', async () => {
    const input = fixture();
    const list = marketsFor('football');
    const result = await upsert(input, list);
    expect(result).toMatchObject({ created: true, status: 'scheduled', oddsChanged: 0 });
    expect(result.marketsAdded).toBe(list.length);
    expect(result.messages).toEqual([]);

    const event = await eventRow(result.eventId);
    expect(event).toMatchObject({
      gameId: result.gameId,
      sportId: 'football',
      status: 'scheduled',
      bettingOpen: true,
      feedProvider: 'test-feed',
      feedRef: input.feedRef,
    });
    expect(event.startTime.getTime()).toBe(input.startTime.getTime());

    const stored = await marketsWithSelections(handle.db, result.eventId);
    expect(stored.map((m) => m.key).sort()).toEqual(
      ['1x2', 'dc', 'btts', 'dnb', 'ht_1x2', 'cs', ...FOOTBALL_LINES.map((l) => `ou:${l}`)].sort(),
    );
    for (const market of stored) {
      expect(market.status).toBe('open');
      expect(market.selections.map((s) => s.code)).toEqual(
        selectionsFor(market.type as MarketTypeCode),
      );
    }
    const selectionCount = list.reduce((n, m) => n + m.selections.length, 0);
    expect(await historyCount(result.eventId)).toBe(selectionCount);
    const sources = await handle.db
      .selectDistinct({ source: oddsHistory.source })
      .from(oddsHistory)
      .where(
        inArray(
          oddsHistory.selectionId,
          stored.flatMap((m) => m.selections.map((s) => s.id)),
        ),
      );
    expect(sources).toEqual([{ source: 'feed' }]);
  });

  it('is idempotent: the same prices write nothing', async () => {
    const input = fixture();
    const first = await upsert(input, marketsFor('football'));
    const before = await historyCount(first.eventId);
    const again = await upsert(input, marketsFor('football'));
    expect(again).toEqual({
      eventId: first.eventId,
      gameId: first.gameId,
      created: false,
      status: 'scheduled',
      marketsAdded: 0,
      oddsChanged: 0,
      messages: [],
    });
    expect(await historyCount(first.eventId)).toBe(before);
  });

  it('reprices only the selections whose feed price moved, with odds history', async () => {
    const input = fixture();
    const first = await upsert(input, marketsFor('football'));
    const before = await historyCount(first.eventId);

    let moved = withOdds(marketsFor('football'), '1x2', '1', 1450);
    moved = withOdds(moved, 'btts', 'no', 2222);
    const result = await upsert(input, moved);
    expect(result.oddsChanged).toBe(2);
    expect(await historyCount(first.eventId)).toBe(before + 2);

    const home = await selectionOf(first.eventId, '1x2', '1');
    const no = await selectionOf(first.eventId, 'btts', 'no');
    expect(home.oddsMilli).toBe(1450);
    expect(no.oddsMilli).toBe(2222);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        { type: 'odds', eventId: first.eventId, data: { s: home.id, o: 1450, st: 'open' } },
        { type: 'odds', eventId: first.eventId, data: { s: no.id, o: 2222, st: 'open' } },
      ]),
    );
    expect(result.messages).toHaveLength(2);

    // The same moved prices again: nothing more.
    const again = await upsert(input, moved);
    expect(again.oddsChanged).toBe(0);
    expect(await historyCount(first.eventId)).toBe(before + 2);
  });

  it('moves the start time and adds markets the event does not have yet', async () => {
    const input = fixture();
    const first = await upsert(input, marketsFor('football', ['2.5']));
    const later = new Date(input.startTime.getTime() + 15 * 60_000);
    const result = await upsert(
      { ...input, startTime: later },
      marketsFor('football', ['2.5', '3.5']),
    );
    expect(result.marketsAdded).toBe(1);
    const added = (await marketsWithSelections(handle.db, first.eventId)).find(
      (m) => m.key === 'ou:3.5',
    );
    expect(added?.selections.map((s) => s.code)).toEqual(['over', 'under']);
    expect(result.messages).toEqual([
      { type: 'market', eventId: first.eventId, data: { k: added?.id, st: 'open' } },
    ]);
    expect((await eventRow(first.eventId)).startTime.getTime()).toBe(later.getTime());
  });

  it("keeps a trader's price until the feed itself moves", async () => {
    const input = fixture();
    const first = await upsert(input, marketsFor('football'));
    const draw = await selectionOf(first.eventId, '1x2', 'X');
    await tx((t) => setManualOdds(t, draw.id, 3333, randomUUID()));

    // Same feed prices: the manual price stays.
    await upsert(input, marketsFor('football'));
    expect((await selectionOf(first.eventId, '1x2', 'X')).oddsMilli).toBe(3333);

    // The feed moves the draw: the feed wins again.
    const result = await upsert(input, withOdds(marketsFor('football'), '1x2', 'X', 1700));
    expect(result.oddsChanged).toBe(1);
    expect((await selectionOf(first.eventId, '1x2', 'X')).oddsMilli).toBe(1700);
  });

  it('never touches live or resulted events', async () => {
    const input = fixture();
    const first = await upsert(input, marketsFor('football', ['2.5']));
    await tx((t) =>
      applyLiveState(t, first.eventId, {
        status: 'live',
        minute: 3,
        period: '1H',
        home: 0,
        away: 0,
      }),
    );
    const before = await historyCount(first.eventId);
    const result = await upsert(
      { ...input, startTime: new Date(input.startTime.getTime() + 60_000) },
      withOdds(marketsFor('football', ['2.5', '3.5']), '1x2', '1', 9999),
    );
    expect(result).toMatchObject({
      created: false,
      status: 'live',
      marketsAdded: 0,
      oddsChanged: 0,
      messages: [],
    });
    expect(await historyCount(first.eventId)).toBe(before);
    expect((await marketsWithSelections(handle.db, first.eventId)).map((m) => m.key)).not.toContain(
      'ou:3.5',
    );
    expect((await eventRow(first.eventId)).startTime.getTime()).toBe(input.startTime.getTime());
  });

  it('validates the markets before writing anything', async () => {
    const input = fixture();
    const football = marketsFor('football', ['2.5']);
    const cases: FixtureMarketInput[][] = [
      [...football, ...marketsFor('basketball')],
      withOdds(football, '1x2', '1', 1000),
      withOdds(football, '1x2', '1', 1_000_001),
      football.map((m) => (m.type === 'dc' ? { ...m, selections: m.selections.slice(1) } : m)),
      [...football, { type: 'ou', line: '2.50', selections: football[2]!.selections }],
      [{ type: 'ou', line: '2', selections: [{ code: 'over', oddsMilli: 1900 }] }],
      [{ type: '1x2', line: null, selections: [{ code: 'Y', oddsMilli: 1900 }] }],
    ];
    for (const list of cases) {
      await expect(upsert(input, list)).rejects.toThrow(RangeError);
    }
    await expect(upsert({ ...input, awayTeamId: input.homeTeamId }, football)).rejects.toThrow(
      RangeError,
    );
    const rows = await handle.db.select().from(events).where(eq(events.feedRef, input.feedRef));
    expect(rows).toEqual([]);
  });

  it('creates one event when the same new fixture is upserted concurrently', async () => {
    const input = fixture();
    const results = await Promise.all([1, 2, 3].map(() => upsert(input, marketsFor('football'))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
    const stored = await marketsWithSelections(handle.db, results[0]!.eventId);
    expect(stored).toHaveLength(marketsFor('football').length);
  });
});

describe('setSelectionOdds', () => {
  it('validates every price before writing', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const away = await selectionOf(created.eventId, '1x2', '2');
    for (const bad of [1000, 1_000_001, 1850.5, Number.NaN]) {
      await expect(
        handle.db.transaction((t) =>
          setSelectionOdds(t, [
            { selectionId: home.id, oddsMilli: 1900, source: 'test' },
            { selectionId: away.id, oddsMilli: bad, source: 'test' },
          ]),
        ),
      ).rejects.toThrow(RangeError);
    }
    expect((await selectionOf(created.eventId, '1x2', '1')).oddsMilli).toBe(home.oddsMilli);
    await expect(
      handle.db.transaction((t) =>
        setSelectionOdds(t, [
          { selectionId: home.id, oddsMilli: 1900, source: 'test' },
          { selectionId: home.id, oddsMilli: 2000, source: 'test' },
        ]),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      handle.db.transaction((t) =>
        setSelectionOdds(t, [{ selectionId: randomUUID(), oddsMilli: 1900, source: 'test' }]),
      ),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
  });

  it('updates prices, records history and reports only real changes', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const draw = await selectionOf(created.eventId, '1x2', 'X');
    const before = await historyCount(created.eventId);
    const result = await tx((t) =>
      setSelectionOdds(t, [
        { selectionId: home.id, oddsMilli: 1_000_000, source: 'test' },
        { selectionId: draw.id, oddsMilli: draw.oddsMilli, source: 'test' },
      ]),
    );
    expect(result.changed).toEqual([
      {
        selectionId: home.id,
        marketId: home.marketId,
        eventId: created.eventId,
        previousOddsMilli: home.oddsMilli,
        oddsMilli: 1_000_000,
        source: 'test',
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.messages).toEqual([
      { type: 'odds', eventId: created.eventId, data: { s: home.id, o: 1_000_000, st: 'open' } },
    ]);
    expect(await historyCount(created.eventId)).toBe(before + 1);
    const [last] = await handle.db
      .select()
      .from(oddsHistory)
      .where(eq(oddsHistory.selectionId, home.id))
      .orderBy(sql`${oddsHistory.id} DESC`)
      .limit(1);
    expect(last).toMatchObject({ oddsMilli: 1_000_000, source: 'test' });
  });

  it('skips selections of closed markets and reports suspended ones as not bettable', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const yes = await selectionOf(created.eventId, 'btts', 'yes');
    await tx((t) => setMarketStatus(t, home.marketId, 'closed'));
    await tx((t) => setMarketStatus(t, yes.marketId, 'suspended'));
    const result = await tx((t) =>
      setSelectionOdds(t, [
        { selectionId: home.id, oddsMilli: 1999, source: 'test' },
        { selectionId: yes.id, oddsMilli: 1999, source: 'test' },
      ]),
    );
    expect(result.skipped).toEqual([home.id]);
    expect(result.messages).toEqual([
      { type: 'odds', eventId: created.eventId, data: { s: yes.id, o: 1999, st: 'suspended' } },
    ]);
  });
});

describe('market and event state', () => {
  it('opens, suspends and closes markets, refusing final statuses', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const suspended = await tx((t) => setMarketStatus(t, home.marketId, 'suspended'));
    expect(suspended).toEqual({
      changed: true,
      messages: [
        { type: 'market', eventId: created.eventId, data: { k: home.marketId, st: 'suspended' } },
      ],
    });
    expect(await tx((t) => setMarketStatus(t, home.marketId, 'suspended'))).toEqual({
      changed: false,
      messages: [],
    });
    await tx((t) => setMarketStatus(t, home.marketId, 'open'));
    await expect(
      handle.db.transaction((t) => setMarketStatus(t, home.marketId, 'settled' as 'open')),
    ).rejects.toThrow(RangeError);
    await expect(
      handle.db.transaction((t) => setMarketStatus(t, randomUUID(), 'open')),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
  });

  it('opens and closes betting on an event', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const actor = { adminId: randomUUID(), reason: 'VAR check' };
    const closed = await tx((t) => setEventBettingOpen(t, created.eventId, false, actor));
    expect(closed.messages).toEqual([
      {
        type: 'match',
        eventId: created.eventId,
        data: { e: created.eventId, m: null, p: null, sc: null, st: 'scheduled', b: false },
      },
    ]);
    expect((await eventRow(created.eventId)).bettingOpen).toBe(false);
    expect((await tx((t) => setEventBettingOpen(t, created.eventId, false))).changed).toBe(false);
    const audits = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, created.eventId));
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: 'admin',
        actorId: actor.adminId,
        action: 'catalog.event.betting_closed',
        metadata: { reason: 'VAR check' },
      }),
    ]);
    // Odds deltas of an event with betting closed are not bettable.
    const home = await selectionOf(created.eventId, '1x2', '1');
    const repriced = await tx((t) =>
      setSelectionOdds(t, [{ selectionId: home.id, oddsMilli: 1777, source: 'test' }]),
    );
    expect(repriced.messages[0]?.data).toEqual({ s: home.id, o: 1777, st: 'suspended' });
  });

  it('applies live state and reports only real changes', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const state = {
      status: 'live',
      minute: 12,
      period: '1H',
      home: 1,
      away: 0,
    } as const;
    const first = await tx((t) => applyLiveState(t, created.eventId, state));
    expect(first.messages).toEqual([
      {
        type: 'match',
        eventId: created.eventId,
        data: { e: created.eventId, m: 12, p: '1H', sc: [1, 0], st: 'live', b: true },
      },
    ]);
    expect(await tx((t) => applyLiveState(t, created.eventId, state))).toEqual({
      changed: false,
      messages: [],
    });
    const half = await tx((t) =>
      applyLiveState(t, created.eventId, {
        ...state,
        minute: 45,
        period: 'HT',
        htHome: 1,
        htAway: 0,
      }),
    );
    expect(half.changed).toBe(true);
    expect(await eventRow(created.eventId)).toMatchObject({
      status: 'live',
      liveMinute: 45,
      period: 'HT',
      scoreHome: 1,
      scoreAway: 0,
      htScoreHome: 1,
      htScoreAway: 0,
    });
    for (const bad of [
      { ...state, htHome: 2, htAway: 0 },
      { ...state, home: -1 },
      { ...state, away: null },
      { ...state, minute: 1.5 },
      { ...state, status: 'finished' as 'live' },
    ]) {
      await expect(
        handle.db.transaction((t) => applyLiveState(t, created.eventId, bad)),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      handle.db.transaction((t) => applyLiveState(t, randomUUID(), state)),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
  });

  it('suspends and resumes every open market of an event, with an audit entry', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    await tx((t) => setMarketStatus(t, home.marketId, 'closed'));
    const actor = { adminId: randomUUID() };
    const suspended = await tx((t) => suspendEvent(t, created.eventId, actor));
    const all = await marketsWithSelections(handle.db, created.eventId);
    expect(suspended.messages).toHaveLength(all.length - 1);
    expect(all.filter((m) => m.status === 'suspended')).toHaveLength(all.length - 1);
    expect(all.find((m) => m.id === home.marketId)?.status).toBe('closed');
    expect(suspended.messages.every((m) => m.type === 'market' && m.data.st === 'suspended')).toBe(
      true,
    );

    const resumed = await tx((t) => resumeEvent(t, created.eventId, actor));
    expect(resumed.messages).toHaveLength(all.length - 1);
    const after = await marketsWithSelections(handle.db, created.eventId);
    expect(after.filter((m) => m.status === 'open')).toHaveLength(all.length - 1);
    expect((await tx((t) => resumeEvent(t, created.eventId))).changed).toBe(false);

    const actions = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, created.eventId))
      .orderBy(asc(auditLog.id));
    expect(actions.map((a) => a.action)).toEqual([
      'catalog.event.suspended',
      'catalog.event.resumed',
    ]);
  });

  it("never lets an automatic re-open lift a trader's suspension (regression)", async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const yes = await selectionOf(created.eventId, 'btts', 'yes');
    const over = await selectionOf(created.eventId, 'ou:2.5', 'over');
    const trader = { adminId: randomUUID(), reason: 'integrity alert' };
    const suspendedBy = async () =>
      new Map(
        (await marketsWithSelections(handle.db, created.eventId)).map((m) => [
          m.id,
          `${m.status}/${m.suspendedBy ?? '-'}`,
        ]),
      );

    // A trader suspends 1X2; then a goal suspends the rest automatically.
    await tx((t) => setMarketStatus(t, home.marketId, 'suspended', trader));
    const automatic = await tx((t) => suspendEvent(t, created.eventId));
    expect(automatic.messages.some((m) => m.type === 'market' && m.data.k === home.marketId)).toBe(
      false,
    );
    // During the automatic suspension a trader suspends BTTS too: it is taken over, silently.
    const takeover = await tx((t) => setMarketStatus(t, yes.marketId, 'suspended', trader));
    expect(takeover).toEqual({ changed: true, messages: [] });
    let states = await suspendedBy();
    expect(states.get(home.marketId)).toBe('suspended/trader');
    expect(states.get(yes.marketId)).toBe('suspended/trader');
    expect(states.get(over.marketId)).toBe('suspended/feed');

    // The automatic resume re-opens only what was suspended automatically.
    const resumed = await tx((t) => resumeEvent(t, created.eventId));
    expect(resumed.messages.map((m) => m.type === 'market' && m.data.k)).not.toContain(
      home.marketId,
    );
    expect(await tx((t) => setMarketStatus(t, home.marketId, 'open'))).toEqual({
      changed: false,
      messages: [],
    });
    states = await suspendedBy();
    expect(states.get(home.marketId)).toBe('suspended/trader');
    expect(states.get(yes.marketId)).toBe('suspended/trader');
    expect(states.get(over.marketId)).toBe('open/-');

    // A trader's event suspension takes over the feed's; only a trader lifts it.
    await tx((t) => setMarketStatus(t, over.marketId, 'suspended'));
    await tx((t) => suspendEvent(t, created.eventId, trader));
    expect([...(await suspendedBy()).values()].every((v) => v === 'suspended/trader')).toBe(true);
    expect((await tx((t) => resumeEvent(t, created.eventId))).changed).toBe(false);
    const lifted = await tx((t) => resumeEvent(t, created.eventId, trader));
    expect(lifted.messages.length).toBe((await suspendedBy()).size);
    expect([...(await suspendedBy()).values()].every((v) => v === 'open/-')).toBe(true);
    // The schema keeps the owner consistent with the status.
    await expect(
      handle.db.update(markets).set({ suspendedBy: 'feed' }).where(eq(markets.id, home.marketId)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '23514');
  });

  it('closes prematch betting at the start time, in odds deltas too (regression)', async () => {
    const start = new Date('2026-10-08T11:30:00Z');
    const event = { status: 'scheduled', bettingOpen: true, startTime: start } as const;
    const before = new Date(start.getTime() - 1);
    expect(isSelectionBettable(event, 'open', 'open', before)).toBe(true);
    expect(isSelectionBettable(event, 'open', 'open', start)).toBe(false);
    expect(isSelectionBettable({ ...event, status: 'live' }, 'open', 'open', start)).toBe(true);
    expect(isSelectionBettable(event, 'suspended', 'open', before)).toBe(false);
    expect(isSelectionBettable({ ...event, bettingOpen: false }, 'open', 'open', before)).toBe(
      false,
    );

    const created = await upsert(fixture('football', { startTime: start }), marketsFor('football'));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const late = await tx((t) =>
      setSelectionOdds(t, [{ selectionId: home.id, oddsMilli: 2345, source: 'test' }], {
        now: new Date('2026-10-08T12:00:00Z'),
      }),
    );
    expect(late.messages[0]?.data).toEqual({ s: home.id, o: 2345, st: 'suspended' });
    const early = await tx((t) =>
      setSelectionOdds(t, [{ selectionId: home.id, oddsMilli: 2346, source: 'test' }], {
        now: before,
      }),
    );
    expect(early.messages[0]?.data).toEqual({ s: home.id, o: 2346, st: 'open' });
  });

  it('records manual odds in the audit log and refuses settled selections', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const home = await selectionOf(created.eventId, '1x2', '1');
    const adminId = randomUUID();
    const result = await tx((t) =>
      setManualOdds(t, home.id, 2500, adminId, { ip: '10.0.0.1', reason: 'liability' }),
    );
    expect(result.changed).toHaveLength(1);
    const [audit] = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, home.id));
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: adminId,
      action: 'catalog.odds.manual',
      targetType: 'selection',
      ip: '10.0.0.1',
      metadata: {
        eventId: created.eventId,
        marketId: home.marketId,
        fromOddsMilli: home.oddsMilli,
        toOddsMilli: 2500,
        reason: 'liability',
      },
    });
    const [history] = await handle.db
      .select()
      .from(oddsHistory)
      .where(eq(oddsHistory.selectionId, home.id))
      .orderBy(sql`${oddsHistory.id} DESC`)
      .limit(1);
    expect(history).toMatchObject({ oddsMilli: 2500, source: 'manual' });

    await tx((t) =>
      resultEvent(t, created.eventId, {
        status: 'finished',
        score: { home: 1, away: 0, htHome: 0, htAway: 0 },
      }),
    );
    await expect(
      handle.db.transaction((t) => setManualOdds(t, home.id, 2600, adminId)),
    ).rejects.toBeInstanceOf(CatalogStateError);
    await expect(
      handle.db.transaction((t) => setMarketStatus(t, home.marketId, 'open')),
    ).rejects.toBeInstanceOf(CatalogStateError);
    await expect(
      handle.db.transaction((t) => suspendEvent(t, created.eventId)),
    ).rejects.toBeInstanceOf(CatalogStateError);
  });
});

/** Every selection of the event with its market, after resulting. */
async function settledSelections(eventId: string) {
  return handle.db
    .select({
      type: markets.type,
      line: markets.line,
      key: markets.key,
      marketStatus: markets.status,
      settledAt: markets.settledAt,
      code: selections.code,
      status: selections.status,
      result: selections.result,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, eventId));
}

async function expectSettledLike(eventId: string, input: ResolutionInput) {
  const rows = await settledSelections(eventId);
  expect(rows.length).toBeGreaterThan(0);
  const byMarket = new Map<string, typeof rows>();
  for (const row of rows) {
    expect(row.status).toBe('settled');
    expect(row.result).toBe(
      resolveSelection({ type: row.type as MarketTypeCode, line: row.line }, row.code, input),
    );
    byMarket.set(row.key, [...(byMarket.get(row.key) ?? []), row]);
  }
  for (const list of byMarket.values()) {
    const allVoid = list.every((row) => row.result === 'void');
    for (const row of list) {
      expect(row.marketStatus).toBe(allVoid ? 'void' : 'settled');
      expect(row.settledAt).toBeInstanceOf(Date);
    }
  }
  return rows;
}

describe('resultEvent', () => {
  it('settles every football market for 2-1 (half time 1-0)', async () => {
    const created = await upsert(fixture(), marketsFor('football'));
    const input: ResolutionInput = {
      status: 'finished',
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    };
    const outcome = await tx((t) => resultEvent(t, created.eventId, input));
    const marketCount = marketsFor('football').length;
    expect(outcome).toMatchObject({
      outcome: 'resulted',
      status: 'finished',
      marketsSettled: marketCount,
      marketsVoided: 0,
    });
    expect(outcome.messages[0]).toEqual({
      type: 'match',
      eventId: created.eventId,
      data: { e: created.eventId, m: null, p: null, sc: [2, 1], st: 'finished', b: true },
    });
    expect(outcome.messages.filter((m) => m.type === 'market')).toHaveLength(marketCount);

    const rows = await expectSettledLike(created.eventId, input);
    const won = rows
      .filter((row) => row.result === 'won')
      .map((row) => `${row.key}/${row.code}`)
      .sort();
    expect(won).toEqual(
      [
        '1x2/1',
        'dc/1X',
        'dc/12',
        'ou:0.5/over',
        'ou:1.5/over',
        'ou:2.5/over',
        'ou:3.5/under',
        'ou:4.5/under',
        'btts/yes',
        'dnb/1',
        'ht_1x2/1',
        'cs/2-1',
      ].sort(),
    );

    expect(await eventRow(created.eventId)).toMatchObject({
      status: 'finished',
      scoreHome: 2,
      scoreAway: 1,
      htScoreHome: 1,
      htScoreAway: 0,
      resultedAt: expect.any(Date),
    });
    const outbox = await outboxFor(created.eventId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: EVENT_RESULTED,
      payload: {
        eventId: created.eventId,
        status: 'finished',
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      },
    });
  });

  it('voids draw-no-bet on a draw and settles a score outside the correct-score grid', async () => {
    const created = await upsert(fixture(), marketsFor('football'));
    const input: ResolutionInput = {
      status: 'finished',
      score: { home: 5, away: 5, htHome: 2, htAway: 3 },
    };
    const outcome = await tx((t) => resultEvent(t, created.eventId, input));
    expect(outcome.marketsVoided).toBe(1);
    const rows = await expectSettledLike(created.eventId, input);
    expect(rows.filter((r) => r.key === 'dnb').every((r) => r.marketStatus === 'void')).toBe(true);
    expect(rows.find((r) => r.key === 'cs' && r.result === 'won')?.code).toBe('other');
  });

  it('settles basketball and tennis markets', async () => {
    const basketball = await upsert(fixture('basketball'), marketsFor('basketball'));
    const input: ResolutionInput = { status: 'finished', score: { home: 110, away: 108 } };
    await tx((t) => resultEvent(t, basketball.eventId, input));
    const rows = await expectSettledLike(basketball.eventId, input);
    expect(
      rows
        .filter((r) => r.result === 'won')
        .map((r) => `${r.key}/${r.code}`)
        .sort(),
    ).toEqual(['ml/1', 'total:215.5/over']);

    const tennis = await upsert(fixture('tennis'), marketsFor('tennis'));
    const sets: ResolutionInput = { status: 'finished', score: { home: 1, away: 2 } };
    await tx((t) => resultEvent(t, tennis.eventId, sets));
    await expectSettledLike(tennis.eventId, sets);
    // A finished winner market cannot end in a tie.
    const tie = await upsert(fixture('volleyball'), marketsFor('volleyball'));
    await expect(
      handle.db.transaction((t) =>
        resultEvent(t, tie.eventId, { status: 'finished', score: { home: 2, away: 2 } }),
      ),
    ).rejects.toThrow(RangeError);
    expect((await eventRow(tie.eventId)).resultedAt).toBeNull();
  });

  it('voids every market of a cancelled event', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const outcome = await tx((t) => resultEvent(t, created.eventId, { status: 'cancelled' }));
    expect(outcome).toMatchObject({ outcome: 'resulted', status: 'cancelled', marketsSettled: 0 });
    expect(outcome.marketsVoided).toBe(marketsFor('football', ['2.5']).length);
    const rows = await expectSettledLike(created.eventId, { status: 'cancelled' });
    expect(rows.every((r) => r.result === 'void' && r.marketStatus === 'void')).toBe(true);
    expect((await eventRow(created.eventId)).status).toBe('cancelled');
    expect((await outboxFor(created.eventId))[0]?.payload).toEqual({
      eventId: created.eventId,
      status: 'cancelled',
      score: null,
    });
  });

  it('is a no-op when the same result is given again', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const input: ResolutionInput = {
      status: 'finished',
      score: { home: 0, away: 0, htHome: 0, htAway: 0 },
    };
    await tx((t) => resultEvent(t, created.eventId, input));
    const before = await eventRow(created.eventId);
    const again = await tx((t) => resultEvent(t, created.eventId, input));
    expect(again).toEqual({
      outcome: 'unchanged',
      eventId: created.eventId,
      status: 'finished',
      marketsSettled: 0,
      marketsVoided: 0,
      messages: [],
    });
    expect(await outboxFor(created.eventId)).toHaveLength(1);
    expect((await eventRow(created.eventId)).updatedAt).toEqual(before.updatedAt);
  });

  it('re-settles every market on a correction and emits event.result_corrected', async () => {
    const created = await upsert(fixture(), marketsFor('football'));
    const first: ResolutionInput = {
      status: 'finished',
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    };
    const corrected: ResolutionInput = {
      status: 'finished',
      score: { home: 1, away: 1, htHome: 1, htAway: 0 },
    };
    await tx((t) => resultEvent(t, created.eventId, first));
    const outcome = await tx((t) => resultEvent(t, created.eventId, corrected));
    expect(outcome).toMatchObject({ outcome: 'corrected', marketsVoided: 1 });
    await expectSettledLike(created.eventId, corrected);
    expect((await selectionOf(created.eventId, '1x2', 'X')).result).toBe('won');
    expect((await selectionOf(created.eventId, 'cs', '2-1')).result).toBe('lost');
    expect((await eventRow(created.eventId)).scoreHome).toBe(1);

    const outbox = await outboxFor(created.eventId);
    expect(outbox.map((row) => row.type)).toEqual([EVENT_RESULTED, EVENT_RESULT_CORRECTED]);
    expect(outbox[1]?.payload).toEqual({
      eventId: created.eventId,
      status: 'finished',
      score: { home: 1, away: 1, htHome: 1, htAway: 0 },
      previous: {
        status: 'finished',
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      },
    });

    // finished → abandoned is a correction too.
    const voided = await tx((t) => resultEvent(t, created.eventId, { status: 'abandoned' }));
    expect(voided.outcome).toBe('corrected');
    await expectSettledLike(created.eventId, { status: 'abandoned' });
    // And repeating the corrected result changes nothing.
    expect(
      (await tx((t) => resultEvent(t, created.eventId, { status: 'abandoned' }))).outcome,
    ).toBe('unchanged');
  });

  it('leaves markets that were already settled or void before the first resulting', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const btts = await selectionOf(created.eventId, 'btts', 'yes');
    await handle.db.update(markets).set({ status: 'void' }).where(eq(markets.id, btts.marketId));
    const outcome = await tx((t) =>
      resultEvent(t, created.eventId, {
        status: 'finished',
        score: { home: 1, away: 1, htHome: 0, htAway: 0 },
      }),
    );
    expect(outcome.messages.some((m) => m.type === 'market' && m.data.k === btts.marketId)).toBe(
      false,
    );
    const after = await selectionOf(created.eventId, 'btts', 'yes');
    expect(after).toMatchObject({ status: 'open', result: null });
  });

  it('rejects invalid results without writing anything', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const bad: ResolutionInput[] = [
      { status: 'finished', score: { home: 1, away: 0, htHome: 2, htAway: 0 } },
      { status: 'finished', score: { home: -1, away: 0 } },
      { status: 'finished', score: { home: 1, away: 0, htHome: 1 } },
      // ht_1x2 needs the half-time score.
      { status: 'finished', score: { home: 1, away: 0 } },
      { status: 'live' } as unknown as ResolutionInput,
    ];
    for (const input of bad) {
      await expect(
        handle.db.transaction((t) => resultEvent(t, created.eventId, input)),
      ).rejects.toThrow(RangeError);
    }
    const event = await eventRow(created.eventId);
    expect(event).toMatchObject({ status: 'scheduled', resultedAt: null });
    expect(await outboxFor(created.eventId)).toEqual([]);
    await expect(
      handle.db.transaction((t) => resultEvent(t, randomUUID(), { status: 'cancelled' })),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
  });
});

describe('worker queries', () => {
  it('lists simulation candidates and scheduled events of a provider', async () => {
    const provider = `sim-${randomUUID()}`;
    const now = new Date();
    const due = await upsert(
      fixture('football', { feedProvider: provider, startTime: new Date(now.getTime() - 1000) }),
      marketsFor('football', ['2.5']),
    );
    const later = await upsert(
      fixture('football', { feedProvider: provider, startTime: new Date(now.getTime() + 60_000) }),
      marketsFor('football', ['2.5']),
    );
    const live = await upsert(
      fixture('football', { feedProvider: provider, startTime: new Date(now.getTime() + 120_000) }),
      marketsFor('football', ['2.5']),
    );
    await tx((t) =>
      applyLiveState(t, live.eventId, {
        status: 'live',
        minute: 0,
        period: '1H',
        home: 0,
        away: 0,
      }),
    );
    const candidates = await listSimulationCandidates(handle.db, { feedProvider: provider, now });
    expect(candidates.map((c) => c.id)).toEqual([due.eventId, live.eventId]);
    expect(await listScheduledEventIds(handle.db, { feedProvider: provider, after: now })).toEqual([
      later.eventId,
    ]);
    const locked = await handle.db.transaction((t) => lockEventForSimulation(t, due.eventId));
    expect(locked).toMatchObject({ id: due.eventId, sport: 'football', status: 'scheduled' });
    expect(locked.homeRatings).toEqual({ attack: 1.5, defence: 0.68 });
    expect(locked.simSeed).toBeNull();

    // The feed's scheduled events in a window, for withdrawing fixtures it stopped offering.
    const window = await listScheduledFeedEvents(handle.db, {
      feedProvider: provider,
      from: now,
      to: new Date(now.getTime() + 90_000),
    });
    expect(window.map((e) => e.id)).toEqual([later.eventId]);
    expect(window[0]?.feedRef).toMatch(/^test:/);
  });

  it('stores one secret simulation seed per event', async () => {
    const created = await upsert(fixture(), marketsFor('football', ['2.5']));
    const first = await handle.db.transaction(async (t) => {
      await lockEventForSimulation(t, created.eventId);
      return ensureSimulationSeed(t, created.eventId, 'seed-one');
    });
    expect(first).toBe('seed-one');
    const second = await handle.db.transaction((t) =>
      ensureSimulationSeed(t, created.eventId, 'seed-two'),
    );
    expect(second).toBe('seed-one');
    expect(
      (await handle.db.transaction((t) => lockEventForSimulation(t, created.eventId))).simSeed,
    ).toBe('seed-one');
    await expect(
      handle.db.transaction((t) => ensureSimulationSeed(t, randomUUID(), 'x')),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
  });

  it('refuses game ids outside 100–999999, which no view could format (regression)', async () => {
    const valid = await upsert(fixture(), []);
    const row = await eventRow(valid.eventId);
    for (const gameId of [42, 1_000_000]) {
      await expect(
        handle.db.insert(events).values({
          ...row,
          id: randomUUID(),
          gameId,
          feedRef: `test:${randomUUID()}`,
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '23514');
    }
  });
});

describe('live messages', () => {
  type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

  it('match the @vamos/contracts LiveMessage contract', () => {
    const sameType: Equals<LiveMessage, LiveMessageContract> = true;
    expect(sameType).toBe(true);
    expect(LIVE_CHANNEL).toBe(CONTRACT_LIVE_CHANNEL);
    expect(new Set(seen.map((m) => m.type))).toEqual(new Set(['odds', 'match', 'market']));
    for (const message of seen) {
      expect(LiveMessageContract.parse(message)).toEqual(message);
    }
  });
});
