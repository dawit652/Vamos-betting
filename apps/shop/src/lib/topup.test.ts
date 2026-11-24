import { describe, expect, it } from 'vitest';
import { stakeAboveBalance, topUpState } from './topup';

describe('topUpState', () => {
  it('has no state at an HQ shop (no top-up balance)', () => {
    expect(topUpState(null, null)).toBeNull();
    expect(topUpState(null, '100000')).toBeNull();
  });

  it('is empty at zero or less', () => {
    expect(topUpState('0', '100000')).toBe('empty');
    expect(topUpState('-1', '100000')).toBe('empty');
  });

  it('is low at or below the threshold, ok above it', () => {
    expect(topUpState('1', '100000')).toBe('low');
    expect(topUpState('100000', '100000')).toBe('low');
    expect(topUpState('100001', '100000')).toBe('ok');
  });

  it('is ok above zero when no threshold is known', () => {
    expect(topUpState('5', null)).toBe('ok');
  });

  it('ignores a malformed amount', () => {
    expect(topUpState('12.5', '100')).toBeNull();
    expect(topUpState('5000', 'x')).toBe('ok');
  });
});

describe('stakeAboveBalance', () => {
  it('compares santim exactly', () => {
    expect(stakeAboveBalance('5001', '5000')).toBe(true);
    expect(stakeAboveBalance('5000', '5000')).toBe(false);
    expect(stakeAboveBalance('1', '0')).toBe(true);
  });

  it('is false when either side is unknown', () => {
    expect(stakeAboveBalance(null, '5000')).toBe(false);
    expect(stakeAboveBalance('5000', null)).toBe(false);
  });
});
