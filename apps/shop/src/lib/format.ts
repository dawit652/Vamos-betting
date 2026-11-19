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

/** "2026-10-18T09:05:00Z" → "2026-10-18 09:05" in the browser's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
