import { EventDetail, EventListResponse, QuoteResponse } from '@vamos/contracts';
import type { Database } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketName, selectionName } from '../src/modules/betting/views';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

const NOW = new Date('2026-10-08T12:00:00.000Z');

let ctx: TestContext;
let db: Database;
let eventId: string;
let gameId: number;
let htftSelection: string;

const flag = (on: boolean) => {
  (ctx.deps.config.features as { factoryMarkets: boolean }).factoryMarkets = on;
};

beforeAll(async () => {
  ctx = await createTestContext();
  ctx.clock.now = NOW;
  db = ctx.db.db;
  await insertSport(db, 'football', { en: 'Football', am: 'እግር ኳስ' }, 10);
  const category = await insertCategory(db, 'football', 'england', { en: 'England' }, 10, 'GB');
  const competition = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'premier-league',
    name: { en: 'Premier League' },
    featured: true,
  });
  const home = await insertTeam(db, 'football', 'ARS', { en: 'Arsenal', am: 'አርሰናል' });
  const away = await insertTeam(db, 'football', 'CHE', { en: 'Chelsea', am: 'ቼልሲ' });
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: competition,
    homeTeamId: home,
    awayTeamId: away,
    startTime: new Date(NOW.getTime() + 3_600_000),
  });
  eventId = event.id;
  gameId = event.gameId;
  await insertMarket(db, eventId, '1x2', null, [
    ['1', 1850],
    ['X', 3400],
    ['2', 4200],
  ]);
  // Inserted before the factory markets on purpose: display order is by sort order.
  const htft = await insertMarket(db, eventId, 'htft', null, [
    ['1/1', 3000],
    ['X/2', 20000],
  ]);
  htftSelection = htft.selectionIds['1/1']!;
  await insertMarket(db, eventId, 'multigoals', '1-3', [
    ['yes', 1500],
    ['no', 2400],
  ]);
  await insertMarket(db, eventId, 'multigoals', '99-100', [['yes', 1500]]);
  await insertMarket(db, eventId, 'htft_bogus', null, [['1/1', 1500]]);
  await insertMarket(db, eventId, 'btts', null, [
    ['Yes', 1700],
    ['No', 2100],
  ]);
});

afterAll(async () => {
  flag(false);
  await ctx?.close();
});

async function detail(): Promise<EventDetail> {
  const response = await ctx.app.inject({ method: 'GET', url: `/events/${eventId}` });
  expect(response.statusCode).toBe(200);
  return EventDetail.parse(response.json());
}

describe('factory markets in the catalogue', () => {
  it('shows nothing of them with the switch off', async () => {
    flag(false);
    const body = await detail();
    expect(body.markets.map((m) => m.type)).toEqual(['1x2', 'btts']);
    expect(body.markets.every((m) => m.group === undefined)).toBe(true);
    expect(body.marketCount).toBe(1);
  });

  it('shows valid ones after today markets, labelled and grouped, with the switch on', async () => {
    flag(true);
    const body = await detail();
    expect(body.markets.map((m) => m.type)).toEqual(['1x2', 'btts', 'multigoals', 'htft']);
    const htft = body.markets[3]!;
    expect(htft.name.en).toBe('Half time / full time');
    expect(htft.group).toBe('halves');
    expect(htft.selections.map((s) => s.label.en)).toEqual([
      'Arsenal/Arsenal',
      'Chelsea/Draw'.replace('Chelsea/Draw', htft.selections[1]!.label.en),
    ]);
    const multigoals = body.markets[2]!;
    expect(multigoals.line).toBe('1-3');
    expect(multigoals.name.en).toContain('Multigoals');
    expect(multigoals.group).toBe('full_time');
    expect(body.markets.slice(0, 2).every((m) => m.group === undefined)).toBe(true);
    expect(body.marketCount).toBe(3);
  });

  it('hides malformed ones (unknown line, unknown type) even with the switch on', async () => {
    flag(true);
    const body = await detail();
    expect(body.markets.some((m) => m.line === '99-100' || m.type === 'htft_bogus')).toBe(false);
  });

  it('counts them in the list row only with the switch on', async () => {
    const count = async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/events?sport=football' });
      const list = EventListResponse.parse(response.json());
      const row = list.items.find((e) => e.id === eventId)!;
      return [row.marketCount, row.optionCount];
    };
    // Options are the selections of exactly the counted markets: btts (2), htft (2), multigoals 1-3 (2).
    flag(false);
    expect(await count()).toEqual([1, 2]);
    flag(true);
    expect(await count()).toEqual([3, 6]);
    const byGame = await ctx.app.inject({ method: 'GET', url: `/events/by-game-id/${gameId}` });
    expect(byGame.statusCode).toBe(200);
  });
});

describe('factory legs in bet views', () => {
  const base = {
    homeTeam: { en: 'Arsenal', am: 'አርሰናል' },
    awayTeam: { en: 'Chelsea', am: 'ቼልሲ' },
  };

  it('labels a factory leg instead of showing the raw code', () => {
    const leg = { ...base, marketType: 'htft', marketLine: null, code: '1/1' };
    expect(marketName(leg)).toEqual({ en: 'Half time / full time', am: expect.any(String) });
    expect(selectionName(leg).en).toBe('Arsenal/Arsenal');
    expect(
      selectionName({ ...leg, marketType: 'multigoals', marketLine: '1-3', code: 'yes' }).en,
    ).not.toBe('yes');
  });

  it('falls back to the code for a malformed stored leg', () => {
    expect(selectionName({ ...base, marketType: 'htft', marketLine: null, code: 'zzz' })).toEqual({
      en: 'zzz',
    });
    expect(marketName({ marketType: 'nonsense', marketLine: null })).toEqual({ en: 'nonsense' });
  });

  it('labels the leg on the bet slip whatever the switch', async () => {
    for (const on of [false, true]) {
      flag(on);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/betslip/quote',
        payload: { legs: [{ selectionId: htftSelection }], stake: '1000' },
      });
      expect(response.statusCode).toBe(200);
      const leg = QuoteResponse.parse(response.json()).legs[0]!;
      expect(leg.marketName?.en).toBe('Half time / full time');
      expect(leg.selectionName?.en).toBe('Arsenal/Arsenal');
    }
  });
});
