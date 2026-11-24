import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { minutesSince, SERVICE_DOWN_AFTER_MS, serviceHealth } from './service-health';

const now = new Date('2026-11-21T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('serviceHealth', () => {
  it('is unknown before any report, up after a success', () => {
    expect(serviceHealth({ lastOkAt: null, failingSince: null }, now)).toEqual({
      status: 'unknown',
    });
    expect(serviceHealth({ lastOkAt: ago(1000), failingSince: null }, now)).toEqual({
      status: 'up',
    });
  });

  it('is down only after failing for 3 minutes without a success', () => {
    const brief = { lastOkAt: ago(10 * 60_000), failingSince: ago(SERVICE_DOWN_AFTER_MS - 1) };
    expect(serviceHealth(brief, now).status).toBe('up');
    const since = ago(SERVICE_DOWN_AFTER_MS);
    expect(serviceHealth({ lastOkAt: null, failingSince: since }, now)).toEqual({
      status: 'down',
      since,
    });
  });

  it('is down when a scheduled service stopped reporting', () => {
    const report = { lastOkAt: ago(25 * 60_000), failingSince: null };
    expect(serviceHealth(report, now).status).toBe('up');
    expect(serviceHealth(report, now, { staleAfterMs: 20 * 60_000 })).toEqual({
      status: 'down',
      since: ago(5 * 60_000),
    });
  });

  it('a failure younger than the window never makes it down (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: SERVICE_DOWN_AFTER_MS - 1 }), (age) => {
        expect(serviceHealth({ lastOkAt: ago(age + 1), failingSince: ago(age) }, now).status).toBe(
          'up',
        );
      }),
    );
  });

  it('counts whole minutes, at least one', () => {
    expect(minutesSince(ago(30_000), now)).toBe(1);
    expect(minutesSince(ago(42 * 60_000 + 59_000), now)).toBe(42);
  });
});
