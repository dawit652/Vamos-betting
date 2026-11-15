/**
 * The back-office theme: dark by default, light as a choice kept in a cookie
 * that the root layout reads to render `<html data-theme>` (no flash on reload).
 * Not a secret and not a session: readable by the page's own script.
 */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'dark';
export const THEME_COOKIE = 'vamos_admin_theme';
/** One year. */
export const THEME_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export function parseTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : DEFAULT_THEME;
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** The `document.cookie` assignment that stores the choice. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
}
