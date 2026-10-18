'use client';

import type { StaffMeView, StaffSessionResponse } from '@vamos/contracts';
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

type State =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'ready'; session: StaffSessionResponse };

interface SessionValue {
  state: State;
  staff: StaffMeView | null;
  permissions: readonly string[];
  login: (input: { email: string; password: string; code: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Reads the session again (after a change of the own password or authenticator). */
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const adopt = useCallback((session: StaffSessionResponse | null) => {
    setCsrfToken(session?.csrfToken ?? null);
    setState(session === null ? { status: 'anonymous' } : { status: 'ready', session });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<StaffSessionResponse>('/admin/session', { signal: controller.signal })
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

  const value = useMemo<SessionValue>(() => {
    const session = state.status === 'ready' ? state.session : null;
    const permissions = session?.staff.permissions ?? [];
    return {
      state,
      staff: session?.staff ?? null,
      permissions,
      can: (permission) => permissions.includes(permission as never),
      login: async (input) => {
        adopt(
          await api<StaffSessionResponse>('/admin/auth/login', { method: 'POST', body: input }),
        );
      },
      refresh: async () => {
        adopt(await api<StaffSessionResponse>('/admin/session'));
      },
      logout: async () => {
        try {
          await api('/admin/auth/logout', { method: 'POST' });
        } finally {
          adopt(null);
        }
      },
    };
  }, [state, adopt]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession needs a SessionProvider');
  return value;
}
