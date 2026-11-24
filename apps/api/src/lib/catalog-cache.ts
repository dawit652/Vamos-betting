import type { Redis } from 'ioredis';

/**
 * A short-lived cache for public, player-independent answers (the catalogue
 * lists). Design:
 *
 * - Single flight inside the process: concurrent requests for a key that is
 *   not fresh share one refresh, so a cold key costs one database query however
 *   many requests arrive together.
 * - Redis is the shared copy between API processes, so each process does not
 *   have to refresh on its own. We did NOT add a cross-process lock: with N
 *   processes a cold key costs at most N queries per window, which is cheap, and
 *   a lock would add a failure mode (a crashed holder) to the hot path.
 * - Freshness is judged by the injected clock (`at` is stored with the value),
 *   not by Redis TTL alone, so tests move time; the Redis expiry (same window)
 *   only keeps the keyspace clean.
 * - Cache errors are never player errors: every Redis call is bounded by a short
 *   timeout and its failure falls through to the loader.
 */
export interface CatalogCacheOptions {
  redis: Redis;
  clock: () => Date;
  /** Window in seconds; 0 turns the cache off (the loader runs every time). */
  seconds: number;
  /** Longest wait for one Redis call before giving up on it (default 150 ms). */
  redisTimeoutMs?: number;
}

interface Stored {
  at: number;
  body: unknown;
}

const KEY_PREFIX = 'catalog:v1:';

/** A stable key: object keys sorted, undefined dropped, so equal queries give equal keys. */
export function stableKey(parts: Record<string, unknown>): string {
  const entries = Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export class CatalogCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CatalogCacheOptions) {}

  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.options.seconds <= 0) return load();
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const flight = this.refresh(key, load).finally(() => this.inflight.delete(key));
    this.inflight.set(key, flight);
    return flight;
  }

  private async refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
    const windowMs = this.options.seconds * 1000;
    const redisKey = KEY_PREFIX + key;
    const cached = await this.guard(async () => this.options.redis.get(redisKey));
    if (typeof cached === 'string') {
      try {
        const stored = JSON.parse(cached) as Stored;
        const age = this.options.clock().getTime() - stored.at;
        if (age >= 0 && age < windowMs) return stored.body as T;
      } catch {
        // A damaged entry is a miss.
      }
    }
    const startedAt = this.options.clock().getTime();
    const body = await load();
    const value: Stored = { at: startedAt, body };
    await this.guard(async () =>
      this.options.redis.set(redisKey, JSON.stringify(value), 'PX', windowMs),
    );
    return body;
  }

  /** Runs a Redis call with a time limit; any failure or timeout gives undefined. */
  private async guard<R>(call: () => Promise<R>): Promise<R | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.options.redisTimeoutMs ?? 150);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
