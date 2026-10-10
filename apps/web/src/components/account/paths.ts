import { routes } from '@/lib/routes';

/**
 * Account-side pages that are not in the shared `routes` map (src/lib/routes.ts),
 * plus the `?next=` handling of the login page.
 */
export const accountPaths = {
  verify: '/verify',
  resetPassword: '/reset-password',
  betDetail: (id: string): string => `${routes.myBets}/${encodeURIComponent(id)}`,
  settledBets: `${routes.myBets}?tab=settled`,
  profile: routes.account,
  kyc: `${routes.account}/kyc`,
  limits: `${routes.account}/limits`,
  selfExclusion: `${routes.account}/self-exclusion`,
  deposit: `${routes.wallet}/deposit`,
  withdraw: `${routes.wallet}/withdraw`,
} as const;

/**
 * A `?next=` value that is safe to navigate to after logging in: a path on this
 * site (one leading slash, no scheme, no protocol-relative `//host`, no
 * backslashes or control characters). Anything else gives `fallback`.
 */
export function safeNextPath(raw: unknown, fallback: string = routes.home): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  // Never bounce back into the auth pages themselves.
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (AUTH_PATHS.has(path)) return fallback;
  return raw;
}

const AUTH_PATHS: ReadonlySet<string> = new Set([
  routes.login,
  routes.register,
  routes.forgotPassword,
  accountPaths.verify,
  accountPaths.resetPassword,
]);

/** `/login?next=…` for a page that needs a session (no `next` for the home page). */
export function loginHref(next?: string | null): string {
  const target = safeNextPath(next, '');
  return target === '' || target === routes.home
    ? routes.login
    : `${routes.login}?next=${encodeURIComponent(target)}`;
}

/** `/register?next=…`, keeping where the player was going. */
export function registerHref(next?: string | null): string {
  const target = safeNextPath(next, '');
  return target === '' || target === routes.home
    ? routes.register
    : `${routes.register}?next=${encodeURIComponent(target)}`;
}

/** The first value of a search param (Next gives `string | string[] | undefined`). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
