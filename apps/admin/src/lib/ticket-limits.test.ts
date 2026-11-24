import { describe, expect, it } from 'vitest';
import { limitFields, limitsRequest, santimToBirrInput } from './ticket-limits';

const EMPTY = limitFields({});

describe('santimToBirrInput', () => {
  it('drops empty cents and keeps real ones', () => {
    expect(santimToBirrInput('50000000')).toBe('500000');
    expect(santimToBirrInput('12050')).toBe('120.50');
    expect(santimToBirrInput('5')).toBe('0.05');
    expect(santimToBirrInput('0')).toBe('0');
  });
});

describe('limitsRequest', () => {
  it('sends nothing for an untouched form', () => {
    expect(limitsRequest(EMPTY)).toEqual({ ok: true, body: {} });
  });

  it('turns birr into santim strings and counts into numbers', () => {
    const result = limitsRequest({
      ...EMPTY,
      maxStake: '1,000.5',
      dailySales: '20000',
      maxLegs: '12',
      cancelMinutes: '0',
    });
    expect(result).toEqual({
      ok: true,
      body: { maxStake: '100050', dailySales: '2000000', maxLegs: 12, cancelMinutes: 0 },
    });
  });

  it('names the field that is not a number', () => {
    const money = limitsRequest({ ...EMPTY, minStake: 'ten' });
    expect(money.ok).toBe(false);
    const count = limitsRequest({ ...EMPTY, maxLegs: '1.5' });
    expect(count).toEqual({ ok: false, error: 'Most matches per ticket: enter a whole number.' });
  });

  it('round-trips what an admin set', () => {
    const body = { maxWin: '12050', expiryDays: 45, dailySales: '100' };
    expect(limitsRequest(limitFields(body))).toEqual({ ok: true, body });
  });
});
