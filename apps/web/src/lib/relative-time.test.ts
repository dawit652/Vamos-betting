import { describe, expect, it } from 'vitest';
import { minutesAgo } from './relative-time';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

describe('minutesAgo', () => {
  it('is 0 (just now) under a minute', () => {
    expect(minutesAgo('2026-10-08T11:59:30.000Z', NOW)).toBe(0);
    expect(minutesAgo('2026-10-08T12:00:00.000Z', NOW)).toBe(0);
  });

  it('floors to whole minutes', () => {
    expect(minutesAgo('2026-10-08T11:59:00.000Z', NOW)).toBe(1);
    expect(minutesAgo('2026-10-08T11:57:01.000Z', NOW)).toBe(2);
    expect(minutesAgo('2026-10-08T10:00:00.000Z', NOW)).toBe(120);
  });

  it('clamps a time in the future and rejects garbage', () => {
    expect(minutesAgo('2026-10-08T12:05:00.000Z', NOW)).toBe(0);
    expect(minutesAgo('soon', NOW)).toBeNull();
  });
});
