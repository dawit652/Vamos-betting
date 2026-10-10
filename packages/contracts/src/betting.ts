import { z } from 'zod';
import { LocalizedNameSchema, SportCodeSchema } from './catalog';
import { Id, OddsMilli, PageQuery, Santim } from './common';

/**
 * Betslip, bet placement, booking codes and "My bets".
 * Money is santim as a decimal string; odds are integer milli.
 */

/** A positive stake in santim (decimal string). */
export const Stake = Santim.refine((value) => !value.startsWith('-') && /[1-9]/.test(value), {
  message: 'stake must be a positive amount of santim',
});

/**
 * What to do when a price moved between the slip and placement:
 * - none: reject the bet if any price changed
 * - higher: accept price rises (at the new price), reject drops
 * - any: accept the current prices whatever they are
 */
export const OddsChangePolicySchema = z.enum(['none', 'higher', 'any']);
export type OddsChangePolicy = z.infer<typeof OddsChangePolicySchema>;

export const BetChannelSchema = z.enum(['web', 'sms', 'ussd']);
export type BetChannel = z.infer<typeof BetChannelSchema>;

export const BetStatusSchema = z.enum([
  'pending_acceptance',
  'open',
  'won',
  'lost',
  'void',
  'cashed_out',
  'rejected',
]);
export type BetStatus = z.infer<typeof BetStatusSchema>;

export const LegStateSchema = z.enum(['open', 'won', 'lost', 'void']);
export type LegState = z.infer<typeof LegStateSchema>;

const MAX_SLIP_LEGS = 40;

export const SlipLegInput = z.object({
  selectionId: Id,
  /** The price the player saw. Required for placement, ignored for a quote. */
  oddsMilli: OddsMilli,
});
export type SlipLegInput = z.infer<typeof SlipLegInput>;

export const QuoteRequest = z.object({
  legs: z
    .array(
      z.object({
        selectionId: Id,
        /** The price the player saw, if any: the leg then reports `oddsChanged`. */
        oddsMilli: OddsMilli.optional(),
      }),
    )
    .min(1)
    .max(MAX_SLIP_LEGS),
  stake: Stake,
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const SlipErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  selectionId: z.string().optional(),
  eventId: z.string().optional(),
});
export type SlipErrorView = z.infer<typeof SlipErrorSchema>;

/**
 * Why a selection cannot be bet on now:
 * - not_found: no such selection
 * - inactive: its sport or competition is switched off
 * - event_started: prematch betting closed at the start time
 * - event_closed: the event is finished, cancelled, postponed or abandoned
 * - suspended: betting on the event, the market or the selection is suspended
 * - market_closed: the market is closed, settled or void
 */
export const UnavailableReasonSchema = z.enum([
  'not_found',
  'inactive',
  'event_started',
  'event_closed',
  'suspended',
  'market_closed',
]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const QuoteLeg = z.object({
  selectionId: z.string(),
  eventId: z.string().nullable(),
  gameId: z.string().nullable(),
  eventName: z.string().nullable(),
  marketName: LocalizedNameSchema.nullable(),
  selectionName: LocalizedNameSchema.nullable(),
  /** The current price (null when the selection does not exist). */
  oddsMilli: z.number().int().nullable(),
  /** The price the client sent (quotes only; null when none was sent). */
  requestedOddsMilli: z.number().int().nullable(),
  /** A price was sent and it differs from the current one. */
  oddsChanged: z.boolean(),
  /** false when the selection is unknown, suspended or no longer bettable. */
  available: z.boolean(),
  /** Why the selection is not available (null when it is). */
  reason: UnavailableReasonSchema.nullable(),
  /** The event is live: a bet waits for delayed acceptance. */
  live: z.boolean(),
});
export type QuoteLeg = z.infer<typeof QuoteLeg>;

export const QuoteResponse = z.object({
  betType: z.enum(['single', 'multi']),
  legs: z.array(QuoteLeg),
  stake: Santim,
  /** Product of the leg odds, in milli; a string because it can exceed 2^53. */
  totalOddsMilli: z.string(),
  grossReturn: Santim,
  bonusPercentBps: z.number().int(),
  bonusAmount: Santim,
  grossPayout: Santim,
  cappedByMaxPayout: z.boolean(),
  taxAmount: Santim,
  netPayout: Santim,
  errors: z.array(SlipErrorSchema),
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

export const PlaceBetRequest = z.object({
  legs: z.array(SlipLegInput).min(1).max(MAX_SLIP_LEGS),
  stake: Stake,
  oddsChangePolicy: OddsChangePolicySchema.default('none'),
});
export type PlaceBetRequest = z.infer<typeof PlaceBetRequest>;

export const BetLegView = z.object({
  selectionId: z.string(),
  eventId: z.string(),
  gameId: z.string(),
  sport: SportCodeSchema,
  /** "Home vs Away" in English (kept for older clients; show `homeTeam` / `awayTeam`). */
  eventName: z.string(),
  /** The teams' names in every language the catalogue has (render with the player's locale). */
  homeTeam: LocalizedNameSchema,
  awayTeam: LocalizedNameSchema,
  startTime: z.string(),
  marketName: LocalizedNameSchema,
  selectionName: LocalizedNameSchema,
  oddsMilli: z.number().int(),
  live: z.boolean(),
  state: LegStateSchema,
});
export type BetLegView = z.infer<typeof BetLegView>;

export const BetView = z.object({
  id: z.string(),
  shortId: z.string(),
  betType: z.enum(['single', 'multi']),
  status: BetStatusSchema,
  channel: BetChannelSchema,
  oddsChangePolicy: OddsChangePolicySchema,
  stake: Santim,
  totalOddsMilli: z.string(),
  potentialGross: Santim,
  bonusPercentBps: z.number().int(),
  potentialBonus: Santim,
  potentialTax: Santim,
  potentialNet: Santim,
  /** Set once the bet is settled (won, lost, void or cashed out). */
  settledGross: Santim.nullable(),
  settledTax: Santim.nullable(),
  settledNet: Santim.nullable(),
  rejectReason: z.string().nullable(),
  placedAt: z.string(),
  /** While `pending_acceptance`: when the live delay ends. */
  acceptAfter: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  legs: z.array(BetLegView),
});
export type BetView = z.infer<typeof BetView>;

export const MyBetsQuery = PageQuery.extend({
  status: z.enum(['open', 'settled']).default('open'),
});
export type MyBetsQuery = z.infer<typeof MyBetsQuery>;

export const MyBetsResponse = z.object({
  items: z.array(BetView),
  nextCursor: z.string().nullable(),
});
export type MyBetsResponse = z.infer<typeof MyBetsResponse>;

export const CreateBookingCodeRequest = z.object({
  legs: z
    .array(z.object({ selectionId: Id }))
    .min(1)
    .max(MAX_SLIP_LEGS),
});
export type CreateBookingCodeRequest = z.infer<typeof CreateBookingCodeRequest>;

export const BookingCodeResponse = z.object({
  code: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  legs: z.array(QuoteLeg),
});
export type BookingCodeResponse = z.infer<typeof BookingCodeResponse>;
