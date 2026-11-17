'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { canView, homeFor, navFor } from '@/lib/nav';
import { otherTheme, themeCookie, type Theme } from '@/lib/theme';
import { useSession } from './session';

const DEMO = process.env.NEXT_PUBLIC_OPERATING_MODE !== 'licensed';

/** Dark / light switch: applies at once and stores the choice for the next page load. */
function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);
  const next = otherTheme(theme);
  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        document.cookie = themeCookie(next);
        setTheme(next);
      }}
    >
      {next === 'light' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}

export function Shell({ theme, children }: { theme: Theme; children: ReactNode }) {
  const { state, staff, permissions, logout } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const onLogin = pathname === '/login';

  const mustChangePassword = staff?.passwordChangeRequired === true;
  const onAccount = pathname === '/account';

  useEffect(() => {
    if (state.status === 'anonymous' && !onLogin) router.replace('/login');
    if (state.status === 'ready' && onLogin) {
      router.replace(mustChangePassword ? '/account' : homeFor(permissions));
    }
    // A role without the dashboard (the cashier) lands on its own first page instead.
    if (state.status === 'ready' && pathname === '/' && !mustChangePassword) {
      const home = homeFor(permissions);
      if (home !== '/' && !canView(permissions, '/')) router.replace(home);
    }
    // Until the staff member sets a password of their own, the API refuses everything else.
    if (state.status === 'ready' && mustChangePassword && !onLogin && !onAccount) {
      router.replace('/account');
    }
  }, [state.status, onLogin, onAccount, mustChangePassword, permissions, pathname, router]);

  if (onLogin) return <>{children}</>;
  if (state.status !== 'ready' || staff === null) return <p className="muted pad">Loading…</p>;

  const items = navFor(permissions);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Nahubet Back Office</div>
        {DEMO && <div className="demo-badge">Demo mode: play money</div>}
        <nav aria-label="Main">
          {items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="who">
          <div data-testid="staff-name">{staff.displayName}</div>
          <div className="muted small" data-testid="staff-role">
            {staff.role}
          </div>
          <Link href="/account" aria-current={onAccount ? 'page' : undefined}>
            My account
          </Link>
          <ThemeSwitch initial={theme} />
          <button type="button" onClick={() => void logout().then(() => router.replace('/login'))}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        {mustChangePassword && !onAccount ? (
          <p className="muted">Loading…</p>
        ) : canView(permissions, pathname) ? (
          children
        ) : (
          <p className="notice error" role="alert">
            Your role does not have access to this page.
          </p>
        )}
      </main>
    </div>
  );
}
