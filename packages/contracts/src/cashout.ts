import { z } from 'zod';
import { Id, Santim } from './common';

/**
 * Cash-out (Phase 7): the player closes a running bet early for the offer
 * the house makes. Money is santim as a decimal string.
 *
 * - GET /me/bets/:id/cash-out returns the bet's current CashOutOfferView
 *   (404 for an unknown id or another player's bet).
 * - GET /me/cash-out-offers?betIds=a,b returns the offers of up to 50 of the
 *   player's bets at once (ids that are not the player's bets are left out).
 *   Offers follow the live odds and are not pushed: re-fetch them when a live
 *   delta (/live/stream) arrives for an event of an open bet, at most once
 *   every 2 seconds.
 * - POST /me/bets/:id/cash-out with an Idempotency-Key header and
 *   CashOutRequest executes it. The server prices the bet again and pays the
 *   fresh offer when it is at least what the player accepted, both gross and
 *   net; otherwise 409 `cashout_offer_changed` with the fresh offer (show the
 *   new amounts and ask again). 409 `cashout_unavailable` when no offer can
 *   be made now (details.reason). The response is CashOutResponse
 *   (betting.ts); a replay with the same key returns the same response with
 *   the `idempotent-replayed: true` header.
 *
 * A cash-out above the stake is winnings and carries the winnings tax of
 * the bet's own terms: the offer shows `gross` (the cash-out value), `tax`
 * and `net` (what the player receives). The multi bonus is never part of a
 * cash-out. Cash-out is not a stake: responsible-gambling limits and
 * self-exclusion do not block it, and a cashed-out bet does not count toward
 * the deposit wagering requirement.
 */

/** Most bet ids GET /me/cash-out-offers takes at once. */
export const MAX_CASH_OUT_OFFERS = 50;

/**
 * Why no cash-out can be offered now:
 * - bet_not_open: the bet is waiting for live acceptance, settled, rejected
 *   or already cashed out (only `open` bets can cash out);
 * - disabled: cash-out is switched off;
 * - no_legs: the bet has no legs (never for a real bet);
 * - leg_lost: a leg has lost (the bet is lost);
 * - leg_suspended: a leg's selection cannot be bet on right now (market
 *   suspended or closed, betting paused, the event between kick-off and
 *   going live…); try again shortly;
 * - all_legs_settled: every leg is decided; the bet is about to be settled;
 * - below_minimum: the offer is below the minimum cash-out amount.
 */
export const CashOutUnavailableReasonSchema = z.enum([
  'bet_not_open',
  'disabled',
  'no_legs',
  'leg_lost',
  'leg_suspended',
  'all_legs_settled',
  'below_minimum',
]);
export type CashOutUnavailableReason = z.infer<typeof CashOutUnavailableReasonSchema>;

/** The cash-out offer of one bet, as of `quotedAt`. */
export const CashOutOfferView = z.object({
  betId: z.string(),
  /** An offer can be accepted now. */
  available: z.boolean(),
  /** Why not (null when available). */
  reason: CashOutUnavailableReasonSchema.nullable(),
  /** The cash-out value before tax; send it back to accept ("0" when unavailable). */
  gross: Santim,
  /** Winnings tax on the part of `gross` above the stake ("0" at or below the stake). */
  tax: Santim,
  /** gross − tax: what the player receives. */
  net: Santim,
  /**
   * What the bet returns if every open leg wins (capped at the bet's maximum
   * payout, before bonus and tax); "0" once a leg has lost.
   */
  potentialReturn: Santim,
  /** Server time the offer was computed at (ISO). */
  quotedAt: z.string(),
});
export type CashOutOfferView = z.infer<typeof CashOutOfferView>;

/** A positive amount of santim (decimal string, at most 15 digits). */
const PositiveAmount = Santim.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value) && value.length <= 15,
  { message: 'amount must be a positive amount of santim' },
);

/** POST /me/bets/:id/cash-out (Idempotency-Key header required). */
export const CashOutRequest = z.object({
  /** The offer's `gross` as shown to the player when they confirmed. */
  gross: PositiveAmount,
});
export type CashOutRequest = z.infer<typeof CashOutRequest>;

/** What a cash-out paid (BetView.cashedOut and CashOutResponse). */
export const CashedOutView = z.object({
  gross: Santim,
  tax: Santim,
  /** Credited to the player's cash balance. */
  net: Santim,
  cashedOutAt: z.string(),
});
export type CashedOutView = z.infer<typeof CashedOutView>;

/**
 * GET /me/cash-out-offers?betIds=<id>,<id>… (comma-separated, or the
 * parameter repeated): 1 to 50 distinct bet ids.
 */
export const CashOutOffersQuery = z.object({
  betIds: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const parts = (Array.isArray(value) ? value : [value]).flatMap((part) => part.split(','));
      return [...new Set(parts.map((id) => id.trim()).filter((id) => id.length > 0))];
    })
    .pipe(z.array(Id).min(1).max(MAX_CASH_OUT_OFFERS)),
});
export type CashOutOffersQuery = z.infer<typeof CashOutOffersQuery>;

/** The offers of the requested bets that are the player's, in request order. */
export const CashOutOffersResponse = z.object({
  items: z.array(CashOutOfferView),
});
export type CashOutOffersResponse = z.infer<typeof CashOutOffersResponse>;

/** Error codes of the cash-out endpoints (besides the usual 401 / 404 / 422 / 429). */
export const CashOutErrorCodeSchema = z.enum([
  /** 409: no offer can be made now; details CashOutUnavailableDetails. */
  'cashout_unavailable',
  /** 409: the fresh offer is below what the player accepted; details CashOutOfferChangedDetails. */
  'cashout_offer_changed',
]);
export type CashOutErrorCode = z.infer<typeof CashOutErrorCodeSchema>;

/** details of 409 `cashout_unavailable`. */
export const CashOutUnavailableDetails = z.object({
  reason: CashOutUnavailableReasonSchema,
});
export type CashOutUnavailableDetails = z.infer<typeof CashOutUnavailableDetails>;

/** details of 409 `cashout_offer_changed`: the fresh offer to show instead. */
export const CashOutOfferChangedDetails = z.object({
  offer: CashOutOfferView,
});
export type CashOutOfferChangedDetails = z.infer<typeof CashOutOfferChangedDetails>;
