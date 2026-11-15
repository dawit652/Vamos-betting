import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Deletes the key only if it still holds our token (the lock may have expired and moved on). */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export interface RedisLock {
  key: string;
  token: string;
  /** Releases the lock; false when it had already expired (or was taken over). */
  release(): Promise<boolean>;
}

/**
 * Takes a short-lived exclusive lock (SET key token NX PX ttl), or returns
 * null when another holder has it. The TTL bounds how long a crashed holder
 * blocks others; keep the protected work well below it.
 */
export async function tryLock(redis: Redis, key: string, ttlMs: number): Promise<RedisLock | null> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError(`lock ttl must be a positive integer (ms), got ${ttlMs}`);
  }
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;
  return {
    key,
    token,
    release: async () => (await redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1,
  };
}
