import type { APIRequestContext } from '@playwright/test';
import type {
  DepositsResponse,
  DevWithdrawalQueueResponse,
  PaymentOptionsResponse,
  WithdrawalView,
  WithdrawalsResponse,
} from '@vamos/contracts';
import { API_URL } from './env';

/**
 * Payments API helpers for assertions and for the demo back-office stand-in.
 * `page.request` acts as the signed-in player (GETs need no CSRF). A plain
 * `request` fixture has no cookies: it is the staff side, calling the dev
 * routes that stand in for the Phase 9 back office (no session, no CSRF).
 */

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${API_URL}${path}`);
  if (!response.ok()) {
    throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export function paymentOptions(request: APIRequestContext): Promise<PaymentOptionsResponse> {
  return getJson(request, '/payments/options');
}

export function myDeposits(request: APIRequestContext): Promise<DepositsResponse> {
  return getJson(request, '/payments/deposits');
}

export function myWithdrawals(request: APIRequestContext): Promise<WithdrawalsResponse> {
  return getJson(request, '/payments/withdrawals');
}

export function reviewQueue(request: APIRequestContext): Promise<DevWithdrawalQueueResponse> {
  return getJson(request, '/dev/payments/withdrawals');
}

/** Approves a withdrawal waiting for review, as the back-office stand-in. */
export async function devApproveWithdrawal(
  staffRequest: APIRequestContext,
  withdrawalId: string,
): Promise<WithdrawalView> {
  const response = await staffRequest.post(
    `${API_URL}/dev/payments/withdrawals/${encodeURIComponent(withdrawalId)}/approve`,
  );
  if (!response.ok()) {
    throw new Error(
      `approve ${withdrawalId} failed: ${response.status()} ${await response.text()}`,
    );
  }
  return (await response.json()) as WithdrawalView;
}
