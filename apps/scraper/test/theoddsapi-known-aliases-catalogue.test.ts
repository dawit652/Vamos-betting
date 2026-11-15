import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAliasInputs } from '@vamos/db';
import { buildAliasIndex, normalizeName, resolveTeam, type AliasIndex } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

const DATA = resolve(__dirname, '../../../docs/scraper-plan/data');
const KNOWN = 'aliases-theoddsapi-known.csv';

/**
 * The spellings of The Odds API seen in production (U-2 of docs/feed-quality-plan.md) and what the
 * catalogue does with them: `fallback` resolves by the legal-form rule (U-3) with no alias,
 * `alias` is in the known-aliases file, `gap` is a club the catalogue lacks (nothing is invented:
 * a person adds the club from the review item; when one is added, move it to `alias` or `fallback`).
 */
const SPELLINGS: Record<string, { how: 'fallback' | 'alias' | 'gap'; team?: string }> = {
  'Erzurum BB': { how: 'gap' },
  'Genclerbirligi SK': { how: 'fallback', team: 'Genclerbirligi' },
  'Çorum FK': { how: 'gap' },
  'Amed SK': { how: 'gap' },
  'Besiktas JK': { how: 'fallback', team: 'Besiktas' },
  'Gazişehir Gaziantep': { how: 'fallback', team: 'Gaziantep' },
  'Torku Konyaspor': { how: 'fallback', team: 'Konyaspor' },
  'Falkirk F.C.': { how: 'fallback', team: 'Falkirk' },
  'St Johnstone': { how: 'gap' },
  'FC Twente Enschede': { how: 'alias', team: 'Twente' },
  'FC Zwolle': { how: 'alias', team: 'PEC Zwolle' },
  'York City': { how: 'gap' },
  Rochdale: { how: 'gap' },
  'Leicester City': { how: 'gap' },
  'Sheffield Wednesday': { how: 'gap' }, // the catalogue has Sheffield United only
};

describe('The Odds API known spellings against the catalogue (U-2)', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  let index: AliasIndex;
  const shortNameById = new Map<string, string>();
  const knownRows = readFileSync(resolve(DATA, KNOWN), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [kind, sport, alias, target, source] = line.split(',') as [
        string,
        string,
        string,
        string,
        string,
      ];
      return { kind, sport, alias, target, source };
    });

  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    // The catalogue as production has it: the spellings the scripts import before this file.
    for (const file of readdirSync(DATA).filter(
      (f) => f.startsWith('aliases-') && f.endsWith('.csv') && f !== KNOWN,
    )) {
      cli.files.set(file, readFileSync(resolve(DATA, file), 'utf8'));
      const run = await cli.run('aliases', 'import', '--file', file);
      expect(run, file).toMatchObject({ code: 0, stderr: '' });
    }
    // Rows are scoped to sources, so the sources must exist (the scripts add them first).
    for (const source of new Set(knownRows.map((r) => r.source))) {
      cli.files.set(source, readFileSync(resolve(DATA, `source-${source}.json`), 'utf8'));
      const run = await cli.run('sources', 'upsert', '--file', source);
      expect(run, source).toMatchObject({ code: 0, stderr: '' });
    }
    cli.files.set(KNOWN, readFileSync(resolve(DATA, KNOWN), 'utf8'));
    const rows = await db.pool.query<{ id: string; short_name: string }>(
      `SELECT id, short_name FROM teams WHERE sport_id = 'football'`,
    );
    for (const row of rows.rows) shortNameById.set(row.id, row.short_name);
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  const team = (raw: string, sourceId: string) =>
    resolveTeam(index, { sportId: 'football', sourceId, raw });

  it('imports, and importing again changes nothing', async () => {
    const first = await cli.run('aliases', 'import', '--file', KNOWN);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(first.stdout).toContain(`${knownRows.length} added, 0 already present`);
    const again = await cli.run('aliases', 'import', '--file', KNOWN);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(again.stdout).toContain(`0 added, ${knownRows.length} already present`);
    index = buildAliasIndex(await loadAliasInputs(db.db, 'football'));
  });

  it('every row targets a club of the catalogue, scoped to a The Odds API source', () => {
    expect(knownRows.length).toBeGreaterThan(0);
    const shortNames = new Set(shortNameById.values());
    for (const row of knownRows) {
      expect(row.kind).toBe('team');
      expect(shortNames.has(row.target), `${row.alias} -> ${row.target}`).toBe(true);
      expect(row.source, row.alias).toMatch(/^theoddsapi-(scores-)?[a-z0-9]+$/);
    }
  });

  it('no spelling maps to two teams', () => {
    const targets = new Map<string, Set<string>>();
    for (const row of knownRows) {
      const key = normalizeName(row.alias);
      targets.set(key, (targets.get(key) ?? new Set()).add(row.target));
    }
    for (const [alias, set] of targets) expect(set.size, alias).toBe(1);
  });

  it('every listed spelling is in the file, resolves by fallback, or is a named catalogue gap', () => {
    const inFile = new Set(knownRows.map((r) => r.alias));
    for (const [raw, { how }] of Object.entries(SPELLINGS)) {
      expect(inFile.has(raw), raw).toBe(how === 'alias');
    }
    for (const alias of inFile) expect(SPELLINGS[alias]?.how, alias).toBe('alias');
  });

  it('each spelling resolves as its row says, for the row’s source', () => {
    for (const row of knownRows) {
      const resolution = team(row.alias, row.source);
      expect(resolution.status, row.alias).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(shortNameById.get(resolution.id), row.alias).toBe(row.target);
      expect(resolution.via, row.alias).toBe('source_alias');
    }
  });

  it('a row applies to its own sources only', () => {
    for (const row of knownRows) {
      expect(team(row.alias, 'theoddsapi-en1').status, row.alias).toBe('unknown');
    }
  });

  it('the spellings the legal-form fallback resolves need no alias', () => {
    for (const [raw, { how, team: expected }] of Object.entries(SPELLINGS)) {
      if (how !== 'fallback') continue;
      const resolution = team(raw, 'theoddsapi-tr1');
      expect(resolution.status, raw).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(shortNameById.get(resolution.id), raw).toBe(expected);
    }
  });

  it('the clubs the catalogue lacks stay unknown (a catalogue gap, no invented club)', () => {
    for (const [raw, { how }] of Object.entries(SPELLINGS)) {
      if (how !== 'gap') continue;
      expect(team(raw, 'theoddsapi-tr1').status, raw).toBe('unknown');
    }
  });
});
