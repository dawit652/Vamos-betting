/**
 * Jackpots (Phase 8): rounds of 1X2 games, entries priced per combination,
 * closing at the first kick-off, settlement with prize tiers and the
 * cancelled-game rule, and the queries behind the jackpot pages and the
 * My Bets jackpot tab. Pure DB + @vamos/core; money is bigint santim, time
 * comes from the caller's `now`. Errors meant for players are DomainError
 * (see each function); anything else is a bug or an outage.
 *
 * Ledger (every posting in the transaction of its business row and outbox
 * event):
 * | Event        | Type            | Key                                  | Entries                                                      |
 * | ------------ | --------------- | ------------------------------------ | ------------------------------------------------------------ |
 * | Entry        | `jackpot_entry` | `jackpot_entry:<userId>:<clientKey>` | player_cash −cost, house_jackpot +cost                       |
 * | Prize        | `jackpot_prize` | `jackpot_prize:<entryId>`            | house_jackpot −gross, player_cash +net, house_tax_payable +tax |
 * | Refund (void)| `jackpot_entry` | `jackpot_refund:<entryId>`           | house_jackpot −cost, player_cash +cost                       |
 * Lost entries post nothing: their cost stays in house_jackpot, as does
 * shared-pool money nobody won. house_jackpot may go negative (the house
 * guarantees the advertised prizes).
 */
export {
  JACKPOT_ENTERED,
  JACKPOT_RESULT_MISMATCH,
  JACKPOT_ROUND_CLOSED,
  JACKPOT_ROUND_OPENED,
  JACKPOT_ROUND_SETTLED,
  JACKPOT_SETTLED,
} from './events';
export {
  canonicalPicks,
  jackpotEntryEntries,
  jackpotEntryInvalidError,
  jackpotEntryLedgerKey,
  jackpotPrizeEntries,
  jackpotPrizeLedgerKey,
  jackpotRefundEntries,
  jackpotRefundLedgerKey,
  placeJackpotEntry,
  type PlaceJackpotEntryInput,
  type PlaceJackpotEntryResult,
} from './entries';
export {
  catalogueGameResult,
  loadJackpotGames,
  type GameResultSource,
  type LoadedJackpotGame,
} from './games';
export {
  closeDueJackpotRounds,
  createJackpotRound,
  ensureJackpotRound,
  isRoundDue,
  JACKPOT_MARKET_KEY,
  JACKPOT_SPORT,
  jackpotClosedError,
  listJackpotCandidateEvents,
  openJackpotRound,
  type CloseDueRoundsResult,
  type CreateJackpotRoundInput,
  type EnsureJackpotRoundInput,
  type EnsureJackpotRoundResult,
  type JackpotCandidateEvent,
  type JackpotEventProblem,
  type ListJackpotCandidateEventsOptions,
} from './rounds';
export {
  listJackpotRoundIdsForEvent,
  listJackpotRoundIdsForMarket,
  listJackpotRoundsToSettle,
  settleJackpotRound,
  type SettleJackpotOutcome,
  type SettleJackpotRoundResult,
} from './settle';
export {
  encodeRoundCursor,
  getJackpotRound,
  getUserJackpotEntry,
  listOpenJackpotRounds,
  listRecentJackpotRounds,
  listUserJackpotEntries,
  MAX_JACKPOT_PAGE_SIZE,
  toJackpotRounds,
  toUserJackpotEntries,
  type JackpotRoundPage,
  type ListUserJackpotEntriesOptions,
  type UserJackpotEntryPage,
} from './queries';
export {
  FINAL_ROUND_STATUSES,
  OUTCOMES_1X2,
  parseRoundTerms,
  parseSettlement,
  PAST_ROUND_STATUSES,
  SETTLED_ENTRY_STATUSES,
  UNSETTLED_ROUND_STATUSES,
  type JackpotActor,
  type JackpotChannel,
  type JackpotEntryStatus,
  type JackpotGame,
  type JackpotRound,
  type JackpotRoundSettlement,
  type JackpotRoundStatus,
  type JackpotRoundTerms,
  type JackpotTemplateCode,
  type JackpotVoidReason,
  type UserJackpotEntry,
} from './types';
