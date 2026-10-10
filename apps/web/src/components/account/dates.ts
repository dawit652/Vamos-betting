import type { Locale } from '@vamos/i18n/locales';

/**
 * Dates on the account pages, in East Africa Time like the rest of the app.
 * Gregorian calendar; numbers stay Latin so amounts and times read the same in
 * every locale.
 */

const INTL_LOCALE: Record<Locale, string> = { am: 'am-ET', en: 'en-GB', om: 'om-ET', ti: 'ti-ET' };
const TIME_ZONE = 'Africa/Addis_Ababa';

function valid(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/** "12 Oct 2026" (or the locale's equivalent). */
export function formatDate(value: string | Date, locale: Locale): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!valid(date)) return '–';
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: TIME_ZONE,
    numberingSystem: 'latn',
  }).format(date);
}

/** "12 Oct 2026, 18:30". */
export function formatDateTime(value: string | Date, locale: Locale): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!valid(date)) return '–';
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIME_ZONE,
    numberingSystem: 'latn',
  }).format(date);
}

/** A calendar date of birth ("1990-05-17") without any time-zone shift. */
export function formatBirthDate(isoDate: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
    numberingSystem: 'latn',
  }).format(date);
}
