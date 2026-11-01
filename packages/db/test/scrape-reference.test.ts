import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getReferenceBudget,
  getReferencePollState,
  isSelectionBettable,
  listReferenceBookPrices,
  listReferenceCandidates,
  listReferenceConsensus,
  listReferenceEventMap,
  listReferencePollState,
  marketsWithSelections,
  MAX_CLOSE_LEAD_MS,
  POLL_STATE_RETENTION_MS,
  prematchClosesAt,
  pruneReference,
  raiseCloseLead,
  recordReferenceBudget,
  REFERENCE_GUARD_ACTOR,
  removeReferenceEventMap,
  replaceReferenceBookPrices,
  resumeEvent,
  setEventBettingOpen,
  setMarketStatus,
  setReferencePollState,
  suspendMarketForGuard,
  upsertFixture,
  upsertReferenceConsensus,
  upsertReferenceEventMap,
  utcDay,
  type ReferenceBookPriceInput,
} from '../src/index';
import { auditLog, events, markets } from '../src/schema/index';
import { dropTestDatabase } from './helpers';
import {
  createScrapedEvent,
  createScrapeDatabase,
  KICKOFF,
  STAFF,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const P = 'therundown' as const;

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const db = () => ctx.handle.db;
const at = (ms: number) => new Date(T0.getTime() + ms);

const price = (
  marketKey: string,
  outcome: string,
  bookId: number,
  american = -120,
  overrides: Partial<ReferenceBookPriceInput> = {},
): ReferenceBookPriceInput => ({
  marketKey,
  outcome,
  bookId,
  american,
  oddsMilli: 1833,
  vendorUpdatedAt: at(-MINUTE),
  liquidityUsd: null,
  ...overrides,
});

function mapInput(eventId: string, providerEventId: string, seenAt: Date, extra = {}) {
  return {
    provider: P as typeof P,
    providerEventId,
    eventId,
    providerSportId: 11,
    homeTeamRef: 7,
    awayTeamRef: 9,
    kickoff: KICKOFF,
    status: 'STATUS_SCHEDULED',
    seenAt,
    ...extra,
  };
}

describe('reference event map', () => {
  it('maps a provider event; a refresh keeps first_seen_at and never moves last_seen_at back', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    const first = await db().transaction((tx) =>
      upsertReferenceEventMap(tx, mapInput(eventId, 'ev-map-1', at(0))),
    );
    expect(first).toMatchObject({
      provider: P,
      providerEventId: 'ev-map-1',
      eventId,
      providerSportId: 11,
      homeTeamRef: 7,
      awayTeamRef: 9,
      status: 'STATUS_SCHEDULED',
    });
    expect(first.kickoff).toEqual(KICKOFF);
    expect(first.firstSeenAt).toEqual(at(0));

    const refreshed = await db().transaction((tx) =>
      upsertReferenceEventMap(
        tx,
        mapInput(eventId, 'ev-map-1', at(5 * MINUTE), { status: 'STATUS_DELAYED' }),
      ),
    );
    expect(refreshed.firstSeenAt).toEqual(at(0));
    expect(refreshed.lastSeenAt).toEqual(at(5 * MINUTE));
    expect(refreshed.status).toBe('STATUS_DELAYED');

    // An older sighting does not move the clock back.
    const older = await db().transaction((tx) =>
      upsertReferenceEventMap(tx, mapInput(eventId, 'ev-map-1', at(MINUTE))),
    );
    expect(older.lastSeenAt).toEqual(at(5 * MINUTE));
    expect(await listReferenceEventMap(db(), P, { eventIds: [eventId] })).toHaveLength(1);
  });

  it('a new provider id for the same event replaces the old mapping and the old prices (a rescheduled match)', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await db().transaction(async (tx) => {
      await upsertReferenceEventMap(tx, mapInput(eventId, 'ev-old', at(0)));
      await replaceReferenceBookPrices(tx, {
        provider: P,
        providerEventId: 'ev-old',
        fetchedAt: at(0),
        asOf: at(-MINUTE),
        prices: [price('1x2', '1', 3)],
      });
    });
    const second = await db().transaction((tx) =>
      upsertReferenceEventMap(tx, mapInput(eventId, 'ev-new', at(MINUTE))),
    );
    // The event is a different provider event now: its first sighting starts again.
    expect(second.firstSeenAt).toEqual(at(MINUTE));
    const rows = await listReferenceEventMap(db(), P, { eventIds: [eventId] });
    expect(rows.map((r) => r.providerEventId)).toEqual(['ev-new']);
    expect(await listReferenceBookPrices(db(), P, 'ev-old')).toEqual([]);
  });

  it('one provider event points at one event: mapping it elsewhere moves it', async () => {
    const a = await createScrapedEvent(ctx);
    const b = await createScrapedEvent(ctx, { startTime: new Date(KICKOFF.getTime() + DAY) });
    await db().transaction((tx) =>
      upsertReferenceEventMap(tx, mapInput(a.eventId, 'ev-move', at(0))),
    );
    const moved = await db().transaction((tx) =>
      upsertReferenceEventMap(tx, mapInput(b.eventId, 'ev-move', at(MINUTE))),
    );
    expect(moved.eventId).toBe(b.eventId);
    expect(moved.firstSeenAt).toEqual(at(MINUTE));
    expect(await listReferenceEventMap(db(), P, { eventIds: [a.eventId] })).toEqual([]);
    expect(
      (await listReferenceEventMap(db(), P, { providerEventIds: ['ev-move'] })).map(
        (r) => r.eventId,
      ),
    ).toEqual([b.eventId]);
  });

  it('lists by event or provider event, an empty filter lists nothing, and remove drops the map and its prices', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await db().transaction(async (tx) => {
      await upsertReferenceEventMap(tx, mapInput(eventId, 'ev-rm', at(0)));
      await replaceReferenceBookPrices(tx, {
        provider: P,
        providerEventId: 'ev-rm',
        fetchedAt: at(0),
        asOf: at(0),
        prices: [price('1x2', '1', 3)],
      });
    });
    expect(await listReferenceEventMap(db(), P, { eventIds: [] })).toEqual([]);
    expect(await listReferenceEventMap(db(), P, { providerEventIds: [] })).toEqual([]);
    expect(await listReferenceEventMap(db(), P, { providerEventIds: ['nope'] })).toEqual([]);
    expect(await db().transaction((tx) => removeReferenceEventMap(tx, P, 'ev-rm'))).toBe(true);
    expect(await db().transaction((tx) => removeReferenceEventMap(tx, P, 'ev-rm'))).toBe(false);
    expect(await listReferenceEventMap(db(), P, { eventIds: [eventId] })).toEqual([]);
    expect(await listReferenceBookPrices(db(), P, 'ev-rm')).toEqual([]);
  });

  it('refuses a provider that is not known (the table has a CHECK)', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await expect(
      db().transaction((tx) =>
        upsertReferenceEventMap(tx, mapInput(eventId, 'ev-x', at(0), { provider: 'other' })),
      ),
    ).rejects.toThrow();
  });
});

