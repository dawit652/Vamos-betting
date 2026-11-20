import { describe, expect, it } from 'vitest';
import { checkSendCaps, eatDayStart, type SendCaps, type SendEntry } from '../src/caps';

const CAPS: SendCaps = {
  maxPerSend: 200_000n,
  maxSendsPerHour: 3,
  maxSumPerHour: 500_000n,
  maxSumPerShift: 800_000n,
  maxSumPerDay: 1_000_000n,
  minPauseMs: 5_000,
};
const MIN = 60_000;
// 12:00 EAT on 16 Nov 2026.
const NOON = Date.UTC(2026, 10, 16, 9, 0, 0);
const sent = (minutesAgo: number, amount: bigint, outcome: SendEntry['outcome'] = 'sent') => ({
  at: NOON - minutesAgo * MIN,
  amount,
  outcome,
});
const check = (
  history: SendEntry[],
  amount = 100_000n,
  caps = CAPS,
  shiftStartedAt = NOON - 600 * MIN,
) => checkSendCaps({ caps, history, shiftStartedAt, now: NOON, amount });

describe('checkSendCaps', () => {
  it('allows a send inside every limit', () => {
    expect(check([])).toBeNull();
    expect(check([sent(30, 100_000n), sent(10, 100_000n)])).toBeNull();
  });

  it('refuses above the per-send cap, a non-positive amount and caps that make no sense', () => {
    expect(check([], 200_001n)).toBe('over_send_cap');
    expect(check([], 200_000n)).toBeNull();
    expect(check([], 0n)).toBe('invalid_amount');
    expect(check([], 100 as unknown as bigint)).toBe('invalid_amount');
    expect(check([], 100n, { ...CAPS, maxPerSend: -1n })).toBe('invalid_caps');
    expect(check([], 100n, { ...CAPS, maxSendsPerHour: 1.5 })).toBe('invalid_caps');
  });

  it('keeps the pause after any attempt, also one that did not send', () => {
    expect(check([{ at: NOON - 4_999, amount: 1n, outcome: 'not_sent' }])).toBe('too_soon');
    expect(check([{ at: NOON - 5_000, amount: 1n, outcome: 'not_sent' }])).toBeNull();
  });

  it('counts the sends and the sum of the last hour', () => {
    expect(check([sent(50, 1n), sent(40, 1n), sent(30, 1n)])).toBe('over_hour_count');
    expect(check([sent(61, 1n), sent(40, 1n), sent(30, 1n)])).toBeNull();
    expect(check([sent(50, 200_000n), sent(40, 200_000n)], 100_001n)).toBe('over_hour_sum');
    expect(check([sent(50, 200_000n), sent(40, 200_000n)], 100_000n)).toBeNull();
  });

  it('counts an unknown outcome as money that left, and a certain failure as none', () => {
    expect(check([sent(50, 200_000n, 'unknown'), sent(40, 200_000n, 'unknown')], 100_001n)).toBe(
      'over_hour_sum',
    );
    expect(
      check(
        [sent(50, 200_000n, 'not_sent'), sent(40, 200_000n, 'not_sent'), sent(30, 1n, 'not_sent')],
        200_000n,
      ),
    ).toBeNull();
  });

  it('counts the shift from its start and the day from midnight in East Africa Time', () => {
    const loose = { ...CAPS, maxSendsPerHour: 99, maxSumPerHour: 10_000_000n };
    const shift = NOON - 240 * MIN;
    const history = [
      sent(200, 200_000n),
      sent(150, 200_000n),
      sent(100, 200_000n),
      sent(70, 200_000n),
    ];
    expect(check(history, 1n, loose, shift)).toBe('over_shift_sum');
    // The same sends before this shift began do not count for the shift, but for the day.
    expect(check(history, 200_000n, loose, NOON - 60 * MIN)).toBeNull();
    expect(check([...history, sent(65, 200_000n)], 1n, loose, NOON - 60 * MIN)).toBe(
      'over_day_sum',
    );
    // Sent before 00:00 EAT (21:00 UTC the day before): yesterday.
    const yesterday = { at: eatDayStart(NOON) - 1, amount: 900_000n, outcome: 'sent' as const };
    expect(check([yesterday], 200_000n, loose, NOON - 60 * MIN)).toBeNull();
    expect(eatDayStart(NOON)).toBe(Date.UTC(2026, 10, 15, 21, 0, 0));
  });
});
