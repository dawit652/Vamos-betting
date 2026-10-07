import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, isLocale, messagesFor } from './index';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n', () => {
  it('defaults to Amharic', () => {
    expect(DEFAULT_LOCALE).toBe('am');
    expect(messagesFor('xx')).toBe(MESSAGES.am);
  });

  it('every locale has exactly the English keys and no empty strings', () => {
    const expected = keyPaths(MESSAGES.en).sort();
    for (const locale of LOCALES) {
      expect(keyPaths(MESSAGES[locale]).sort()).toEqual(expected);
      for (const path of expected) {
        const text = path
          .split('.')
          .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], MESSAGES[locale]);
        expect(typeof text === 'string' && text.trim().length > 0, `${locale}:${path}`).toBe(true);
      }
    }
  });

  it('recognises locales', () => {
    expect(isLocale('om')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
