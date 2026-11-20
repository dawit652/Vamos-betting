import { createHash, timingSafeEqual } from 'node:crypto';
import { institutionById } from '@vamos/core';
import type { CollectionAccount } from '@vamos/config';
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
  WebhookVerificationError,
} from '../errors';
import type {
  DepositInitiation,
  InitiateDepositInput,
  PaymentProvider,
  PayoutInitiation,
  ProviderCapabilities,
  ProviderStatusResult,
  VerifiedWebhookEvent,
} from '../types';

const NAME = 'sms' as const;

/** Header the SMS forwarder sends its shared secret in (or `secret` in the JSON body). */
export const SMS_GATEWAY_SECRET_HEADER = 'x-gateway-secret';

export interface SmsRailProviderOptions {
  /** `simulated`: only the dev simulator feeds the rail; `live`: the collection handset. */
  mode: 'simulated' | 'live';
  /** SMS_GATEWAY_SECRET (live: required, 32+ characters). */
  gatewaySecret?: string | undefined;
  /** SMS_GATEWAY_ALLOWLIST: addresses the gateway may post from (empty: any). */
  gatewayAllowlist?: readonly string[];
  /**
   * SMS_COLLECTION_ACCOUNTS (or the demo accounts): where players pay until the back office's
   * list is loaded (setCollectionAccounts), and what fills that list while it is empty. May be
   * empty. Each institution must have a parser spec.
   */
  collectionAccounts: readonly CollectionAccount[];
}

/** The back office's collection accounts as the rail uses them (@vamos/db loadRailAccounts). */
export interface CollectionAccountSet {
  /** Offered to new deposits. */
  active: readonly CollectionAccount[];
  /**
   * The active ones and those deleted lately: SMS, receipts and open deposits on them still
   * count, so money already sent to a deleted account is still credited.
   */
  known: readonly CollectionAccount[];
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * The SMS deposit rail (ported from Melabingo). Players transfer an exact
 * amount to a collection account; the collection handset forwards the
 * confirmation SMS to the gateway route, and @vamos/db (ingestSms) matches
 * and credits it. Payouts are sent by hand by an operator (manual), so the
 * payout worker never calls this provider.
 */
export class SmsRailProvider implements PaymentProvider {
  readonly name = NAME;
  readonly capabilities: ProviderCapabilities = { deposits: true, payouts: true, manual: true };
  readonly mode: 'simulated' | 'live';
  /** The accounts of SMS_COLLECTION_ACCOUNTS (or the demo ones): they fill an empty list once. */
  readonly configuredAccounts: readonly CollectionAccount[];
  readonly gatewayAllowlist: readonly string[];
  readonly #secretDigest: Buffer | null;
  #active: readonly CollectionAccount[];
  #known: readonly CollectionAccount[];

  constructor(options: SmsRailProviderOptions) {
    for (const account of options.collectionAccounts) {
      if (institutionById(account.institution) === null) {
        throw new ProviderNotConfiguredError(
          NAME,
          `SMS_COLLECTION_ACCOUNTS: unknown institution "${account.institution}" (no SMS parser for it)`,
          ['SMS_COLLECTION_ACCOUNTS'],
        );
      }
    }
    if (options.mode === 'live' && (options.gatewaySecret?.length ?? 0) < 32) {
      throw new ProviderNotConfiguredError(
        NAME,
        'SMS_GATEWAY_SECRET must have at least 32 characters',
        ['SMS_GATEWAY_SECRET'],
      );
    }
    this.mode = options.mode;
    this.configuredAccounts = options.collectionAccounts.map((account) => ({ ...account }));
    this.#active = this.configuredAccounts;
    this.#known = this.configuredAccounts;
    this.gatewayAllowlist = [...(options.gatewayAllowlist ?? [])];
    this.#secretDigest =
      options.mode === 'live' && options.gatewaySecret ? digest(options.gatewaySecret) : null;
  }

  /**
   * Whether a gateway request carries the shared secret (constant time).
   * Always false on the simulated rail: only the dev simulator feeds it.
   */
  gatewaySecretMatches(provided: string | undefined): boolean {
    if (this.#secretDigest === null || typeof provided !== 'string' || provided.length === 0) {
      return false;
    }
    return timingSafeEqual(digest(provided), this.#secretDigest);
  }

  /** Whether `ip` may post to the gateway route (any, without an allowlist). */
  gatewayAddressAllowed(ip: string): boolean {
    return this.gatewayAllowlist.length === 0 || this.gatewayAllowlist.includes(ip);
  }

  /** The accounts offered to new deposits (the back office's active list once loaded). */
  get collectionAccounts(): readonly CollectionAccount[] {
    return this.#active;
  }

  /** The active accounts and those deleted lately (SMS and receipts on them still count). */
  get knownCollectionAccounts(): readonly CollectionAccount[] {
    return this.#known;
  }

  /**
   * Replaces the accounts with the back office's list. An account of an institution without a
   * parser is left out (the back office refuses to add one); every active account is known.
   */
  setCollectionAccounts(set: CollectionAccountSet): void {
    const usable = (account: CollectionAccount) => institutionById(account.institution) !== null;
    const active = set.active.filter(usable).map((account) => ({ ...account }));
    const known = [...active];
    for (const account of set.known) {
      if (usable(account) && !known.some((k) => k.id === account.id)) known.push({ ...account });
    }
    this.#active = active;
    this.#known = known;
  }

  /** Our collection account numbers at an institution (the receipt verifier's receivers). */
  collectionAccountsAt(institution: string): string[] {
    return this.#known.filter((a) => a.institution === institution).map((a) => a.account);
  }

  /** The ids of the known collection accounts (each has its own space of exact amounts). */
  get collectionAccountIds(): string[] {
    return this.#known.map((a) => a.id);
  }

  /**
   * The collection account a receiver number at an institution is, by id. When the receiver is
   * not given or not listed, the account only if the institution has exactly one; else null.
   */
  collectionAccountIdAt(institution: string, receiver?: string | null): string | null {
    const at = this.#known.filter((a) => a.institution === institution);
    const named = receiver ? at.find((a) => a.account === receiver) : undefined;
    if (named !== undefined) return named.id;
    return at.length === 1 ? at[0]!.id : null;
  }

  async initiateDeposit(input: InitiateDepositInput): Promise<DepositInitiation> {
    if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
      throw new PaymentProviderError(NAME, 'amount must be a positive santim bigint');
    }
    return { kind: 'transfer', providerRef: input.intentId };
  }

  /** The gateway has its own route (SMS_GATEWAY_SECRET_HEADER), not the provider webhooks. */
  async verifyWebhook(): Promise<VerifiedWebhookEvent> {
    throw new WebhookVerificationError(
      NAME,
      'malformed_payload',
      'the SMS rail is fed by the gateway route /payments/webhooks/sms',
    );
  }

  /** There is nobody to ask: a deposit stays pending until its SMS arrives. */
  async queryDeposit(providerRef: string): Promise<ProviderStatusResult> {
    return { providerRef, status: 'pending', amount: null, currency: null, raw: null };
  }

  async initiatePayout(): Promise<PayoutInitiation> {
    throw new PaymentProviderError(NAME, 'SMS rail payouts are sent by hand (manual payouts)');
  }

  async queryPayout(): Promise<ProviderStatusResult> {
    throw new PaymentProviderError(NAME, 'SMS rail payouts are sent by hand (manual payouts)');
  }
}
