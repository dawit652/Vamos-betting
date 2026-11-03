import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from './client';
import { runMigrations } from './migrate';

/**
 * SQLSTATE admin_shutdown: the server ended the session, as DROP DATABASE …
 * WITH (FORCE) does to every session still connected to the database.
 */
const ADMIN_SHUTDOWN = '57P01';

export interface TestDatabase extends DbHandle {
  /** Connection URL of the database. */
  url: string;
  /**
   * Opens another pool on this database (fewer connections, or signed in as
   * another role). Close it when done; `drop` closes it if it is still open.
   */
  openPool(options?: { max?: number; user?: string; password?: string }): DbHandle;
  /** Closes every pool on the database, waits for their connections to close, then drops it. */
  drop(): Promise<void>;
}

/**
 * Creates an isolated, migrated database for an integration test file and
 * returns a handle plus a `drop` function. Requires a role that may CREATE
 * DATABASE (the local dev role and the CI service both can).
 */
export async function createTestDatabase(
  baseUrl = process.env.DATABASE_URL ?? 'postgres://vamos:vamos@localhost:5432/vamos',
): Promise<TestDatabase> {
  const name = `vamos_test_${randomBytes(6).toString('hex')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  await runOnMaintenanceDatabase(adminUrl, `CREATE DATABASE ${name}`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const teardown = { started: false };
  const pools: DbHandle[] = [];
  const open = (poolUrl: URL, max: number): DbHandle => {
    const pool = createTrackedDb(poolUrl.toString(), max, teardown);
    pools.push(pool);
    return pool;
  };
  const handle = open(url, 20);
  await runMigrations(handle.db);

  return {
    ...handle,
    url: url.toString(),
    openPool: ({ max = 10, user, password } = {}) => {
      const poolUrl = new URL(url);
      if (user !== undefined) poolUrl.username = user;
      if (password !== undefined) poolUrl.password = password;
      return open(poolUrl, max);
    },
    drop: async () => {
      teardown.started = true;
      // Leave WITH (FORCE) no session of ours to terminate.
      await Promise.all(pools.map((pool) => pool.close()));
      await runOnMaintenanceDatabase(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/**
 * `createDb`, except that `close` resolves only once every connection of the
 * pool has closed, and the pool has an 'error' listener.
 *
 * pg-pool's `end()` resolves as soon as it has told its idle clients to
 * disconnect, while their sockets are still open, and those clients keep the
 * pool's idle 'error' listener. DROP DATABASE … WITH (FORCE) could then
 * terminate a backend that has not exited yet: its FATAL 57P01 reaches the
 * client, pg-pool re-emits it on the pool, and with no listener that is an
 * uncaught exception. PostgreSQL keeps a session's socket open until its
 * backend has exited, and pg-pool emits 'remove' once a client's socket has
 * closed, so when every client is removed no session of the pool is left.
 */
function createTrackedDb(url: string, max: number, teardown: { started: boolean }): DbHandle {
  const { db, pool } = createDb(url, { max });
  const connected = new Set<pg.PoolClient>();
  let allClosed: (() => void) | undefined;
  pool.on('connect', (client) => connected.add(client));
  pool.on('remove', (client) => {
    connected.delete(client);
    if (connected.size === 0) allClosed?.();
  });
  // Backstop: an idle session that the drop terminated all the same. Any other
  // error is rethrown, as it would be with no listener.
  pool.on('error', (error) => {
    if (teardown.started && (error as { code?: unknown }).code === ADMIN_SHUTDOWN) return;
    throw error;
  });

  const closeAll = async () => {
    await pool.end();
    if (connected.size > 0) {
      await new Promise<void>((resolve) => {
        allClosed = resolve;
      });
    }
  };
  let closing: Promise<void> | undefined;
  return { db, pool, close: () => (closing ??= closeAll()) };
}

/** Runs one statement on the `postgres` maintenance database (CREATE and DROP DATABASE). */
async function runOnMaintenanceDatabase(adminUrl: URL, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
