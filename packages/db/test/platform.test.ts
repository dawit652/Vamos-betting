import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOperatingMode,
  claimOutboxBatch,
  countDeadLetteredOutbox,
  enqueueOutbox,
  getDatabaseInstallationId,
  getSetting,
  markOutboxFailed,
  markOutboxPublished,
  redriveOutboxEvents,
  setSetting,
  toJsonSafe,
  writeAudit,
} from '../src/index';
import { auditLog, outboxEvents, settings } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase, errorText, pgCode } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** A promise plus its resolver, to hold a transaction open from the outside. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('toJsonSafe', () => {
  it('turns bigint into decimal strings and dates into ISO strings, deeply', () => {
    const at = new Date('2026-10-08T09:30:00.000Z');
    expect(
      toJsonSafe({
        stake: 12_345n,
        huge: 9_007_199_254_740_993n,
        negative: -5n,
        at,
        legs: [{ odds: 1850, payout: 22_838n }, null, 'x', undefined],
        nested: { deeper: { when: at, ok: true } },
        skipped: undefined,
      }),
    ).toEqual({
      stake: '12345',
      huge: '9007199254740993',
      negative: '-5',
      at: '2026-10-08T09:30:00.000Z',
      legs: [{ odds: 1850, payout: '22838' }, null, 'x', null],
      nested: { deeper: { when: '2026-10-08T09:30:00.000Z', ok: true } },
    });
  });

  it('handles primitives, maps, sets and invalid values', () => {
    expect(toJsonSafe(7n)).toBe('7');
    expect(toJsonSafe('a')).toBe('a');
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeUndefined();
    expect(toJsonSafe(Number.NaN)).toBeNull();
    expect(toJsonSafe(new Date(Number.NaN))).toBeNull();
    expect(toJsonSafe(new Map<string, bigint>([['a', 1n]]))).toEqual({ a: '1' });
    expect(toJsonSafe(new Set([1n, 2n]))).toEqual(['1', '2']);
    const result = toJsonSafe({ a: 1n });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('allows shared references but rejects cycles', () => {
    const shared = { amount: 1n };
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({
      a: { amount: '1' },
      b: { amount: '1' },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toJsonSafe(cyclic)).toThrow(/circular/);
  });
});

describe('outbox', () => {
  it('stores events with JSON-safe payloads and returns their id', async () => {
    const id = await enqueueOutbox(handle.db, {
      type: 'bet.placed',
      aggregateType: 'bet',
      aggregateId: 'bet-1',
      payload: { stake: 1_000n, placedAt: new Date('2026-10-08T00:00:00Z') },
    });
    expect(typeof id).toBe('bigint');
    const [row] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row).toMatchObject({
      type: 'bet.placed',
      aggregateType: 'bet',
      aggregateId: 'bet-1',
      payload: { stake: '1000', placedAt: '2026-10-08T00:00:00.000Z' },
      publishedAt: null,
      attempts: 0,
    });
    await markOutboxPublished(handle.db, [id]);
  });

  it('is written atomically with the surrounding transaction', async () => {
    const before = await handle.db.$count(outboxEvents);
    await handle.db
      .transaction(async (tx) => {
        await enqueueOutbox(tx, {
          type: 'deposit.completed',
          aggregateType: 'payment_intent',
          aggregateId: 'pi-1',
          payload: {},
        });
        throw new Error('business write failed');
      })
      .catch(() => undefined);
    expect(await handle.db.$count(outboxEvents)).toBe(before);
  });

  it('lets concurrent publishers claim disjoint batches (SKIP LOCKED)', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(
        await enqueueOutbox(handle.db, {
          type: 'sms.requested',
          aggregateType: 'user',
          aggregateId: `u-${i}`,
          payload: { i },
        }),
      );
    }

    const claimed = gate();
    const release = gate();
    let firstBatch: bigint[] = [];

    const first = handle.db.transaction(async (tx) => {
      const batch = await claimOutboxBatch(tx, 4);
      firstBatch = batch.map((e) => e.id);
      claimed.open();
      await release.promise; // keep the row locks while the second publisher runs
      await markOutboxPublished(tx, firstBatch);
    });

    await claimed.promise;
    const secondBatch = await handle.db.transaction(async (tx) => {
      const batch = await claimOutboxBatch(tx, 4);
      await markOutboxPublished(
        tx,
        batch.map((e) => e.id),
      );
      return batch.map((e) => e.id);
    });
    release.open();
    await first;

    expect(firstBatch).toEqual(ids.slice(0, 4));
    expect(secondBatch).toEqual(ids.slice(4, 8));

    const rest = await handle.db.transaction((tx) => claimOutboxBatch(tx, 100));
    expect(rest.map((e) => e.id)).toEqual(ids.slice(8));
    await markOutboxPublished(
      handle.db,
      rest.map((e) => e.id),
    );
    expect(await handle.db.transaction((tx) => claimOutboxBatch(tx, 100))).toEqual([]);
  });

  it('records failures and keeps failed events claimable', async () => {
    const id = await enqueueOutbox(handle.db, {
      type: 'report.els',
      aggregateType: 'bet',
      aggregateId: 'bet-9',
      payload: {},
    });
    await markOutboxFailed(handle.db, id, 'regulator endpoint timed out');
    await markOutboxFailed(handle.db, id, 'x'.repeat(5_000));

    const [row] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(row!.attempts).toBe(2);
    expect(row!.lastError).toHaveLength(2_000);
    expect(row!.publishedAt).toBeNull();

    const again = await handle.db.transaction((tx) => claimOutboxBatch(tx, 10));
    expect(again.map((e) => e.id)).toEqual([id]);
    const capped = await handle.db.transaction((tx) =>
      claimOutboxBatch(tx, 10, { maxAttempts: 2 }),
    );
    expect(capped).toEqual([]);

    await markOutboxPublished(handle.db, [id]);
    const [published] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(published!.publishedAt).toBeInstanceOf(Date);
    await markOutboxPublished(handle.db, []);
  });

  it('leaves rows backing off unclaimed (so newer rows go first) and outages uncounted', async () => {
    // Earlier tests' rows are out of the way.
    await handle.db.update(outboxEvents).set({ publishedAt: new Date() });
    const now = new Date('2026-10-09T12:00:00.000Z');
    const add = (aggregateId: string) =>
      enqueueOutbox(handle.db, { type: 't', aggregateType: 'x', aggregateId, payload: {} });
    const failing = await add('a');
    const newer = await add('b');
    await markOutboxFailed(handle.db, failing, 'nope', {
      retryAt: new Date(now.getTime() + 5000),
    });
    const claim = (at: Date, limit = 1) =>
      handle.db.transaction(async (tx) =>
        (await claimOutboxBatch(tx, limit, { maxAttempts: 3, now: at })).map((e) => e.id),
      );
    expect(await claim(now)).toEqual([newer]);
    expect(await claim(new Date(now.getTime() + 5000), 2)).toEqual([failing, newer]);

    // An outage records the error and the retry time but uses up no attempt.
    await markOutboxFailed(handle.db, failing, 'OOM command not allowed', {
      countAttempt: false,
      retryAt: new Date(now.getTime() + 7000),
    });
    const [row] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, failing));
    expect(row).toMatchObject({ attempts: 1, lastError: 'OOM command not allowed' });
    expect(row!.nextAttemptAt).toEqual(new Date(now.getTime() + 7000));
    await markOutboxPublished(handle.db, [newer]);
    const [cleared] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, newer));
    expect(cleared!.nextAttemptAt).toBeNull();
  });

  it('counts dead letters and redrives them under a new job key', async () => {
    await handle.db.update(outboxEvents).set({ publishedAt: new Date() });
    const id = await enqueueOutbox(handle.db, {
      type: 't',
      aggregateType: 'x',
      aggregateId: 'dead',
      payload: {},
    });
    for (let i = 0; i < 3; i += 1) await markOutboxFailed(handle.db, id, 'bad payload');
    expect(await countDeadLetteredOutbox(handle.db, 3)).toBe(1);
    expect(
      await handle.db.transaction((tx) => claimOutboxBatch(tx, 10, { maxAttempts: 3 })),
    ).toEqual([]);
    const [before] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));

    expect(await redriveOutboxEvents(handle.db, [id])).toEqual([id]);
    expect(await countDeadLetteredOutbox(handle.db, 3)).toBe(0);
    const [after] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    expect(after).toMatchObject({ attempts: 0, publishedAt: null, lastError: null });
    expect(after!.jobKey).not.toBe(before!.jobKey);
    const claimed = await handle.db.transaction((tx) =>
      claimOutboxBatch(tx, 10, { maxAttempts: 3 }),
    );
    expect(claimed.map((e) => e.id)).toEqual([id]);
    // A published row can be redriven too (re-running a consumer job that failed for good).
    await markOutboxPublished(handle.db, [id]);
    expect(await redriveOutboxEvents(handle.db, [id])).toEqual([id]);
    expect(await redriveOutboxEvents(handle.db, [])).toEqual([]);
  });

  it('gives every row a random job key', async () => {
    const a = await enqueueOutbox(handle.db, {
      type: 't',
      aggregateType: 'x',
      aggregateId: 'k1',
      payload: {},
    });
    const b = await enqueueOutbox(handle.db, {
      type: 't',
      aggregateType: 'x',
      aggregateId: 'k2',
      payload: {},
    });
    const rows = await handle.db
      .select({ jobKey: outboxEvents.jobKey })
      .from(outboxEvents)
      .where(sql`${outboxEvents.id} IN (${a}, ${b})`);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.jobKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]!.jobKey).not.toBe(rows[1]!.jobKey);
  });
});

