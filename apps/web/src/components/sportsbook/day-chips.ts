import { addisAbabaDate } from '@vamos/contracts';

/**
 * The Upcoming tab's days: today and the next 29 (owner, 23 Nov 2026: up to 30 days, scrolled
 * sideways). The API accepts a day up to EVENT_DAY_MAX_AHEAD (30) ahead.
 */
export const DAY_CHIP_COUNT = 30;

export interface DayChip {
  /** Addis Ababa calendar date, YYYY-MM-DD. */
  date: string;
  /** Days after today: 0 and 1 are labelled Today and Tomorrow, the others weekday and date. */
  offset: number;
}

/** The day chips of a list, from the Addis Ababa date of `now`. */
export function dayChips(now: Date): DayChip[] {
  return Array.from({ length: DAY_CHIP_COUNT }, (_, offset) => ({
    date: addisAbabaDate(now, offset),
    offset,
  }));
}
