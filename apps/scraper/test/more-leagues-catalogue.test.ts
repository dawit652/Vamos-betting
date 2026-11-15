import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAliasInputs } from '@vamos/db';
import { buildAliasIndex, resolveCompetition, resolveTeam, type AliasIndex } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

const DATA = resolve(__dirname, '../../../docs/scraper-plan/data');

interface League {
  key: string;
  slug: string;
  name: string;
  category: string;
  country: string;
  /** The clubs of the openfootball file, spelt as it spells them, with the seeded team they are. */
  clubs: Array<[openfootball: string, shortName: string]>;
  /** Seeded teams that exist for other competitions too (reused, never duplicated). */
  reused: string[];
}

const LEAGUES: League[] = [
  {
    key: 'en2',
    slug: 'championship',
    name: 'EFL Championship',
    category: 'england',
    country: 'GB-ENG',
    reused: ['Burnley', 'West Ham', 'Wolves'],
    clubs: [
      ['Birmingham City FC', 'Birmingham'],
      ['Blackburn Rovers FC', 'Blackburn'],
      ['Bolton Wanderers FC', 'Bolton'],
      ['Bristol City FC', 'Bristol City'],
      ['Burnley FC', 'Burnley'],
      ['Cardiff City FC', 'Cardiff'],
      ['Charlton Athletic FC', 'Charlton'],
      ['Derby County FC', 'Derby'],
      ['Lincoln City FC', 'Lincoln'],
      ['Middlesbrough FC', 'Middlesbrough'],
      ['Millwall FC', 'Millwall'],
      ['Norwich City FC', 'Norwich'],
      ['Portsmouth FC', 'Portsmouth'],
      ['Preston North End FC', 'Preston'],
      ['Queens Park Rangers FC', 'QPR'],
      ['Sheffield United FC', 'Sheffield United'],
      ['Southampton FC', 'Southampton'],
      ['Stoke City FC', 'Stoke'],
      ['Swansea City AFC', 'Swansea'],
      ['Watford FC', 'Watford'],
      ['West Bromwich Albion FC', 'West Brom'],
      ['West Ham United FC', 'West Ham'],
      ['Wolverhampton Wanderers FC', 'Wolves'],
      ['Wrexham AFC', 'Wrexham'],
    ],
  },
  {
    key: 'nl1',
    slug: 'eredivisie',
    name: 'Eredivisie',
    category: 'netherlands',
    country: 'NL',
    reused: ['PSV', 'Feyenoord'],
    clubs: [
      ['ADO Den Haag', 'ADO Den Haag'],
      ['AFC Ajax', 'Ajax'],
      ['AZ', 'AZ'],
      ['FC Groningen', 'Groningen'],
      ["FC Twente '65", 'Twente'],
      ['FC Utrecht', 'Utrecht'],
      ['Feyenoord Rotterdam', 'Feyenoord'],
      ['Fortuna Sittard', 'Fortuna Sittard'],
      ['Go Ahead Eagles', 'Go Ahead Eagles'],
      ['NEC', 'NEC'],
      ['PEC Zwolle', 'PEC Zwolle'],
      ['PSV', 'PSV'],
      ['SBV Excelsior', 'Excelsior'],
      ['SC Cambuur-Leeuwarden', 'Cambuur'],
      ['SC Heerenveen', 'Heerenveen'],
      ['Sparta Rotterdam', 'Sparta Rotterdam'],
      ['Telstar 1963', 'Telstar'],
      ['Willem II Tilburg', 'Willem II'],
    ],
  },
  {
    key: 'pt1',
    slug: 'primeira-liga',
    name: 'Primeira Liga',
    category: 'portugal',
    country: 'PT',
    reused: ['Porto', 'Sporting CP'],
    clubs: [
      ['Académico de Viseu FC', 'Academico Viseu'],
      ['CD Nacional', 'Nacional'],
      ['CD Santa Clara', 'Santa Clara'],
      ['CF Estrela da Amadora', 'Estrela Amadora'],
      ['CS Marítimo', 'Maritimo'],
      ['Casa Pia AC', 'Casa Pia'],
      ['FC Alverca', 'Alverca'],
      ['FC Arouca', 'Arouca'],
      ['FC Famalicão', 'Famalicao'],
      ['FC Porto', 'Porto'],
      ['GD Estoril Praia', 'Estoril'],
      ['Gil Vicente FC', 'Gil Vicente'],
      ['Moreirense FC', 'Moreirense'],
      ['Rio Ave FC', 'Rio Ave'],
      ['Sport Lisboa e Benfica', 'Benfica'],
      ['Sporting Clube de Braga', 'Braga'],
      ['Sporting Clube de Portugal', 'Sporting CP'],
      ['Vitória Guimarães', 'Vitoria Guimaraes'],
    ],
  },
  {
    key: 'br1',
    slug: 'brasileirao-serie-a',
    name: 'Brasileirão Série A',
    category: 'brazil',
    country: 'BR',
    reused: [],
    clubs: [
      ['Botafogo FR', 'Botafogo'],
      ['CA Mineiro', 'Atletico Mineiro'],
      ['CA Paranaense', 'Athletico Paranaense'],
      ['CR Flamengo', 'Flamengo'],
      ['CR Vasco da Gama', 'Vasco'],
      ['Chapecoense AF', 'Chapecoense'],
      ['Clube do Remo', 'Remo'],
      ['Coritiba FBC', 'Coritiba'],
      ['Cruzeiro EC', 'Cruzeiro'],
      ['EC Bahia', 'Bahia'],
      ['EC Vitória', 'Vitoria'],
      ['Fluminense FC', 'Fluminense'],
      ['Grêmio FBPA', 'Gremio'],
      ['Mirassol FC', 'Mirassol'],
      ['RB Bragantino', 'Bragantino'],
      ['SC Corinthians Paulista', 'Corinthians'],
      ['SC Internacional', 'Internacional'],
      ['SE Palmeiras', 'Palmeiras'],
      ['Santos FC', 'Santos'],
      ['São Paulo FC', 'Sao Paulo'],
    ],
  },
];

