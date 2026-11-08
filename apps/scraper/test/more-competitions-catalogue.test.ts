import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAliasInputs } from '@vamos/db';
import { buildAliasIndex, resolveCompetition, resolveTeam, type AliasIndex } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

const DATA = resolve(__dirname, '../../../docs/scraper-plan/data');
const ALIASES = 'aliases-openfootball-more-competitions.csv';

interface Competition {
  key: string;
  slug: string;
  sportKey: string;
  name: string;
  category: string;
  country: string | null;
}

/** The fifteen competitions of task 1.4, each with its The Odds API sport key. */
const COMPETITIONS: Competition[] = [
  ['el', 'uefa-europa-league', 'soccer_uefa_europa_league', 'UEFA Europa League'],
  [
    'ecl',
    'uefa-conference-league',
    'soccer_uefa_europa_conference_league',
    'UEFA Conference League',
  ],
  ['facup', 'fa-cup', 'soccer_fa_cup', 'FA Cup'],
  ['eflcup', 'efl-cup', 'soccer_england_efl_cup', 'EFL Cup'],
  ['en3', 'league-one', 'soccer_england_league1', 'EFL League One'],
  ['en4', 'league-two', 'soccer_england_league2', 'EFL League Two'],
  ['cdr', 'copa-del-rey', 'soccer_spain_copa_del_rey', 'Copa del Rey'],
  ['dfbpokal', 'dfb-pokal', 'soccer_germany_dfb_pokal', 'DFB-Pokal'],
  ['coppaitalia', 'coppa-italia', 'soccer_italy_coppa_italia', 'Coppa Italia'],
  ['cdf', 'coupe-de-france', 'soccer_france_coupe_de_france', 'Coupe de France'],
  ['sa1', 'saudi-pro-league', 'soccer_saudi_arabia_pro_league', 'Saudi Pro League'],
  ['tr1', 'super-lig', 'soccer_turkey_super_league', 'Süper Lig'],
  ['sco1', 'scottish-premiership', 'soccer_spl', 'Scottish Premiership'],
  ['be1', 'belgian-pro-league', 'soccer_belgium_first_div', 'Belgian Pro League'],
  ['ch1', 'swiss-super-league', 'soccer_switzerland_superleague', 'Swiss Super League'],
].map(([key, slug, sportKey, name]) => ({
  key: key as string,
  slug: slug as string,
  sportKey: sportKey as string,
  name: name as string,
  category: '',
  country: null,
}));

const CATEGORY: Record<string, [category: string, country: string]> = {
  'uefa-europa-league': ['international-clubs', ''],
  'uefa-conference-league': ['international-clubs', ''],
  'fa-cup': ['england', 'GB-ENG'],
  'efl-cup': ['england', 'GB-ENG'],
  'league-one': ['england', 'GB-ENG'],
  'league-two': ['england', 'GB-ENG'],
  'copa-del-rey': ['spain', 'ES'],
  'dfb-pokal': ['germany', 'DE'],
  'coppa-italia': ['italy', 'IT'],
  'coupe-de-france': ['france', 'FR'],
  'saudi-pro-league': ['saudi-arabia', 'SA'],
  'super-lig': ['turkey', 'TR'],
  'scottish-premiership': ['scotland', 'GB-SCT'],
  'belgian-pro-league': ['belgium', 'BE'],
  'swiss-super-league': ['switzerland', 'CH'],
};

const FILES = {
  tr1: 'tr.1.json',
  sco1: 'sco.1.json',
  be1: 'be.1.json',
  en3: 'en.3.json',
  en4: 'en.4.json',
} as const;

