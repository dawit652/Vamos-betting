import type { DbExecutor } from '../ledger/types';
import type { operatingMode } from '../schema/enums';
import { databaseIdentity } from '../schema/platform';

export type DatabaseOperatingMode = (typeof operatingMode.enumValues)[number];

/**
 * The database belongs to another operating mode than the one configured, or
 * it cannot be marked licensed because it holds play money or identity
 * checks made by the mock KYC provider. The process must refuse to start.
 */
export class OperatingModeMismatchError extends Error {
  constructor(
    readonly configured: DatabaseOperatingMode,
    /** The mode recorded in the database; null when none was recorded yet. */
    readonly recorded: DatabaseOperatingMode | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OperatingModeMismatchError';
  }
}

/** The operating mode recorded for this database, or null when none was claimed yet. */
export async function getDatabaseOperatingMode(
  exec: DbExecutor,
): Promise<DatabaseOperatingMode | null> {
  const [row] = await exec
    .select({ mode: databaseIdentity.operatingMode })
    .from(databaseIdentity)
    .limit(1);
  return row?.mode ?? null;
}

/** SQLSTATE and message of the Postgres error along a driver/ORM cause chain. */
function postgresError(error: unknown): { code: string; message: string } | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && typeof message === 'string') return { code, message };
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

function mismatch(configured: DatabaseOperatingMode, recorded: DatabaseOperatingMode) {
  return new OperatingModeMismatchError(
    configured,
    recorded,
    `this database belongs to ${recorded} mode and cannot be used in ${configured} mode. ` +
      `Use a separate database for ${configured} mode.`,
  );
}

/**
 * Records `mode` as the database's operating mode on first use, or checks that
 * it matches the mode already recorded (the record can never change). Call it
 * at startup, before serving, from every process that touches the database
 * (API, worker, seed).
 *
 * Throws OperatingModeMismatchError when the database belongs to the other mode,
 * or when an unmarked database is claimed for licensed mode while it holds
 * play money (demo top-ups, a demo funding balance) or mock identity checks.
 * The database enforces this too (see migration 0003).
 */
export async function claimOperatingMode(
  exec: DbExecutor,
  mode: DatabaseOperatingMode,
): Promise<{ mode: DatabaseOperatingMode; claimed: boolean }> {
  const recorded = await getDatabaseOperatingMode(exec);
  if (recorded !== null) {
    if (recorded !== mode) throw mismatch(mode, recorded);
    return { mode, claimed: false };
  }

  let inserted: Array<{ mode: DatabaseOperatingMode }>;
  try {
    // A savepoint (or transaction), so a refused claim leaves the caller's transaction usable.
    inserted = await exec.transaction((tx) =>
      tx
        .insert(databaseIdentity)
        .values({ operatingMode: mode })
        .onConflictDoNothing({ target: databaseIdentity.id })
        .returning({ mode: databaseIdentity.operatingMode }),
    );
  } catch (error) {
    const pg = postgresError(error);
    if (pg?.code === '23001') {
      throw new OperatingModeMismatchError(mode, null, pg.message, { cause: error });
    }
    throw error;
  }
  if (inserted.length > 0) return { mode, claimed: true };

  // Another process claimed the database at the same time.
  const raced = await getDatabaseOperatingMode(exec);
  if (raced !== mode) throw mismatch(mode, raced ?? mode);
  return { mode, claimed: false };
}
