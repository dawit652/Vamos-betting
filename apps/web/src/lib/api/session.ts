import type { MeResponse, OkResponse, WalletResponse } from '@vamos/contracts';
import { api } from './client';

/** Browser calls used by the session provider (see src/providers/SessionProvider.tsx). */
export const sessionApi = {
  me: (signal?: AbortSignal) => api.get<MeResponse>('/me', signal ? { signal } : {}),
  wallet: (signal?: AbortSignal) => api.get<WalletResponse>('/wallet', signal ? { signal } : {}),
  logout: () => api.post<OkResponse>('/auth/logout'),
};
