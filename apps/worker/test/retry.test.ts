import type { Database } from '@vamos/db';
import { describe, expect, it } from 'vitest';
import { isRetryableTxError, pgCode, withTxRetry } from '../src/lib/retry';

/** A Database whose transaction() runs `fn` with a dummy tx, failing the first `failures` calls. */
function flakyDb(failures: Error[]) {
  let calls = 0;
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      calls += 1;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return fn({});
    },
  } as unknown as Database;
  return { db, calls: () => calls };
}

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
/** Drizzle wraps driver errors: the SQLSTATE is on the cause. */
const wrapped = (code: string) => new Error('Failed query', { cause: pgError(code) });

describe('withTxRetry', () => {
  it('finds the SQLSTATE through wrappers', () => {
    expect(pgCode(wrapped('40P01'))).toBe('40P01');
    expect(pgCode(new Error('plain'))).toBeUndefined();
    expect(isRetryableTxError(wrapped('40001'))).toBe(true);
    expect(isRetryableTxError(pgError('23505'))).toBe(false);
  });

  it('retries deadlocks and serialization failures, then succeeds', async () => {
    const flaky = flakyDb([wrapped('40P01'), pgError('40001')]);
    const retries: number[] = [];
    const result = await withTxRetry(flaky.db, async () => 'ok', {
      baseDelayMs: 1,
      onRetry: (_error, attempt) => retries.push(attempt),
    });
    expect(result).toBe('ok');
    expect(flaky.calls()).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it('gives up after the last attempt and never retries other errors', async () => {
    const deadlocks = flakyDb([1, 2, 3].map(() => wrapped('40P01')));
    await expect(
      withTxRetry(deadlocks.db, async () => 'ok', { attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow('Failed query');
    expect(deadlocks.calls()).toBe(3);

    const unique = flakyDb([pgError('23505')]);
    await expect(withTxRetry(unique.db, async () => 'ok', { baseDelayMs: 1 })).rejects.toThrow(
      'pg 23505',
    );
    expect(unique.calls()).toBe(1);
  });
});
