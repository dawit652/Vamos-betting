import type {
  JackpotGameResult,
  JackpotTemplate,
  Outcome1X2,
  TaxConfig,
  TierPayout,
} from '@vamos/core';
import { z } from 'zod';
import type { EventStatus } from '../catalog/live';
import { toJsonSafe } from '../platform/json';
import type { betChannel } from '../schema/betting';
import type { LocalizedName } from '../schema/catalog';
import type {
  jackpotEntries,
  jackpotEntryStatus,
  jackpotRounds,
  jackpotRoundStatus,
  JackpotRoundTermsJson,
  JackpotSettlementJson,
} from '../schema/jackpots';
import { JackpotTemplateSchema, TaxSchema } from '../settings/index';

export type JackpotRoundStatus = (typeof jackpotRoundStatus.enumValues)[number];
export type JackpotEntryStatus = (typeof jackpotEntryStatus.enumValues)[number];
export type JackpotTemplateCode = JackpotTemplate['code'];
export type JackpotChannel = (typeof betChannel.enumValues)[number];
export type JackpotRoundRow = typeof jackpotRounds.$inferSelect;
export type JackpotEntryRow = typeof jackpotEntries.$inferSelect;

/** The outcomes in display order; picks are stored in this order. */
export const OUTCOMES_1X2 = ['1', 'X', '2'] as const satisfies readonly Outcome1X2[];

/** Rounds taking entries or waiting for results. */
export const UNSETTLED_ROUND_STATUSES = [
  'scheduled',
  'open',
  'closed',
] as const satisfies readonly JackpotRoundStatus[];
/** Rounds whose money is final. */
export const FINAL_ROUND_STATUSES = [
  'settled',
  'cancelled',
] as const satisfies readonly JackpotRoundStatus[];
/** Rounds shown as results / history (no longer taking entries). */
export const PAST_ROUND_STATUSES = [
  'closed',
  'settled',
  'cancelled',
] as const satisfies readonly JackpotRoundStatus[];
/** Entry statuses of the My Bets jackpot tab "settled" filter. */
export const SETTLED_ENTRY_STATUSES = [
  'won',
  'lost',
  'void',
] as const satisfies readonly JackpotEntryStatus[];

/** Who did something to a round: the worker, or a person in the back office. */
export type JackpotActor = { type: 'system' } | { type: 'admin'; id: string; ip?: string | null };

/**
 * The terms a round was opened with: the template as it was (its own
 * game count, prices and prize tiers) and the winnings tax in force.
 */
export interface JackpotRoundTerms {
  template: JackpotTemplate;
  tax: TaxConfig;
}

export function serializeRoundTerms(terms: JackpotRoundTerms): JackpotRoundTermsJson {
  return toJsonSafe(terms) as JackpotRoundTermsJson;
}

/** Parses stored round terms (throws when the row was tampered with). */
export function parseRoundTerms(json: JackpotRoundTermsJson): JackpotRoundTerms {
  return {
    template: JackpotTemplateSchema.parse(json.template),
    tax: TaxSchema.parse(json.tax),
  };
}

/** Why a round is void. */
export type JackpotVoidReason = 'cancelled_games' | 'not_opened';

/** The settlement summary of a settled or cancelled round. */
export interface JackpotRoundSettlement {
  void: boolean;
  voidReason: JackpotVoidReason | null;
  /** Each game's result, in game order ([] when the round never opened). */
  results: JackpotGameResult[];
  cancelledGames: number;
  entries: number;
  /** Entries with a prize above zero. */
  winners: number;
  /** Σ entry costs. */
  stakes: bigint;
  /** Σ prizes before tax, Σ tax, Σ paid. */
  gross: bigint;
  tax: bigint;
  net: bigint;
  /** Σ costs refunded (void round). */
  refunds: bigint;
  /** Shared-pool money nobody won: it stays with the house. */
  undistributed: bigint;
  /** Every prize tier as settled, in tier order (empty when void). */
  payouts: TierPayout[];
}

const amount = z
  .string()
  .regex(/^-?\d+$/)
  .transform(BigInt);
const count = z.number().int().min(0);

const SettlementSchema = z.object({
  void: z.boolean(),
  voidReason: z.enum(['cancelled_games', 'not_opened']).nullable(),
  results: z.array(z.enum(['1', 'X', '2', 'cancelled'])),
  cancelledGames: count,
  entries: count,
  winners: count,
  stakes: amount,
  gross: amount,
  tax: amount,
  net: amount,
  refunds: amount,
  undistributed: amount,
  payouts: z.array(
    z.object({
      correct: count,
      kind: z.enum(['shared', 'fixed']),
      winningCombinations: amount,
      prizePerCombination: amount,
      total: amount,
      undistributed: amount,
    }),
  ),
});

export function serializeSettlement(settlement: JackpotRoundSettlement): JackpotSettlementJson {
  return toJsonSafe(settlement) as JackpotSettlementJson;
}

export function parseSettlement(json: JackpotSettlementJson): JackpotRoundSettlement {
  return SettlementSchema.parse(json);
}

/** One game of a round with its event as it is now. */
export interface JackpotGame {
  /** 0-based game order. */
  position: number;
  eventId: string;
  /** The event's 1X2 market and its selections. */
  marketId: string;
  selectionIds: Record<Outcome1X2, string>;
  gameId: number;
  sportId: string;
  competitionName: LocalizedName;
  homeTeam: LocalizedName;
  awayTeam: LocalizedName;
  startTime: Date;
  eventStatus: EventStatus;
  scoreHome: number | null;
  scoreAway: number | null;
  /** The 1X2 odds now, for information only (null once the market is not open). */
  odds: Record<Outcome1X2, number> | null;
  /**
   * The result recorded on the round: null until known; final once the
   * round is settled (a later correction only flags the round).
   */
  result: JackpotGameResult | null;
}

/** A round as shown to players (and used by the services). */
export interface JackpotRound {
  id: string;
  templateCode: JackpotTemplateCode;
  status: JackpotRoundStatus;
  /** The frozen terms (template and tax) the round was opened with. */
  template: JackpotTemplate;
  tax: TaxConfig;
  gameCount: number;
  costPerCombination: bigint;
  maxCombinations: number;
  /** The advertised jackpot: the amount of the first (all-correct) prize tier. */
  pool: bigint;
  /** Entries close here (the first kick-off). */
  closesAt: Date;
  createdAt: Date;
  closedAt: Date | null;
  settledAt: Date | null;
  /** Set once settled or cancelled. */
  settlement: JackpotRoundSettlement | null;
  /** A result changed after settlement (never paid again; for the back office). */
  resultsFlaggedAt: Date | null;
  games: JackpotGame[];
}

/** A player's entry with its round, as shown to its owner. */
export interface UserJackpotEntry {
  id: string;
  userId: string;
  roundId: string;
  status: JackpotEntryStatus;
  channel: JackpotChannel;
  /** One array of picks per game, in game order, each in '1', 'X', '2' order. */
  picks: Outcome1X2[][];
  combinations: number;
  cost: bigint;
  /** Combinations by exact number of correct predictions (won / lost only). */
  correct: bigint[] | null;
  bestCorrect: number | null;
  /** The prize once settled (0 when lost or void), null while open. */
  prizeGross: bigint | null;
  prizeTax: bigint | null;
  prizeNet: bigint | null;
  /** The cost refunded when the round was void, else null. */
  refund: bigint | null;
  placedAt: Date;
  settledAt: Date | null;
  round: JackpotRound;
}
