import type { Database, DbTransaction } from '@vamos/db';

/** SQLSTATEs after which re-running the whole transaction is safe: deadlock, serialization failure. */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** Postgres SQLSTATE of an error, looking through driver / ORM wrappers (error.cause). */
export function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e !== null && e !== undefined && depth < 5; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isRetryableTxError(error: unknown): boolean {
  const code = pgCode(error);
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

export interface TxRetryOptions {
  /** Total tries (default 5). */
  attempts?: number;
  /** Base of the jittered backoff between tries (default 20 ms, doubled each time). */
  baseDelayMs?: number;
  /** Called before each retry (for logging). */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Runs `fn` in its own transaction, retrying the whole transaction when
 * Postgres aborts it with a deadlock (40P01) or serialization failure
 * (40001). `fn` must be safe to re-run (everything it wrote was rolled back).
 */
export async function withTxRetry<T>(
  db: Database,
  fn: (tx: DbTransaction) => Promise<T>,
  options: TxRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      if (attempt >= attempts || !isRetryableTxError(error)) throw error;
      options.onRetry?.(error, attempt);
      const delay = base * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
