import { bareSmsReference, institutionById } from '@vamos/core';
import type { ProviderDeps } from '../types';
import { receiptMatchesAnyAccount } from './accountmatch';
import { Breaker, DEFAULT_BREAKER, type BreakerConfig } from './breaker';
import { isReceiptNotFoundPage, parseTelebirrReceipt } from './telebirrhtml';
import type { ReceiptVerdict, ReceiptVerifier, ReceiptVerifyRequest } from './types';

/**
 * The only part of receipt verification that touches the network.
 *
 * The URL is built from the institution registry and the reference, never
 * taken from an SMS (whose text the handset's holder controls), the host is
 * allowlisted, and redirects are refused rather than followed: following
 * one would let a redirect on the far side make us fetch any address.
 */

const ALLOWED_HOSTS = new Set(['transactioninfo.ethiotelecom.et']);

/** Measured at ~0.6 s; generous for a bad day, short enough to fail fast. */
const DEFAULT_TIMEOUT_MS = 6_000;
const RETRY_DELAY_MS = 400;
/** Receipts are ~10 KB. */
const MAX_BODY_BYTES = 256 * 1024;
const SAMPLE_BYTES = 4096;

export interface ReceiptVerifierOptions {
  /** Simultaneous requests to the institution. */
  concurrency?: number;
  breaker?: BreakerConfig;
  /** Waits between the one retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];

  constructor(size: number) {
    this.#free = Math.max(1, size);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free === 0) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#free--;
    try {
      return await fn();
    } finally {
      this.#free++;
      this.#queue.shift()?.();
    }
  }
}

type FetchOutcome = { ok: true; body: string } | { ok: false; kind: 'timeout' | 'unavailable' };

const sample = (body: string) => body.slice(0, SAMPLE_BYTES);

export function createReceiptVerifier(
  deps: Pick<ProviderDeps, 'fetch' | 'clock' | 'timeoutMs'>,
  options: ReceiptVerifierOptions = {},
): ReceiptVerifier {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breaker = new Breaker(options.breaker ?? DEFAULT_BREAKER, () => deps.clock().getTime());
  const gate = new Semaphore(options.concurrency ?? 4);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function fetchOnce(url: string): Promise<FetchOutcome> {
    try {
      const response = await deps.fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent':
            'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      if (response.status >= 300 && response.status < 400)
        return { ok: false, kind: 'unavailable' };
      if (response.status >= 500) return { ok: false, kind: 'unavailable' };
      if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
        return { ok: false, kind: 'unavailable' };
      }
      return { ok: true, body: (await response.text()).slice(0, MAX_BODY_BYTES) };
    } catch (error) {
      const timedOut =
        error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`);
      return { ok: false, kind: timedOut ? 'timeout' : 'unavailable' };
    }
  }

  async function verify(request: ReceiptVerifyRequest): Promise<ReceiptVerdict> {
    const spec = institutionById(request.institution);
    if (!spec?.receiptUrl) return { status: 'skipped', reason: 'institution_unsupported' };
    const reference = bareSmsReference(request.reference);
    if (reference === null) {
      return { status: 'rejected', reason: 'not_a_receipt', facts: null, rawSample: '' };
    }
    const url = spec.receiptUrl(reference);
    if (!ALLOWED_HOSTS.has(new URL(url).hostname)) {
      return { status: 'skipped', reason: 'institution_unsupported' };
    }
    if (!breaker.tryAcquire())
      return { status: 'indeterminate', reason: 'breaker_open', rawSample: '' };
    let outcome = await gate.run(() => fetchOnce(url));
    if (!outcome.ok) {
      // One retry, transport failures only: a clean answer will not change.
      await sleep(RETRY_DELAY_MS);
      outcome = await gate.run(() => fetchOnce(url));
    }
    if (!outcome.ok) {
      breaker.failure();
      return { status: 'indeterminate', reason: outcome.kind, rawSample: '' };
    }
    breaker.success();
    return judgeReceipt(outcome.body, reference, request);
  }

  return {
    verify,
    state: () => ({
      breaker: breaker.snapshot.state,
      consecutiveFailures: breaker.snapshot.consecutiveFailures,
    }),
  };
}

/**
 * The four gates, each a positive assertion ("we found our account"), so a
 * half-readable receipt is indeterminate rather than accidentally verified:
 * 1. not reported as failed; 2. the reference is the one asked about;
 * 3. the receiver is one of our accounts (an unreadable receiver is
 *    indeterminate, never verified); 4. the expected amount is on it.
 */
export function judgeReceipt(
  body: string,
  reference: string,
  request: Pick<ReceiptVerifyRequest, 'receiverAccounts' | 'amount'>,
): ReceiptVerdict {
  if (isReceiptNotFoundPage(body)) {
    return { status: 'rejected', reason: 'not_a_receipt', facts: null, rawSample: sample(body) };
  }
  const facts = parseTelebirrReceipt(body);
  if (!facts) return { status: 'indeterminate', reason: 'unparseable', rawSample: sample(body) };
  const reject = (reason: Extract<ReceiptVerdict, { status: 'rejected' }>['reason']) =>
    ({ status: 'rejected', reason, facts, rawSample: sample(body) }) as const;
  if (facts.completed === false) return reject('not_completed');
  if (facts.reference !== null && facts.reference !== reference)
    return reject('reference_mismatch');
  if (facts.receiverAccount === null) {
    return { status: 'indeterminate', reason: 'unparseable', rawSample: sample(body) };
  }
  if (!receiptMatchesAnyAccount(facts.receiverAccount, request.receiverAccounts)) {
    return reject('receiver_not_ours');
  }
  if (request.amount === undefined) {
    const first = facts.amounts[0];
    if (first === undefined) return reject('amount_absent');
    return { status: 'verified', facts, amount: first };
  }
  if (!facts.amounts.includes(request.amount)) return reject('amount_absent');
  return { status: 'verified', facts, amount: request.amount };
}