describe('database installation id', () => {
  it('is null until the operating mode is claimed, then a fixed random uuid', async () => {
    const other = await createTestDatabase();
    try {
      expect(await getDatabaseInstallationId(other.db)).toBeNull();
      await claimOperatingMode(other.db, 'demo');
      const id = await getDatabaseInstallationId(other.db);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(await getDatabaseInstallationId(other.db)).toBe(id);
      await claimOperatingMode(handle.db, 'demo');
      expect(await getDatabaseInstallationId(handle.db)).not.toBe(id);
    } finally {
      await dropTestDatabase(other);
    }
  });
});

describe('audit log', () => {
  it('writes entries with JSON-safe metadata and is append-only', async () => {
    await writeAudit(handle.db, {
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'wallet.adjust',
      targetType: 'user',
      targetId: 'user-1',
      metadata: { amount: 50_000n, at: new Date('2026-10-08T12:00:00Z') },
      ip: '196.188.0.1',
    });
    await writeAudit(handle.db, { actorType: 'system', action: 'settlement.run' });

    const rows = await handle.db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'wallet.adjust',
      targetType: 'user',
      targetId: 'user-1',
      metadata: { amount: '50000', at: '2026-10-08T12:00:00.000Z' },
      ip: '196.188.0.1',
    });
    expect(rows[1]).toMatchObject({ actorType: 'system', actorId: null, metadata: null, ip: null });

    const update = await handle.db
      .execute(sql`UPDATE audit_log SET action = 'tampered'`)
      .catch((e: unknown) => e);
    expect(errorText(update)).toMatch(/append-only/);
    expect(pgCode(update)).toBe('23001');
    const del = await handle.db.execute(sql`DELETE FROM audit_log`).catch((e: unknown) => e);
    expect(errorText(del)).toMatch(/append-only/);
  });
});

