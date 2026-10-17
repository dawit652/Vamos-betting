import { formatBirr, parseSantim } from '@vamos/core';

/** "1,000.00" from a santim wire string, exactly as the web app shows it. */
export function birr(santimWire: string): string {
  return formatBirr(parseSantim(santimWire));
}

/** Santim of the first "ETB 1,234.56" in a text (a button label, a toast). */
export function santimIn(text: string): bigint {
  const match = /ETB ([\d,]+)\.(\d{2})/.exec(text);
  if (match === null) throw new Error(`no ETB amount in "${text}"`);
  return BigInt(match[1]!.replaceAll(',', '')) * 100n + BigInt(match[2]!);
}

/** "5000.00" from a santim wire string: what a player types into an amount field. */
export function typedBirr(santimWire: string): string {
  const santim = BigInt(santimWire);
  return `${santim / 100n}.${String(santim % 100n).padStart(2, '0')}`;
}
