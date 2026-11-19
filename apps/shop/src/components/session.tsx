'use client';

import type { ShopSessionResponse } from '@vamos/contracts';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setCsrfToken, UNAUTHORIZED_EVENT } from '@/lib/api';
import { ApiClientError } from '@/lib/errors';
import { redirectFor } from '@/lib/guards';
import { TEXT } from '@/lib/text';

type State =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'ready'; session: ShopSessionResponse };

interface SessionValue {
  state: State;
  session: ShopSessionResponse | null;
  login: (input: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Reads the session again (after the password change). */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Loads GET /shop/me, keeps the session (the CSRF token only in memory, see lib/api.ts) and
 * sends the browser where the route guard says: the sign-in when anonymous, the password page
 * while a password an admin chose is still in use.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const router = useRouter();
  const pathname = usePathname();

  const adopt = useCallback((session: ShopSessionResponse | null) => {
    setCsrfToken(session?.csrfToken ?? null);
    setState((previous) => {
      if (session === null) {
        return previous.status === 'anonymous' ? previous : { status: 'anonymous' };
      }
      return { status: 'ready', session };
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<ShopSessionResponse>('/shop/me', { signal: controller.signal })
      .then((session) => adopt(session))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // 401 is the normal "not signed in"; anything else also leaves the UI at the sign-in form.
        if (!(error instanceof ApiClientError)) console.error(error);
        adopt(null);
      });
    const onUnauthorized = () => adopt(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      controller.abort();
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [adopt]);

  const session = state.status === 'ready' ? state.session : null;
  const target = redirectFor(
    pathname,
    state.status,
    session?.staff.passwordChangeRequired ?? false,
  );
  useEffect(() => {
    if (target !== null) router.replace(target);
  }, [target, router]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      session,
      login: async (input) => {
        adopt(await api<ShopSessionResponse>('/shop/auth/login', { method: 'POST', body: input }));
      },
      refresh: async () => {
        adopt(await api<ShopSessionResponse>('/shop/me'));
      },
      logout: async () => {
        try {
          await api('/shop/auth/logout', { method: 'POST' });
        } finally {
          adopt(null);
        }
      },
    }),
    [state, session, adopt],
  );

  // No page flashes before its guard has decided: wait for the load and for a pending redirect.
  if (state.status === 'loading' || target !== null) {
    return (
      <p className="pad muted" role="status">
        {TEXT.loading}
      </p>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession needs a SessionProvider');
  return value;
}
