import type { MessageKey } from '@vamos/i18n/translate';
import type { ReactNode } from 'react';
import { routes } from '@/lib/routes';

/** The five destinations of the main navigation (MainNav). */
export interface NavItem {
  id: 'home' | 'live' | 'myBets' | 'jackpot' | 'account';
  href: string;
  label: MessageKey;
  icon: ReactNode;
  active: (path: string) => boolean;
}

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'home',
    href: routes.home,
    label: 'common.nav.home',
    icon: icon('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'),
    active: (p) => p === '/' || p.startsWith('/sport/') || p.startsWith('/event/'),
  },
  {
    id: 'live',
    href: routes.live(),
    label: 'common.nav.live',
    icon: icon(
      'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
    ),
    active: (p) => p === '/live' || p.startsWith('/live/'),
  },
  {
    id: 'myBets',
    href: routes.myBets,
    label: 'common.nav.myBets',
    icon: icon('M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3'),
    active: (p) => p.startsWith(routes.myBets),
  },
  {
    id: 'jackpot',
    href: routes.jackpot,
    label: 'common.nav.jackpot',
    icon: icon('M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z'),
    active: (p) => p === routes.jackpot,
  },
  {
    id: 'account',
    href: routes.account,
    label: 'common.nav.account',
    icon: icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'),
    active: (p) =>
      [routes.account, routes.wallet, routes.login, routes.register, routes.forgotPassword].some(
        (r) => p === r || p.startsWith(`${r}/`),
      ),
  },
];
