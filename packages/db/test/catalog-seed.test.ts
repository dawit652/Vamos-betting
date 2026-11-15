import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categories, competitions, sports, teams } from '../src/schema/index';
import {
  CATALOG_CATEGORIES,
  CATALOG_SPORTS,
  CATALOG_TEAMS,
  DEFAULT_TEAM_RATINGS,
  loadFeedTeams,
  seed,
  seedCatalog,
} from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const ETHIOPIC = /[ሀ-፿]/;
const RATING_KEYS = {
  football: ['attack', 'defence'],
  basketball: ['defence', 'offence'],
  tennis: ['rating'],
  volleyball: ['rating'],
} as const;

const competitionCount = CATALOG_CATEGORIES.reduce((n, c) => n + c.competitions.length, 0);

function seededCompetition(sport: string, slug: string) {
  for (const category of CATALOG_CATEGORIES) {
    if (category.sport !== sport) continue;
    const competition = category.competitions.find((c) => c.slug === slug);
    if (competition) return { category, competition };
  }
  throw new Error(`no seeded competition ${sport}/${slug}`);
}

async function competitionRow(sport: string, slug: string) {
  const [row] = await handle.db
    .select()
    .from(competitions)
    .where(and(eq(competitions.sportId, sport), eq(competitions.slug, slug)));
  if (!row) throw new Error(`competition ${sport}/${slug} not found`);
  return row;
}

async function teamRow(sport: string, shortName: string) {
  const [row] = await handle.db
    .select()
    .from(teams)
    .where(and(eq(teams.sportId, sport), eq(teams.shortName, shortName)));
  if (!row) throw new Error(`team ${sport}/${shortName} not found`);
  return row;
}

async function snapshot() {
  const [s, c, k, t] = await Promise.all([
    handle.db.select().from(sports).orderBy(asc(sports.id)),
    handle.db.select().from(categories).orderBy(asc(categories.sportId), asc(categories.slug)),
    handle.db
      .select()
      .from(competitions)
      .orderBy(asc(competitions.sportId), asc(competitions.slug)),
    handle.db.select().from(teams).orderBy(asc(teams.sportId), asc(teams.shortName)),
  ]);
  return { sports: s, categories: c, competitions: k, teams: t };
}

describe('catalogue reference data', () => {
  it('has unique natural keys and pools made of seeded teams of the same sport', () => {
    const teamKeys = CATALOG_TEAMS.map((team) => `${team.sport}/${team.shortName}`);
    expect(new Set(teamKeys).size).toBe(teamKeys.length);
    const categoryKeys = CATALOG_CATEGORIES.map((c) => `${c.sport}/${c.slug}`);
    expect(new Set(categoryKeys).size).toBe(categoryKeys.length);
    // Feed pools are keyed by slug alone, so slugs are unique across sports.
    const slugs = CATALOG_CATEGORIES.flatMap((c) => c.competitions.map((k) => k.slug));
    expect(new Set(slugs).size).toBe(slugs.length);

    for (const category of CATALOG_CATEGORIES) {
      for (const competition of category.competitions) {
        expect(new Set(competition.teams).size).toBe(competition.teams.length);
        for (const shortName of competition.teams) {
          expect(teamKeys).toContain(`${category.sport}/${shortName}`);
        }
      }
    }
  });

  it('gives every team positive ratings with the keys its sport is priced on', () => {
    for (const team of CATALOG_TEAMS) {
      expect(Object.keys(team.ratings).sort()).toEqual([...RATING_KEYS[team.sport]]);
      for (const value of Object.values(team.ratings)) {
        expect(Number.isFinite(value) && value > 0).toBe(true);
      }
    }
    const rating = (shortName: string, key: string) =>
      CATALOG_TEAMS.find((team) => team.shortName === shortName)?.ratings[key];
    // Stronger clubs attack above and concede below the league average.
    expect(rating('Liverpool', 'attack')).toBeGreaterThan(1);
    expect(rating('Liverpool', 'defence')).toBeLessThan(1);
    expect(rating('Bayern', 'attack')).toBeGreaterThan(rating('Union Berlin', 'attack') ?? 0);
    expect(rating('St George', 'defence')).toBeLessThan(1);
    expect(rating('Burnley', 'attack')).toBeLessThan(1);
    expect(rating('Burnley', 'defence')).toBeGreaterThan(1);
  });
});

