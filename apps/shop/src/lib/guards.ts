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
 * Signed in otherwise: the public pages lead on to the desk (an owner's overview).
 */
export function redirectFor(
  pathname: string,
  status: SessionStatus,
  passwordChangeRequired: boolean,
  role: 'cashier' | 'agent_owner' = 'cashier',
): string | null {
  if (status === 'loading') return null;
  if (status === 'anonymous') return isPublicPath(pathname) ? null : '/login';
  if (passwordChangeRequired) return pathname === '/password' ? null : '/password';
  // Owners work on /owner and /password only; cashiers never see /owner.
  if (role === 'agent_owner') {
    return isPublicPath(pathname) || pathname === '/' || pathname === '/printer' ? '/owner' : null;
  }
  if (pathname === '/owner') return '/';
  return isPublicPath(pathname) ? '/' : null;
}