describe('settings', () => {
  it('returns undefined for missing settings and upserts values', async () => {
    expect(await getSetting(handle.db, 'betting.limits')).toBeUndefined();

    await setSetting(handle.db, 'betting.limits', { minStake: 500n, maxLegs: 40 }, 'admin-1');
    expect(await getSetting(handle.db, 'betting.limits')).toEqual({
      minStake: '500',
      maxLegs: 40,
    });

    await setSetting(handle.db, 'betting.limits', { minStake: 1_000n, maxLegs: 30 });
    expect(
      await getSetting<{ minStake: string; maxLegs: number }>(handle.db, 'betting.limits'),
    ).toEqual({ minStake: '1000', maxLegs: 30 });
    const rows = await handle.db.select().from(settings).where(eq(settings.key, 'betting.limits'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedBy).toBeNull();
  });

  it('round-trips scalar JSON values exactly', async () => {
    await setSetting(handle.db, 'tax.rate_bps', 2_000);
    await setSetting(handle.db, 'licence.number', '123');
    await setSetting(handle.db, 'reporting.enabled', false);
    await setSetting(handle.db, 'jackpot.pool', 1_000_000n);
    await setSetting(handle.db, 'ladder', [3, 5, 10]);

    expect(await getSetting(handle.db, 'tax.rate_bps')).toBe(2_000);
    expect(await getSetting(handle.db, 'licence.number')).toBe('123');
    expect(await getSetting(handle.db, 'reporting.enabled')).toBe(false);
    expect(await getSetting(handle.db, 'jackpot.pool')).toBe('1000000');
    expect(await getSetting(handle.db, 'ladder')).toEqual([3, 5, 10]);
    await expect(setSetting(handle.db, 'nothing', undefined)).rejects.toThrow(TypeError);
  });
});
