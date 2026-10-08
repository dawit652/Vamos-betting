import { randomInt as cryptoRandomInt } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { events } from '../schema/catalog';
import { CatalogError } from './errors';

/**
 * Betika-style numeric Game IDs, printed on every fixture so customers can
 * bet by SMS/USSD ("4821#1#50").
 *
 * IDs are random 4–5 digit numbers (1000–99999), so they are short to type
 * and do not reveal how many fixtures exist. When random draws keep landing
 * on taken numbers the range is considered crowded and 6-digit IDs
 * (100000–999999) are handed out instead.
 *
 * Product rule: an ID must not be in use by an event that is scheduled or
 * live, or that started within the last 7 days (customers still quote those).
 * `events.game_id` is currently UNIQUE across all events, so an ID is never
 * reused at all and the check below covers every event, a superset of that
 * rule. Freeing old IDs needs a schema change (e.g. a unique index over
 * recent events only) and then narrowing `usedAmong` to recent events.
 *
 * Concurrent allocators can still pick the same free number; the insert then
 * fails on `events_game_id_unique` and the caller retries (see upsertFixture).
 */

export const GAME_ID_RANGE = Object.freeze({ min: 1000, max: 99_999 });
export const GAME_ID_FALLBACK_RANGE = Object.freeze({ min: 100_000, max: 999_999 });
/** Name of the unique constraint on events.game_id (migration 0004). */
export const GAME_ID_CONSTRAINT = 'events_game_id_unique';

const CANDIDATES_PER_BATCH = 24;
/** Batches of draws per range before it counts as crowded. */
const BATCHES_PER_RANGE = 3;

export interface AllocateGameIdOptions {
  /** Uniform random integer in [min, maxExclusive). Defaults to crypto.randomInt. */
  randomInt?: (min: number, maxExclusive: number) => number;
  /** Numbers that must not be returned (e.g. one that just lost an insert race). */
  exclude?: ReadonlySet<number>;
}

/** Returns a Game ID no event uses yet (see the module notes). */
export async function allocateGameId(
  exec: DbExecutor,
  options: AllocateGameIdOptions = {},
): Promise<number> {
  const random = options.randomInt ?? cryptoRandomInt;
  for (const range of [GAME_ID_RANGE, GAME_ID_FALLBACK_RANGE]) {
    for (let batch = 0; batch < BATCHES_PER_RANGE; batch++) {
      const candidates = new Set<number>();
      for (let i = 0; i < CANDIDATES_PER_BATCH; i++) {
        const candidate = random(range.min, range.max + 1);
        if (!Number.isSafeInteger(candidate) || candidate < range.min || candidate > range.max) {
          throw new RangeError(
            `randomInt returned ${candidate}, outside ${range.min}..${range.max}`,
          );
        }
        if (options.exclude?.has(candidate) !== true) candidates.add(candidate);
      }
      if (candidates.size === 0) continue;
      const used = await usedAmong(exec, [...candidates]);
      for (const candidate of candidates) {
        if (!used.has(candidate)) return candidate;
      }
    }
  }
  throw new CatalogError('no free game id: every random draw was already taken');
}

async function usedAmong(exec: DbExecutor, candidates: number[]): Promise<Set<number>> {
  const rows = await exec
    .select({ gameId: events.gameId })
    .from(events)
    .where(inArray(events.gameId, candidates));
  return new Set(rows.map((row) => row.gameId));
}
