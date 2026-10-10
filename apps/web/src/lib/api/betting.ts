import type {
  BetView,
  BookingCodeResponse,
  CreateBookingCodeRequest,
  EventDetail,
  PlaceBetRequest,
  QuoteRequest,
  QuoteResponse,
} from '@vamos/contracts';
import { api } from './client';

/**
 * Browser calls of the betslip drawer (sportsbook). Types only from
 * @vamos/contracts: no zod in the bundle.
 */
export const bettingApi = {
  /** Current prices, availability and payout of the slip (public, rate limited per address). */
  quote: (body: QuoteRequest, signal?: AbortSignal) =>
    api.post<QuoteResponse>('/betslip/quote', body, signal ? { signal } : {}),

  /** Places a bet; reuse `idempotencyKey` for every retry of the same slip. */
  place: (body: PlaceBetRequest, idempotencyKey: string) =>
    api.post<BetView>('/bets', body, { idempotencyKey }),

  /** One of the player's bets (to follow a live bet's acceptance). */
  bet: (betId: string, signal?: AbortSignal) =>
    api.get<BetView>(`/me/bets/${encodeURIComponent(betId)}`, signal ? { signal } : {}),

  createBookingCode: (body: CreateBookingCodeRequest) =>
    api.post<BookingCodeResponse>('/booking-codes', body),

  bookingCode: (code: string) =>
    api.get<BookingCodeResponse>(`/booking-codes/${encodeURIComponent(code)}`),

  /** Public event page data (team names and markets for a loaded booking code). */
  event: (eventId: string) => api.get<EventDetail>(`/events/${encodeURIComponent(eventId)}`),
};