describe('reference book prices', () => {
  it('replaces the whole snapshot of a provider event (a book that left is gone), the last repeat wins', async () => {
    const stamp = {
      provider: P,
      providerEventId: 'ev-prices',
      fetchedAt: at(0),
      asOf: at(-MINUTE),
    };
    const first = await db().transaction((tx) =>
      replaceReferenceBookPrices(tx, {
        ...stamp,
        prices: [
          price('1x2', '1', 3, -120, { liquidityUsd: 5000 }),
          price('1x2', 'X', 3, 290),
          price('1x2', '2', 3, 320),
          price('1x2', '1', 7, -118),
          price('ou:2.5', 'over', 3, -105),
          // repeats the Pinnacle home price: the last one wins
          price('1x2', '1', 3, -130, { oddsMilli: 1769 }),
        ],
      }),
    );
    expect(first).toEqual({ deleted: 0, inserted: 5 });
    const stored = await listReferenceBookPrices(db(), P, 'ev-prices');
    expect(stored.map((r) => [r.marketKey, r.outcome, r.bookId])).toEqual([
      ['1x2', '1', 3],
      ['1x2', '1', 7],
      ['1x2', '2', 3],
      ['1x2', 'X', 3],
      ['ou:2.5', 'over', 3],
    ]);
    expect(stored[0]).toMatchObject({ american: -130, oddsMilli: 1769, liquidityUsd: null });
    expect(stored[0]!.asOf).toEqual(at(-MINUTE));
    expect(stored[0]!.fetchedAt).toEqual(at(0));

    const second = await db().transaction((tx) =>
      replaceReferenceBookPrices(tx, {
        ...stamp,
        fetchedAt: at(MINUTE),
        prices: [price('1x2', '1', 32, -125)],
      }),
    );
    expect(second).toEqual({ deleted: 5, inserted: 1 });
    expect(
      (await listReferenceBookPrices(db(), P, 'ev-prices')).map((r) => [r.marketKey, r.bookId]),
    ).toEqual([['1x2', 32]]);

    // An empty snapshot empties the event and inserts nothing.
    expect(
      await db().transaction((tx) => replaceReferenceBookPrices(tx, { ...stamp, prices: [] })),
    ).toEqual({ deleted: 1, inserted: 0 });
  });

  it('keeps provider events apart', async () => {
    const stamp = { provider: P, fetchedAt: at(0), asOf: at(0) };
    await db().transaction(async (tx) => {
      await replaceReferenceBookPrices(tx, {
        ...stamp,
        providerEventId: 'ev-a',
        prices: [price('1x2', '1', 3)],
      });
      await replaceReferenceBookPrices(tx, {
        ...stamp,
        providerEventId: 'ev-b',
        prices: [price('1x2', '1', 3)],
      });
      await replaceReferenceBookPrices(tx, { ...stamp, providerEventId: 'ev-a', prices: [] });
    });
    expect(await listReferenceBookPrices(db(), P, 'ev-a')).toEqual([]);
    expect(await listReferenceBookPrices(db(), P, 'ev-b')).toHaveLength(1);
  });

  it('only stores valid prices (CHECK constraints)', async () => {
    const stamp = { provider: P, providerEventId: 'ev-bad', fetchedAt: at(0), asOf: at(0) };
    await expect(
      db().transaction((tx) =>
        replaceReferenceBookPrices(tx, { ...stamp, prices: [price('1x2', '1', 3, 50)] }),
      ),
    ).rejects.toThrow();
    await expect(
      db().transaction((tx) =>
        replaceReferenceBookPrices(tx, {
          ...stamp,
          prices: [price('1x2', '1', 3, -120, { oddsMilli: 1000 })],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('reference consensus', () => {
  const row = (eventId: string, marketKey: string, home: number, computedAt: Date) => ({
    eventId,
    provider: P as typeof P,
    marketKey,
    fair: { '1': home, X: 0.26, '2': 1 - home - 0.26 },
    booksUsed: [3, 7, 32],
    dispersion: 0.01,
    confidence: 'normal' as const,
    asOf: at(-MINUTE),
    computedAt,
  });

  it('writes one row per event and market; a later row replaces an earlier one', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    const other = await createScrapedEvent(ctx);
    expect(await upsertReferenceConsensus(db(), [])).toBe(0);
    expect(
      await upsertReferenceConsensus(db(), [
        row(eventId, '1x2', 0.5, at(0)),
        row(eventId, 'ou:2.5', 0.55, at(0)),
        row(other.eventId, '1x2', 0.4, at(0)),
        // the same key twice in one call: the later one wins
        row(eventId, '1x2', 0.52, at(0)),
      ]),
    ).toBe(3);
    const stored = await listReferenceConsensus(db(), P, [eventId]);
    expect(stored.map((r) => r.marketKey)).toEqual(['1x2', 'ou:2.5']);
    expect(stored[0]).toMatchObject({
      confidence: 'normal',
      booksUsed: [3, 7, 32],
      dispersion: 0.01,
    });
    expect(stored[0]!.fair['1']).toBeCloseTo(0.52, 10);

    await upsertReferenceConsensus(db(), [
      { ...row(eventId, '1x2', 0.6, at(MINUTE)), confidence: 'low', booksUsed: [3, 32] },
    ]);
    const replaced = (await listReferenceConsensus(db(), P, [eventId]))[0]!;
    expect(replaced).toMatchObject({ confidence: 'low', booksUsed: [3, 32] });
    expect(replaced.computedAt).toEqual(at(MINUTE));
    expect(replaced.fair['1']).toBeCloseTo(0.6, 10);
    expect(await listReferenceConsensus(db(), P, [])).toEqual([]);
  });

  it('rejects a confidence it does not know and a dispersion outside 0 to 1', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await expect(
      upsertReferenceConsensus(db(), [
        { ...row(eventId, '1x2', 0.5, at(0)), confidence: 'certain' as 'high' },
      ]),
    ).rejects.toThrow();
    await expect(
      upsertReferenceConsensus(db(), [{ ...row(eventId, '1x2', 0.5, at(0)), dispersion: 1.5 }]),
    ).rejects.toThrow();
  });

  it('goes with its event when the event is deleted', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await upsertReferenceConsensus(db(), [row(eventId, '1x2', 0.5, at(0))]);
    await db().delete(events).where(eq(events.id, eventId));
    expect(await listReferenceConsensus(db(), P, [eventId])).toEqual([]);
  });
});

describe('reference budget', () => {
  const NOW = new Date('2026-11-01T10:00:00Z');
  const snap = (
    extra: Partial<{ used: number | null; remaining: number | null; resetAt: Date | null }>,
    observedAt = NOW,
  ) => ({
    used: 1_000,
    remaining: 24_999_000,
    resetAt: new Date('2026-12-01T00:00:00Z'),
    observedAt,
    ...extra,
  });

  it('has no row until something is recorded, then creates it with the first response', async () => {
    expect(await getReferenceBudget(db(), P)).toBeNull();
    const row = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: NOW,
        cost: 27,
        snapshot: snap({}),
        delaySeconds: 60,
        rateLimit: 2,
        level: 'green',
      }),
    );
    expect(row).toMatchObject({
      provider: P,
      used: 1_000,
      remaining: 24_999_000,
      spentDay: '2026-11-01',
      spentToday: 27,
      delaySeconds: 60,
      rateLimit: 2,
      level: 'green',
    });
    expect(row.resetAt).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(row.observedAt).toEqual(NOW);
    expect(await getReferenceBudget(db(), P)).toEqual(row);
  });

  it('adds the cost of each response to today and starts again on a new UTC day', async () => {
    const same = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: new Date('2026-11-01T23:59:59Z'),
        cost: 13.2,
        snapshot: snap({ used: 1_040, remaining: 24_998_960 }, new Date('2026-11-01T23:59:59Z')),
      }),
    );
    // 27 from before, 13.2 rounded up to 14: a fraction never counts as less.
    expect(same).toMatchObject({ spentDay: '2026-11-01', spentToday: 41, used: 1_040 });
    const next = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: new Date('2026-11-02T00:00:01Z'),
        cost: 5,
      }),
    );
    expect(next).toMatchObject({ spentDay: '2026-11-02', spentToday: 5 });
    // The meters stay as the last response said when a call carries no snapshot.
    expect(next).toMatchObject({
      used: 1_040,
      remaining: 24_998_960,
      delaySeconds: 60,
      rateLimit: 2,
    });
    // A clock that is behind (an old call arriving late) does not reset the day.
    const late = await db().transaction((tx) =>
      recordReferenceBudget(tx, { provider: P, now: new Date('2026-11-01T12:00:00Z'), cost: 1 }),
    );
    expect(late).toMatchObject({ spentDay: '2026-11-02', spentToday: 6 });
  });

  it('ignores a snapshot older than the stored reading, and keeps the figures a snapshot lacks', async () => {
    const before = (await getReferenceBudget(db(), P))!;
    const stale = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: new Date('2026-11-02T01:00:00Z'),
        snapshot: snap({ remaining: 1, used: 1 }, new Date('2026-11-01T00:00:00Z')),
      }),
    );
    expect(stale.remaining).toBe(before.remaining);
    expect(stale.used).toBe(before.used);

    const partial = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: new Date('2026-11-02T02:00:00Z'),
        snapshot: {
          used: null,
          remaining: 24_000_000,
          resetAt: null,
          observedAt: new Date('2026-11-02T02:00:00Z'),
        },
      }),
    );
    expect(partial).toMatchObject({ remaining: 24_000_000, used: before.used });
    expect(partial.resetAt).toEqual(before.resetAt);
  });

  it('sets the level alone, a negative remaining is kept, a bad cost is refused', async () => {
    const red = await db().transaction((tx) =>
      recordReferenceBudget(tx, {
        provider: P,
        now: new Date('2026-11-02T03:00:00Z'),
        level: 'red',
        snapshot: snap({ remaining: -5 }, new Date('2026-11-02T03:00:00Z')),
      }),
    );
    expect(red).toMatchObject({ level: 'red', remaining: -5 });
    await expect(
      db().transaction((tx) => recordReferenceBudget(tx, { provider: P, now: NOW, cost: -1 })),
    ).rejects.toThrow(RangeError);
  });

  it('utcDay is the UTC date', () => {
    expect(utcDay(new Date('2026-11-01T23:59:59.999Z'))).toBe('2026-11-01');
    expect(utcDay(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
    expect(() => utcDay(new Date('nope'))).toThrow(RangeError);
  });
});

