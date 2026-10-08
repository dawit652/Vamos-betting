/**
 * Write side of the sports catalogue, shared by the worker (feed ingest, live
 * simulator) and the back office (trading). Every function that changes what
 * players see returns LiveMessage deltas; publish them on LIVE_CHANNEL only
 * after the transaction has committed.
 */
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
export {
  MANUAL_ODDS_SOURCE,
  oddsProvenance,
  setManualOdds,
  setSelectionOdds,
  type ChangedOdds,
  type ManualOddsOptions,
  type OddsChange,
  type OddsProvenance,
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
  resultEvent,
  type ResultEventOutcome,
  type ResultScore,
  type ResultStatus,
} from './results';
export {
  listScheduledEventIds,
  listSimulationCandidates,
  loadCatalogIds,
  lockEventForSimulation,
  marketsWithSelections,
  type CatalogIds,
  type EventForSimulation,
  type MarketWithSelections,
  type SimulationCandidate,
} from './queries';
