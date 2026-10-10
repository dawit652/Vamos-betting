import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  createTranslator,
  interpolate,
  isLocale,
  lookup,
  messagesFor,
  placeholders,
  resolveLocale,
  withFallback,
} from './index';

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

  it('every translation keeps the English placeholders', () => {
    for (const path of keyPaths(MESSAGES.en)) {
      const expected = placeholders(lookup(MESSAGES.en, path) ?? '');
      for (const locale of LOCALES) {
        expect(placeholders(lookup(MESSAGES[locale], path) ?? ''), `${locale}:${path}`).toEqual(
          expected,
        );
      }
    }
  });

  it('resolves unknown or missing locales to Amharic', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('EN')).toBe('am');
    expect(resolveLocale(undefined)).toBe('am');
    expect(resolveLocale(null)).toBe('am');
  });
});

describe('translator', () => {
  it('looks up dotted keys and interpolates placeholders', () => {
    const t = createTranslator(MESSAGES.en);
    expect(t('common.nav.home')).toBe('Home');
    expect(t('common.betslip.count', { count: 3 })).toBe('3 selections');
    expect(t('sportsbook.markets.more', { count: 12n })).toBe('+12 markets');
  });

  it('renders an unknown key as the key itself', () => {
    const t = createTranslator(MESSAGES.en);
    expect(t('common.nope' as never)).toBe('common.nope');
    expect(t('common.nav' as never)).toBe('common.nav');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(interpolate('no vars {x}')).toBe('no vars {x}');
  });

  it('fills untranslated keys from the source locale', () => {
    const source = { a: { b: 'B', c: 'C' }, d: 'D' };
    expect(withFallback(source, { a: { b: 'bb' } })).toEqual({ a: { b: 'bb', c: 'C' }, d: 'D' });
    expect(withFallback(source, { d: '  ' })).toEqual(source);
  });
});
