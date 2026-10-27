import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { receiptAccountMatches, receiptMatchesAnyAccount } from './accountmatch';
import { Breaker } from './breaker';
import {
  CREDIT_100_37,
  CREDIT_BALANCE_FIRST,
  CREDIT_FAILED,
  CREDIT_NO_RECEIVER,
  CREDIT_WRONG_RECEIVER,
  CREDIT_WRONG_REFERENCE,
  NOT_FOUND,
  TRUNCATED,
  UNRELATED_PAGE,
} from './fixtures';
import { isReceiptNotFoundPage, parseTelebirrReceipt } from './telebirrhtml';
import { createReceiptVerifier, judgeReceipt } from './verifier';

const OURS = ['0911678426'];
const REF = 'CBE7XK2M91';

describe('parseTelebirrReceipt', () => {
  it('reads every field of a completed receipt', () => {
    expect(parseTelebirrReceipt(CREDIT_100_37)).toMatchObject({
      reference: REF,
      amounts: expect.arrayContaining([10037n]),
      payerName: 'ABEBE K TESFAYE',
      receiverAccount: '251911***426',
      completed: true,
    });
  });

  it('does not read script or style content', () => {
    expect(parseTelebirrReceipt(CREDIT_100_37)?.payerName).not.toMatch(/var x/);
  });

  it('leaves a balance figure out of the amounts', () => {
    const facts = parseTelebirrReceipt(CREDIT_BALANCE_FIRST)!;
    expect(facts.amounts).toContain(10037n);
    expect(facts.amounts).not.toContain(999900n);
  });

  it('returns null for the not-found page, a truncated answer and a page that is no receipt', () => {
    expect(parseTelebirrReceipt(NOT_FOUND)).toBeNull();
    expect(parseTelebirrReceipt(TRUNCATED)).toBeNull();
    expect(parseTelebirrReceipt(UNRELATED_PAGE)).toBeNull();
    expect(isReceiptNotFoundPage(NOT_FOUND)).toBe(true);
    expect(isReceiptNotFoundPage(CREDIT_100_37)).toBe(false);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (html) => {
        parseTelebirrReceipt(html);
        return true;
      }),
    );
  });
});

describe('judgeReceipt: the four gates', () => {
  const request = { receiverAccounts: OURS, amount: 10037n };

  it('verifies a genuine payment into our account', () => {
    expect(judgeReceipt(CREDIT_100_37, REF, request)).toMatchObject({
      status: 'verified',
      amount: 10037n,
    });
  });

  it.each([
    ['an unknown reference', NOT_FOUND, 'not_a_receipt'],
    ['a payment to someone else', CREDIT_WRONG_RECEIVER, 'receiver_not_ours'],
    ['a page about another transaction', CREDIT_WRONG_REFERENCE, 'reference_mismatch'],
    ['a failed transaction', CREDIT_FAILED, 'not_completed'],
  ])('rejects %s', (_label, html, reason) => {
    expect(judgeReceipt(html, REF, request)).toMatchObject({ status: 'rejected', reason });
  });

  it('rejects an amount that appears nowhere on the receipt (an inflated SMS)', () => {
    expect(judgeReceipt(CREDIT_100_37, REF, { ...request, amount: 90000n })).toMatchObject({
      status: 'rejected',
      reason: 'amount_absent',
    });
  });

  it('is indeterminate, never verified, when the receiver cannot be read', () => {
    expect(judgeReceipt(CREDIT_NO_RECEIVER, REF, request)).toMatchObject({
      status: 'indeterminate',
      reason: 'unparseable',
    });
  });

  it('is indeterminate for markup it cannot parse, and keeps a sample', () => {
    const verdict = judgeReceipt(TRUNCATED, REF, request);
    expect(verdict).toMatchObject({ status: 'indeterminate', reason: 'unparseable' });
    expect(verdict.status === 'indeterminate' && verdict.rawSample.length).toBeGreaterThan(0);
  });

  it('takes a figure when the caller names no amount (the player check intersects)', () => {
    expect(judgeReceipt(CREDIT_100_37, REF, { receiverAccounts: OURS })).toMatchObject({
      status: 'verified',
    });
  });
});

