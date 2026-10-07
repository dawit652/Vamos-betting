import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies all pending migrations. Returns false when no migrations exist yet. */
export async function runMigrations(
  db: Database,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<boolean> {
  if (!existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    return false;
  }
  await migrate(db, { migrationsFolder });
  return true;
}
