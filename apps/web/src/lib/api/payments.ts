import type {
  AddPayoutAccountRequest,
  AddPayoutAccountResponse,
  CreateDepositRequest,
  CreateWithdrawalRequest,
  DepositCheckResponse,
  DevSmsRequest,
  DevSmsResponse,
  PayoutAccountView,
  PayoutAccountsResponse,
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
  /** SMS rail: "I paid but my balance did not change" (the paste is only a lookup key). */
  checkDeposit: (text: string) =>
    api.post<DepositCheckResponse>('/payments/deposits/check', { text }),

  payoutAccounts: (signal?: AbortSignal) =>
    get<PayoutAccountsResponse>('/payments/payout-accounts', signal),
  addPayoutAccount: (body: AddPayoutAccountRequest) =>
    api.post<AddPayoutAccountResponse>('/payments/payout-accounts', body),
  confirmPayoutAccount: (id: string, code: string) =>
    api.post<PayoutAccountView>(`/payments/payout-accounts/${encodeURIComponent(id)}/confirm`, {
      code,
    }),
  resendPayoutAccountCode: (id: string) =>
    api.post<AddPayoutAccountResponse>(
      `/payments/payout-accounts/${encodeURIComponent(id)}/resend`,
    ),
  removePayoutAccount: (id: string) =>
    api.post<void>(`/payments/payout-accounts/${encodeURIComponent(id)}/remove`),

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

/** DEV ONLY (simulated SMS rail): the player's bank sends the confirmation SMS of their own deposit. */
export const devSmsApi = {
  send: (body: Partial<DevSmsRequest> & { depositId: string }) =>
    api.post<DevSmsResponse>('/dev/payments/sms', body),
};
