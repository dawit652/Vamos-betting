import { describe, expect, it } from 'vitest';
import { MOVE_MS, activeMove, advanceMove, initialMove, oddsDirection } from './odds-move';

describe('oddsDirection', () => {
  it('compares integer milli', () => {
    expect(oddsDirection(1850, 1900)).toBe('up');
    expect(oddsDirection(1850, 1800)).toBe('down');
    expect(oddsDirection(1850, 1850)).toBeNull();
  });
});

describe('move expiry', () => {
  it('treats the first value as a baseline', () => {
    expect(activeMove(initialMove(1850), 0)).toBeNull();
  });

  it('shows the arrow for MOVE_MS then expires', () => {
    const state = advanceMove(initialMove(1850), 1900, 10_000);
    expect(activeMove(state, 10_000)).toBe('up');
    expect(activeMove(state, 10_000 + MOVE_MS - 1)).toBe('up');
    expect(activeMove(state, 10_000 + MOVE_MS)).toBeNull();
  });

  it('restarts on a new change and flips direction', () => {
    const first = advanceMove(initialMove(1850), 1900, 0);
    const second = advanceMove(first, 1700, 2000);
    expect(activeMove(second, 4000)).toBe('down');
    expect(activeMove(second, 2000 + MOVE_MS)).toBeNull();
  });

  it('ignores an unchanged value', () => {
    const state = advanceMove(initialMove(1850), 1900, 0);
    expect(advanceMove(state, 1900, 2500)).toBe(state);
  });
});
