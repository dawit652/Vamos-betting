/**
 * The heartbeat a collection handset's forwarder sends (POST /payments/webhooks/sms/heartbeat):
 * the API stores the last one per collection account in Redis, the worker and the health panel
 * read it. A phone that is alive but quiet (nobody paying) is told apart from a dead one by it.
 * Pure: no I/O.
 */

/** Redis key of an account's last heartbeat (the API writes it, the worker and health read it). */
export const smsHeartbeatKey = (accountId: string): string => `vamos:sms-heartbeat:${accountId}`;

/** A stored heartbeat expires after this long, so a retired account leaves no stale row. */
export const SMS_HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** At or below this battery percentage, not charging, the handset is about to die. */
export const SMS_HANDSET_BATTERY_LOW_PERCENT = 15;

export interface SmsHeartbeat {
  /** When the API received it (ISO 8601, the API's clock). */
  at: string;
  /** Battery percentage 0..100, when the forwarder reported it. */
  battery: number | null;
  /** Whether the phone is charging, when the forwarder reported it. */
  charging: boolean | null;
}

/** Reads a stored heartbeat; anything that is not one is null. */
export function parseSmsHeartbeat(raw: string | null): SmsHeartbeat | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof SmsHeartbeat, unknown>> | null;
    if (value === null || typeof value !== 'object' || typeof value.at !== 'string') return null;
    if (Number.isNaN(Date.parse(value.at))) return null;
    return {
      at: value.at,
      battery: typeof value.battery === 'number' ? value.battery : null,
      charging: typeof value.charging === 'boolean' ? value.charging : null,
    };
  } catch {
    return null;
  }
}

/** The battery is low: under the limit and known not to be charging. */
export function smsHandsetBatteryLow(heartbeat: SmsHeartbeat): boolean {
  return (
    heartbeat.battery !== null &&
    heartbeat.battery < SMS_HANDSET_BATTERY_LOW_PERCENT &&
    heartbeat.charging === false
  );
}

/** The heartbeat is older than `alarmMs` at `now`. */
export function smsHeartbeatLate(heartbeat: SmsHeartbeat, now: Date, alarmMs: number): boolean {
  return now.getTime() - Date.parse(heartbeat.at) > alarmMs;
}