describe('reference poll state', () => {
  it('records when a request was made and replaces it the next time', async () => {
    expect(await getReferencePollState(db(), P, 'day:11:2026-11-01')).toBeNull();
    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'day:11:2026-11-01',
      fetchedAt: at(0),
      outcome: 'ok',
      cost: 27,
      details: { events: 2, since: at(0) },
    });
    const first = (await getReferencePollState(db(), P, 'day:11:2026-11-01'))!;
    expect(first).toMatchObject({
      provider: P,
      requestKey: 'day:11:2026-11-01',
      lastOutcome: 'ok',
      lastCost: 27,
      details: { events: 2, since: at(0).toISOString() },
    });
    expect(first.lastFetchedAt).toEqual(at(0));

    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'day:11:2026-11-01',
      fetchedAt: at(HOUR),
      outcome: 'error',
    });
    const second = (await getReferencePollState(db(), P, 'day:11:2026-11-01'))!;
    expect(second).toMatchObject({ lastOutcome: 'error', lastCost: null, details: null });
    expect(second.lastFetchedAt).toEqual(at(HOUR));
  });

  it('lists by key, or all of a provider, and an empty key list lists nothing', async () => {
    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'event:abc',
      fetchedAt: at(0),
      outcome: 'ok',
    });
    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'affiliates',
      fetchedAt: at(0),
      outcome: 'ok',
    });
    expect(
      (await listReferencePollState(db(), P, ['event:abc', 'affiliates', 'missing'])).map(
        (r) => r.requestKey,
      ),
    ).toEqual(['affiliates', 'event:abc']);
    expect((await listReferencePollState(db(), P)).length).toBeGreaterThanOrEqual(3);
    expect(await listReferencePollState(db(), P, [])).toEqual([]);
  });
});