describe('seedCatalog', () => {
  it('is part of seed(): an empty database gets the whole catalogue', async () => {
    await seed(handle.db);
    const counts = await handle.db
      .select({
        sports: sql<number>`(SELECT count(*)::int FROM ${sports})`,
        categories: sql<number>`(SELECT count(*)::int FROM ${categories})`,
        competitions: sql<number>`(SELECT count(*)::int FROM ${competitions})`,
        teams: sql<number>`(SELECT count(*)::int FROM ${teams})`,
      })
      .from(sql`(SELECT 1) AS one`);
    expect(counts[0]).toEqual({
      sports: 4,
      categories: CATALOG_CATEGORIES.length,
      competitions: competitionCount,
      teams: CATALOG_TEAMS.length,
    });
  });

  it('is idempotent: a second run creates and changes nothing', async () => {
    const before = await snapshot();
    expect(await seedCatalog(handle.db)).toEqual({
      sportsCreated: 0,
      categoriesCreated: 0,
      competitionsCreated: 0,
      teamsCreated: 0,
      rowsUpdated: 0,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('seeds the four sports with Amharic names in display order', async () => {
    const rows = await handle.db.select().from(sports).orderBy(asc(sports.sortOrder));
    expect(rows.map((row) => [row.id, row.name.am, row.active])).toEqual([
      ['football', 'እግር ኳስ', true],
      ['basketball', 'የቅርጫት ኳስ', true],
      ['tennis', 'ቴኒስ', true],
      ['volleyball', 'የመረብ ኳስ', true],
    ]);
    expect(CATALOG_SPORTS.map((sport) => sport.id)).toEqual(rows.map((row) => row.id));
  });

  it('marks the featured competitions', async () => {
    const rows = await handle.db
      .select({ sportId: competitions.sportId, slug: competitions.slug })
      .from(competitions)
      .where(and(eq(competitions.featured, true), eq(competitions.sportId, 'football')))
      .orderBy(asc(competitions.slug));
    expect(rows.map((row) => row.slug)).toEqual([
      'ethiopian-premier-league',
      'laliga',
      'premier-league',
      'primera-division',
      'serie-a',
      'uefa-champions-league',
    ]);
    const epl = await competitionRow('football', 'ethiopian-premier-league');
    expect(epl.name).toEqual({ en: 'Ethiopian Premier League', am: 'የኢትዮጵያ ፕሪምየር ሊግ' });
    for (const slug of ['bundesliga', 'ligue-1', 'caf-champions-league', 'caf-confederation-cup']) {
      expect((await competitionRow('football', slug)).featured).toBe(false);
    }
    for (const [sport, slug] of [
      ['basketball', 'nba'],
      ['tennis', 'atp-tour'],
      ['volleyball', 'volleyball-nations-league'],
    ] as const) {
      expect((await competitionRow(sport, slug)).active).toBe(true);
    }
  });

  it('seeds the team pools the mock feed needs', async () => {
    const feed = await loadFeedTeams(handle.db);
    const pool = (slug: string) => feed.teams[slug] ?? [];

    expect(pool('premier-league')).toHaveLength(23);
    // The clubs promoted for 2026-27, with the modest starting ratings of the other seeded clubs.
    for (const [short, attack, defence] of [
      ['Coventry', 0.88, 1.12],
      ['Hull', 0.82, 1.18],
      ['Ipswich', 0.86, 1.14],
    ] as const) {
      expect(pool('premier-league').find((t) => t.shortName === short)?.ratings).toEqual({
        attack,
        defence,
      });
    }
    for (const slug of ['laliga', 'serie-a', 'bundesliga', 'ligue-1']) {
      expect(pool(slug).length).toBeGreaterThanOrEqual(12);
    }
    expect(pool('nba').length).toBeGreaterThanOrEqual(12);
    expect(pool('atp-tour').length).toBeGreaterThanOrEqual(12);
    expect(pool('volleyball-nations-league').length).toBeGreaterThanOrEqual(8);

    const caf = new Set(
      [...pool('caf-champions-league'), ...pool('caf-confederation-cup')].map((t) => t.shortName),
    );
    for (const club of [
      'Al Ahly',
      'Wydad',
      'Sundowns',
      'Esperance',
      'Zamalek',
      'TP Mazembe',
      'Simba SC',
      'Young Africans',
    ]) {
      expect(caf).toContain(club);
    }

    const ethiopian = pool('ethiopian-premier-league');
    expect(ethiopian).toHaveLength(16);
    const rows = await handle.db
      .select()
      .from(teams)
      .where(and(eq(teams.sportId, 'football'), eq(teams.countryCode, 'ET')));
    expect(rows).toHaveLength(16);
    for (const row of rows) {
      expect(row.name.am).toMatch(ETHIOPIC);
      expect(row.name.en).not.toMatch(ETHIOPIC);
    }
    expect((await teamRow('football', 'St George')).name).toEqual({
      en: 'Saint George',
      am: 'ቅዱስ ጊዮርጊስ',
    });
    expect((await teamRow('football', 'Mekelle 70')).name.am).toBe('መቐለ 70 እንደርታ');
  });

  it('seeds the Costa Rican top division first, with the ten Apertura 2026 clubs and neutral ratings', async () => {
    const [first] = await handle.db
      .select()
      .from(categories)
      .where(eq(categories.sportId, 'football'))
      .orderBy(asc(categories.sortOrder))
      .limit(1);
    expect(first).toMatchObject({
      slug: 'costa-rica',
      countryCode: 'CR',
      name: { en: 'Costa Rica' },
    });
    const primera = await competitionRow('football', 'primera-division');
    expect(primera).toMatchObject({
      name: { en: 'Primera División' },
      featured: true,
      active: true,
      categoryId: first!.id,
    });

    const feed = await loadFeedTeams(handle.db);
    const pool = feed.teams['primera-division'] ?? [];
    expect(pool.map((t) => t.shortName).sort()).toEqual(
      [
        'Alajuelense',
        'Cartaginés',
        'Escorpiones',
        'Herediano',
        'Inter San Carlos',
        'Pérez Zeledón',
        'Puntarenas',
        'San Carlos',
        'Saprissa',
        'Sporting CR',
      ].sort(),
    );
    const rows = await handle.db
      .select()
      .from(teams)
      .where(and(eq(teams.sportId, 'football'), eq(teams.countryCode, 'CR')));
    expect(rows).toHaveLength(10);
    // Neutral and uncalibrated (rule O1): no `matches`, no `manual`.
    for (const row of rows) expect(row.ratings).toEqual({ attack: 1, defence: 1 });
    expect((await teamRow('football', 'Pérez Zeledón')).name).toEqual({
      en: 'Municipal Pérez Zeledón',
    });
    const unverified = await handle.db
      .select({ shortName: teams.shortName })
      .from(teams)
      .where(sql`${teams.shortName} ILIKE '%liberia%' OR ${teams.shortName} ILIKE '%guadalupe%'`);
    expect(unverified).toEqual([]);
  });

  it('keeps back-office edits and refreshes only what the seed owns', async () => {
    const premier = await competitionRow('football', 'premier-league');
    await handle.db
      .update(competitions)
      .set({ featured: false, sortOrder: 99, active: false, name: { en: 'EPL (typo)' } })
      .where(eq(competitions.id, premier.id));
    const liverpool = await teamRow('football', 'Liverpool');
    await handle.db
      .update(teams)
      .set({ ratings: { attack: 2, defence: 0.5 } })
      .where(eq(teams.id, liverpool.id));
    const sinner = await teamRow('tennis', 'Sinner');
    await handle.db.update(teams).set({ ratings: null }).where(eq(teams.id, sinner.id));
    const nba = await competitionRow('basketball', 'nba');
    await handle.db
      .update(sports)
      .set({ active: false, sortOrder: 7 })
      .where(eq(sports.id, 'tennis'));

    expect(await seedCatalog(handle.db)).toEqual({
      sportsCreated: 0,
      categoriesCreated: 0,
      competitionsCreated: 0,
      teamsCreated: 0,
      rowsUpdated: 2,
    });

    expect(await competitionRow('football', 'premier-league')).toEqual({
      ...premier,
      featured: false,
      sortOrder: 99,
      active: false,
    });
    expect((await teamRow('football', 'Liverpool')).ratings).toEqual({ attack: 2, defence: 0.5 });
    expect((await teamRow('tennis', 'Sinner')).ratings).toEqual(
      CATALOG_TEAMS.find((team) => team.shortName === 'Sinner')?.ratings,
    );
    expect(await competitionRow('basketball', 'nba')).toEqual(nba);
    const [tennis] = await handle.db.select().from(sports).where(eq(sports.id, 'tennis'));
    expect(tennis).toMatchObject({ active: false, sortOrder: 7 });

    // Restore for the tests below.
    await handle.db
      .update(competitions)
      .set({ featured: true, sortOrder: premier.sortOrder, active: true })
      .where(eq(competitions.id, premier.id));
    await handle.db
      .update(sports)
      .set({ active: true, sortOrder: 30 })
      .where(eq(sports.id, 'tennis'));
  });

  it('restores deleted rows and is safe to run concurrently', async () => {
    const before = await snapshot();
    const volleyball = await handle.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.sportId, 'volleyball'), eq(teams.shortName, 'Cuba')));
    await handle.db.delete(teams).where(eq(teams.id, volleyball[0]!.id));

    const results = await Promise.all([
      seedCatalog(handle.db),
      seedCatalog(handle.db),
      seedCatalog(handle.db),
    ]);
    expect(results.reduce((n, r) => n + r.teamsCreated, 0)).toBe(1);
    for (const result of results) {
      expect(result).toMatchObject({ sportsCreated: 0, competitionsCreated: 0, rowsUpdated: 0 });
    }
    const after = await snapshot();
    expect(after.teams).toHaveLength(before.teams.length);
    expect(after.competitions).toEqual(before.competitions);
  });
});

describe('loadFeedTeams', () => {
  it('lists every seeded competition with its pool, in catalogue order', async () => {
    const feed = await loadFeedTeams(handle.db);
    expect(feed.competitions.map((c) => `${c.sport}/${c.slug}`)).toEqual(
      CATALOG_SPORTS.flatMap((sport) =>
        CATALOG_CATEGORIES.filter((category) => category.sport === sport.id).flatMap((category) =>
          // Cups and the competitions without a club list (pool of fewer than two) have no
          // fixtures to draw: the mock feed leaves them out.
          category.competitions
            .filter((competition) => competition.teams.length >= 2)
            .map((competition) => `${sport.id}/${competition.slug}`),
        ),
      ),
    );
    for (const competition of feed.competitions) {
      const { competition: seeded } = seededCompetition(competition.sport, competition.slug);
      expect(competition.featured).toBe(seeded.featured);
      expect(feed.teams[competition.slug]?.map((t) => t.shortName)).toEqual(seeded.teams);
    }
    const ucl = feed.teams['uefa-champions-league'] ?? [];
    expect(ucl.find((t) => t.shortName === 'Real Madrid')?.ratings).toEqual(
      CATALOG_TEAMS.find((t) => t.shortName === 'Real Madrid')?.ratings,
    );
  });

  it('uses current ratings, defaults for unusable ones, and skips what cannot be priced', async () => {
    const liverpool = await teamRow('football', 'Liverpool');
    const arsenal = await teamRow('football', 'Arsenal');
    await handle.db
      .update(teams)
      .set({ ratings: { attack: 1.7, defence: 0.7 } })
      .where(eq(teams.id, liverpool.id));
    await handle.db.update(teams).set({ ratings: null }).where(eq(teams.id, arsenal.id));
    await handle.db
      .update(competitions)
      .set({ active: false })
      .where(and(eq(competitions.sportId, 'football'), eq(competitions.slug, 'ligue-1')));
    await handle.db.update(sports).set({ active: false }).where(eq(sports.id, 'volleyball'));

    // A competition added in the back office: its pool comes from the category's country.
    const england = await handle.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.sportId, 'football'), eq(categories.slug, 'england')));
    const africa = await handle.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.sportId, 'football'), eq(categories.slug, 'africa')));
    await handle.db.insert(competitions).values([
      {
        sportId: 'football',
        categoryId: england[0]!.id,
        slug: 'community-shield',
        name: { en: 'Community Shield' },
      },
      // No country on the category and no seeded pool: nothing to draw fixtures from.
      {
        sportId: 'football',
        categoryId: africa[0]!.id,
        slug: 'caf-super-cup',
        name: { en: 'CAF Super Cup' },
      },
    ]);

    const feed = await loadFeedTeams(handle.db);
    const premier = feed.teams['premier-league'] ?? [];
    expect(premier.find((t) => t.shortName === 'Liverpool')?.ratings).toEqual({
      attack: 1.7,
      defence: 0.7,
    });
    expect(premier.find((t) => t.shortName === 'Arsenal')?.ratings).toEqual(
      DEFAULT_TEAM_RATINGS.football,
    );
    expect(feed.teams['community-shield']?.map((t) => t.shortName).sort()).toEqual(
      CATALOG_TEAMS.filter((t) => t.countryCode === 'GB-ENG')
        .map((t) => t.shortName)
        .sort(),
    );
    expect(feed.competitions.find((c) => c.slug === 'community-shield')).toEqual({
      slug: 'community-shield',
      sport: 'football',
      featured: false,
    });
    const slugs = feed.competitions.map((c) => c.slug);
    expect(slugs).not.toContain('ligue-1');
    expect(slugs).not.toContain('volleyball-nations-league');
    expect(slugs).not.toContain('caf-super-cup');
    expect(Object.keys(feed.teams).sort()).toEqual([...slugs].sort());
  });
});
