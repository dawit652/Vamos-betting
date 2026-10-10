import type {
  BetView,
  CreateExclusionRequest,
  Exclusion,
  ForgotPasswordRequest,
  KycResponse,
  LoginRequest,
  MeResponse,
  MyBetsResponse,
  OkResponse,
  OtpSentResponse,
  RegisterRequest,
  RegisterResponse,
  ResendOtpRequest,
  ResetPasswordRequest,
  RgLimitsRequest,
  RgLimitsResponse,
  SessionResponse,
  SubmitKycRequest,
  UpdateMeRequest,
  VerifyOtpRequest,
  WalletResponse,
  WalletTransactionsResponse,
} from '@vamos/contracts';
import { api } from './client';

/**
 * Browser calls of the account side: auth, profile, KYC, responsible-gambling
 * settings, wallet statement and My Bets. Types only from @vamos/contracts.
 */

const PAGE_SIZE = 20;

export const authApi = {
  register: (body: RegisterRequest) => api.post<RegisterResponse>('/auth/register', body),
  verifyOtp: (body: VerifyOtpRequest) => api.post<SessionResponse>('/auth/verify-otp', body),
  resendOtp: (body: ResendOtpRequest) => api.post<OtpSentResponse>('/auth/otp/resend', body),
  login: (body: LoginRequest) => api.post<SessionResponse>('/auth/login', body),
  forgotPassword: (body: ForgotPasswordRequest) =>
    api.post<OtpSentResponse>('/auth/password/forgot', body),
  resetPassword: (body: ResetPasswordRequest) => api.post<OkResponse>('/auth/password/reset', body),
};

/** POST /me/exclusions answer (201). */
export interface CreateExclusionResponse {
  exclusion: Exclusion;
}

export const accountApi = {
  updateMe: (body: UpdateMeRequest) => api.patch<MeResponse>('/me', body),
  kyc: (signal?: AbortSignal) => api.get<KycResponse>('/me/kyc', signal ? { signal } : {}),
  submitKyc: (body: SubmitKycRequest) => api.post<KycResponse>('/me/kyc', body),
  limits: (signal?: AbortSignal) =>
    api.get<RgLimitsResponse>('/me/limits', signal ? { signal } : {}),
  updateLimits: (body: RgLimitsRequest) => api.put<RgLimitsResponse>('/me/limits', body),
  createExclusion: (body: CreateExclusionRequest) =>
    api.post<CreateExclusionResponse>('/me/exclusions', body),
};

export const walletApi = {
  transactions: (cursor: string | null, signal?: AbortSignal) =>
    api.get<WalletTransactionsResponse>('/wallet/transactions', {
      query: { limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) },
      ...(signal ? { signal } : {}),
    }),
  /** Play money (demo mode only). `amount` is santim; one idempotency key per intent. */
  demoTopUp: (amount: string, idempotencyKey: string) =>
    api.post<WalletResponse>('/wallet/demo-topup', { amount }, { idempotencyKey }),
};

export type BetListStatus = 'open' | 'settled';

export const betsApi = {
  list: (status: BetListStatus, cursor: string | null, signal?: AbortSignal) =>
    api.get<MyBetsResponse>('/me/bets', {
      query: { status, limit: PAGE_SIZE, ...(cursor === null ? {} : { cursor }) },
      ...(signal ? { signal } : {}),
    }),
  get: (id: string, signal?: AbortSignal) =>
    api.get<BetView>(`/me/bets/${encodeURIComponent(id)}`, signal ? { signal } : {}),
};
