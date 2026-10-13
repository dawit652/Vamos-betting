import type { CashOutOfferView, CashOutOffersResponse, CashOutResponse } from '@vamos/contracts';
import { api } from './client';

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
   * the first result.
   */
  execute: (betId: string, gross: string, idempotencyKey: string) =>
    api.post<CashOutResponse>(
      `/me/bets/${encodeURIComponent(betId)}/cash-out`,
      { gross },
      { idempotencyKey },
    ),
};
