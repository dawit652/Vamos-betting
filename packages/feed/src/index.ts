/**
 * @vamos/feed – the odds feeds:
 * - the OddsFeedProvider contract and the deterministic mock provider
 *   (Poisson pricing and a live match simulator) of FEED_PROVIDER=mock;
 * - The Odds API client and schemas (FEED_PROVIDER=theoddsapi) and the
 *   consensus pricing that turns many bookmakers' odds into ours.
 * No database or Redis access; the only network access is the Odds API
 * client's, through the fetch it is given.
 */
export * from './types';
export * from './random';
export * from './pricing';
export * from './simulator';
export * from './mock-provider';
export * from './oddsapi/schema';
export * from './oddsapi/client';
export * from './consensus/devig';
export * from './consensus/consensus';
export * from './consensus/lines';
export * from './consensus/goals-model';
export * from './consensus/price';
export * from './oddsapi/leagues';
export * from './oddsapi/map';
