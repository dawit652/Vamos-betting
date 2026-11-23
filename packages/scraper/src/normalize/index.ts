export {
  LEGAL_FORM_TOKENS,
  legalFormStripped,
  NAME_AFFIX_TOKENS,
  nameTokens,
  normalizeName,
  SPONSOR_PREFIX_TOKENS,
} from './name';
export {
  SUGGESTION_MIN_SCORE,
  buildAliasIndex,
  nameSimilarity,
  resolveCompetition,
  resolveTeam,
  suggestCompetitions,
  suggestTeams,
  teamCatalogueNames,
} from './alias';
export type {
  AliasCompetition,
  AliasIndex,
  AliasIndexInput,
  AliasTeam,
  CompetitionAliasRow,
  Resolution,
  ResolveQuery,
  SuggestQuery,
  Suggestion,
  TeamAliasRow,
} from './alias';
export { isValidTimeZone, localDateOf, zonedToUtc } from './time';
export type { ZonedFailure, ZonedInput, ZonedResult } from './time';
export { fixtureKey } from './fixture-key';
export type { FixtureKeyInput } from './fixture-key';
export { catalogueGaps } from './gaps';
export type { GapObservation, GapRow } from './gaps';
export {
  combineFixtureContexts,
  fixtureContextSuggestions,
  FIXTURE_CONTEXT_WINDOW_MS,
  STRONG_FIXTURE_SIMILARITY,
} from './fixture-context';
export type {
  CatalogueFixture,
  FixtureContextCandidate,
  FixtureContextQuery,
  FixtureContextResult,
  FixtureSide,
} from './fixture-context';
export { AUTO_ALIAS_MIN_FIXTURES } from './fixture-context';
export { suspiciousAlias, variantConflict, variantsOf } from './variant';
export type { TeamVariant } from './variant';
