/**
 * Helpers of the "Password and devices" page (pure, unit tested): a short name
 * for the device of a session, from its user agent.
 */

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/KaiOS/i, 'KaiOS'],
  [/Windows/i, 'Windows'],
  [/Mac OS X|Macintosh/i, 'macOS'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux/i, 'Linux'],
];

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Opera Mini/i, 'Opera Mini'],
  [/OPR\/|Opera/i, 'Opera'],
  [/Edg\//i, 'Edge'],
  [/SamsungBrowser/i, 'Samsung Internet'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
];

/** "Chrome · Android", or null when the user agent says nothing recognisable. */
export function deviceLabel(userAgent: string | null): string | null {
  if (userAgent === null || userAgent.trim() === '') return null;
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  const parts = [browser, system].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The file name of a data export downloaded on `date`: `nahubet-my-data-2026-10-27.json`. */
export function exportFileName(date: Date): string {
  return `nahubet-my-data-${date.toISOString().slice(0, 10)}.json`;
}
