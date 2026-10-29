/**
 * Drizzle schema root. Tables are added per phase:
 * - Phase 2: accounts, sessions, KYC, responsible gambling, ledger, outbox, audit, settings, SMS
 * - Phase 3: sports catalogue and odds
 * - Phase 4: bets, bet legs, booking codes
 * - Phase 6: payments
 * - Phase 8: jackpot rounds, games and entries
 * - Phase 10: compliance (reconciliation, PSP statements, AML flags)
 * - Phase 11: SMS / USSD channels (inbound messages, USSD sessions)
 * - Data scraper: sources, runs, observations, aliases, review queue (docs/scraper.md)
 */
export * from './enums';
export * from './accounts';
export * from './ledger';
export * from './platform';
export * from './catalog';
export * from './betting';
export * from './payments';
export * from './jackpots';
export * from './compliance';
export * from './channels';
export * from './scrape';
