/** Transaction retry on deadlock / serialization failure (shared with the API, see @vamos/db). */
export {
  isRetryableTxError,
  pgCode,
  RETRYABLE_SQLSTATES,
  withTxRetry,
  type TxRetryOptions,
} from '@vamos/db';
