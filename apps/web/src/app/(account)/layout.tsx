import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { UserStreamHost } from '@/components/account/UserStreamHost';
import { AccountMessages } from '@/components/account/AccountMessages';

// Personal pages: keep them out of search results.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Account side (auth, My Bets, wallet, account settings): makes the `account`
 * messages available to the client forms below and mounts the toast host of the
 * player's push stream (bet settled, cashed out…; the stream code loads only here). Renders inside the root shell.
 */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <AccountMessages>
      {children}
      <UserStreamHost />
    </AccountMessages>
  );
}
