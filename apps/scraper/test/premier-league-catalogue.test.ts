import { loadAliasInputs } from '@vamos/db';
import { buildAliasIndex, isCalibrated, resolveTeam, type AliasIndex } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

/** The twenty clubs of the 2026-27 file (openfootball, en.1.json), spelt as the file spells them. */
const OPENFOOTBALL_2026_27 = [
  'AFC Bournemouth',
  'Arsenal FC',
  'Aston Villa FC',
  'Brentford FC',
  'Brighton & Hove Albion FC',
  'Chelsea FC',
  'Coventry City FC',
  'Crystal Palace FC',
  'Everton FC',
  'Fulham FC',
  'Hull City AFC',
  'Ipswich Town FC',
  'Leeds United FC',
  'Liverpool FC',
  'Manchester City FC',
  'Manchester United FC',
  'Newcastle United FC',
  'Nottingham Forest FC',
  'Sunderland AFC',
  'Tottenham Hotspur FC',
];

describe('Premier League catalogue against the 2026-27 openfootball club names', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let index: AliasIndex;

  beforeAll(async () => {
    db = await catalogDatabase();
    index = buildAliasIndex(await loadAliasInputs(db.db, 'football'));
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  const team = (raw: string) => resolveTeam(index, { sportId: 'football', sourceId: 'any', raw });

  it('resolves every club of the file by name alone, without any alias', () => {
    const ids = new Set<string>();
    for (const raw of OPENFOOTBALL_2026_27) {
      const resolution = team(raw);
      expect(resolution, raw).toMatchObject({ status: 'resolved', via: 'name' });
      if (resolution.status === 'resolved') ids.add(resolution.id);
    }
    // Twenty names, twenty different teams.
    expect(ids.size).toBe(20);
  });

  it('has the three promoted clubs, in England, with modest ratings that stay uncalibrated', async () => {
    const rows = await db.pool.query<{
      short_name: string;
      name: { en: string };
      country_code: string;
      ratings: Record<string, unknown>;
    }>(
      `SELECT short_name, name, country_code, ratings FROM teams
        WHERE sport_id = 'football' AND short_name IN ('Coventry', 'Hull', 'Ipswich')
        ORDER BY short_name`,
    );
    expect(rows.rows.map((r) => [r.short_name, r.name.en, r.country_code])).toEqual([
      ['Coventry', 'Coventry City', 'GB-ENG'],
      ['Hull', 'Hull City', 'GB-ENG'],
      ['Ipswich', 'Ipswich Town', 'GB-ENG'],
    ]);
    for (const row of rows.rows) expect(isCalibrated(row.ratings)).toBe(false);
    expect(rows.rows.map((r) => r.ratings)).toEqual([
      { attack: 0.88, defence: 1.12 },
      { attack: 0.82, defence: 1.18 },
      { attack: 0.86, defence: 1.14 },
    ]);
  });
});
