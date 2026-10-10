import { formatBirr, parseSantim } from '@vamos/core';

/** "1,000.00" from a santim wire string, exactly as the web app shows it. */
export function birr(santimWire: string): string {
  return formatBirr(parseSantim(santimWire));
}

/** "5000.00" from a santim wire string: what a player types into an amount field. */
export function typedBirr(santimWire: string): string {
  const santim = BigInt(santimWire);
  return `${santim / 100n}.${String(santim % 100n).padStart(2, '0')}`;
}
