import { EventDetail } from '@vamos/contracts';
import { storeTeamLogo } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

/** Team logos (owner, 17 Nov 2026): the logo's version on the team, and the PNG itself. */

const NOW = new Date('2026-11-17T12:00:00.000Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('team logos', () => {
  let ctx: TestContext;
  let eventId: string;
  let arsenal: string;
  let chelsea: string;
  beforeAll(async () => {
    ctx = await createTestContext({ CATALOG_CACHE_SECONDS: '0' });
    ctx.clock.now = NOW;
    const db = ctx.db.db;
    await insertSport(db, 'football', { en: 'Football' }, 10);
    const england = await insertCategory(db, 'football', 'england', { en: 'England' }, 10, 'GB');
    const premier = await insertCompetition(db, {
      sportId: 'football',
      categoryId: england,
      slug: 'premier-league',
      name: { en: 'Premier League' },
    });
    arsenal = await insertTeam(db, 'football', 'ARS', { en: 'Arsenal' });
    chelsea = await insertTeam(db, 'football', 'CHE', { en: 'Chelsea' });
    ({ id: eventId } = await insertEvent(db, {
      sportId: 'football',
      competitionId: premier,
      homeTeamId: arsenal,
      awayTeamId: chelsea,
      startTime: new Date(NOW.getTime() + 3 * 3_600_000),
    }));
    await insertMarket(db, eventId, '1x2', null, ONE_X_TWO);
    await storeTeamLogo(db, { teamId: arsenal, apiFootballTeamId: 42, png: PNG, now: NOW });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('says which team has a logo, with the version that goes into its address', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `/events/${eventId}` });
    expect(response.statusCode, response.body).toBe(200);
    const detail = EventDetail.parse(response.json());
    expect(detail.home.logo).toBe(String(NOW.getTime()));
    expect(detail.away.logo).toBeUndefined();
  });

  it('serves the PNG with a week of cache, and 404 without a logo or for a bad id', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `/teams/${arsenal}/logo` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=604800, immutable');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.equals(PNG)).toBe(true);
    for (const id of [chelsea, 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const missing = await ctx.app.inject({ method: 'GET', url: `/teams/${id}/logo` });
      expect(missing.statusCode).toBe(404);
    }
  });
});
