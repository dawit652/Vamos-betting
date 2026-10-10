/**
 * @vamos/payments – payment provider adapters behind one PaymentProvider
 * interface. Pure apart from the injected `fetch`, clock and random source:
 * no database. Amounts are bigint santim. Business rules (limits, ledger,
 * idempotency) live in @vamos/db's payment services.
 *
 * Demo mode allows only the mock provider (@vamos/config guard); Chapa and
 * telebirr can be enabled only in licensed mode. CBE Birr and M-Pesa are
 * skeletons until merchant documents and credentials exist.
 *
 * Flows (the API and worker glue these to @vamos/db):
 * - deposit: createDepositIntent (db) → provider.initiateDeposit (outside
 *   the transaction) → markDepositInitiated / markDepositInitiationFailed
 *   (db). The webhook route (`paymentWebhookPath`, no session, no CSRF)
 *   passes the raw body to provider.verifyWebhook and the verified event to
 *   applyDepositEvent (db), which is idempotent by provider event id.
 *   Pollers use provider.queryDeposit + eventFromStatusQuery the same way.
 * - payout: requestWithdrawal (db) → approval → the payout worker:
 *   claimDuePayouts + markPayoutProcessing (db), then attemptPayout (here,
 *   outside the transaction), then applyPayoutAttempt (db). Webhooks go to
 *   applyPayoutEvent (db).
 */
export * from './types';
export {
  PaymentProviderError,
  ProviderNotConfiguredError,
  ProviderRequestError,
  UnknownPaymentProviderError,
  WebhookVerificationError,
  type WebhookRejection,
} from './errors';
export {
  createPaymentProvider,
  createPaymentProviders,
  paymentWebhookPath,
  paymentWebhookUrl,
  type PaymentProviderRegistry,
  type PaymentsConfig,
} from './factory';
export {
  attemptPayout,
  eventFromStatusQuery,
  payoutRetryDelayMs,
  type PayoutAttemptInput,
  type PayoutAttemptResult,
} from './payouts';
export {
  MOCK_PROVIDER_PIN,
  MOCK_SIGNATURE_HEADER,
  MOCK_WEBHOOK_TOLERANCE_MS,
  MockPaymentProvider,
  MockPinError,
  mockDepositRef,
  type MockProviderOptions,
} from './providers/mock';
export { CHAPA_WALLET_BANK_CODES, ChapaProvider, type ChapaOptions } from './providers/chapa';
export {
  TelebirrProvider,
  telebirrCanonicalString,
  telebirrOrderId,
  telebirrSign,
  telebirrVerify,
  type TelebirrOptions,
  type TelebirrSignatureScheme,
} from './providers/telebirr';
export { CbeBirrProvider, MpesaEthiopiaProvider } from './providers/skeleton';
export { hexDigestEquals, hmacSha256Hex } from './util';
