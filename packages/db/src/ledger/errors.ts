/** Base class for ledger rule violations (bad input, idempotency misuse…). */
export class LedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LedgerError';
  }
}

/**
 * A debit would take an account that may not go negative below zero.
 * `amount` is the requested debit in santim (positive); `available` is the
 * account balance at the time of the attempt.
 */
export class InsufficientFundsError extends LedgerError {
  readonly accountKey: string;
  readonly amount: bigint;
  readonly available: bigint;

  constructor(accountKey: string, amount: bigint, available: bigint) {
    super(`insufficient funds in ${accountKey}: requested ${amount}, available ${available}`);
    this.name = 'InsufficientFundsError';
    this.accountKey = accountKey;
    this.amount = amount;
    this.available = available;
  }
}

/** The entries of a posting do not sum to zero (or there are too few of them). */
export class UnbalancedTransactionError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedTransactionError';
  }
}
