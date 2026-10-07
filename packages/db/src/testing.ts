import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from './client';
import { runMigrations } from './migrate';

/**
 * Creates an isolated, migrated database for an integration test file and
 * returns a handle plus a `drop` function. Requires a role that may CREATE
 * DATABASE (the local dev role and the CI service both can).
 */
export async function createTestDatabase(
  baseUrl = process.env.DATABASE_URL ?? 'postgres://vamos:vamos@localhost:5432/vamos',
): Promise<DbHandle & { url: string; drop: () => Promise<void> }> {
  const name = `vamos_test_${randomBytes(6).toString('hex')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), { max: 20 });
  await runMigrations(handle.db);

  return {
    ...handle,
    url: url.toString(),
    drop: async () => {
      await handle.close();
      const dropper = new pg.Client({ connectionString: adminUrl.toString() });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
