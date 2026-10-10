import { ProviderNotConfiguredError } from '../errors';
import type {
  DepositInitiation,
  PaymentProvider,
  PayoutInitiation,
  ProviderCapabilities,
  ProviderStatusResult,
  VerifiedWebhookEvent,
} from '../types';

/**
 * Placeholder for a provider whose merchant documents and credentials do not
 * exist yet: every call throws ProviderNotConfiguredError, and the factory
 * refuses to enable it. Replace with a real adapter once the PSP's API
 * specification and sandbox credentials are available.
 */
abstract class UnconfiguredProvider implements PaymentProvider {
  abstract readonly name: 'cbebirr' | 'mpesa-et';
  readonly capabilities: ProviderCapabilities = { deposits: false, payouts: false };
  protected abstract readonly label: string;

  /** The error every call throws (the factory throws it at startup). */
  notConfiguredError(): ProviderNotConfiguredError {
    return new ProviderNotConfiguredError(
      this.name,
      `${this.label} is not configured yet: merchant documents and API credentials are pending`,
    );
  }

  async initiateDeposit(): Promise<DepositInitiation> {
    throw this.notConfiguredError();
  }

  async verifyWebhook(): Promise<VerifiedWebhookEvent> {
    throw this.notConfiguredError();
  }

  async queryDeposit(): Promise<ProviderStatusResult> {
    throw this.notConfiguredError();
  }

  async initiatePayout(): Promise<PayoutInitiation> {
    throw this.notConfiguredError();
  }

  async queryPayout(): Promise<ProviderStatusResult> {
    throw this.notConfiguredError();
  }
}

/** CBE Birr (Commercial Bank of Ethiopia mobile money). */
export class CbeBirrProvider extends UnconfiguredProvider {
  readonly name = 'cbebirr' as const;
  protected readonly label = 'CBE Birr';
}

/** M-Pesa Ethiopia (Safaricom). */
export class MpesaEthiopiaProvider extends UnconfiguredProvider {
  readonly name = 'mpesa-et' as const;
  protected readonly label = 'M-Pesa Ethiopia';
}
