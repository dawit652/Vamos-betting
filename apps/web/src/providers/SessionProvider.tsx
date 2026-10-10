'use client';

import type { MeResponse, WalletResponse } from '@vamos/contracts';
import { isLocale } from '@vamos/i18n/locales';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { UNAUTHORIZED_EVENT } from '@/lib/api/client';
import { isApiClientError } from '@/lib/api/errors';
import { sessionApi } from '@/lib/api/session';
import { useLocale, useSetLocale } from '@/i18n/client';
import { CSRF_COOKIE, LOCALE_COOKIE, readBrowserCookie } from '@/lib/cookies';

/**
 * The signed-in player, on the client. `status` is:
 * - `loading` while /me and /wallet are in flight (only when a session cookie exists);
 * - `anonymous` when there is no session (or it expired: any 401 from the API);
 * - `authenticated` with `me` and `wallet` set.
 *
 * After logging in or out, call `refresh()`; after a balance change (bet placed,
 * top-up), call `refreshWallet()`.
 */
export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface SessionValue {
  status: SessionStatus;
  me: MeResponse | null;
  wallet: WalletResponse | null;
  /** Reloads /me and /wallet. Resolves when done; never rejects. */
  refresh: () => Promise<void>;
  /** Reloads /wallet only. Resolves when done; never rejects. */
  refreshWallet: () => Promise<void>;
  /**
   * Calls POST /auth/logout. Resolves true once the API ended the session (2xx,
   * or 401: it was already gone) and the state is anonymous; false when the
   * call failed (no connection, 5xx, 403), in which case the session is still
   * valid and stays signed in here too: show an error and let the player retry.
   */
  logout: () => Promise<boolean>;
}

interface State {
  status: SessionStatus;
  me: MeResponse | null;
  wallet: WalletResponse | null;
}

const ANONYMOUS: State = { status: 'anonymous', me: null, wallet: null };
const WALLET_REFRESH_ON_FOCUS_MS = 30_000;

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  hasSessionCookie,
  children,
}: {
  /** The server saw a `vamos_csrf` cookie: start as `loading` instead of `anonymous`. */
  hasSessionCookie: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>(
    hasSessionCookie ? { status: 'loading', me: null, wallet: null } : ANONYMOUS,
  );
  const lastWalletAt = useRef(0);
  const generation = useRef(0);
  const statusRef = useRef(state.status);
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const refresh = useCallback(async () => {
    const run = ++generation.current;
    if (readBrowserCookie(CSRF_COOKIE) === null) {
      setState(ANONYMOUS);
      return;
    }
    try {
      const [me, wallet] = await Promise.all([sessionApi.me(), sessionApi.wallet()]);
      if (run !== generation.current) return;
      lastWalletAt.current = Date.now();
      setState({ status: 'authenticated', me, wallet });
    } catch (error) {
      if (run !== generation.current) return;
      if (isApiClientError(error) && error.status === 401) {
        setState(ANONYMOUS);
      } else {
        // Network trouble: keep what we had; a first load falls back to anonymous.
        setState((prev) => (prev.status === 'loading' ? ANONYMOUS : prev));
      }
    }
  }, []);

  const refreshWallet = useCallback(async () => {
    try {
      const wallet = await sessionApi.wallet();
      lastWalletAt.current = Date.now();
      setState((prev) => (prev.status === 'authenticated' ? { ...prev, wallet } : prev));
    } catch {
      // A 401 is handled by the unauthorized listener; anything else keeps the old balance.
    }
  }, []);

  const logout = useCallback(async (): Promise<boolean> => {
    try {
      await sessionApi.logout();
    } catch (error) {
      // 401: the session had already ended. Anything else: the httpOnly
      // session cookie and the server session may still be valid, so a
      // signed-out screen would be a lie (someone else could reload into it).
      if (!(isApiClientError(error) && error.status === 401)) return false;
    }
    generation.current++;
    setState(ANONYMOUS);
    return true;
  }, []);

  // A player who chose a language (at registration or in the account) gets it
  // back on a new device: when this browser has no language cookie yet.
  const locale = useLocale();
  const setLocale = useSetLocale();
  const profileLocale = state.me?.locale;
  useEffect(() => {
    if (profileLocale === undefined || !isLocale(profileLocale) || profileLocale === locale) return;
    if (readBrowserCookie(LOCALE_COOKIE) !== null) return;
    setLocale(profileLocale);
  }, [profileLocale, locale, setLocale]);

  useEffect(() => {
    // Initial load (the server may not have seen the cookie, e.g. when the API is on another host).
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => {
      generation.current++;
      setState(ANONYMOUS);
    };
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        statusRef.current === 'authenticated' &&
        Date.now() - lastWalletAt.current > WALLET_REFRESH_ON_FOCUS_MS
      ) {
        void refreshWallet();
      }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshWallet]);

  const value = useMemo<SessionValue>(
    () => ({ ...state, refresh, refreshWallet, logout }),
    [state, refresh, refreshWallet, logout],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
