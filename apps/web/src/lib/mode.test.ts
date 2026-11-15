import { describe, expect, it } from 'vitest';
import { isDemoMode } from './mode';

describe('isDemoMode', () => {
  it('is real money only for licensed; a missing or other value keeps the demo notices', () => {
    expect(isDemoMode('licensed')).toBe(false);
    expect(isDemoMode('demo')).toBe(true);
    expect(isDemoMode(undefined)).toBe(true);
    expect(isDemoMode('')).toBe(true);
    expect(isDemoMode('Licensed')).toBe(true);
  });
});
