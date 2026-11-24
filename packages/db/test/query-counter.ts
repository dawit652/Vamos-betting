import type pg from 'pg';
import { createDb, type Database } from '../src/client';

export interface CountedDb {
  /** A Database on its own pool whose every round trip to Postgres is recorded. */
  db: Database;
  /**
   * The SQL text of every statement sent, in order, including `begin`, `savepoint`, `release
   * savepoint`, `commit` and `rollback` (one entry per round trip).
   */
  statements: string[];
  /** Forgets what was recorded so far. */
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * Opens a second pool on the test database that records every statement its clients send, for
 * statement budgets. The drizzle logger misses transaction control statements; this does not.
 */
export function countingDb(url: string): CountedDb {
  const statements: string[] = [];
  const handle = createDb(url, { max: 2 });
  handle.pool.on('connect', (client: pg.PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const [first] = args;
      statements.push(
        typeof first === 'string' ? first : String((first as { text?: unknown }).text),
      );
      return query(...args);
    };
  });
  return {
    db: handle.db,
    statements,
    reset: () => {
      statements.length = 0;
    },
    close: async () => {
      handle.pool.on('error', () => undefined);
      await handle.close();
    },
  };
}
