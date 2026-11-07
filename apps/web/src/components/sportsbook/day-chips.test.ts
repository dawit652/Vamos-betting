import { describe, expect, it } from 'vitest';
import { formatWeekday } from '@/lib/format';
import { dayChips } from './day-chips';

describe('dayChips', () => {
  it('lists today, tomorrow and five more days from the Addis Ababa date', () => {
    // 12:00 UTC is 15:00 in Addis Ababa, still 2026-10-08.
    const chips = dayChips(new Date('2026-10-08T12:00:00.000Z'));
    expect(chips.map((chip) => chip.date)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]);
    expect(chips.map((chip) => chip.offset)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rolls over at Addis midnight (21:00 UTC), crossing a month end', () => {
    expect(dayChips(new Date('2026-10-31T20:59:59.000Z'))[0]?.date).toBe('2026-10-31');
    const chips = dayChips(new Date('2026-10-31T21:00:00.000Z'));
    expect(chips[0]?.date).toBe('2026-11-01');
    expect(chips.at(-1)?.date).toBe('2026-11-07');
  });
});

describe('formatWeekday', () => {
  it('names the weekday of an Addis Ababa date', () => {
    // 2026-10-12 is a Monday.
    expect(formatWeekday('2026-10-12', 'en')).toBe('Mon');
    expect(formatWeekday('2026-10-13', 'en')).toBe('Tue');
    expect(formatWeekday('2026-10-12', 'am')).toBe('ሰኞ');
    expect(formatWeekday('2026-10-13', 'am')).toBe('ማክሰ');
  });
});
