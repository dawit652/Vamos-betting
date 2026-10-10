import type { CreateExclusionRequest } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';

/** Cool-off and self-exclusion choices (pure). The API computes the real end. */

export type ExclusionChoice = CreateExclusionRequest;
export type ExclusionDuration = CreateExclusionRequest['duration'];

export const COOL_OFF_DURATIONS = ['24h', '7d', '30d'] as const;
export const SELF_EXCLUSION_DURATIONS = ['6m', '1y', '5y', 'permanent'] as const;

export const DURATION_LABEL: Readonly<Record<ExclusionDuration, MessageKey>> = {
  '24h': 'account.exclusion.durations.24h',
  '7d': 'account.exclusion.durations.7d',
  '30d': 'account.exclusion.durations.30d',
  '6m': 'account.exclusion.durations.6m',
  '1y': 'account.exclusion.durations.1y',
  '5y': 'account.exclusion.durations.5y',
  permanent: 'account.exclusion.durations.permanent',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds calendar months in UTC, clamping to the last day of the month (as the API does). */
export function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** When a break chosen now would end (for the confirmation text); null = never. */
export function previewEnd(duration: ExclusionDuration, now: Date): Date | null {
  switch (duration) {
    case '24h':
      return new Date(now.getTime() + DAY_MS);
    case '7d':
      return new Date(now.getTime() + 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() + 30 * DAY_MS);
    case '6m':
      return addUtcMonths(now, 6);
    case '1y':
      return addUtcMonths(now, 12);
    case '5y':
      return addUtcMonths(now, 60);
    case 'permanent':
      return null;
  }
}

export function exclusionRequest(duration: ExclusionDuration): ExclusionChoice {
  return (COOL_OFF_DURATIONS as readonly string[]).includes(duration)
    ? { kind: 'cool_off', duration: duration as (typeof COOL_OFF_DURATIONS)[number] }
    : { kind: 'self_exclusion', duration: duration as (typeof SELF_EXCLUSION_DURATIONS)[number] };
}
