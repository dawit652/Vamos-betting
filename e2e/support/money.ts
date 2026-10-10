import { formatBirr, parseSantim } from '@vamos/core';

/** "1,000.00" from a santim wire string, exactly as the web app shows it. */
export function birr(santimWire: string): string {
  return formatBirr(parseSantim(santimWire));
}
