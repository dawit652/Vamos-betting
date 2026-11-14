import { describe, expect, it } from 'vitest';
import { parseTheme, readCookie } from './cookies';

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    const header = 'a=1; vamos_csrf=abc%2Fdef; vamos_locale=en';
    expect(readCookie(header, 'vamos_csrf')).toBe('abc/def');
    expect(readCookie(header, 'vamos_locale')).toBe('en');
    expect(readCookie(header, 'a')).toBe('1');
  });

  it('returns null when absent and does not match prefixes', () => {
    expect(readCookie('', 'vamos_csrf')).toBeNull();
    expect(readCookie('xvamos_csrf=1', 'vamos_csrf')).toBeNull();
    expect(readCookie('vamos_csrf_old=1', 'vamos_csrf')).toBeNull();
  });

  it('keeps values with = and bad escapes', () => {
    expect(readCookie('t=a=b', 't')).toBe('a=b');
    expect(readCookie('t=%E0%A4%A', 't')).toBe('%E0%A4%A');
  });
});

describe('parseTheme', () => {
  it('is dark unless the cookie says light', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme(undefined)).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('LIGHT')).toBe('dark');
    expect(parseTheme('<script>')).toBe('dark');
  });
});
