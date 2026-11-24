import { describe, expect, it } from 'vitest';
import { isEventDayInRange } from '@vamos/contracts';
import { formatChipDay, formatWeekday } from '@/lib/format';
import { dayChips } from './day-chips';

describe('dayChips', () => {
  it('lists today and the next 29 days from the Addis Ababa date (the Upcoming tab)', () => {
    // 12:00 UTC is 15:00 in Addis Ababa, still 2026-10-08.
    const chips = dayChips(new Date('2026-10-08T12:00:00.000Z'));
    expect(chips).toHaveLength(30);
    expect(chips.slice(0, 3).map((chip) => chip.date)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]);
    expect(chips.at(-1)).toEqual({ date: '2026-11-06', offset: 29 });
    // Every chip is a day the API accepts (today .. today + EVENT_DAY_MAX_AHEAD).
    expect(
      chips.every((chip) => isEventDayInRange(chip.date, new Date('2026-10-08T12:00:00.000Z'))),
    ).toBe(true);
  });

  it('rolls over at Addis midnight (21:00 UTC), crossing a month end', () => {
    expect(dayChips(new Date('2026-10-31T20:59:59.000Z'))[0]?.date).toBe('2026-10-31');
    const chips = dayChips(new Date('2026-10-31T21:00:00.000Z'));
    expect(chips[0]?.date).toBe('2026-11-01');
    expect(chips.at(-1)?.date).toBe('2026-11-30');
  });
});

describe('formatChipDay', () => {
  it('shows the weekday and the day of the month', () => {
    expect(formatChipDay('2026-10-12', 'en')).toBe('Mon 12');
    expect(formatChipDay('2026-11-03', 'en')).toBe('Tue 3');
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
