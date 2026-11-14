import { describe, expect, it } from 'vitest';
import { otherTheme, parseTheme, themeCookie } from './theme';

describe('back-office theme', () => {
  it('is dark unless the cookie says light', () => {
    expect(parseTheme(undefined)).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('blue')).toBe('dark');
  });

  it('switches between the two themes', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });

  it('stores the choice for a year, for every page', () => {
    expect(themeCookie('light')).toBe(
      'vamos_admin_theme=light; path=/; max-age=31536000; samesite=lax',
    );
  });
});
