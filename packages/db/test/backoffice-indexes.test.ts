import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing';

/**
 * The back-office list and dashboard queries have an index of their own:
 * with sequential scans disabled, the plan names it (a full scan of some
 * unrelated index or a sort of the whole table would not).
 */
let handle: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await handle.drop();
});

const FROM = '2026-01-01T00:00:00Z';
const TO = '2026-02-01T00:00:00Z';

async function plan(query: string): Promise<string> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const result = await tx.execute<{ 'QUERY PLAN': string }>(sql.raw(`EXPLAIN ${query}`));
    return result.rows.map((row) => row['QUERY PLAN']).join('\n');
  });
}

describe('back-office indexes', () => {
  it.each([
    [
      'ledger postings in a window (dashboard bet settlements)',
      'ledger_transactions_ref_created_idx',
      `SELECT id FROM ledger_transactions WHERE ref_type = 'bet'
         AND created_at >= '${FROM}' AND created_at < '${TO}'`,
    ],
    [
      'deposits that succeeded in a window',
      'payment_intents_succeeded_idx',
      `SELECT sum(amount) FROM payment_intents WHERE status = 'succeeded'
         AND completed_at IS NOT NULL AND completed_at >= '${FROM}' AND completed_at < '${TO}'`,
    ],
    [
      'withdrawals paid in a window',
      'payouts_paid_idx',
      `SELECT sum(amount) FROM payouts WHERE status = 'paid'
         AND completed_at IS NOT NULL AND completed_at >= '${FROM}' AND completed_at < '${TO}'`,
    ],
    [
      'jackpot entries placed in a window',
      'jackpot_entries_placed_idx',
      `SELECT sum(cost) FROM jackpot_entries WHERE placed_at >= '${FROM}' AND placed_at < '${TO}'`,
    ],
    [
      'jackpot entries settled in a window',
      'jackpot_entries_settled_idx',
      `SELECT sum(cost) FROM jackpot_entries WHERE status IN ('won', 'lost', 'void')
         AND settled_at IS NOT NULL AND settled_at >= '${FROM}' AND settled_at < '${TO}'`,
    ],
    [
      'players registered in a window',
      'users_created_idx',
      `SELECT count(*) FROM users WHERE created_at >= '${FROM}' AND created_at < '${TO}'`,
    ],
  ])('%s', async (_name, index, query) => {
    expect(await plan(query)).toContain(index);
  });

  it.each([
    [
      'the player list, newest first',
      'users_created_idx',
      'SELECT id FROM users ORDER BY created_at DESC, id DESC LIMIT 26',
    ],
    [
      'every withdrawal, newest first',
      'payouts_requested_idx',
      'SELECT id FROM payouts ORDER BY requested_at DESC, id DESC LIMIT 26',
    ],
    [
      'the next page of players (keyset cursor)',
      'users_created_idx',
      `SELECT id FROM users WHERE (created_at, id) < ('${TO}', '00000000-0000-0000-0000-000000000000')
         ORDER BY created_at DESC, id DESC LIMIT 26`,
    ],
  ])('%s reads an index in order', async (_name, index, query) => {
    const text = await plan(query);
    expect(text).toContain(index);
    expect(text).not.toMatch(/\bSort\b/);
  });
});
