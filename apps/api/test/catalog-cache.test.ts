import { sports } from '@vamos/db/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogCache } from '../src/lib/catalog-cache';
import { insertCategory, insertCompetition, insertSport } from './fixtures';
import { createTestContext, type TestContext } from './helpers';

const NOW = new Date('2026-10-08T12:00:00.000Z');
let ctx: TestContext;
let off: TestContext;

async function seed(c: TestContext): Promise<void> {
  c.clock.now = NOW;
  await insertSport(c.db.db, 'football', { en: 'Football' }, 10);
  const cat = await insertCategory(c.db.db, 'football', 'england', { en: 'England' }, 10);
  await insertCompetition(c.db.db, {
    sportId: 'football',
    categoryId: cat,
    slug: 'premier-league',
    name: { en: 'Premier League' },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  off = await createTestContext({ CATALOG_CACHE_SECONDS: '0' });
  await seed(ctx);
  await seed(off);
});
afterAll(async () => {
  await ctx.close();
  await off.close();
});

const get = async (c: TestContext, url: string) => {
  const res = await c.app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  return res;
};
const setActive = (c: TestContext, active: boolean) => c.db.db.update(sports).set({ active });
/** Catalogue keys of one context (KEYS does not add the ioredis key prefix to its pattern). */
const keysOf = async (c: TestContext): Promise<string[]> =>
  (await c.redis.keys('*')).filter((k) => k.startsWith(`${c.redis.options.keyPrefix}catalog:v1:`));
const cacheKeys = async () => (await keysOf(ctx)).length;

describe('catalogue cache', () => {
  it('serves the same query from the cache inside the window and refreshes after it', async () => {
    const first = await get(ctx, '/sports');
    await setActive(ctx, false); // only a refresh can show this
    const second = await get(ctx, '/sports');
    expect(second.body).toBe(first.body);
    expect(second.headers['cache-control']).toBe('public, max-age=5');
    ctx.clock.advance(1_900);
    expect((await get(ctx, '/sports')).body).toBe(first.body);
    ctx.clock.advance(200);
    expect((await get(ctx, '/sports')).body).not.toBe(first.body);
    await setActive(ctx, true);
    ctx.clock.advance(2_100);
    expect((await get(ctx, '/sports')).body).toBe(first.body);
  });

  it('caches competitions per sport, and a missing sport stays a 404', async () => {
    await get(ctx, '/sports/football/competitions');
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/sports/golf/competitions' })).statusCode,
    ).toBe(404);
  });

  it('keeps different queries apart and shares one key between spellings', async () => {
    const a = await get(ctx, '/events?filter=upcoming&limit=5');
    const before = await cacheKeys();
    const same = await get(ctx, '/events?limit=5&market=1x2&sport=football&filter=upcoming');
    expect(same.body).toBe(a.body);
    expect(await cacheKeys()).toBe(before);
    await get(ctx, '/events?filter=upcoming&limit=6');
    expect(await cacheKeys()).toBe(before + 1);
    await get(ctx, '/events?filter=upcoming&limit=5&competition=premier-league');
    expect(await cacheKeys()).toBe(before + 2);
  });

  it('reads the database once for 100 concurrent requests on a cold key', async () => {
    const select = vi.spyOn(ctx.deps.db, 'select');
    await get(ctx, '/events?filter=live&limit=11');
    const single = select.mock.calls.length;
    expect(single).toBeGreaterThan(0);
    select.mockClear();
    ctx.clock.advance(5_000);
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        ctx.app.inject({ method: 'GET', url: '/events?filter=live&limit=11' }),
      ),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(select.mock.calls.length).toBe(single);
    select.mockRestore();
  });

  it('does not cache with CATALOG_CACHE_SECONDS=0', async () => {
    expect(off.deps.config.api.catalogCacheSeconds).toBe(0);
    const first = await get(off, '/sports');
    await setActive(off, false);
    expect((await get(off, '/sports')).body).not.toBe(first.body);
    await setActive(off, true);
    expect(await keysOf(off)).toHaveLength(0);
  });

  it('answers from the database when Redis errors or hangs', async () => {
    const broken = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    } as unknown as TestContext['redis'];
    const cache = new CatalogCache({ redis: broken, clock: ctx.deps.clock, seconds: 2 });
    expect(await cache.get('k', async () => 'db')).toBe('db');
    const hanging = {
      get: () => new Promise(() => undefined),
      set: () => new Promise(() => undefined),
    } as unknown as TestContext['redis'];
    const slow = new CatalogCache({
      redis: hanging,
      clock: ctx.deps.clock,
      seconds: 2,
      redisTimeoutMs: 20,
    });
    expect(await slow.get('k', async () => 'db')).toBe('db');
  });

  it('does not cache a failing load', async () => {
    const cache = new CatalogCache({ redis: ctx.redis, clock: ctx.deps.clock, seconds: 2 });
    await expect(cache.get('boom', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await cache.get('boom', async () => 'ok')).toBe('ok');
  });
});
