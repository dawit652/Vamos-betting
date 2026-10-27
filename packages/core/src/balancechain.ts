import type { Santim } from './money';
import type { SmsDirection } from './smsparse';

/**
 * Balance reconciliation of a collection account from its own SMS (SMS
 * deposit rail, pure part). Ported from Melabingo's `balance-chain.ts`.
 *
 * Every confirmation ends with "Your account balance is ETB X": the
 * institution stating the true balance of our collection account on every
 * transaction. Over any window,
 *
 *     balance(last) − balance(first) = Σ signed amounts after the first
 *
 * A forged message has to invent a balance, and the next genuine message
 * carries the real one, so the sum stops adding up by exactly the forged
 * amount. This needs no endpoint, which is why it is the only independent
 * check for CBE. Summed over a window rather than chained message to message
 * because forwarded SMS overtake each other routinely.
 */

export interface BalanceObservation {
  /** The institution's reported balance after this transaction. */
  balance: Santim;
  amount: Santim;
  direction: SmsDirection;
  /** When it happened (or was received). */
  at: Date;
}

export type BalanceReconciliation =
  | { status: 'consistent'; observations: number; movement: Santim }
  | {
      status: 'drift';
      observations: number;
      expected: Santim;
      actual: Santim;
      /**
       * actual − expected. Negative: we acted on more than arrived (the
       * forgery signature). Positive: money arrived that no message covered
       * (the handset missed messages; players are waiting).
       */
      drift: Santim;
      direction: 'credited_more_than_arrived' | 'missed_incoming';
    }
  | { status: 'insufficient_data'; observations: number };

export function signedSmsAmount(o: Pick<BalanceObservation, 'amount' | 'direction'>): Santim {
  return o.direction === 'credit' ? o.amount : -o.amount;
}

/**
 * Reconciles one collection account's messages over a window. The first
 * observation (by time) is the anchor: its balance is the state after it, so
 * its own amount is not counted. Order-independent: the input order does not
 * change the result.
 */
export function reconcileBalances(
  observations: readonly BalanceObservation[],
): BalanceReconciliation {
  const ordered = [...observations].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (ordered.length < 2) return { status: 'insufficient_data', observations: ordered.length };
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const actual = last.balance - first.balance;
  const expected = ordered.slice(1).reduce((sum, o) => sum + signedSmsAmount(o), 0n);
  const drift = actual - expected;
  if (drift === 0n) {
    return { status: 'consistent', observations: ordered.length, movement: actual };
  }
  return {
    status: 'drift',
    observations: ordered.length,
    expected,
    actual,
    drift,
    direction: drift < 0n ? 'credited_more_than_arrived' : 'missed_incoming',
  };
}
