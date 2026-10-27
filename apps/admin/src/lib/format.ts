/** Display helpers. Money is a decimal string of santim; never converted through floating point. */

/** "123456" → "1,234.56" (negative amounts keep their sign). */
export function formatSantim(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '–';
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

/** "ETB 1,234.56" */
export function formatEtb(value: string | null | undefined): string {
  const text = formatSantim(value);
  return text === '–' ? text : `ETB ${text}`;
}

/**
 * ETB text typed by staff ("1,250", "12.5") → santim string; null when it is not an amount
 * with at most two decimals.
 */
export function parseEtbToSantim(input: string): string | null {
  const text = input.trim().replace(/,/g, '');
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const cents = (match[2] ?? '').padEnd(2, '0');
  return `${BigInt(whole)}${cents}`.replace(/^0+(?=\d)/, '');
}

/** Odds in milli (1850 or "1850") → "1.85". */
export function formatOdds(milli: number | string | null | undefined): string {
  if (milli === null || milli === undefined) return '–';
  const text = String(milli);
  if (!/^\d+$/.test(text)) return '–';
  const digits = text.padStart(4, '0');
  return `${digits.slice(0, -3)}.${digits.slice(-3, -1)}`;
}

/** "1.85" → 1850; null when not a price of at most 3 decimals in 1.001 to 1000. */
export function parseOddsToMilli(input: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (match === null) return null;
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return milli >= 1001 && milli <= 1_000_000 ? milli : null;
}

/** "2026-10-18T09:05:00Z" → "2026-10-18 09:05" in the browser's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local calendar day "2026-10-18" → ISO instant of its start (`endOfDay`: the next midnight). */
export function dayToIso(day: string, endOfDay = false): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + (endOfDay ? 1 : 0),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Local calendar day of `date` as "YYYY-MM-DD". */
export function toDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The English text of a localized name. */
export function nameOf(name: { en: string } | null | undefined): string {
  return name?.en ?? '–';
}

/** "pending_acceptance" → "pending acceptance". */
export function humanize(code: string | null | undefined): string {
  return code === null || code === undefined ? '–' : code.replace(/_/g, ' ');
}

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/Windows/i, 'Windows'],
  [/Mac OS X|Macintosh/i, 'macOS'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux/i, 'Linux'],
];

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/OPR\/|Opera/i, 'Opera'],
  [/Edg\//i, 'Edge'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
];

/** "Chrome · Windows" for a session's user agent, or "Unknown device" (the sessions list). */
export function deviceLabel(userAgent: string | null): string {
  if (userAgent === null) return 'Unknown device';
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  const parts = [browser, system].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'Unknown device' : parts.join(' · ');
}
