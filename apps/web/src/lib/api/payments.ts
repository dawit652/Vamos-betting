import type {
  CreateDepositRequest,
  CreateWithdrawalRequest,
  DepositsResponse,
  DepositView,
  DevPhoneDecisionRequest,
  DevPhoneDecisionResponse,
  DevPhonePushesResponse,
  PaymentOptionsResponse,
  WithdrawalsResponse,
  WithdrawalView,
} from '@vamos/contracts';
import { api } from './client';

/**
 * Browser calls of the payments side (deposits, withdrawals and the demo-only
 * phone simulator). Types only from @vamos/contracts. Deposits and withdrawals
 * take one idempotency key per intent (see `createIntentKeys`).
 */

const get = <T>(path: string, signal?: AbortSignal) => api.get<T>(path, signal ? { signal } : {});

export const paymentsApi = {
  /** Public: enabled providers, amount limits and whether this is a demo. */
  options: (signal?: AbortSignal) => get<PaymentOptionsResponse>('/payments/options', signal),

  createDeposit: (body: CreateDepositRequest, idempotencyKey: string) =>
    api.post<DepositView>('/payments/deposits', body, { idempotencyKey }),
  deposit: (id: string, signal?: AbortSignal) =>
    get<DepositView>(`/payments/deposits/${encodeURIComponent(id)}`, signal),
  deposits: (signal?: AbortSignal) => get<DepositsResponse>('/payments/deposits', signal),

  createWithdrawal: (body: CreateWithdrawalRequest, idempotencyKey: string) =>
    api.post<WithdrawalView>('/payments/withdrawals', body, { idempotencyKey }),
  withdrawals: (signal?: AbortSignal) => get<WithdrawalsResponse>('/payments/withdrawals', signal),
  cancelWithdrawal: (id: string) =>
    api.post<WithdrawalView>(`/payments/withdrawals/${encodeURIComponent(id)}/cancel`),
};

/** DEV ONLY (demo mode): the simulated phone. 404 when the API does not offer it. */
/** The dev phone simulator: the signed-in player's own phone (the session decides whose). */
export const devPhoneApi = {
  pushes: (signal?: AbortSignal) => get<DevPhonePushesResponse>('/dev/payments/phone', signal),
  decide: (body: DevPhoneDecisionRequest) =>
    api.post<DevPhoneDecisionResponse>('/dev/payments/phone', body),
};
