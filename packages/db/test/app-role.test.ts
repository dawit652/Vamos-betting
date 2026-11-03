import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { APP_ROLE, setAppRolePassword } from '../src/app-role';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

/**
 * Phase 12 security review I1: the api and worker must not connect as a
 * superuser or the table owner, who can switch the append-only triggers off
 * (`SET session_replication_role = replica`) and rewrite the ledger. They
 * use the `vamos_app` role the migrations create.
 */
let handle: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  handle = await createTestDatabase();
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
  (await handle.db.execute(query)).rows;

/** Runs `query` as the app role (SET LOCAL ROLE in a transaction) and returns the error, if any. */
async function asAppRole(query: string): Promise<{ code?: string; message: string } | null> {
  try {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
      await tx.execute(sql.raw(query));
      throw new Error('__rollback__');
    });
  } catch (error) {
    const err = error as {
      code?: string;
      message: string;
      cause?: { code?: string; message: string };
    };
    if (err.message === '__rollback__') return null;
    return err.cause ?? err;
  }
  return null;
}

describe('the app role', () => {
  it('exists without superuser, owner or bypass powers', async () => {
    const [role] = await rows(sql`
      SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolinherit
      FROM pg_roles WHERE rolname = ${APP_ROLE}`);
    expect(role).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
      rolinherit: false,
    });
    const owned = await rows(sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = ${APP_ROLE}`);
    expect(owned).toEqual([]);
  });

  it('cannot UPDATE ledger_entries, not even after SET session_replication_role', async () => {
    const replica = await asAppRole('SET LOCAL session_replication_role = replica');
    expect(replica?.code).toBe('42501'); // insufficient_privilege
    for (const statement of [
      'UPDATE ledger_entries SET amount = amount',
      'DELETE FROM ledger_entries',
      'UPDATE audit_log SET action = action',
      'TRUNCATE ledger_entries',
    ]) {
      const error = await asAppRole(statement);
      expect(error?.code, statement).toBe('42501');
      expect(error?.message, statement).toMatch(/permission denied/);
    }
    // What the app does every day still works.
    expect(await asAppRole('SELECT count(*) FROM ledger_entries')).toBeNull();
    expect(await asAppRole('UPDATE users SET updated_at = updated_at')).toBeNull();
  });

  it('has no UPDATE/DELETE/TRUNCATE where a trigger makes a table append-only', async () => {
    // Every BEFORE UPDATE/DELETE trigger that calls vamos_reject_mutation, read from the catalog,
    // so a new append-only table without a matching REVOKE fails here.
    const guarded = await rows(sql`
      SELECT c.relname AS table,
             (t.tgtype & 16) <> 0 AS on_update,
             (t.tgtype & 8) <> 0 AS on_delete
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname = 'vamos_reject_mutation' AND NOT t.tgisinternal AND (t.tgtype & 1) = 1`);
    expect(guarded.length).toBeGreaterThan(10);
    for (const row of guarded) {
      const table = row.table as string;
      const [privileges] = await rows(sql`
        SELECT has_table_privilege(${APP_ROLE}, ${`public.${table}`}, 'UPDATE') AS can_update,
               has_table_privilege(${APP_ROLE}, ${`public.${table}`}, 'DELETE') AS can_delete`);
      if (row.on_update) expect(privileges?.can_update, `${table} UPDATE`).toBe(false);
      if (row.on_delete) expect(privileges?.can_delete, `${table} DELETE`).toBe(false);
    }
    const tables = await rows(sql`
      SELECT tablename,
             has_table_privilege(${APP_ROLE}, 'public.' || tablename, 'SELECT') AS can_select,
             has_table_privilege(${APP_ROLE}, 'public.' || tablename, 'INSERT') AS can_insert,
             has_table_privilege(${APP_ROLE}, 'public.' || tablename, 'TRUNCATE') AS can_truncate
      FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables.length).toBeGreaterThan(40);
    for (const table of tables) {
      expect(table, String(table.tablename)).toMatchObject({
        can_select: true,
        can_insert: true,
        can_truncate: false,
      });
    }
  });

  it('logs in with the password the migrate job sets (APP_DB_PASSWORD)', async () => {
    await expect(setAppRolePassword(handle.db, 'short')).rejects.toThrow(/16 to 200/);
    const password = `${randomBytes(12).toString('hex')}'x`;
    await setAppRolePassword(handle.db, password);
    const app = handle.openPool({ max: 1, user: APP_ROLE, password });
    try {
      const result = await app.db.execute(sql`SELECT current_user AS user`);
      expect(result.rows[0]).toEqual({ user: APP_ROLE });
      await expect(
        app.db.execute(sql`UPDATE ledger_entries SET amount = amount`),
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
