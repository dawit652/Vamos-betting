import type { Redis } from 'ioredis';
import { sha256Hex } from './crypto';

/**
 * X6b, the failed-login alarm (docs/plans/x6-sign-in-review.md): the per-number login limits stop
 * one number being guessed, but not an attack spread over many numbers (one guess per number) or
 * a flood from one address. Every failed player login is counted in a fixed window, and crossing a
 * threshold writes ONE `error` log line with an `alarm` field per kind and window (the repository's
 * alarm convention, as on the SMS rail). Counting never fails a login: a Redis error is only logged.
 *
 * Kinds:
 * - `login_failures_total`: failed logins in the window, all numbers and addresses together;
 * - `login_failures_numbers`: distinct numbers that failed in the window (spraying);
 * - `login_failures_address`: distinct numbers that failed from ONE address in the window.
 *
 * Numbers are kept as hashes only, with the window's keys expiring after two windows.
 */

export interface LoginAlarmThresholds {
  windowMs: number;
  total: number;
  numbers: number;
  numbersPerAddress: number;
}

/** About 4 failures a minute overall, or 30 numbers, or 10 numbers from one address, in 15 minutes. */
export const DEFAULT_LOGIN_ALARM: LoginAlarmThresholds = {
  windowMs: 15 * 60_000,
  total: 60,
  numbers: 30,
  numbersPerAddress: 10,
};

export type LoginAlarmKind =
  'login_failures_total' | 'login_failures_numbers' | 'login_failures_address';

interface AlarmLog {
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const KEY = 'auth:login-failures';

/**
 * Counts one failed player login (`phone` normalised, or null when the number did not parse;
 * `address` the client's address key) and raises the alarms it crosses. Returns the alarms raised
 * by this call (for tests); each kind is raised once per window.
 */
export async function recordLoginFailure(
  redis: Redis,
  log: AlarmLog | undefined,
  input: { phone: string | null; address: string; now: Date },
  thresholds: LoginAlarmThresholds = DEFAULT_LOGIN_ALARM,
): Promise<LoginAlarmKind[]> {
  const window = Math.floor(input.now.getTime() / thresholds.windowMs);
  const ttlSeconds = Math.ceil((2 * thresholds.windowMs) / 1000);
  const base = `${KEY}:${window}`;
  const addressKey = `${base}:a:${sha256Hex(input.address).slice(0, 32)}`;
  try {
    const multi = redis.multi().incr(`${base}:n`).expire(`${base}:n`, ttlSeconds);
    if (input.phone !== null) {
      const number = sha256Hex(input.phone).slice(0, 32);
      multi
        .sadd(`${base}:p`, number)
        .expire(`${base}:p`, ttlSeconds)
        .sadd(addressKey, number)
        .expire(addressKey, ttlSeconds);
    }
    multi.scard(`${base}:p`).scard(addressKey);
    const results = await multi.exec();
    if (results === null) return [];
    const values = results.map(([error, value]) => {
      if (error) throw error;
      return value;
    });
    const total = Number(values[0]);
    const numbers = Number(values.at(-2));
    const fromAddress = Number(values.at(-1));
    const crossed: Array<[LoginAlarmKind, number, number]> = [];
    if (total >= thresholds.total) crossed.push(['login_failures_total', total, thresholds.total]);
    if (numbers >= thresholds.numbers) {
      crossed.push(['login_failures_numbers', numbers, thresholds.numbers]);
    }
    if (fromAddress >= thresholds.numbersPerAddress) {
      crossed.push(['login_failures_address', fromAddress, thresholds.numbersPerAddress]);
    }
    const raised: LoginAlarmKind[] = [];
    for (const [kind, count, threshold] of crossed) {
      const scope = kind === 'login_failures_address' ? addressKey : base;
      const first = await redis.set(`${scope}:alarm:${kind}`, '1', 'EX', ttlSeconds, 'NX');
      if (first !== 'OK') continue;
      raised.push(kind);
      log?.error(
        {
          alarm: kind,
          count,
          threshold,
          windowMinutes: thresholds.windowMs / 60_000,
          ...(kind === 'login_failures_address' ? { address: input.address } : {}),
        },
        'many failed player logins: someone may be guessing PINs',
      );
    }
    return raised;
  } catch (err) {
    log?.warn({ err }, 'could not count a failed login for the alarm');
    return [];
  }
}
