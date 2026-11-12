/**
 * The gates (docs/scraper.md section 6): pure decision functions between
 * scraped observations and the catalogue. No I/O, no clock, no randomness.
 * Decisions are discriminated unions whose actions cannot express a forbidden
 * change: nothing here can cancel, void or abandon an event, and nothing is
 * derived from the absence of data.
 */
export * from './review';
export * from './confirmation';
export * from './result';
export * from './ladder';
export * from './fixture';
export * from './conflict-close';
export * from './kickoff';
export * from './missing';
export * from './shape';
export * from './odds';
export * from './half-time';
