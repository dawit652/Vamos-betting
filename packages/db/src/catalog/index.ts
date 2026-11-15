/**
 * Write side of the sports catalogue, shared by the worker (feed ingest, live
 * simulator) and the back office (trading). Every function that changes what
 * players see returns LiveMessage deltas; publish them on LIVE_CHANNEL only
 * after the transaction has committed.
 */
export { MARKET_SUSPENDED_BY, type MarketSuspendedBy } from '../schema/catalog';
export {
  CatalogError,
  CatalogNotFoundError,
  CatalogStateError,
  isUniqueViolation,
  postgresErrorOf,
} from './errors';
export {
  allocateGameId,
  GAME_ID_CONSTRAINT,
  GAME_ID_FALLBACK_RANGE,
  GAME_ID_RANGE,
  type AllocateGameIdOptions,
} from './game-id';
export {
  isSelectionBettable,
  LIVE_CHANNEL,
  MAX_CLOSE_LEAD_MS,
  prematchClosesAt,
  type BettableEvent,
  marketMessage,
  matchMessage,
  oddsMessage,
  type EventStatus,
  type LiveMessage,
  type MarketDeltaData,
  type MarketStatus,
  type MatchDeltaData,
  type MatchDeltaSource,
  type OddsDeltaData,
  type SelectionStatus,
} from './live';
export { raiseCloseLead } from './close-lead';
export {
  MANUAL_ODDS_SOURCE,
  oddsProvenance,
  setManualOdds,
  setSelectionOdds,
  type ChangedOdds,
  type ManualOddsOptions,
  type OddsChange,
  type OddsProvenance,
  type SetOddsOptions,
  type SetOddsResult,
} from './odds';
export {
  FEED_ODDS_SOURCE,
  upsertFixture,
  type FixtureMarketInput,
  type UpsertFixtureInput,
  type UpsertFixtureOptions,
  type UpsertFixtureResult,
} from './fixtures';
export {
  applyLiveState,
  lockEvent,
  resumeEvent,
  setEventBettingOpen,
  setMarketStatus,
  suspendEvent,
  type CatalogChange,
  type LiveStateInput,
  type TradingActor,
  type TradingMarketStatus,
} from './status';
export {
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  MARKET_RESULTED,
  resultEvent,
  resultMarket,
  type ResultEventOutcome,
  type ResultMarketInput,
  type ResultMarketOutcome,
  type ResultScore,
  type ResultStatus,
} from './results';
export {
  MARKET_VOIDED,
  MAX_VOID_REASON_LENGTH,
  SELECTION_VOIDED,
  voidMarket,
  voidSelection,
  type VoidActor,
  type VoidOutcome,
} from './void';
export {
  ensureSimulationSeed,
  listScheduledEventIds,
  listScheduledFeedEvents,
  listSimulationCandidates,
  loadCatalogIds,
  lockEventForSimulation,
  marketsWithSelections,
  type CatalogIds,
  type EventForSimulation,
  type MarketWithSelections,
  type ScheduledFeedEvent,
  type SimulationCandidate,
} from './queries';
