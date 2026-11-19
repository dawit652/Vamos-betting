'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from '@/components/session';
import { TEXT } from '@/lib/text';

/** The header of a signed-in page: the shop, the cashier, the pages and Sign out. */
export function Shell({ children }: { children: ReactNode }) {
  const { session, logout } = useSession();
  const pathname = usePathname();
  if (session === null) return <main className="pad narrow">{children}</main>;
  const owner = session.staff.role === 'agent_owner';
  const links: ReadonlyArray<readonly [string, string]> = owner
    ? [
        ['/owner', TEXT.navOverview],
        ['/password', TEXT.navPassword],
      ]
    : [
        ['/', TEXT.navDesk],
        ['/printer', TEXT.navPrinter],
        ['/password', TEXT.navPassword],
      ];
  const forced = session.staff.passwordChangeRequired;
  return (
    <>
      <header className="topbar no-print">
        <div>
          {session.shop === null ? (
            <strong data-testid="agent-label">{`${session.agent.number} · ${session.agent.name}`}</strong>
          ) : (
            <>
              <strong data-testid="shop-label">{`${session.shop.label} · ${session.shop.name}`}</strong>
              <div className="muted small" data-testid="agent-label">
                {`${session.agent.number} · ${session.agent.name}`}
              </div>
            </>
          )}
          <div className="muted small" data-testid="cashier-name">
            {owner ? TEXT.owner : TEXT.cashier}: {session.staff.displayName}
          </div>
        </div>
        {forced ? null : (
          <nav aria-label="Main">
            {links.map(([href, label]) => (
              <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
                {label}
              </Link>
            ))}
          </nav>
        )}
        <button type="button" onClick={() => void logout()}>
          {TEXT.signOut}
        </button>
      </header>
      <main className="pad">{children}</main>
    </>
  );
}
