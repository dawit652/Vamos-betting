import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * The database role the api and worker connect as in production (Phase 12
 * review I1). Created NOLOGIN by migration 0030 with only the privileges the
 * app needs: no superuser, not the owner of any table, no TRUNCATE, and no
 * UPDATE/DELETE on the append-only tables (ledger, audit log, …), so it can
 * neither rewrite them nor switch their triggers off. Migrations, the seed
 * and the admin CLI run as the owner (POSTGRES_USER).
 */
export const APP_ROLE = 'vamos_app';

/**
 * Lets the app role log in with `password` (the migrate job does this after
 * the migrations when APP_DB_PASSWORD is set, so the secret never sits in a
 * migration file). Run it as the owner or a role with CREATEROLE. The
 * password must be 16 to 200 printable ASCII characters.
 */
export async function setAppRolePassword(db: Database, password: string): Promise<void> {
  if (!/^[\x21-\x7e]{16,200}$/.test(password)) {
    throw new Error('APP_DB_PASSWORD must be 16 to 200 printable ASCII characters (no spaces)');
  }
  // ALTER ROLE takes no bind parameters: a quoted literal (standard_conforming_strings is on).
  const literal = `'${password.replaceAll("'", "''")}'`;
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${literal}`));
}
