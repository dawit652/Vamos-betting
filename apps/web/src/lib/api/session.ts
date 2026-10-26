import type {
  MeResponse,
  OkResponse,
  SessionStateResponse,
  WalletResponse,
} from '@vamos/contracts';
import { api } from './client';

/** Browser calls used by the session provider (see src/providers/SessionProvider.tsx). */
export const sessionApi = {
  /** The session behind the API cookie, with its CSRF token, or null (always 200). */
  state: (signal?: AbortSignal) =>
    api.get<SessionStateResponse>('/auth/session', signal ? { signal } : {}),
  me: (signal?: AbortSignal) => api.get<MeResponse>('/me', signal ? { signal } : {}),
  wallet: (signal?: AbortSignal) => api.get<WalletResponse>('/wallet', signal ? { signal } : {}),
  logout: () => api.post<OkResponse>('/auth/logout'),
};
