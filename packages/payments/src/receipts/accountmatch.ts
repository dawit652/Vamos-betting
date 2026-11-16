/**
 * Comparing a (possibly masked) account number on a receipt with one of our
 * collection accounts. The logic lives in `@vamos/core` (receiptaccount.ts)
 * so the pure double-proof payout rule can use it; this module re-exports it
 * unchanged for the receipt verifier.
 */
export { receiptAccountMatches, receiptMatchesAnyAccount } from '@vamos/core';