const SOURCE_FILES = LEAGUES.flatMap(({ key }) => [
  `source-openfootball-${key}.json`,
  `source-footballdata-${key}.json`,
  `source-theoddsapi-${key}.json`,
  `source-theoddsapi-scores-${key}.json`,
]);

describe('EFL Championship, Eredivisie, Primeira Liga and Brasileirão against the openfootball club names', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  let index: AliasIndex;
  const shortNameById = new Map<string, string>();

  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    cli.files.set(
      'aliases.csv',
      readFileSync(resolve(DATA, 'aliases-openfootball-more-leagues.csv'), 'utf8'),
    );
    const imported = await cli.run('aliases', 'import', '--file', 'aliases.csv');
    expect(imported).toMatchObject({ code: 0, stderr: '' });
    index = buildAliasIndex(await loadAliasInputs(db.db, 'football'));
    const rows = await db.pool.query<{ id: string; short_name: string }>(
      `SELECT id, short_name FROM teams WHERE sport_id = 'football'`,
    );
    for (const row of rows.rows) shortNameById.set(row.id, row.short_name);
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await db?.drop();
  }, SETUP_TIMEOUT);

  const team = (raw: string) => resolveTeam(index, { sportId: 'football', sourceId: 'any', raw });

  it('each openfootball source names the competition exactly as the seed does', () => {
    // The source file's competition name must resolve without an alias.
    for (const league of LEAGUES) {
      const source = JSON.parse(
        readFileSync(resolve(DATA, `source-openfootball-${league.key}.json`), 'utf8'),
      ) as { config: { requests: Array<{ competition: string }> } };
      expect(source.config.requests[0]?.competition).toBe(league.name);
    }
  });

  for (const league of LEAGUES) {
    describe(league.name, () => {
      it('resolves every club of the file to its seeded team, one team per club', () => {
        const seen = new Set<string>();
        for (const [raw, shortName] of league.clubs) {
          const resolution = team(raw);
          expect(resolution.status, raw).toBe('resolved');
          if (resolution.status !== 'resolved') continue;
          expect(shortNameById.get(resolution.id), raw).toBe(shortName);
          seen.add(resolution.id);
        }
        expect(seen.size).toBe(league.clubs.length);
      });

      it('has the competition under its category, not featured, with an Amharic name', async () => {
        const row = await db.pool.query<{
          name: { en: string; am?: string };
          featured: boolean;
          category: string;
          country_code: string | null;
        }>(
          `SELECT c.name, c.featured, k.slug AS category, k.country_code
             FROM competitions c JOIN categories k ON k.id = c.category_id
            WHERE c.sport_id = 'football' AND c.slug = $1`,
          [league.slug],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0]).toMatchObject({
          name: { en: league.name },
          featured: false,
          category: league.category,
        });
        expect(row.rows[0]?.name.am).toBeTruthy();
        const competition = resolveCompetition(index, {
          sportId: 'football',
          sourceId: 'any',
          raw: league.name,
        });
        expect(competition.status).toBe('resolved');
      });

      it('shares reused clubs with their other competitions instead of duplicating them', async () => {
        for (const shortName of league.reused) {
          const rows = await db.pool.query(
            `SELECT 1 FROM teams WHERE sport_id = 'football' AND short_name = $1`,
            [shortName],
          );
          expect(rows.rowCount, shortName).toBe(1);
        }
        const names = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT name->>'en' FROM teams WHERE sport_id = 'football'
              GROUP BY 1 HAVING count(*) > 1) d`,
        );
        expect(names.rows[0]?.n).toBe(0);
      });
    });
  }

  it('every alias of the file points to a seeded club of these leagues', () => {
    const wanted = new Set(LEAGUES.flatMap((league) => league.clubs.map(([, s]) => s)));
    const lines = readFileSync(resolve(DATA, 'aliases-openfootball-more-leagues.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const target = line.split(',')[3] ?? '';
      expect(wanted.has(target), line).toBe(true);
    }
  });

  it('the new source files are accepted by sources upsert, and start disabled', async () => {
    for (const file of SOURCE_FILES) {
      cli.files.set(file, readFileSync(resolve(DATA, file), 'utf8'));
      const result = await cli.run('sources', 'upsert', '--file', file);
      expect(result, file).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout, file).toContain('state: disabled');
    }
    const rows = await db.pool.query<{ id: string }>(
      `SELECT id FROM scrape_sources WHERE id ~ '-(en2|nl1|pt1|br1)$' ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(SOURCE_FILES.length);
  });
});
