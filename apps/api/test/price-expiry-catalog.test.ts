import { EventDetail, EventListResponse } from '@vamos/contracts';
import type { Database } from '@vamos/db';
import { markets } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { displayedMarketStatus } from '../src/modules/catalog/views';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

/**
 * Task 1.10 (A13): an expired price (markets.price_valid_until at or before now) is shown as
 * suspended on the match page and the list row, as bet placement already refuses it, and its
 * selections are not open. The expiry travels as `priceValidUntil`.
 */

const NOW = new Date('2026-10-08T12:00:00.000Z');
const MINUTE = 60_000;

let ctx: TestContext;
let db: Database;
let eventId: string;
let mainMarketId: string;
let bttsMarketId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.clock.now = NOW;
  db = ctx.db.db;
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'england', { en: 'England' }, 10, 'GB');
  const competition = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'premier-league',
    name: { en: 'Premier League' },
    featured: true,
  });
  const home = await insertTeam(db, 'football', 'ARS', { en: 'Arsenal' });
  const away = await insertTeam(db, 'football', 'CHE', { en: 'Chelsea' });
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: competition,
    homeTeamId: home,
    awayTeamId: away,
    startTime: new Date(NOW.getTime() + 3 * 3_600_000),
  });
  eventId = event.id;
  mainMarketId = (
    await insertMarket(db, eventId, '1x2', null, [
      ['1', 1850],
      ['X', 3400],
      ['2', 4200],
    ])
  ).id;
  bttsMarketId = (
    await insertMarket(db, eventId, 'btts', null, [
      ['Yes', 1700],
      ['No', 2100],
    ])
  ).id;
});

afterAll(async () => {
  await ctx?.close();
});

const setExpiry = (marketId: string, until: Date | null) =>
  db.update(markets).set({ priceValidUntil: until }).where(eq(markets.id, marketId));

async function detail(): Promise<EventDetail> {
  const response = await ctx.app.inject({ method: 'GET', url: `/events/${eventId}` });
  expect(response.statusCode).toBe(200);
  return EventDetail.parse(response.json());
}

describe('expired prices in the catalogue (task 1.10)', () => {
  it('shows a market whose price never expires as before, without priceValidUntil', async () => {
    const body = await detail();
    const main = body.markets.find((m) => m.id === mainMarketId)!;
    expect(main.status).toBe('open');
    expect(main.priceValidUntil).toBeUndefined();
    expect(main.selections.every((s) => s.open)).toBe(true);
  });

  it('shows a valid price open, with its expiry', async () => {
    const until = new Date(NOW.getTime() + 30 * MINUTE);
    await setExpiry(mainMarketId, until);
    const main = (await detail()).markets.find((m) => m.id === mainMarketId)!;
    expect(main.status).toBe('open');
    expect(main.priceValidUntil).toBe(until.toISOString());
    expect(main.selections.every((s) => s.open)).toBe(true);
  });

  it('shows an expired price suspended, its selections closed, from the instant itself', async () => {
    await setExpiry(mainMarketId, NOW);
    await setExpiry(bttsMarketId, new Date(NOW.getTime() - MINUTE));
    const body = await detail();
    for (const market of body.markets) {
      expect(market.status).toBe('suspended');
      expect(market.selections.every((s) => !s.open)).toBe(true);
    }
    // Still listed: a suspended market counts towards "+N markets".
    expect(body.marketCount).toBe(1);
  });

  it('shows the list row’s main market suspended too', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/events?sport=football' });
    expect(response.statusCode).toBe(200);
    const row = EventListResponse.parse(response.json()).items.find((e) => e.id === eventId)!;
    expect(row.mainMarket?.status).toBe('suspended');
    expect(row.mainMarket?.selections.every((s) => !s.open)).toBe(true);
  });
});

describe('displayedMarketStatus', () => {
  it('changes only an open market with an expired price', () => {
    const past = new Date(NOW.getTime() - 1);
    expect(displayedMarketStatus({ status: 'open', priceValidUntil: past }, NOW)).toBe('suspended');
    expect(displayedMarketStatus({ status: 'open', priceValidUntil: null }, NOW)).toBe('open');
    expect(displayedMarketStatus({ status: 'open' }, NOW)).toBe('open');
    for (const status of ['suspended', 'closed', 'settled', 'void'] as const) {
      expect(displayedMarketStatus({ status, priceValidUntil: past }, NOW)).toBe(status);
    }
  });
});
