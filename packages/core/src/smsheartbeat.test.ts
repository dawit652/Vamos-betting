import { describe, expect, it } from 'vitest';
import {
  parseSmsHeartbeat,
  smsHandsetBatteryLow,
  smsHeartbeatKey,
  smsHeartbeatLate,
} from './smsheartbeat';

const at = '2026-11-16T10:00:00.000Z';

describe('sms heartbeat', () => {
  it('keys by account', () => {
    expect(smsHeartbeatKey('telebirr:0911')).toBe('vamos:sms-heartbeat:telebirr:0911');
  });

  it('parses what the API stores and nothing else', () => {
    expect(parseSmsHeartbeat(JSON.stringify({ at, battery: 64, charging: true }))).toEqual({
      at,
      battery: 64,
      charging: true,
    });
    expect(parseSmsHeartbeat(JSON.stringify({ at, battery: null, charging: null }))).toEqual({
      at,
      battery: null,
      charging: null,
    });
    for (const bad of [null, '', 'nope', '[]', '{"at":3}', '{"at":"yesterday"}']) {
      expect(parseSmsHeartbeat(bad)).toBeNull();
    }
  });

  it('is low only under 15 percent and known not to be charging', () => {
    const hb = (battery: number | null, charging: boolean | null) => ({ at, battery, charging });
    expect(smsHandsetBatteryLow(hb(14, false))).toBe(true);
    expect(smsHandsetBatteryLow(hb(15, false))).toBe(false);
    expect(smsHandsetBatteryLow(hb(5, true))).toBe(false);
    expect(smsHandsetBatteryLow(hb(5, null))).toBe(false);
    expect(smsHandsetBatteryLow(hb(null, false))).toBe(false);
  });

  it('is late once older than the limit', () => {
    const hb = { at, battery: null, charging: null };
    const t = Date.parse(at);
    expect(smsHeartbeatLate(hb, new Date(t + 20 * 60_000), 20 * 60_000)).toBe(false);
    expect(smsHeartbeatLate(hb, new Date(t + 20 * 60_000 + 1), 20 * 60_000)).toBe(true);
  });
});
