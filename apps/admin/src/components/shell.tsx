'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { canView, navFor } from '@/lib/nav';
import { useSession } from './session';

const DEMO = process.env.NEXT_PUBLIC_OPERATING_MODE !== 'licensed';

export function Shell({ children }: { children: ReactNode }) {
  const { state, staff, permissions, logout } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const onLogin = pathname === '/login';

  useEffect(() => {
    if (state.status === 'anonymous' && !onLogin) router.replace('/login');
    if (state.status === 'ready' && onLogin) router.replace('/');
  }, [state.status, onLogin, router]);

  if (onLogin) return <>{children}</>;
  if (state.status !== 'ready' || staff === null) return <p className="muted pad">Loading…</p>;

  const items = navFor(permissions);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Vamos Back Office</div>
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
          <button type="button" onClick={() => void logout().then(() => router.replace('/login'))}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        {canView(permissions, pathname) ? (
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
