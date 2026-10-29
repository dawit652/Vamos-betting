import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAliasInputs } from '@vamos/db';
import {
  buildAliasIndex,
  isCalibrated,
  normalizeName,
  resolveCompetition,
  resolveTeam,
  type AliasIndex,
} from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cli/csv';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

const ALIAS_FILE = resolve(__dirname, '../../../docs/scraper-plan/data/costa-rica-aliases.csv');
const SHORT_NAMES = [
  'Alajuelense',
  'Saprissa',
  'Herediano',
  'Cartaginés',
  'Pérez Zeledón',
  'Puntarenas',
  'Sporting CR',
  'San Carlos',
  'Inter San Carlos',
  'Escorpiones',
];

describe('Costa Rica catalogue and alias file', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  let index: AliasIndex;
  const teamIds = new Map<string, string>();
  let competitionId = '';

  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    cli.files.set('costa-rica-aliases.csv', readFileSync(ALIAS_FILE, 'utf8'));
    const result = await cli.run('aliases', 'import', '--file', 'costa-rica-aliases.csv');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    index = buildAliasIndex(await loadAliasInputs(db.db, 'football'));
    const teams = await db.pool.query<{ id: string; short_name: string }>(
      `SELECT id, short_name FROM teams WHERE country_code = 'CR'`,
    );
    for (const row of teams.rows) teamIds.set(row.short_name, row.id);
    const comp = await db.pool.query<{ id: string }>(
      `SELECT id FROM competitions WHERE slug = 'primera-division'`,
    );
    competitionId = comp.rows[0]!.id;
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  const team = (raw: string) => resolveTeam(index, { sportId: 'football', sourceId: 'any', raw });
  const competition = (raw: string) =>
    resolveCompetition(index, { sportId: 'football', sourceId: 'any', raw });

  it('seeds the ten clubs as uncalibrated (rule O1)', async () => {
    expect([...teamIds.keys()].sort()).toEqual([...SHORT_NAMES].sort());
    const rows = await db.pool.query<{ ratings: Record<string, unknown> }>(
      `SELECT ratings FROM teams WHERE country_code = 'CR'`,
    );
    expect(rows.rows).toHaveLength(10);
    for (const row of rows.rows) expect(isCalibrated(row.ratings)).toBe(false);
  });

  it('folds the accents: Cartagines and Perez Zeledon are the same normal form', () => {
    expect(normalizeName('Cartagines')).toBe(normalizeName('Cartaginés'));
    expect(normalizeName('Perez Zeledon')).toBe(normalizeName('Pérez Zeledón'));
    expect(team('Cartagines')).toEqual({
      status: 'resolved',
      id: teamIds.get('Cartaginés'),
      via: 'name',
    });
    expect(team('PEREZ ZELEDON')).toEqual({
      status: 'resolved',
      id: teamIds.get('Pérez Zeledón'),
      via: 'name',
    });
  });

  it('resolves every short name and official name to its own team', () => {
    for (const shortName of SHORT_NAMES) {
      expect(team(shortName)).toMatchObject({ status: 'resolved', id: teamIds.get(shortName) });
    }
  });

  it('resolves every alias of the file to the team or competition it names', () => {
    const rows = parseCsv(readFileSync(ALIAS_FILE, 'utf8'));
    const header = rows[0]!.cells;
    const col = (cells: string[], name: string) => cells[header.indexOf(name)] ?? '';
    const body = rows.slice(1);
    expect(body.filter((r) => col(r.cells, 'kind') === 'team').length).toBeGreaterThanOrEqual(10);
    expect(body.filter((r) => col(r.cells, 'kind') === 'competition')).toHaveLength(4);
    for (const { cells } of body) {
      expect(col(cells, 'source')).toBe('');
      const alias = col(cells, 'alias');
      const target = col(cells, 'target');
      if (col(cells, 'kind') === 'team') {
        expect(team(alias), alias).toEqual({
          status: 'resolved',
          id: teamIds.get(target),
          via: 'alias',
        });
      } else {
        expect(target).toBe('primera-division');
        expect(competition(alias), alias).toEqual({
          status: 'resolved',
          id: competitionId,
          via: 'alias',
        });
      }
    }
  });

  it('resolves the competition names the sources use', () => {
    for (const raw of [
      'Primera División',
      'Primera Division',
      'Liga Promerica',
      'Liga FPD',
      'Liga de Fútbol de Primera División',
      'Primera División de Costa Rica',
    ]) {
      expect(competition(raw), raw).toMatchObject({ status: 'resolved', id: competitionId });
    }
  });

  it('keeps San Carlos and Inter San Carlos apart, and leaves unverified clubs unknown', () => {
    expect(team('San Carlos')).toMatchObject({ id: teamIds.get('San Carlos') });
    expect(team('Inter de San Carlos')).toMatchObject({ id: teamIds.get('Inter San Carlos') });
    expect(team('Municipal Liberia')).toEqual({ status: 'unknown' });
    expect(team('Guadalupe')).toEqual({ status: 'unknown' });
  });

  it('is idempotent: importing the file again adds nothing', async () => {
    const again = await cli.run('aliases', 'import', '--file', 'costa-rica-aliases.csv');
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^0 added, \d+ already present$/m);
  });

  it('ratings backfill --dry-run accepts a file written with the new short names', async () => {
    // TEST FIXTURE: invented scores, only to prove the file format works with the
    // seeded teams. These are not real results and must never be backfilled.
    const fixture = [
      { date: '2024-01-06', home: 'Cartagines', away: 'Perez Zeledon', homeGoals: 2, awayGoals: 1 },
      {
        date: '2024-01-13',
        home: 'Sporting CR',
        away: 'Inter San Carlos',
        homeGoals: 0,
        awayGoals: 0,
      },
    ];
    cli.files.set('fixture-not-real-results.json', JSON.stringify(fixture));
    const result = await cli.run(
      'ratings',
      'backfill',
      '--file',
      'fixture-not-real-results.json',
      '--competition',
      'primera-division',
      '--dry-run',
    );
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('2 results for primera-division, 4 teams');
    expect(result.stdout).toContain('dry run: 4 would change, 0 unchanged; nothing was written');
    const after = await db.pool.query<{ ratings: Record<string, unknown> }>(
      `SELECT ratings FROM teams WHERE country_code = 'CR'`,
    );
    for (const row of after.rows) expect(row.ratings).toEqual({ attack: 1, defence: 1 });
  });
});