describe('raiseCloseLead', () => {
  it('raises the lead, never lowers it, and betting then closes that long before the start', async () => {
    const { eventId } = await createScrapedEvent(ctx, {
      startTime: new Date(T0.getTime() + 3 * HOUR),
    });
    const read = async () => {
      const [row] = await db().select().from(events).where(eq(events.id, eventId));
      return row!;
    };
    expect((await read()).closeLeadMs).toBe(0);

    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 5 * MINUTE))).toEqual({
      changed: true,
      closeLeadMs: 5 * MINUTE,
    });
    // The same lead, or a smaller one, changes nothing.
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 5 * MINUTE))).toEqual({
      changed: false,
      closeLeadMs: 5 * MINUTE,
    });
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 2 * MINUTE))).toEqual({
      changed: false,
      closeLeadMs: 5 * MINUTE,
    });
    expect((await read()).closeLeadMs).toBe(5 * MINUTE);

    const event = await read();
    expect(prematchClosesAt(event)).toEqual(new Date(event.startTime.getTime() - 5 * MINUTE));
    const open = (now: Date) => isSelectionBettable(event, 'open', 'open', now);
    expect(open(new Date(event.startTime.getTime() - 6 * MINUTE))).toBe(true);
    expect(open(new Date(event.startTime.getTime() - 4 * MINUTE))).toBe(false);

    // Rounded up to a whole millisecond, and held to the largest lead the column allows.
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 5 * MINUTE + 0.2))).toEqual({
      changed: true,
      closeLeadMs: 5 * MINUTE + 1,
    });
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 10 * HOUR))).toEqual({
      changed: true,
      closeLeadMs: MAX_CLOSE_LEAD_MS,
    });
    expect((await read()).closeLeadMs).toBe(MAX_CLOSE_LEAD_MS);
    // A negative lead is zero: it cannot lower anything.
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, -5))).toMatchObject({
      changed: false,
      closeLeadMs: MAX_CLOSE_LEAD_MS,
    });
  });

  it('touches only a scheduled event, and a number that is not one is refused', async () => {
    const { eventId } = await createScrapedEvent(ctx);
    await db().update(events).set({ status: 'live' }).where(eq(events.id, eventId));
    expect(await db().transaction((tx) => raiseCloseLead(tx, eventId, 5 * MINUTE))).toEqual({
      changed: false,
      closeLeadMs: null,
    });
    expect(
      (
        await db().select({ lead: events.closeLeadMs }).from(events).where(eq(events.id, eventId))
      )[0]!.lead,
    ).toBe(0);
    expect(
      await db().transaction((tx) => raiseCloseLead(tx, '00000000-0000-4000-8000-000000000000', 1)),
    ).toEqual({ changed: false, closeLeadMs: null });
    await expect(db().transaction((tx) => raiseCloseLead(tx, eventId, Number.NaN))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('pruneReference (the 24 hour retention)', () => {
  it('deletes map, price and consensus rows older than the retention and poll state older than 8 days', async () => {
    const NOW = new Date('2026-11-10T12:00:00Z');
    const old = new Date(NOW.getTime() - 25 * HOUR);
    const edge = new Date(NOW.getTime() - 24 * HOUR + MINUTE);
    const fresh = new Date(NOW.getTime() - HOUR);
    const evOld = await createScrapedEvent(ctx);
    const evEdge = await createScrapedEvent(ctx);
    const evFresh = await createScrapedEvent(ctx);
    await db().transaction(async (tx) => {
      for (const [ev, id, when] of [
        [evOld, 'prune-old', old],
        [evEdge, 'prune-edge', edge],
        [evFresh, 'prune-fresh', fresh],
      ] as const) {
        await upsertReferenceEventMap(tx, mapInput(ev.eventId, id, when));
        await replaceReferenceBookPrices(tx, {
          provider: P,
          providerEventId: id,
          fetchedAt: when,
          asOf: when,
          prices: [price('1x2', '1', 3), price('1x2', 'X', 3)],
        });
      }
    });
    await upsertReferenceConsensus(db(), [
      {
        eventId: evOld.eventId,
        provider: P,
        marketKey: '1x2',
        fair: { '1': 0.5, X: 0.3, '2': 0.2 },
        booksUsed: [3, 7],
        dispersion: 0,
        confidence: 'normal',
        asOf: old,
        computedAt: old,
      },
      {
        eventId: evFresh.eventId,
        provider: P,
        marketKey: '1x2',
        fair: { '1': 0.5, X: 0.3, '2': 0.2 },
        booksUsed: [3, 7],
        dispersion: 0,
        confidence: 'normal',
        asOf: fresh,
        computedAt: fresh,
      },
    ]);
    const pollAt = (ms: number) => new Date(NOW.getTime() - ms);
    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'prune-poll-old',
      fetchedAt: pollAt(POLL_STATE_RETENTION_MS + MINUTE),
      outcome: 'ok',
    });
    await setReferencePollState(db(), {
      provider: P,
      requestKey: 'prune-poll-new',
      fetchedAt: pollAt(7 * DAY),
      outcome: 'ok',
    });
    await db().transaction((tx) => recordReferenceBudget(tx, { provider: P, now: old, cost: 1 }));

    const counts = await pruneReference(db(), P, NOW, 24);
    expect(counts.eventMap).toBeGreaterThanOrEqual(1);
    expect(counts.bookPrices).toBeGreaterThanOrEqual(2);
    expect(counts.consensus).toBeGreaterThanOrEqual(1);
    expect(counts.pollState).toBeGreaterThanOrEqual(1);

    const mapped = (await listReferenceEventMap(db(), P)).map((r) => r.providerEventId);
    expect(mapped).not.toContain('prune-old');
    expect(mapped).toEqual(expect.arrayContaining(['prune-edge', 'prune-fresh']));
    expect(await listReferenceBookPrices(db(), P, 'prune-old')).toEqual([]);
    expect(await listReferenceBookPrices(db(), P, 'prune-edge')).toHaveLength(2);
    expect(await listReferenceBookPrices(db(), P, 'prune-fresh')).toHaveLength(2);
    expect(await listReferenceConsensus(db(), P, [evOld.eventId])).toEqual([]);
    expect(await listReferenceConsensus(db(), P, [evFresh.eventId])).toHaveLength(1);
    expect(await getReferencePollState(db(), P, 'prune-poll-old')).toBeNull();
    expect(await getReferencePollState(db(), P, 'prune-poll-new')).not.toBeNull();
    // Our own meters are not provider data.
    expect(await getReferenceBudget(db(), P)).not.toBeNull();

    // Nothing is left that is older than a day, whatever table it is in.
    const cutoff = new Date(NOW.getTime() - 24 * HOUR).toISOString();
    const { rows } = await ctx.handle.pool.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM reference_event_map WHERE last_seen_at < $1)
            + (SELECT count(*) FROM reference_book_prices WHERE fetched_at < $1)
            + (SELECT count(*) FROM reference_consensus WHERE computed_at < $1) AS n`,
      [cutoff],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // A second prune finds nothing more.
    expect(await pruneReference(db(), P, NOW, 24)).toEqual({
      eventMap: 0,
      bookPrices: 0,
      consensus: 0,
      pollState: 0,
    });
  });

  it('a longer retention keeps more, and a retention that is not a number above 0 is refused', async () => {
    const NOW = new Date('2026-11-20T12:00:00Z');
    const { eventId } = await createScrapedEvent(ctx);
    await db().transaction((tx) =>
      upsertReferenceEventMap(
        tx,
        mapInput(eventId, 'prune-48', new Date(NOW.getTime() - 30 * HOUR)),
      ),
    );
    expect((await pruneReference(db(), P, NOW, 48)).eventMap).toBe(0);
    expect(await listReferenceEventMap(db(), P, { providerEventIds: ['prune-48'] })).toHaveLength(
      1,
    );
    expect((await pruneReference(db(), P, NOW, 24)).eventMap).toBe(1);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pruneReference(db(), P, NOW, bad)).rejects.toThrow(RangeError);
    }
  });
});

describe('listReferenceCandidates', () => {
  it('lists scheduled events of the competitions that start after `after` and no later than `upTo`', async () => {
    const base = new Date('2026-12-01T12:00:00Z');
    const inside = await createScrapedEvent(ctx, { startTime: new Date(base.getTime() + 2 * DAY) });
    const atEnd = await createScrapedEvent(ctx, { startTime: new Date(base.getTime() + 7 * DAY) });
    const tooLate = await createScrapedEvent(ctx, {
      startTime: new Date(base.getTime() + 7 * DAY + MINUTE),
    });
    const started = await createScrapedEvent(ctx, { startTime: new Date(base.getTime() - MINUTE) });
    const atNow = await createScrapedEvent(ctx, { startTime: base });
    const live = await createScrapedEvent(ctx, { startTime: new Date(base.getTime() + 3 * DAY) });
    await db().update(events).set({ status: 'live' }).where(eq(events.id, live.eventId));
    const found = await listReferenceCandidates(db(), {
      competitionIds: [ctx.competitionId],
      after: base,
      upTo: new Date(base.getTime() + 7 * DAY),
    });
    const ids = found.map((c) => c.eventId);
    expect(ids).toEqual([inside.eventId, atEnd.eventId]);
    for (const excluded of [tooLate, started, atNow, live])
      expect(ids).not.toContain(excluded.eventId);
    expect(found[0]).toMatchObject({
      feedRef: inside.feedRef,
      homeTeamId: inside.homeTeamId,
      awayTeamId: inside.awayTeamId,
      bettingOpen: true,
      closeLeadMs: 0,
    });
    expect(
      await listReferenceCandidates(db(), {
        competitionIds: [],
        after: base,
        upTo: new Date(base.getTime() + DAY),
      }),
    ).toEqual([]);
    const otherCompetition = (
      await db().execute<{ id: string }>(
        sql`SELECT id FROM competitions WHERE id <> ${ctx.competitionId} LIMIT 1`,
      )
    ).rows[0]!.id;
    expect(
      await listReferenceCandidates(db(), {
        competitionIds: [otherCompetition],
        after: base,
        upTo: new Date(base.getTime() + 7 * DAY),
      }),
    ).toEqual([]);
  });
});

describe('suspendMarketForGuard: a suspension only a person lifts', () => {
  async function eventWithMarket() {
    const event = await createScrapedEvent(ctx, { startTime: new Date(T0.getTime() + 3 * HOUR) });
    const market = (await marketsWithSelections(db(), event.eventId)).find((m) => m.key === '1x2')!;
    return { ...event, marketId: market.id };
  }
  const marketRow = async (marketId: string) =>
    (await db().select().from(markets).where(eq(markets.id, marketId)))[0]!;

  it('resumeEvent and setMarketStatus without an actor leave it suspended; a staff actor opens it', async () => {
    const { eventId, marketId } = await eventWithMarket();
    const suspended = await db().transaction((tx) => suspendMarketForGuard(tx, marketId));
    expect(suspended.changed).toBe(true);
    expect(suspended.messages).toHaveLength(1);
    expect(await marketRow(marketId)).toMatchObject({ status: 'suspended', suspendedBy: 'trader' });

    // Automatic code (the feed, the live simulator) has no actor: it must not re-open the market.
    const resumed = await db().transaction((tx) => resumeEvent(tx, eventId));
    expect(resumed.changed).toBe(false);
    expect(resumed.messages).toEqual([]);
    expect(await marketRow(marketId)).toMatchObject({ status: 'suspended', suspendedBy: 'trader' });
    const opened = await db().transaction((tx) => setMarketStatus(tx, marketId, 'open'));
    expect(opened.changed).toBe(false);
    expect(await marketRow(marketId)).toMatchObject({ status: 'suspended' });

    // A person can.
    const byStaff = await db().transaction((tx) => resumeEvent(tx, eventId, STAFF));
    expect(byStaff.changed).toBe(true);
    expect(await marketRow(marketId)).toMatchObject({ status: 'open', suspendedBy: null });
  });

  it('is audited with the scraper as the actor and the reason; a second call changes nothing', async () => {
    const { marketId } = await eventWithMarket();
    await db().transaction((tx) => suspendMarketForGuard(tx, marketId));
    const again = await db().transaction((tx) => suspendMarketForGuard(tx, marketId));
    expect(again).toEqual({ changed: false, messages: [] });
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'catalog.market.suspended'), eq(auditLog.targetId, marketId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: REFERENCE_GUARD_ACTOR.adminId });
    expect(rows[0]!.actorId).toBe('system:scraper');
    expect(rows[0]!.metadata).toMatchObject({ reason: 'odds-error guard (rule P6)' });
  });

  it('takes over a suspension the feed made, which the feed could otherwise lift', async () => {
    const { eventId, marketId } = await eventWithMarket();
    await db().transaction((tx) => setMarketStatus(tx, marketId, 'suspended'));
    expect(await marketRow(marketId)).toMatchObject({ suspendedBy: 'feed' });
    expect((await db().transaction((tx) => suspendMarketForGuard(tx, marketId))).changed).toBe(
      true,
    );
    expect(await marketRow(marketId)).toMatchObject({ status: 'suspended', suspendedBy: 'trader' });
    expect((await db().transaction((tx) => resumeEvent(tx, eventId))).changed).toBe(false);
  });

  it('works on a closed-betting event too, and refuses an event that is not scheduled or live', async () => {
    const { eventId, marketId } = await eventWithMarket();
    await db().transaction((tx) => setEventBettingOpen(tx, eventId, false));
    expect((await db().transaction((tx) => suspendMarketForGuard(tx, marketId))).changed).toBe(
      true,
    );
    await db().update(events).set({ status: 'finished' }).where(eq(events.id, eventId));
    const other = await eventWithMarket();
    await db().update(events).set({ status: 'postponed' }).where(eq(events.id, other.eventId));
    await expect(
      db().transaction((tx) => suspendMarketForGuard(tx, other.marketId)),
    ).rejects.toThrow(/postponed/);
  });

  it('keeps a fixture upsert from re-opening what the guard suspended (prices change, the status does not)', async () => {
    const event = await eventWithMarket();
    await db().transaction((tx) => suspendMarketForGuard(tx, event.marketId));
    // The feed (or the scraper's re-price) writes prices again through the same fixture key.
    await db().transaction((tx) =>
      upsertFixture(
        tx,
        {
          feedProvider: 'scraped',
          feedRef: event.feedRef,
          sport: 'football',
          competitionId: ctx.competitionId,
          homeTeamId: event.homeTeamId,
          awayTeamId: event.awayTeamId,
          startTime: new Date(T0.getTime() + 3 * HOUR),
        },
        [
          {
            type: '1x2',
            line: null,
            selections: [
              { code: '1', oddsMilli: 2100 },
              { code: 'X', oddsMilli: 3200 },
              { code: '2', oddsMilli: 3500 },
            ],
          },
        ],
      ),
    );
    expect(await marketRow(event.marketId)).toMatchObject({
      status: 'suspended',
      suspendedBy: 'trader',
    });
  });
});
