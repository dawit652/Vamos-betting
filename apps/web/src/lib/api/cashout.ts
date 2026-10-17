import type { CashOutOfferView, CashOutOffersResponse, CashOutResponse } from '@vamos/contracts';
import { api } from './client';

/** Covers the live bet delay (6 s by default) an in-play cash-out waits on the server. */
const EXECUTE_TIMEOUT_MS = 30_000;

/**
 * Browser calls of cash-out (My Bets only; not imported by the shell or the
 * home page). Types only from @vamos/contracts.
 */
export const cashOutApi = {
  /** The current offer of one bet. */
  offer: (betId: string, signal?: AbortSignal) =>
    api.get<CashOutOfferView>(
      `/me/bets/${encodeURIComponent(betId)}/cash-out`,
      signal ? { signal } : {},
    ),

  /** The offers of up to 50 of the player's bets in one call. */
  offers: (betIds: readonly string[], signal?: AbortSignal) =>
    api.get<CashOutOffersResponse>('/me/cash-out-offers', {
      query: { betIds: betIds.join(',') },
      ...(signal ? { signal } : {}),
    }),

  /**
   * Cashes the bet out for the offer the player saw (`gross`, santim). Reuse
   * `idempotencyKey` for retries of the same confirmation; a replay returns
   * the first result. In play the server answers only after the live bet
   * delay, hence the longer timeout.
   */
  execute: (betId: string, gross: string, idempotencyKey: string) =>
    api.post<CashOutResponse>(
      `/me/bets/${encodeURIComponent(betId)}/cash-out`,
      { gross },
      { idempotencyKey, timeoutMs: EXECUTE_TIMEOUT_MS },
    ),
};