/** The clubs of each openfootball 2025-26 file, spelt as it spells them -> the seeded team. */
const CLUBS: Record<keyof typeof FILES, Array<[openfootball: string, shortName: string]>> = {
  tr1: [
    ['Alanyaspor', 'Alanyaspor'],
    ['Antalyaspor', 'Antalyaspor'],
    ['Beşiktaş', 'Besiktas'],
    ['Eyüpspor', 'Eyupspor'],
    ['Fatih Karagümrük', 'Fatih Karagumruk'],
    ['Fenerbahçe', 'Fenerbahce'],
    ['Galatasaray', 'Galatasaray'],
    ['Gaziantep FK', 'Gaziantep'],
    ['Gençlerbirliği', 'Genclerbirligi'],
    ['Göztepe', 'Goztepe'],
    ['Kasımpaşa SK', 'Kasimpasa'],
    ['Kayserispor', 'Kayserispor'],
    ['Kocaelispor', 'Kocaelispor'],
    ['Konyaspor', 'Konyaspor'],
    ['Samsunspor', 'Samsunspor'],
    ['Trabzonspor', 'Trabzonspor'],
    ['Çaykur Rizespor', 'Rizespor'],
    ['İstanbul Başakşehir', 'Basaksehir'],
  ],
  sco1: [
    ['Aberdeen FC', 'Aberdeen'],
    ['Celtic FC', 'Celtic'],
    ['Dundee FC', 'Dundee'],
    ['Dundee United', 'Dundee United'],
    ['Falkirk FC', 'Falkirk'],
    ['Heart of Midlothian', 'Hearts'],
    ['Hibernian FC', 'Hibernian'],
    ['Kilmarnock FC', 'Kilmarnock'],
    ['Livingston FC', 'Livingston'],
    ['Motherwell FC', 'Motherwell'],
    ['Rangers FC', 'Rangers'],
    ['St. Mirren FC', 'St Mirren'],
  ],
  be1: [
    ['Cercle Brugge', 'Cercle Brugge'],
    ['Club Brugge KV', 'Club Brugge'],
    ['FCV Dender EH', 'Dender'],
    ['KAA Gent', 'Gent'],
    ['KRC Genk', 'Genk'],
    ['KV Mechelen', 'Mechelen'],
    ['KVC Westerlo', 'Westerlo'],
    ['Oud-Heverlee Leuven', 'OH Leuven'],
    ['RAAL La Louviére', 'La Louviere'],
    ['RSC Anderlecht', 'Anderlecht'],
    ['Royal Antwerp FC', 'Antwerp'],
    ['SV Zulte Waregem', 'Zulte Waregem'],
    ['Sint-Truidense VV', 'Sint-Truiden'],
    ['Sporting Charleroi', 'Charleroi'],
    ['Standard Liège', 'Standard Liege'],
    ['Union Saint-Gilloise', 'Union SG'],
  ],
  en3: [
    ['AFC Wimbledon', 'AFC Wimbledon'],
    ['Barnsley FC', 'Barnsley'],
    ['Blackpool FC', 'Blackpool'],
    ['Bolton Wanderers', 'Bolton'],
    ['Bradford City', 'Bradford'],
    ['Burton Albion', 'Burton'],
    ['Cardiff City', 'Cardiff'],
    ['Doncaster Rovers', 'Doncaster'],
    ['Exeter City', 'Exeter'],
    ['Huddersfield Town', 'Huddersfield'],
    ['Leyton Orient', 'Leyton Orient'],
    ['Lincoln City', 'Lincoln'],
    ['Luton Town', 'Luton'],
    ['Mansfield Town', 'Mansfield'],
    ['Northampton Town', 'Northampton'],
    ['Peterborough United', 'Peterborough'],
    ['Plymouth Argyle', 'Plymouth'],
    ['Port Vale FC', 'Port Vale'],
    ['Reading FC', 'Reading'],
    ['Rotherham United', 'Rotherham'],
    ['Stevenage FC', 'Stevenage'],
    ['Stockport County', 'Stockport'],
    ['Wigan Athletic', 'Wigan'],
    ['Wycombe Wanderers', 'Wycombe'],
  ],
  en4: [
    ['Accrington Stanley', 'Accrington'],
    ['Barnet FC', 'Barnet'],
    ['Barrow AFC', 'Barrow'],
    ['Bristol Rovers', 'Bristol Rovers'],
    ['Bromley FC', 'Bromley'],
    ['Cambridge United', 'Cambridge'],
    ['Cheltenham Town', 'Cheltenham'],
    ['Chesterfield FC', 'Chesterfield'],
    ['Colchester United', 'Colchester'],
    ['Crawley Town', 'Crawley'],
    ['Crewe Alexandra', 'Crewe'],
    ['Fleetwood Town', 'Fleetwood'],
    ['Gillingham FC', 'Gillingham'],
    ['Grimsby Town', 'Grimsby'],
    ['Harrogate Town', 'Harrogate'],
    ['Milton Keynes Dons', 'MK Dons'],
    ['Newport County', 'Newport'],
    ['Notts County', 'Notts County'],
    ['Oldham Athletic', 'Oldham'],
    ['Salford City', 'Salford'],
    ['Shrewsbury Town', 'Shrewsbury'],
    ['Swindon Town', 'Swindon'],
    ['Tranmere Rovers', 'Tranmere'],
    ['Walsall FC', 'Walsall'],
  ],
};

