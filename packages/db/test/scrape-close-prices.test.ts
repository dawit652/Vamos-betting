import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  eventsWithClosePrices,
  listClosePrices,
  recordClosePrices,
  type ClosePrice,
} from '../src/index';
import { dropTestDatabase } from './helpers';
import {
  createScrapeDatabase,
  createScrapedEvent,
  T0,
  type ScrapeTestContext,
} from './scrape-fixtures';

let ctx: ScrapeTestContext;
beforeAll(async () => {
  ctx = await createScrapeDatabase();
});
afterAll(async () => {
  await dropTestDatabase(ctx?.handle);
});

const H = 3_600_000;
const price = (overrides: Partial<ClosePrice>): ClosePrice => ({
  market: '1x2',
  line: null,
  selection: '1',
  pricingSource: 'market',
  ourOddsMilli: 2100,
  consensusPpm: 450_000,
  pinnaclePpm: 455_000,
  bestOddsMilli: 2200,
  bestBookmaker: 'theoddsapi:pinnacle',
  books: 3,
  overroundPpm: 1_045_000,
  ...overrides,
});

describe('scrape_close_prices (rule M1)', () => {
  it('records an event once, and lists what was captured in a window', async () => {
    const { db } = ctx.handle;
    const { eventId } = await createScrapedEvent(ctx);
    const prices = [
      price({ selection: '1' }),
      price({ selection: 'X', consensusPpm: 280_000 }),
      price({ market: 'ou', line: '2.5', selection: 'over', ourOddsMilli: null }),
    ];
    expect(await db.transaction((tx) => recordClosePrices(tx, eventId, prices, T0))).toBe(3);
    // Captured once: a second capture writes nothing and changes nothing.
    const later = new Date(T0.getTime() + H);
    expect(
      await db.transaction((tx) =>
        recordClosePrices(tx, eventId, [price({ consensusPpm: 1 })], later),
      ),
    ).toBe(0);
    expect(await eventsWithClosePrices(db, [eventId])).toEqual(new Set([eventId]));

    const listed = await listClosePrices(db, { from: T0, to: later });
    expect(listed).toHaveLength(3);
    expect(listed.find((p) => p.selection === '1')).toMatchObject({
      eventId,
      market: '1x2',
      line: null,
      consensusPpm: 450_000,
      capturedAt: T0,
    });
    expect(listed.find((p) => p.selection === 'over')).toMatchObject({
      line: '2.5',
      ourOddsMilli: null,
    });
    expect(await listClosePrices(db, { from: later, to: new Date(later.getTime() + H) })).toEqual(
      [],
    );
  });

  it('refuses a probability outside [0, 1] and an unknown selection', async () => {
    const { db } = ctx.handle;
    const { eventId } = await createScrapedEvent(ctx);
    await expect(
      db.transaction((tx) =>
        recordClosePrices(tx, eventId, [price({ consensusPpm: 1_000_001 })], T0),
      ),
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) =>
        recordClosePrices(tx, eventId, [price({ selection: 'home' as '1' })], T0),
      ),
    ).rejects.toThrow();
  });
});
