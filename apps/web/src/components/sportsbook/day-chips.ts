import { addisAbabaDate } from '@vamos/contracts';

/** Today, Tomorrow, then the next five days (named by weekday). */
export const DAY_CHIP_COUNT = 7;

export interface DayChip {
  /** Addis Ababa calendar date, YYYY-MM-DD. */
  date: string;
  /** Days after today: 0 and 1 are labelled Today and Tomorrow, 2 to 6 by weekday. */
  offset: number;
}

/** The day chips of a list, from the Addis Ababa date of `now`. */
export function dayChips(now: Date): DayChip[] {
  return Array.from({ length: DAY_CHIP_COUNT }, (_, offset) => ({
    date: addisAbabaDate(now, offset),
    offset,
  }));
}
