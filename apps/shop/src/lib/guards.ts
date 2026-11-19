/** Where the session state sends the browser: the pure part of the route guard. */

export type SessionStatus = 'loading' | 'anonymous' | 'ready';

/** Pages a person can open without a session. */
const PUBLIC_PATHS = ['/login', '/register-device'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

/**
 * The path to redirect to, or null to stay. Not signed in: only the public pages. Signed in with
 * an admin-chosen password: only /password (every desk route refuses until it is replaced).
 * Signed in otherwise: the public pages lead on to the desk.
 */
export function redirectFor(
  pathname: string,
  status: SessionStatus,
  passwordChangeRequired: boolean,
): string | null {
  if (status === 'loading') return null;
  if (status === 'anonymous') return isPublicPath(pathname) ? null : '/login';
  if (passwordChangeRequired) return pathname === '/password' ? null : '/password';
  return isPublicPath(pathname) ? '/' : null;
}
