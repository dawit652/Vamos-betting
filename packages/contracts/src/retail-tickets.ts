import { z } from 'zod';
import {
  BetStatusSchema,
  BetView,
  OddsChangePolicySchema,
  PlaceBetRequest,
  QuoteRequest,
  QuoteResponse,
} from './betting';
import { CashierShopView } from './cashier';
import { IsoDateTime, Santim } from './common';

/**
 * Tickets sold at a shop's counter (docs/plans/agent-shops.md phase 3). A ticket is a bet of the
 * agent's counter bettor: its legs, odds and payouts are a BetView; the ticket adds where it was
 * sold, by whom, and its life at the shop.
 */

/**
 * POST /shop/desk/tickets/check: the current price and state of each match before printing, with
 * the agent's limits. A match that has kicked off or is live is not available (reason
 * `event_started`): the cashier removes it.
 */
export const ShopTicketCheckRequest = QuoteRequest;
export type ShopTicketCheckRequest = z.infer<typeof ShopTicketCheckRequest>;
export const ShopTicketCheckResponse = QuoteResponse;
export type ShopTicketCheckResponse = z.infer<typeof ShopTicketCheckResponse>;

/**
 * POST /shop/desk/tickets: sells a ticket in the cashier's open shift; the stake leaves the agent's
 * balance. `idempotencyKey` is made once per ticket: sending it again answers with the same
 * ticket. 409 `agent_balance_low`, `selection_unavailable`, `odds_changed`, `daily_sales_limit`,
 * `shift_not_open`; 422 `slip_invalid`.
 */
