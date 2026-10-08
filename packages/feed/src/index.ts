/**
 * @vamos/feed – the OddsFeedProvider contract plus a deterministic mock
 * provider (Poisson pricing and a live match simulator) used in demo mode.
 * Pure: no database, Redis or network access.
 */
export * from './types';
export * from './random';
export * from './pricing';
export * from './simulator';
export * from './mock-provider';
