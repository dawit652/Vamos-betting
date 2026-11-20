import { countryCodeOfName } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBoardCompetition, fillBoardCategoryCountries } from '../src/scrape/board-events';
import { categories } from '../src/schema/catalog';
import { CATALOG_CATEGORIES, seedCatalog } from '../src/seed/catalog';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

/**
 * Board leagues show their country's flag: new board categories are created with the code of their
 * group's name, and ones created before that are filled in (docs/plans/hulusport-feed.md).
 */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
  await seedCatalog(handle.db);
}, 60_000);

afterAll(async () => {
  await dropTestDatabase(handle);
});

const codeOf = async (slug: string) => {
  const [row] = await handle.db
    .select({ code: categories.countryCode })
    .from(categories)
    .where(eq(categories.slug, slug));
  return row === undefined ? undefined : row.code;
};

const ensure = (leagueKey: string, group: string | null) =>
  handle.db.transaction((tx) =>
    ensureBoardCompetition(tx, { board: 'hulusport', leagueKey, name: `L ${leagueKey}`, group }),
  );

describe('board categories and their country', () => {
  it('knows the country of every football category of the catalogue seed', () => {
    for (const category of CATALOG_CATEGORIES) {
      if (category.countryCode === null || category.sport !== 'football') continue;
      expect(countryCodeOfName(category.name.en), category.name.en).toBe(category.countryCode);
    }
  });

  it('creates a board category with the code of its group', async () => {
    await ensure('t-1', 'Poland');
    await ensure('t-2', 'England Amateur');
    await ensure('t-3', 'International');
    await ensure('t-4', null);
    expect(await codeOf('hl-poland')).toBe('PL');
    expect(await codeOf('hl-england-amateur')).toBe('GB-ENG');
    expect(await codeOf('hl-international')).toBeNull();
    expect(await codeOf('hl-other')).toBeNull();
  });

  it('fills categories created without a code, once, and leaves other names alone', async () => {
    await handle.db
      .update(categories)
      .set({ countryCode: null })
      .where(eq(categories.slug, 'hl-poland'));
    await ensure('t-5', 'Czechia');
    await handle.db
      .update(categories)
      .set({ countryCode: null })
      .where(eq(categories.slug, 'hl-czechia'));
    // A catalogue category without a code is not the board's: untouched.
    const filled = await fillBoardCategoryCountries(handle.db);
    expect(filled).toBe(2);
    expect(await codeOf('hl-poland')).toBe('PL');
    expect(await codeOf('hl-czechia')).toBe('CZ');
    expect(await codeOf('hl-international')).toBeNull();
    expect(await fillBoardCategoryCountries(handle.db)).toBe(0);
  });
});
