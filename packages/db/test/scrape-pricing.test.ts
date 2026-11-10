import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listEventPricing,
  recordEventHeld,
  recordEventPriced,
  recordEventSuspension,
} from '../src/index';
import { events } from '../src/schema/index';
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

describe('scrape_event_pricing (rule O3 stamps)', () => {
  it('records the ratings behind the prices, keeps a held proposal apart, and clears it when priced', async () => {
    const { db } = ctx.handle;
    const { eventId } = await createScrapedEvent(ctx);
    expect((await listEventPricing(db, [eventId])).size).toBe(0);

    // A proposal held for an event nobody stamped: the price stamp stays unknown.
    await db.transaction((tx) => recordEventHeld(tx, eventId, 'k1', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      ratingsKey: null,
      pricedAt: null,
      heldKey: 'k1',
    });

    await db.transaction((tx) => recordEventPriced(tx, eventId, 'k2', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      ratingsKey: 'k2',
      pricedAt: T0,
      heldKey: null,
    });

    // Held again: the price stamp is kept.
    await db.transaction((tx) => recordEventHeld(tx, eventId, 'k3', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      ratingsKey: 'k2',
      heldKey: 'k3',
    });
    expect((await listEventPricing(db, [])).size).toBe(0);
  });

  it('records the cause of the scraper suspension apart from the price stamp (rule A2)', async () => {
    const { db } = ctx.handle;
    const { eventId } = await createScrapedEvent(ctx);
    await db.transaction((tx) => recordEventPriced(tx, eventId, 'k1', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      suspendedFor: null,
    });

    await db.transaction((tx) => recordEventSuspension(tx, eventId, 'reprice_held', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      ratingsKey: 'k1',
      suspendedFor: 'reprice_held',
    });
    // A new price stamp leaves the suspension to its own pass.
    await db.transaction((tx) => recordEventPriced(tx, eventId, 'k2', T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      ratingsKey: 'k2',
      suspendedFor: 'reprice_held',
    });
    await db.transaction((tx) => recordEventSuspension(tx, eventId, null, T0));
    expect((await listEventPricing(db, [eventId])).get(eventId)).toMatchObject({
      suspendedFor: null,
    });

    // Any other cause is refused by the database.
    await expect(
      db.transaction((tx) =>
        recordEventSuspension(tx, eventId, 'trader_said_so' as 'reprice_held', T0),
      ),
    ).rejects.toThrow();
  });

  it('is removed with its event', async () => {
    const { db } = ctx.handle;
    const { eventId } = await createScrapedEvent(ctx);
    await db.transaction((tx) => recordEventPriced(tx, eventId, 'k', T0));
    await db.delete(events).where(eq(events.id, eventId));
    expect((await listEventPricing(db, [eventId])).size).toBe(0);
  });
});