describe('receipt account matching', () => {
  it('matches a masked value against the real account in any phone form', () => {
    expect(receiptAccountMatches('251911***426', '0911678426')).toBe(true);
    expect(receiptAccountMatches('251911***426', '+251911678426')).toBe(true);
    expect(receiptAccountMatches('0911***426', '251911678426')).toBe(true);
  });

  it('refuses another account, an all-masked value, a hidden tail and absent values', () => {
    expect(receiptAccountMatches('251911***427', '0911678426')).toBe(false);
    expect(receiptAccountMatches('251*********', '0911678426')).toBe(false);
    expect(receiptAccountMatches('2519116784**', '0911678426')).toBe(false);
    expect(receiptAccountMatches(null, '0911678426')).toBe(false);
    expect(receiptAccountMatches('251911***426', '')).toBe(false);
  });

  it('checks a list of collection accounts', () => {
    expect(receiptMatchesAnyAccount('251911***426', ['1000123', '0911678426'])).toBe(true);
    expect(receiptMatchesAnyAccount('251911***426', [])).toBe(false);
  });

  it('never matches when the visible digits differ', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^9\d{8}$/), fc.stringMatching(/^9\d{8}$/), (a, b) => {
        fc.pre(a.slice(-3) !== b.slice(-3));
        return !receiptAccountMatches(`251${a.slice(0, 3)}***${a.slice(-3)}`, `0${b}`);
      }),
    );
  });
});

describe('breaker', () => {
  const config = { threshold: 3, cooldownMs: 1000 };

  it('opens after the threshold, lets one probe through after the cooldown, and resets on success', () => {
    let now = 0;
    const breaker = new Breaker(config, () => now);
    for (let i = 0; i < 3; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.failure();
    }
    expect(breaker.snapshot.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    now = 1000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // the probe slot is taken
    breaker.failure();
    expect(breaker.snapshot).toMatchObject({ state: 'open', openedAt: 1000 });
    now = 2000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.success();
    expect(breaker.snapshot).toEqual({ state: 'closed', consecutiveFailures: 0, openedAt: null });
  });
});

describe('createReceiptVerifier', () => {
  const clock = () => new Date('2026-10-10T09:00:00Z');
  const noSleep = async () => {};

  function verifierWith(
    respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof globalThis.fetch;
    return { calls, verifier: createReceiptVerifier({ fetch, clock }, { sleep: noSleep }) };
  }

  it('builds the URL from the reference and refuses to follow redirects', async () => {
    const { calls, verifier } = verifierWith(() => new Response(CREDIT_100_37, { status: 200 }));
    const verdict = await verifier.verify({
      institution: 'telebirr',
      reference: REF,
      receiverAccounts: OURS,
      amount: 10037n,
    });
    expect(verdict.status).toBe('verified');
    expect(calls[0]?.url).toBe(`https://transactioninfo.ethiotelecom.et/receipt/${REF}`);
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('treats a redirect as unavailable', async () => {
    const { verifier } = verifierWith(
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    expect(
      await verifier.verify({ institution: 'telebirr', reference: REF, receiverAccounts: OURS }),
    ).toMatchObject({ status: 'indeterminate', reason: 'unavailable' });
  });

  it('skips institutions without a readable receipt page and rejects a malformed reference', async () => {
    const { calls, verifier } = verifierWith(() => new Response(CREDIT_100_37));
    expect(
      await verifier.verify({ institution: 'cbe', reference: REF, receiverAccounts: OURS }),
    ).toEqual({
      status: 'skipped',
      reason: 'institution_unsupported',
    });
    expect(
      await verifier.verify({
        institution: 'telebirr',
        reference: '../../etc',
        receiverAccounts: OURS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'not_a_receipt' });
    expect(calls).toHaveLength(0);
  });

  it('retries a transport failure once, then opens the breaker after repeated outages', async () => {
    const { calls, verifier } = verifierWith(() => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < 5; i++) {
      expect(
        await verifier.verify({ institution: 'telebirr', reference: REF, receiverAccounts: OURS }),
      ).toMatchObject({ status: 'indeterminate', reason: 'unavailable' });
    }
    expect(calls).toHaveLength(10);
    expect(verifier.state().breaker).toBe('open');
    expect(
      await verifier.verify({ institution: 'telebirr', reference: REF, receiverAccounts: OURS }),
    ).toMatchObject({ status: 'indeterminate', reason: 'breaker_open' });
    expect(calls).toHaveLength(10);
  });

  it('treats a 5xx as unavailable and a not-found page as a rejection', async () => {
    const down = verifierWith(() => new Response('oops', { status: 503 }));
    expect(
      await down.verifier.verify({
        institution: 'telebirr',
        reference: REF,
        receiverAccounts: OURS,
      }),
    ).toMatchObject({ status: 'indeterminate' });
    const unknown = verifierWith(() => new Response(NOT_FOUND, { status: 200 }));
    expect(
      await unknown.verifier.verify({
        institution: 'telebirr',
        reference: REF,
        receiverAccounts: OURS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'not_a_receipt' });
  });
});
