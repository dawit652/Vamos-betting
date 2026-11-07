import { formatBirr, formatOdds, parseSantim } from '@vamos/core';
import type { Locale } from '@vamos/i18n';

/**
 * Display helpers. Money from the API is a santim decimal string ("12550");
 * it is parsed to bigint and formatted with @vamos/core, never through a float.
 */

/** "1,250.50" from a santim wire string; "–" when the value is not a valid amount. */
export function formatSantim(
  wire: string | null | undefined,
  options: { currency?: boolean } = {},
): string {
  if (wire === null || wire === undefined) return '–';
  try {
    return formatBirr(parseSantim(wire), { currency: options.currency ?? false });
  } catch {
    return '–';
  }
}

/** "ETB 1,250.50" from a santim wire string. */
export function formatMoney(wire: string | null | undefined): string {
  return formatSantim(wire, { currency: true });
}

/** "1.85" from milli odds (1850); "1.855" when the third decimal is set. */
export function formatOddsMilli(oddsMilli: number): string {
  return Number.isInteger(oddsMilli) && oddsMilli > 0 ? formatOdds(oddsMilli) : '–';
}

/**
 * Total odds of an accumulator travel as a milli string (they can exceed 2^53).
 * Shown with two decimals, truncated: "12,345.67".
 */
export function formatTotalOdds(totalOddsMilli: string): string {
  if (!/^\d+$/.test(totalOddsMilli)) return '–';
  const value = BigInt(totalOddsMilli);
  const whole = value / 1000n;
  const hundredths = (value % 1000n) / 10n;
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${hundredths
    .toString()
    .padStart(2, '0')}`;
}

const INTL_LOCALE: Record<Locale, string> = { am: 'am-ET', en: 'en-GB', om: 'om-ET', ti: 'ti-ET' };

/** Kick-off time in East Africa Time (the app's market), e.g. "18:30". */
export function formatTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Addis_Ababa',
  }).format(new Date(iso));
}

/** Short date in East Africa Time, e.g. "12/10" (day/month). */
export function formatDayMonth(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Africa/Addis_Ababa',
  }).formatToParts(new Date(iso));
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return `${day}/${month}`;
}

/** Weekday name of an Addis Ababa calendar date (YYYY-MM-DD), e.g. "Mon" or "ሰኞ". */
export function formatWeekday(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: 'short',
    timeZone: 'Africa/Addis_Ababa',
  }).format(new Date(`${date}T12:00:00+03:00`));
}
