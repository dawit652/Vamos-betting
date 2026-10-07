import type { Database } from '../client';

/**
 * Idempotent seed. Reference data (sports, competitions, teams, house ledger
 * accounts, default settings) is added as the schema grows in later phases.
 */
export async function seed(_db: Database): Promise<Record<string, number>> {
  return Promise.resolve({});
}