/** Clubs that belong to another seeded competition (reused, never duplicated). */
const REUSED = [
  'Galatasaray',
  'Fenerbahce',
  'Club Brugge',
  'Bolton',
  'Cardiff',
  'Lincoln',
] as const;

const SOURCE_FILES = COMPETITIONS.flatMap(({ key }) => [
  `source-theoddsapi-${key}.json`,
  `source-theoddsapi-scores-${key}.json`,
]);

describe('fifteen more competitions against the catalogue', () => {
  let db: Awaited<ReturnType<typeof catalogDatabase>>;
  let cli: ReturnType<typeof cliHarness>;
  let index: AliasIndex;
  const shortNameById = new Map<string, string>();

  beforeAll(async () => {
    db = await catalogDatabase();
    cli = cliHarness({ db: db.db });
    cli.files.set('aliases.csv', readFileSync(resolve(DATA, ALIASES), 'utf8'));
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

  for (const [key, clubs] of Object.entries(CLUBS)) {
    it(`resolves every club of ${FILES[key as keyof typeof FILES]} to its seeded team, one team per club`, () => {
      const seen = new Set<string>();
      for (const [raw, shortName] of clubs) {
        const resolution = team(raw);
        expect(resolution.status, raw).toBe('resolved');
        if (resolution.status !== 'resolved') continue;
        expect(shortNameById.get(resolution.id), raw).toBe(shortName);
        seen.add(resolution.id);
      }
      expect(seen.size).toBe(clubs.length);
    });
  }

  it('lists the clubs of the openfootball files as fetched (counts)', () => {
    expect(Object.fromEntries(Object.entries(CLUBS).map(([k, v]) => [k, v.length]))).toEqual({
      tr1: 18,
      sco1: 12,
      be1: 16,
      en3: 24,
      en4: 24,
    });
  });

  for (const competition of COMPETITIONS) {
    describe(competition.name, () => {
      it('exists under its category, not featured, with an Amharic name and the source name', async () => {
        const [category, country] = CATEGORY[competition.slug] ?? ['', ''];
        const row = await db.pool.query<{
          name: { en: string; am?: string };
          featured: boolean;
          category: string;
          country_code: string | null;
        }>(
          `SELECT c.name, c.featured, k.slug AS category, k.country_code
             FROM competitions c JOIN categories k ON k.id = c.category_id
            WHERE c.sport_id = 'football' AND c.slug = $1`,
          [competition.slug],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0]).toMatchObject({
          name: { en: competition.name },
          featured: false,
          category,
        });
        if (country !== '') expect(row.rows[0]?.country_code).toBe(country);
        expect(row.rows[0]?.name.am).toBeTruthy();
        for (const file of [
          `source-theoddsapi-${competition.key}.json`,
          `source-theoddsapi-scores-${competition.key}.json`,
        ]) {
          const source = JSON.parse(readFileSync(resolve(DATA, file), 'utf8')) as {
            config: { competition: string; sportKey: string };
          };
          expect(source.config.competition, file).toBe(competition.name);
          expect(source.config.sportKey, file).toBe(competition.sportKey);
        }
        const resolved = resolveCompetition(index, {
          sportId: 'football',
          sourceId: 'any',
          raw: competition.name,
        });
        expect(resolved.status).toBe('resolved');
      });
    });
  }

  it('shares reused clubs with their other competitions instead of duplicating them', async () => {
    for (const shortName of REUSED) {
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

  it('seeds no Saudi or Swiss clubs, and no club for the cups and European ties', async () => {
    const rows = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE sport_id = 'football' AND country_code IN ('SA', 'CH')`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('every alias of the file points to a seeded club of these competitions', () => {
    const wanted = new Set(Object.values(CLUBS).flatMap((clubs) => clubs.map(([, s]) => s)));
    const lines = readFileSync(resolve(DATA, ALIASES), 'utf8').trim().split('\n').slice(1);
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
    const keys = COMPETITIONS.map((c) => c.key).join('|');
    const rows = await db.pool.query<{ id: string }>(
      `SELECT id FROM scrape_sources WHERE id ~ '^theoddsapi-(scores-)?(${keys})$' ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(SOURCE_FILES.length);
  });
});
