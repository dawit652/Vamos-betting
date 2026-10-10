import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOperatingMode,
  getDatabaseOperatingMode,
  OperatingModeMismatchError,
} from '../src/index';
import { databaseIdentity, kycProfiles } from '../src/schema/index';
import { seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { createUser, dropTestDatabase, errorText, fund, pgCode } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** A database that was used in demo mode before modes were recorded. */
describe('operating mode of a database used in demo mode', () => {
  it('starts unrecorded', async () => {
    expect(await getDatabaseOperatingMode(handle.db)).toBeNull();
  });

  it('cannot be claimed for licensed mode while it holds mock identity checks', async () => {
    const userId = await createUser(handle.db);
    await handle.db.insert(kycProfiles).values({ userId, status: 'verified', provider: 'mock' });

    const claim = claimOperatingMode(handle.db, 'licensed');
    await expect(claim).rejects.toBeInstanceOf(OperatingModeMismatchError);
    await expect(claim).rejects.toMatchObject({
      configured: 'licensed',
      recorded: null,
      message: expect.stringMatching(/mock KYC provider/),
    });
    expect(await getDatabaseOperatingMode(handle.db)).toBeNull();
    await handle.db.delete(kycProfiles).where(eq(kycProfiles.userId, userId));
  });

  it('cannot be claimed for licensed mode while it holds play money', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 500_000n);

    await expect(claimOperatingMode(handle.db, 'licensed')).rejects.toMatchObject({
      name: 'OperatingModeMismatchError',
      message: expect.stringMatching(/play money from demo mode/),
    });
    // The database refuses the record itself, whoever writes it.
    const raw = await handle.db
      .insert(databaseIdentity)
      .values({ operatingMode: 'licensed' })
      .catch((e: unknown) => e);
    expect(errorText(raw)).toMatch(/play money from demo mode/);
    expect(pgCode(raw)).toBe('23001');
    expect(await getDatabaseOperatingMode(handle.db)).toBeNull();

    // Seeding for licensed mode is refused the same way.
    await expect(seed(handle.db, { mode: 'licensed' })).rejects.toBeInstanceOf(
      OperatingModeMismatchError,
    );
    expect(await getDatabaseOperatingMode(handle.db)).toBeNull();
  });

  it('is claimed for demo mode once, then only demo mode may use it', async () => {
    expect(await claimOperatingMode(handle.db, 'demo')).toEqual({ mode: 'demo', claimed: true });
    expect(await claimOperatingMode(handle.db, 'demo')).toEqual({ mode: 'demo', claimed: false });
    expect(await getDatabaseOperatingMode(handle.db)).toBe('demo');

    const licensed = claimOperatingMode(handle.db, 'licensed');
    await expect(licensed).rejects.toBeInstanceOf(OperatingModeMismatchError);
    await expect(licensed).rejects.toMatchObject({
      configured: 'licensed',
      recorded: 'demo',
      message: expect.stringMatching(/belongs to demo mode and cannot be used in licensed mode/),
    });

    expect(await seed(handle.db, { mode: 'demo' })).toMatchObject({ houseAccounts: 7 });
    await expect(seed(handle.db, { mode: 'licensed' })).rejects.toBeInstanceOf(
      OperatingModeMismatchError,
    );
  });

  it('keeps the record forever: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    for (const statement of [
      sql`UPDATE database_identity SET operating_mode = 'licensed'`,
      sql`DELETE FROM database_identity`,
      sql`TRUNCATE database_identity`,
    ]) {
      const result = await handle.db.execute(statement).catch((e: unknown) => e);
      expect(errorText(result)).toMatch(/database_identity is append-only/);
    }
    // A second row is impossible too.
    const second = await handle.db
      .insert(databaseIdentity)
      .values({ id: false, operatingMode: 'licensed' })
      .catch((e: unknown) => e);
    expect(pgCode(second)).toBeDefined();
    expect(await getDatabaseOperatingMode(handle.db)).toBe('demo');
  });

  it('settles concurrent claims on one mode', async () => {
    const results = await Promise.all([
      claimOperatingMode(handle.db, 'demo'),
      claimOperatingMode(handle.db, 'demo'),
    ]);
    expect(results.every((r) => r.mode === 'demo' && !r.claimed)).toBe(true);
  });
});
