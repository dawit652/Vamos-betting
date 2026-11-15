import type { Santim } from '@vamos/core';

/**
 * Receipt verification (SMS rail, ported from Melabingo): confirming a
 * payment against the institution's own public receipt page rather than
 * trusting the SMS that announced it. Whoever holds the collection handset
 * can compose any SMS; they cannot make Ethio Telecom serve a receipt for a
 * payment that never reached our account.
 */

/**
 * What a receipt page told us. Every field is nullable: a page whose layout
 * drifted costs the fields that moved, not the whole verification.
 */
export interface ReceiptFacts {
  /** The reference the page itself reports. */
  reference: string | null;
  /**
   * Every currency figure on the page not introduced by a balance word, in
   * document order (amount, fee, VAT, total…). "The expected amount is among
   * them" survives label drift and is tighter than trusting one field.
   */
  amounts: Santim[];
  payerName: string | null;
  /** Possibly masked by the institution (251911***426). */
  payerAccount: string | null;
  receiverName: string | null;
  receiverAccount: string | null;
  /** null when the page does not say. */
  completed: boolean | null;
  occurredAt: Date | null;
}

export type ReceiptRejectReason =
  /** The page says there is no such transaction. */
  | 'not_a_receipt'
  /** The page describes another transaction than the one asked about. */
  | 'reference_mismatch'
  /** A real payment, but not to one of our collection accounts. */
  | 'receiver_not_ours'
  /** The expected amount appears nowhere on the receipt. */
  | 'amount_absent'
  | 'not_completed';

export type ReceiptIndeterminateReason =
  /** Fetched, but the page no longer parses (or its receiver cannot be read). */
  | 'unparseable'
  /** Refused, unreachable, redirected or a 5xx. */
  | 'unavailable'
  | 'timeout'
  /** The circuit breaker is open: nothing was sent. */
  | 'breaker_open';

/**
 * `rejected`: the institution contradicts the claim. `indeterminate`: we
 * could not find out (never treat it as a rejection: an Ethio Telecom
 * outage must not stop real deposits). `skipped`: the institution has no
 * readable receipt page (CBE: balance reconciliation covers it).
 */
export type ReceiptVerdict =
  | { status: 'verified'; facts: ReceiptFacts; amount: Santim }
  | {
      status: 'rejected';
      reason: ReceiptRejectReason;
      facts: ReceiptFacts | null;
      rawSample: string;
    }
  | { status: 'indeterminate'; reason: ReceiptIndeterminateReason; rawSample: string }
  | { status: 'skipped'; reason: 'institution_unsupported' };

export interface ReceiptVerifyRequest {
  /** Institution id (core INSTITUTIONS); decides whether a verifier exists. */
  institution: string;
  /** The reference to look up; the URL is built from it, never taken from an SMS. */
  reference: string;
  /** Our collection accounts at this institution: the receipt's receiver must be one. */
  receiverAccounts: readonly string[];
  /**
   * The amount that must appear. Omitted on the player's check, where the
   * caller intersects `facts.amounts` with that player's own open deposits.
   */
  amount?: Santim;
}

export interface ReceiptVerifier {
  verify(request: ReceiptVerifyRequest): Promise<ReceiptVerdict>;
  /** For the health panel: is the breaker open right now. */
  state(): { breaker: 'closed' | 'open' | 'half_open'; consecutiveFailures: number };
}
