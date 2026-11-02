/**
 * The data scraper's database layer (docs/scraper.md section 4): sources and
 * competition policy, runs and raw snapshots, current observations and their
 * append-only history, aliases, the review queue, ratings bookkeeping and the
 * queries over scraped events. Structural types only: this package does not
 * import @vamos/scraper.
 */
export {
  ScrapeAliasConflictError,
  ScrapeReviewStateError,
  ScrapeRunStateError,
  type ScrapeActor,
} from './common';
export {
  getSource,
  listSources,
  setSourceEnabled,
  upsertSource,
  type ScrapeSource,
  type UpsertSourceInput,
} from './sources';
export {
  getCompetitionPolicy,
  listCompetitionPolicies,
  setCompetitionPolicy,
  type CompetitionPolicy,
  type CompetitionPolicyFlags,
  type CompetitionPolicyRow,
} from './policy';
export {
  apiCreditUsage,
  capIssues,
  finishRun,
  listRecentRuns,
  MAX_RUN_ERROR_LENGTH,
  MAX_RUN_ISSUES,
  recentAcceptedCounts,
  sourceHealth,
  startRun,
  type ApiCreditUsage,
  type FinishRunInput,
  type ScrapeRun,
  type ScrapeRunIssueJson,
  type ScrapeRunTrigger,
  type SourceHealth,
} from './runs';
export {
  deleteRaw,
  latestAcceptedRaw,
  listPrunableRaw,
  markRawKeep,
  recordRaw,
  type RecordRawInput,
  type ScrapeRawRecord,
} from './raw';
export {
  listCurrentObservations,
  listObservationHistory,
  listUnresolvedObservations,
  observationPayloadHash,
  setObservationResolution,
  touchObservationsOfRaw,
  upsertObservation,
  type ListObservationsQuery,
  type ObservationHistoryRow,
  type ObservationKind,
  type ObservationScore,
  type ScrapeObservationRow,
  type UpsertObservationInput,
  type UpsertObservationResult,
} from './observations';
export {
  findScrapedEventId,
  latestMarketOdds,
  linkMarketOddsToEvents,
  listUnresolvedMarketOddsNames,
  nextMarketOddsKickoffs,
  pruneMarketOdds,
  setMarketOddsResolution,
  touchMarketOddsOfRaw,
  upsertMarketOdds,
  type LatestMarketOdd,
  type LatestMarketOddsQuery,
  type MarketOddsInput,
  type UnresolvedMarketOddsNames,
} from './market-odds';
export {
  addCompetitionAlias,
  addTeamAlias,
  listAliases,
  loadAliasInputs,
  localizedNames,
  removeAlias,
  type AliasInputs,
  type AliasKind,
  type AliasListRow,
  type AliasRecord,
  type CompetitionAliasInput,
  type TeamAliasInput,
} from './aliases';
export {
  closeReviewItemsBySubject,
  countReviewItemsByKind,
  getReviewItem,
  listReviewItems,
  openReviewItem,
  resolveReviewItem,
  type ListReviewItemsQuery,
  type OpenReviewItemInput,
  type ScrapeReviewItem,
} from './review';
export { listEventPricing, recordEventHeld, recordEventPriced, type EventPricing } from './pricing';
export { listSourceContentFacts, type SourceContentFacts } from './staleness';
export {
  KICKOFF_CONFIRMED_AUDIT_ACTION,
  listSourceKickoffFacts,
  loadKickoffEvidence,
  recordKickoffConfirmation,
  type KickoffEventFacts,
  type KickoffEvidence,
  type KickoffPersonRow,
  type KickoffStatementRow,
  type KickoffThresholds,
  type LoadKickoffEvidenceOptions,
  type RecordKickoffConfirmationInput,
  type SourceKickoffFacts,
} from './kickoff';
export {
  competitionGoalEvidence,
  getTeamRatings,
  markRatingApplied,
  setTeamRatings,
  type CompetitionGoalEvidence,
  type TeamRatings,
} from './ratings';
export {
  DEFAULT_LISTED_WINDOW_MS,
  getEventExposure,
  listScrapedEvents,
  type EventExposure,
  type ListScrapedEventsQuery,
  type ScrapedEvent,
  type ScrapedEventStatus,
} from './events';
