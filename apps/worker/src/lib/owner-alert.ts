import { buildOwnerAlert, type OwnerAlertInput } from '@vamos/core';
import { enqueueOwnerAlert } from '@vamos/db';
import type { Redis } from 'ioredis';
import type { TaskContext } from '../tasks/context';

/**
 * Alerts to the owner's phone (plan task 1.11): the deduplication both ends share, and the raising
 * of an alert from worker code. An alert key is allowed at most once per OWNER_ALERT_MIN_INTERVAL
 * (one Redis key per key and side). The window runs on the alert's own time (`raisedAt`), not on
 * delivery time, so a late delivery cannot shift the next window.
 */

const KEY_PREFIX = 'vamos:owner-alert:';

/** The key outlives its window by this much, so a slow clock never lets an alert through early. */
const SLOT_GRACE_MS = 60_000;

/**
 * Claims the slot of `key` for an alert raised at `atMs`: true when the last claimed alert of this
 * key is at least `intervalMs` older (or there is none), recording `atMs` as the new last; false
 * when it falls inside the window. Atomic, so two workers never both claim one window.
 */
const CLAIM_SCRIPT = `local last = redis.call('get', KEYS[1])
if last and (tonumber(ARGV[1]) - tonumber(last)) < tonumber(ARGV[2]) then
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1`;

/** Gives the slot back, only if it still holds the claim made at `atMs`. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export type AlertSide = 'raised' | 'sent';

const slotKey = (side: AlertSide, key: string): string => `${KEY_PREFIX}${side}:${key}`;

export async function claimAlertSlot(
  redis: Redis,
  side: AlertSide,
  key: string,
  atMs: number,
  intervalMs: number,
): Promise<boolean> {
  const claimed = await redis.eval(
    CLAIM_SCRIPT,
    1,
    slotKey(side, key),
    String(atMs),
    String(intervalMs),
    String(intervalMs + SLOT_GRACE_MS),
  );
  return claimed === 1;
}

export async function releaseAlertSlot(
  redis: Redis,
  side: AlertSide,
  key: string,
  atMs: number,
): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, slotKey(side, key), String(atMs));
}

/** True when owner alerts are on (an owner number is set). */
export const ownerAlertsOn = (ctx: Pick<TaskContext, 'ownerAlerts'>): boolean =>
  ctx.ownerAlerts !== undefined && ctx.ownerAlerts.phones.length > 0;

/**
 * Raises an alert from worker code (the SMS rail's alarms, which are log lines): an `owner.alert`
 * outbox row in a small transaction of its own. A watch raises the same alarm every pass while its
 * condition holds, so the row is written once per interval and key; the worker's own deduplication
 * (processOwnerAlertJob) stays the last word. Never throws: an alert that cannot be queued is
 * logged and goes no further, so it cannot break the check that raised it. Returns whether a row
 * was written.
 */
export async function raiseOwnerAlert(ctx: TaskContext, input: OwnerAlertInput): Promise<boolean> {
  const alerts = ctx.ownerAlerts;
  if (alerts === undefined || alerts.phones.length === 0) return false;
  const now = ctx.clock();
  const { key } = buildOwnerAlert(input);
  const intervalMs = alerts.minIntervalMinutes * 60_000;
  let claimed = false;
  try {
    claimed = await claimAlertSlot(ctx.redis, 'raised', key, now.getTime(), intervalMs);
    if (!claimed) return false;
    return await enqueueOwnerAlert(ctx.db, alerts, input, now);
  } catch (error) {
    // The alert was not queued: let the next pass try again rather than hold it for an interval.
    if (claimed) await releaseAlertSlot(ctx.redis, 'raised', key, now.getTime()).catch(() => {});
    ctx.logger.warn({ err: error, alertKey: key }, 'owner alert could not be queued');
    return false;
  }
}
