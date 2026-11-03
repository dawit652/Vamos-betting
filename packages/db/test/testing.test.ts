import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing';

/**
 * The test database helper itself. `drop` must leave DROP DATABASE … WITH
 * (FORCE) no session of ours to terminate: the FATAL 57P01 it would send an
 * idle client is re-emitted on the pool, an uncaught exception that fails the
 * run although every test passed.
 */

/** On the maintenance database, which no test database's drop terminates. */
let observer: pg.Client;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://vamos:vamos@localhost:5432/vamos');
  url.pathname = '/postgres';
  observer = new pg.Client({ connectionString: url.toString() });
  await observer.connect();
});
afterAll(async () => {
  await observer?.end();
});

const databaseName = (url: string) => new URL(url).pathname.slice(1);

/** Client sessions on `database` (not autovacuum, which may visit a new database). */
async function sessionsOn(database: string): Promise<number> {
  const result = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = $1 AND backend_type = 'client backend'`,
    [database],
  );
  return result.rows[0]!.n;
}

async function exists(database: string): Promise<boolean> {
  const result = await observer.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  return result.rowCount === 1;
}

/** Puts `count` connections to use at once; all are idle again when this resolves. */
async function fill(pool: pg.Pool, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => pool.query('SELECT pg_sleep(0.01)')));
}

describe('createTestDatabase', () => {
  it('close() resolves only once every connection of the pool has closed', async () => {
    const handle = await createTestDatabase();
    const database = databaseName(handle.url);
    const clients = new Set<pg.PoolClient>();
    const disconnected = new Set<pg.PoolClient>();
    handle.pool.on('acquire', (client) => {
      if (clients.has(client)) return;
      clients.add(client);
      client.once('end', () => disconnected.add(client));
    });
    try {
      await fill(handle.pool, 20);
      expect(clients.size).toBe(20);
      expect(await sessionsOn(database)).toBe(20);
      await handle.close();
      // pg-pool's end() on its own resolves before any of its clients has disconnected.
      expect(disconnected.size).toBe(20);
      // PostgreSQL keeps a session's socket open until its backend has exited.
      expect(await sessionsOn(database)).toBe(0);
    } finally {
      await handle.drop();
    }
    expect(await exists(database)).toBe(false);
  });

  it('drop() closes the pools a test opened and left open', async () => {
    const handle = await createTestDatabase();
    const database = databaseName(handle.url);
    const extra = handle.openPool({ max: 3 });
    try {
      await fill(extra.pool, 3);
      await fill(handle.pool, 5);
      expect(await sessionsOn(database)).toBe(handle.pool.totalCount + extra.pool.totalCount);
    } finally {
      await handle.drop();
    }
    expect(handle.pool.ended).toBe(true);
    expect(extra.pool.ended).toBe(true);
    expect(await exists(database)).toBe(false);
  });

  it('ignores only an admin shutdown (57P01) on a pool, and only once the drop has begun', async () => {
    const handle = await createTestDatabase();
    const adminShutdown = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    );
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    // Before the drop it is rethrown, like any error: as it would be with no listener.
    expect(() => handle.pool.emit('error', adminShutdown)).toThrow(adminShutdown);
    const dropping = handle.drop();
    try {
      expect(() => handle.pool.emit('error', adminShutdown)).not.toThrow();
      expect(() => handle.pool.emit('error', reset)).toThrow(reset);
    } finally {
      await dropping;
    }
  });
});
