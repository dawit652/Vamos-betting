import { eq, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { settings } from '../schema/platform';
import { toJsonSafe } from './json';

/**
 * Raw jsonb value of a back-office setting, or undefined when it is not set.
 * The value is read as text and parsed here, so a stored JSON string such as
 * "123" stays a string (the jsonb column mapper would turn it into a number).
 */
export async function getSetting<T>(exec: DbExecutor, key: string): Promise<T | undefined> {
  const [row] = await exec
    .select({ value: sql<string>`${settings.value}::text` })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

/** Creates or replaces a setting. bigint / Date values are stored as strings. */
export async function setSetting(
  exec: DbExecutor,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  const json = toJsonSafe(value);
  if (json === undefined) {
    throw new TypeError(`setting ${key} has no JSON representation`);
  }
  await exec
    .insert(settings)
    .values({ key, value: json, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: json, updatedAt: sql`now()`, updatedBy: updatedBy ?? null },
    });
}
