import type {
  BetRules,
  LegState,
  MultiBonusConfig,
  OddsChangePolicy,
  TaxConfig,
} from '@vamos/core';
import { toJsonSafe } from '../platform/json';
import type { betChannel, betStatus, betType, BetTermsJson } from '../schema/betting';
import { BetRulesSchema, MultiBonusSchema, TaxSchema } from '../settings/index';
import type { SelectionSnapshot } from './selections';

export type BetStatus = (typeof betStatus.enumValues)[number];
export type BetChannel = (typeof betChannel.enumValues)[number];
export type BetType = (typeof betType.enumValues)[number];
export type { OddsChangePolicy };

/** Statuses of a bet that is still running (My Bets "open" tab). */
export const OPEN_BET_STATUSES = ['pending_acceptance', 'open'] as const satisfies BetStatus[];
/** Statuses of a closed bet (My Bets "settled" tab). */
export const CLOSED_BET_STATUSES = [
  'won',
  'lost',
  'void',
  'cashed_out',
  'rejected',
] as const satisfies BetStatus[];
/** Statuses with a settlement posting in the ledger. */
export const SETTLED_BET_STATUSES = ['won', 'lost', 'void'] as const satisfies BetStatus[];

/** The pricing terms a bet was placed under (see BetTermsJson). */
export interface BetTerms {
  betRules: BetRules;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
}

export function serializeTerms(terms: BetTerms): BetTermsJson {
  return toJsonSafe(terms) as BetTermsJson;
}

/** Parses stored terms (throws when the row was tampered with). */
export function parseTerms(json: BetTermsJson): BetTerms {
  return {
    betRules: BetRulesSchema.parse(json.betRules),
    multiBonus: MultiBonusSchema.parse(json.multiBonus),
    tax: TaxSchema.parse(json.tax),
  };
}

/** What a cash-out paid (bet_cashouts; on the bet: settled_* and settled_at). */
export interface CashOutRecord {
  gross: bigint;
  tax: bigint;
  net: bigint;
  cashedOutAt: Date;
}

/** One leg of a bet, with its selection as it is now. */
export interface UserBetLeg {
  id: string;
  position: number;
  selectionId: string;
  marketId: string;
  eventId: string;
  /** The odds the leg is priced at. */
  oddsMilli: number;
  /** The odds the client sent. */
  requestedOddsMilli: number;
  isLive: boolean;
  state: LegState;
  /** Names, Game ID, statuses and score for display. */
  selection: SelectionSnapshot;
}

/** A bet as shown to its owner (My Bets) and returned by placement. */
export interface UserBet {
  id: string;
  shortId: string;
  userId: string;
  betType: BetType;
  status: BetStatus;
  stake: bigint;
  /** The terms the bet was placed under (settlement and cash-out price it with these). */
  terms: BetTerms;
  totalOddsMilli: bigint;
  potentialGrossPayout: bigint;
  potentialBonus: bigint;
  potentialTax: bigint;
  potentialNetPayout: bigint;
  bonusPercentBps: number;
  oddsChangePolicy: OddsChangePolicy;
  channel: BetChannel;
  settlementVersion: number;
  /** Set while the bet is settled (won / lost / void), and for a cash-out (its gross, tax, net). */
  settledGrossPayout: bigint | null;
  settledTax: bigint | null;
  settledNetPayout: bigint | null;
  placedAt: Date;
  acceptAfter: Date | null;
  acceptedAt: Date | null;
  settledAt: Date | null;
  rejectReason: string | null;
  /** Set when the bet is cashed out: what the cash-out paid (as in settled_*) and when. */
  cashedOut: CashOutRecord | null;
  legs: UserBetLeg[];
}
