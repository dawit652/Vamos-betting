/**
 * Every page path of the player app, in one place. Link with these helpers rather
 * than hand-written strings so a route can move without hunting for links.
 *
 * Sport is a path segment so lists render on the server without client state:
 * football is the default sport and lives at `/` and `/live`.
 * Home/live tabs (highlights, today, upcoming, leagues) are a `?tab=` query.
 */
export const SPORTS = ['football', 'basketball', 'tennis', 'volleyball'] as const;
export type Sport = (typeof SPORTS)[number];
export const DEFAULT_SPORT: Sport = 'football';

export function isSport(value: string): value is Sport {
  return (SPORTS as readonly string[]).includes(value);
}

export const routes = {
  home: '/',
  /** Sport home: `/` for football, `/sport/basketball` otherwise. */
  sport: (sport: Sport): string => (sport === DEFAULT_SPORT ? '/' : `/sport/${sport}`),
  /** Live list: `/live` for football, `/live/basketball` otherwise. */
  live: (sport: Sport = DEFAULT_SPORT): string =>
    sport === DEFAULT_SPORT ? '/live' : `/live/${sport}`,
  /** Competition page; slugs are unique per sport. */
  competition: (sport: Sport, slug: string): string =>
    `/sport/${sport}/${encodeURIComponent(slug)}`,
  event: (eventId: string): string => `/event/${encodeURIComponent(eventId)}`,
  myBets: '/my-bets',
  jackpot: '/jackpot',
  account: '/account',
  wallet: '/wallet',
  deposit: '/wallet/deposit',
  withdraw: '/wallet/withdraw',
  /** Demo-only simulated phone for approving mock deposits. */
  devPhone: '/dev/phone',
  /** Demo-only SMS and USSD simulator. */
  devChannels: '/dev/channels',
  login: '/login',
  register: '/register',
  forgotPassword: '/forgot-password',
  help: '/help',
  terms: '/terms',
  privacy: '/privacy',
  responsibleGambling: '/responsible-gambling',
} as const;

/** The sport a sportsbook path is about, or null when the path is not a sport list. */
export function sportFromPath(pathname: string): { sport: Sport; live: boolean } | null {
  if (pathname === '/') return { sport: DEFAULT_SPORT, live: false };
  if (pathname === '/live') return { sport: DEFAULT_SPORT, live: true };
  const [, first, second] = pathname.split('/');
  if ((first === 'sport' || first === 'live') && second !== undefined && isSport(second)) {
    return { sport: second, live: first === 'live' };
  }
  return null;
}
