/**
 * Cookie names shared with the API (apps/api/src/plugins/session.ts) and the
 * locale cookie the web app owns.
 */
export const SESSION_COOKIE = 'vamos_session'; // httpOnly, never readable from scripts
export const CSRF_COOKIE = 'vamos_csrf'; // readable; echoed in the x-csrf-token header
export const CSRF_HEADER = 'x-csrf-token';
export const LOCALE_COOKIE = 'vamos_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Reads one cookie from a `document.cookie`-style string; null when absent. */
export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Browser only: reads a cookie of the current document. */
export function readBrowserCookie(name: string): string | null {
  return typeof document === 'undefined' ? null : readCookie(document.cookie, name);
}
