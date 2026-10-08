import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import type { Database } from '../src/client';
import { postTransaction, type AccountRef, type PostingResult } from '../src/ledger/index';
import { users } from '../src/schema/index';

let phoneCounter = 0;

/** Inserts a minimal active player and returns its id. */
export async function createUser(db: Database): Promise<string> {
  phoneCounter += 1;
  const digits = `${randomInt(1_000, 9_999)}${String(phoneCounter).padStart(4, '0')}`;
  const [row] = await db
    .insert(users)
    .values({
      phone: `+2519${digits}`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
}

export const cash = (userId: string): AccountRef => ({ kind: 'player_cash', userId });
export const bonus = (userId: string): AccountRef => ({ kind: 'player_bonus', userId });

let keyCounter = 0;
export function uniqueKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}:${Date.now()}:${keyCounter}:${randomInt(1_000_000)}`;
}

/** Credits play money to a player's cash account from the demo funding account. */
export async function fund(db: Database, userId: string, amount: bigint): Promise<PostingResult> {
  return db.transaction((tx) =>
    postTransaction(tx, {
      type: 'demo_topup',
      idempotencyKey: uniqueKey('topup'),
      entries: [
        { account: { kind: 'house_demo_funding' }, amount: -amount },
        { account: cash(userId), amount },
      ],
    }),
  );
}

/** Postgres SQLSTATE of an error, looking through driver/ORM wrappers. */
export function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** All messages along an error's cause chain, for assertions on DB errors. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (e instanceof Error) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drops a test database. `pool.end()` resolves before its idle clients have
 * finished disconnecting, so `DROP DATABASE … WITH (FORCE)` can terminate a
 * client mid-shutdown and its idle error listener re-emits that FATAL on the
 * pool; with no pool 'error' listener that becomes an uncaught exception.
 */
export async function dropTestDatabase(
  handle: { pool: Pool; drop: () => Promise<void> } | undefined,
) {
  if (!handle) return;
  handle.pool.on('error', () => undefined);
  await handle.drop();
}
