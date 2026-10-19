import type {
  DevSmsSendRequest,
  DevSmsSendResponse,
  DevUssdRequest,
  DevUssdResponse,
} from '@vamos/contracts';
import { api } from './client';

/**
 * DEV ONLY (demo mode, outside production, channel enabled): the SMS / USSD
 * simulator. Each call is made as the signed-in player's own phone; the API
 * signs it like the aggregator and forwards it to the inbound route.
 */
export interface DevInboxResponse {
  items: { to: string; body: string; template: string; createdAt: string }[];
}

export const devChannelsApi = {
  sendSms: (body: DevSmsSendRequest) => api.post<DevSmsSendResponse>('/dev/channels/sms', body),
  ussd: (body: DevUssdRequest) => api.post<DevUssdResponse>('/dev/channels/ussd', body),
  /** The dev SMS inbox of a number (replies the platform "sent"). */
  inbox: (phone: string, signal?: AbortSignal) =>
    api.get<DevInboxResponse>('/dev/sms', { query: { phone }, ...(signal ? { signal } : {}) }),
};
