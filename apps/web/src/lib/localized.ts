import type { LocalizedNameValue } from '@vamos/contracts';
import type { Locale } from '@vamos/i18n';

/**
 * Picks a catalogue name (team, competition, market, selection) in the UI locale,
 * falling back to English, which the API always sends.
 */
export function localName(name: LocalizedNameValue | null | undefined, locale: Locale): string {
  if (name === null || name === undefined) return '';
  const value = name[locale];
  return value !== undefined && value.trim() !== '' ? value : name.en;
}
