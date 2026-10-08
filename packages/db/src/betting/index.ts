/**
 * Bets: placement, live acceptance, settlement (with corrections), booking
 * codes and the My Bets queries. Pure DB + @vamos/core; money is bigint
 * santim, time comes from the caller's `now`. Errors meant for players are
 * DomainError (see each function); anything else is a bug or an outage.
 */
export {
  BET_ACCEPTED,
  BET_CORRECTION_BLOCKED,
  BET_PLACED,
  BET_REJECTED,
  BET_REOPENED,
  BET_SETTLED,
} from './events';
export {
  oddsChangedError,
  placeBet,
  potentialOf,
  quoteSlip,
  selectionUnavailableError,
  slipInvalidError,
  type GameSettingsForBets,
  type PlaceBetInput,
  type PlaceBetResult,
  type QuotedLeg,
  type QuoteSlipInput,
  type SlipLegInput,
  type SlipQuote,
  type UnavailableSelection,
} from './place';
export {
  acceptPendingBet,
  listDuePendingBets,
  rejectPendingBet,
  type AcceptPendingResult,
  type RejectReason,
} from './accept';
export {
  listBetIdsForEvent,
  settleEventBets,
  settlePlacedBet,
  type SettleBetResult,
  type SettleEventSummary,
  type SettleOutcome,
} from './settle';
export {
  BOOKING_CODE_TTL_MS,
  createBookingCode,
  loadBookingCode,
  type BookingCode,
  type BookingLeg,
  type CreateBookingCodeInput,
} from './booking';
export {
  decodeBetCursor,
  encodeBetCursor,
  getBetById,
  getUserBet,
  listUserBets,
  MAX_BET_PAGE_SIZE,
  type ListUserBetsOptions,
  type UserBetPage,
} from './queries';
export {
  loadPostingEntries,
  negateEntries,
  refundEntries,
  rejectionLedgerKey,
  reversalLedgerKey,
  settlementLedgerKey,
  settlementPosting,
  stakeEntries,
  stakeLedgerKey,
  type SettlementAmounts,
  type SettlementPosting,
} from './postings';
export {
  isUuid,
  loadSelectionSnapshots,
  unavailableReason,
  type SelectionSnapshot,
  type UnavailableReason,
} from './selections';
export {
  CLOSED_BET_STATUSES,
  OPEN_BET_STATUSES,
  parseTerms,
  serializeTerms,
  SETTLED_BET_STATUSES,
  type BetChannel,
  type BetStatus,
  type BetTerms,
  type BetType,
  type OddsChangePolicy,
  type UserBet,
  type UserBetLeg,
} from './types';