export const ShopSellTicketRequest = z
  .object({
    shiftId: z.uuid(),
    legs: PlaceBetRequest.shape.legs,
    stake: PlaceBetRequest.shape.stake,
    oddsChangePolicy: OddsChangePolicySchema.default('none'),
    /** Optional: a ticket pays whoever holds it. */
    customerPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{9,15}$/)
      .optional(),
    /**
     * The booking code the player brought (6 digits, or an older letter code), printed on the
     * ticket when the ticket has exactly its matches (otherwise the ticket shows none).
     */
    bookingCode: z.string().trim().min(4).max(16).optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ShopSellTicketRequest = z.infer<typeof ShopSellTicketRequest>;

export const ShopTicketStatusSchema = z.enum(['sold', 'cancelled', 'paid', 'expired']);

/**
 * What the pay screen shows (phase 4): open (not settled), lost, payable (won or void: `payAmount`
 * is due; the cashier pays any amount alone, owner 21 Nov 2026), paid, expired, cancelled.
 */
export const TicketPayStateSchema = z.enum([
  'open',
  'lost',
  'payable',
  'paid',
  'expired',
  'cancelled',
]);
export type TicketPayState = z.infer<typeof TicketPayStateSchema>;

export const ShopTicketView = z.object({
  id: z.uuid(),
  /** The ticket number (the barcode): the bet's short id. */
  number: z.string(),
  status: ShopTicketStatusSchema,
  betStatus: BetStatusSchema,
  stake: Santim,
  soldAt: IsoDateTime,
  cancelledAt: IsoDateTime.nullable(),
  cancelReason: z.string().nullable(),
  /** Until when the selling cashier may cancel it (null once it no longer can). */
  cancellableUntil: IsoDateTime.nullable(),
  customerPhone: z.string().nullable(),
  /** The booking code the ticket was built from (printed under the barcode), or null. */
  bookingCode: z.string().nullable(),
  originalPrintedAt: IsoDateTime.nullable(),
  reprints: z.number().int(),
  shop: CashierShopView,
  cashierName: z.string(),
  bet: BetView,
  /** Phase 4: the pay screen's state, what is due or was paid, and when it was paid. */
  payState: TicketPayStateSchema,
  payAmount: Santim.nullable(),
  paidAt: IsoDateTime.nullable(),
});
export type ShopTicketView = z.infer<typeof ShopTicketView>;

/**
 * POST /shop/desk/tickets/payouts: pays a won or void ticket at the shop that sold it, in the
 * cashier's open shift: hand over `amount` and print the slip (any amount, no HQ approval: owner,
 * 21 Nov 2026). 409 `ticket_other_shop`, `ticket_not_payable` (details.state), `shift_not_open`.
 */
export const ShopPayTicketRequest = z
  .object({
    shiftId: z.uuid(),
    number: z.string().trim().min(4).max(20),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ShopPayTicketRequest = z.infer<typeof ShopPayTicketRequest>;

export const ShopPayTicketResponse = z.object({
  outcome: z.literal('paid'),
  amount: Santim,
  replayed: z.boolean(),
  ticket: ShopTicketView,
});
export type ShopPayTicketResponse = z.infer<typeof ShopPayTicketResponse>;

export const ShopTicketResponse = z.object({ ticket: ShopTicketView, replayed: z.boolean() });
export type ShopTicketResponse = z.infer<typeof ShopTicketResponse>;

/** POST /shop/desk/tickets/:id/print: the first print is the original, later ones copies. */
export const ShopTicketPrintResponse = z.object({ ticket: ShopTicketView, copy: z.boolean() });
export type ShopTicketPrintResponse = z.infer<typeof ShopTicketPrintResponse>;

/**
 * POST /shop/desk/tickets/:id/cancel (the selling cashier, within the cancel window),
 * /shop/owner/tickets/:id/cancel (the agent's owner) and /admin/retail-tickets/:id/cancel
 * (admin): before the first kick-off only. 409 `cancel_window_passed`, `ticket_match_started`,
 * `ticket_not_open`.
 */
export const ShopTicketCancelRequest = z
  .object({ reason: z.string().trim().max(200).optional() })
  .strict();
export type ShopTicketCancelRequest = z.infer<typeof ShopTicketCancelRequest>;

/** GET /shop/desk/tickets: the open shift's tickets, newest first. */
export const ShopTicketSummary = z.object({
  id: z.uuid(),
  number: z.string(),
  status: ShopTicketStatusSchema,
  stake: Santim,
  soldAt: IsoDateTime,
});
export const ShopTicketListResponse = z.object({ tickets: z.array(ShopTicketSummary) });
export type ShopTicketListResponse = z.infer<typeof ShopTicketListResponse>;

/**
 * POST /shop/desk/tickets/picks: matches by Game ID and pick (`81492` + `1`, `X`, `OV25`, `GG`…),
 * each answered with its selection and price, or why it cannot be taken.
 */
export const ShopPicksRequest = z
  .object({
    picks: z
      .array(
        z.object({
          gameId: z.number().int().positive(),
          pick: z.string().trim().min(1).max(8),
        }),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type ShopPicksRequest = z.infer<typeof ShopPicksRequest>;

export const ShopPicksResponse = z.object({
  legs: z.array(
    z.object({
      gameId: z.number().int(),
      pick: z.string(),
      selectionId: z.string().nullable(),
      oddsMilli: z.number().int().nullable(),
      /** Why the pick cannot be taken (`game_not_found`, `pick_not_offered`, …); null when it can. */
      refusal: z.string().nullable(),
    }),
  ),
});
export type ShopPicksResponse = z.infer<typeof ShopPicksResponse>;

/** GET /shop/desk/booking-codes/:code: the matches of a booking code a player made online. */
export const ShopBookingResponse = z.object({
  legs: z.array(z.object({ selectionId: z.string(), oddsMilli: z.number().int() })),
});
export type ShopBookingResponse = z.infer<typeof ShopBookingResponse>;

/**
 * PUT /admin/agents/:id/ticket-limits (agents.manage): an admin's limits for one agent's tickets;
 * a field left out takes the default. Amounts are santim strings.
 */
export const TicketLimitsRequest = z
  .object({
    minStake: Santim.optional(),
    maxStake: Santim.optional(),
    maxWin: Santim.optional(),
    maxLegs: z.number().int().min(1).max(100).optional(),
    minLegOddsMilli: z.number().int().min(1000).max(1_000_000).optional(),
    dailySales: Santim.nullable().optional(),
    cancelMinutes: z.number().int().min(0).max(1440).optional(),
    /** No longer used (owner, 21 Nov 2026: cashiers pay any winning ticket); kept so saved limits load. */
    hqApprovalAbove: Santim.optional(),
    expiryDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type TicketLimitsRequest = z.infer<typeof TicketLimitsRequest>;

/** The limits in force for an agent (`effective`) and what the admin set (`overrides`). */
export const TicketLimitsResponse = z.object({
  overrides: TicketLimitsRequest,
  effective: z.object({
    minStake: Santim,
    maxStake: Santim,
    maxWin: Santim,
    maxLegs: z.number().int(),
    minLegOddsMilli: z.number().int(),
    dailySales: Santim.nullable(),
    cancelMinutes: z.number().int(),
    hqApprovalAbove: Santim,
    expiryDays: z.number().int(),
  }),
});
export type TicketLimitsResponse = z.infer<typeof TicketLimitsResponse>;
