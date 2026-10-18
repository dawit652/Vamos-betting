import { randomBytes, randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  DepositView,
  DepositsResponse,
  DevPhoneDecisionResponse,
  DevPhonePushesResponse,
  DevWithdrawalQueueResponse,
  PaymentOptionsResponse,
  PaymentWebhookAck,
  WalletResponse,
  WithdrawalView,
  WithdrawalsResponse,
} from '@vamos/contracts';
import { applyPayoutAttempt, markPayoutProcessing, setSetting } from '@vamos/db';
import {
  amlFlags,
  kycProfiles,
  ledgerTransactions,
  outboxEvents,
  paymentEvents,
  paymentIntents,
  payouts,
} from '@vamos/db/schema';
import {
  createPaymentProviders,
  mockDepositRef,
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
  PaymentProviderError,
  ProviderNotConfiguredError,
  type InitiateDepositInput,
  type PaymentProvider,
  type PaymentProviderRegistry,
  type WebhookInput,
} from '@vamos/payments';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/lib/idempotency';
import { DEV_BACK_OFFICE_ACTOR, devPaymentsEnabled } from '../src/modules/payments/dev-routes';
import { WEBHOOK_BODY_LIMIT } from '../src/modules/payments/routes';
import { depositReturnUrl } from '../src/modules/payments/service';
import { withdrawalSteps } from '../src/modules/payments/views';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const MINUTE_MS = 60_000;
const PIN = '1234';

let ctx: TestContext;
let mock: MockPaymentProvider;

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = ctx.deps.payments.get('mock');
  if (!(provider instanceof MockPaymentProvider)) throw new Error('mock provider missing');
  mock = provider;
});

afterAll(async () => {
  await ctx?.close();
});

const apiError = (response: LightMyRequestResponse) => ApiErrorSchema.parse(response.json()).error;
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });

function postDeposit(
  user: LoggedInUser,
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
  app: FastifyInstance = ctx.app,
) {
  return app.inject({
    method: 'POST',
    url: '/payments/deposits',
    payload,
    headers: { ...bearer(user), ...(key === null ? {} : { 'idempotency-key': key }) },
  });
}

function postWithdrawal(
  user: LoggedInUser,
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/payments/withdrawals',
    payload,
    headers: { ...bearer(user), ...(key === null ? {} : { 'idempotency-key': key }) },
  });
}

/** The dev phone simulator, used by the signed-in player (Bearer: no CSRF token needed). */
function phoneDecision(user: LoggedInUser, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/dev/payments/phone',
    payload,
    headers: bearer(user),
  });
}

function phonePushes(user: LoggedInUser | null, query = '') {
  return ctx.app.inject({
    method: 'GET',
    url: `/dev/payments/phone${query}`,
    ...(user === null ? {} : { headers: bearer(user) }),
  });
}

function deliver(webhook: WebhookInput, app: FastifyInstance = ctx.app, provider = 'mock') {
  return app.inject({
    method: 'POST',
    url: `/payments/webhooks/${provider}`,
    headers: webhook.headers as Record<string, string>,
    payload: typeof webhook.rawBody === 'string' ? webhook.rawBody : Buffer.from(webhook.rawBody),
  });
}

async function cashOf(user: LoggedInUser): Promise<bigint> {
  const response = await ctx.app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
  return BigInt(WalletResponse.parse(response.json()).cash);
}

async function verifyKyc(user: LoggedInUser, name = 'Test Player'): Promise<void> {
  await ctx.db.db
    .insert(kycProfiles)
    .values({ userId: user.userId, status: 'verified', provider: 'mock', verifiedName: name });
}

/** A deposit approved on the dev phone simulator; returns its id. */
async function depositAndApprove(user: LoggedInUser, amount: bigint): Promise<string> {
  const created = await postDeposit(user, { amount: amount.toString() });
  expect(created.statusCode).toBe(201);
  const deposit = DepositView.parse(created.json());
  const decided = await phoneDecision(user, {
    depositId: deposit.id,
    decision: 'approve',
    pin: PIN,
  });
  expect(decided.statusCode).toBe(200);
  expect(DevPhoneDecisionResponse.parse(decided.json()).outcome).toBe('credited');
  return deposit.id;
}

async function setPaymentRules(rules: Record<string, unknown>): Promise<void> {
  await setSetting(ctx.db.db, 'payments', rules);
}

async function outboxTypes(aggregateId: string): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ type: outboxEvents.type })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, aggregateId))
    .orderBy(outboxEvents.id);
  return rows.map((row) => row.type);
}

/** A registry around the mock provider whose initiateDeposit can be made to fail. */
function flakyRegistry(
  failure: { mode: 'retryable' | 'refuse' | null },
  seen: InitiateDepositInput[] = [],
): PaymentProviderRegistry {
  const provider: PaymentProvider = {
    name: 'mock',
    capabilities: mock.capabilities,
    initiateDeposit: async (input) => {
      seen.push(input);
      if (failure.mode !== null) {
        throw new PaymentProviderError('mock', 'simulated outage', {
          retryable: failure.mode === 'retryable',
        });
      }
      return mock.initiateDeposit(input);
    },
    verifyWebhook: (input) => mock.verifyWebhook(input),
    queryDeposit: (ref) => mock.queryDeposit(ref),
    initiatePayout: (input) => mock.initiatePayout(input),
    queryPayout: (ref) => mock.queryPayout(ref),
  };
  return {
    names: ['mock'],
    get: (name) => (name === 'mock' ? provider : undefined),
    require: (name) => {
      if (name !== 'mock') throw new Error(`not enabled: ${name}`);
      return provider;
    },
  };
}

describe('GET /payments/options', () => {
  it('lists the enabled providers and the amount limits (public)', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/payments/options' });
    expect(response.statusCode).toBe(200);
    const body = PaymentOptionsResponse.parse(response.json());
    expect(body.demo).toBe(true);
    expect(body.providers).toEqual([{ name: 'mock', deposits: true, payouts: true }]);
    expect(body.limits).toMatchObject({
      minDeposit: '1000',
      maxDeposit: '10000000',
      minWithdrawal: '5000',
      autoApproveBelow: '500000',
    });
  });
});

describe('deposits', () => {
  let player: LoggedInUser;
  let other: LoggedInUser;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
    other = await registerAndLogin(ctx);
  });

  it('needs a session, a CSRF token with cookies, an idempotency key and a valid body', async () => {
    const unauth = await ctx.app.inject({
      method: 'POST',
      url: '/payments/deposits',
      payload: { amount: '5000' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(unauth.statusCode).toBe(401);

    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/payments/deposits',
      payload: { amount: '5000' },
      headers: { cookie: player.cookie, 'idempotency-key': randomUUID() },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(apiError(noCsrf).code).toBe('csrf_invalid');

    const noKey = await postDeposit(player, { amount: '5000' }, null);
    expect(noKey.statusCode).toBe(400);
    expect(apiError(noKey).code).toBe('idempotency_key_required');

    for (const amount of ['0', '-500', '12.5', 'abc', '0000']) {
      const bad = await postDeposit(player, { amount });
      expect(bad.statusCode, amount).toBe(400);
      expect(apiError(bad).code).toBe('validation_error');
    }
    expect(await ctx.db.db.select().from(paymentIntents)).toHaveLength(0);

    const withCookie = await ctx.app.inject({
      method: 'POST',
      url: '/payments/deposits',
      payload: { amount: '5000' },
      headers: {
        cookie: player.cookie,
        'x-csrf-token': player.csrfToken,
        'idempotency-key': randomUUID(),
      },
    });
    expect(withCookie.statusCode).toBe(201);
  });

  it('creates a pending push deposit and replays the same key without a second intent', async () => {
    const key = randomUUID();
    const first = await postDeposit(player, { amount: '25000' }, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const deposit = DepositView.parse(first.json());
    expect(deposit).toMatchObject({
      provider: 'mock',
      amount: '25000',
      currency: 'ETB',
      phone: player.phone,
      status: 'pending',
      failureReason: null,
      underReview: false,
      completedAt: null,
    });
    expect(deposit.initiation?.kind).toBe('push');
    expect(deposit.initiation?.instructions).toMatch(/simulator/i);
    expect(Date.parse(deposit.expiresAt) - ctx.clock.now.getTime()).toBe(30 * MINUTE_MS);

    const replay = await postDeposit(player, { amount: '25000' }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(DepositView.parse(replay.json()).id).toBe(deposit.id);

    const reused = await postDeposit(player, { amount: '26000' }, key);
    expect(reused.statusCode).toBe(422);
    expect(apiError(reused).code).toBe('idempotency_key_reused');

    const rows = await ctx.db.db
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.userId, player.userId), eq(paymentIntents.idempotencyKey, key)));
    expect(rows).toHaveLength(1);
  });

  it('refuses amounts outside the limits, other phones and providers that are not enabled', async () => {
    const small = await postDeposit(player, { amount: '999' });
    expect(small.statusCode).toBe(422);
    expect(apiError(small).code).toBe('deposit_amount_out_of_range');

    const big = await postDeposit(player, { amount: '10000001' });
    expect(apiError(big).code).toBe('deposit_amount_out_of_range');

    const phone = await postDeposit(player, { amount: '5000', phone: other.phone });
    expect(phone.statusCode).toBe(422);
    expect(apiError(phone).code).toBe('deposit_phone_mismatch');

    const chapa = await postDeposit(player, { amount: '5000', provider: 'chapa' });
    expect(chapa.statusCode).toBe(422);
    expect(apiError(chapa).code).toBe('payment_provider_unavailable');

    const unknown = await postDeposit(player, { amount: '5000', provider: 'paypal' });
    expect(apiError(unknown).code).toBe('validation_error');
  });

  it('shows a deposit to its owner only (no IDOR), and lists the owner’s deposits', async () => {
    const created = DepositView.parse((await postDeposit(player, { amount: '7000' })).json());

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/payments/deposits/${created.id}`,
      headers: bearer(player),
    });
    expect(own.statusCode).toBe(200);
    expect(DepositView.parse(own.json())).toEqual(created);

    const stranger = await ctx.app.inject({
      method: 'GET',
      url: `/payments/deposits/${created.id}`,
      headers: bearer(other),
    });
    expect(stranger.statusCode).toBe(404);

    for (const id of ['not-a-uuid', randomUUID()]) {
      const missing = await ctx.app.inject({
        method: 'GET',
        url: `/payments/deposits/${id}`,
        headers: bearer(player),
      });
      expect(missing.statusCode).toBe(404);
    }
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/payments/deposits/${created.id}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const mine = DepositsResponse.parse(
      (
        await ctx.app.inject({ method: 'GET', url: '/payments/deposits', headers: bearer(player) })
      ).json(),
    );
    expect(mine.items.map((item) => item.id)).toContain(created.id);
    const theirs = DepositsResponse.parse(
      (
        await ctx.app.inject({ method: 'GET', url: '/payments/deposits', headers: bearer(other) })
      ).json(),
    );
    expect(theirs.items.map((item) => item.id)).not.toContain(created.id);
  });

  it('answers 503 on a provider outage and initiates again when the same key is replayed', async () => {
    const failure: { mode: 'retryable' | 'refuse' | null } = { mode: 'retryable' };
    const app = buildApp(
      { ...ctx.deps, payments: flakyRegistry(failure) },
      { logger: false, rateLimitNameSpace: `flaky-${randomBytes(4).toString('hex')}:` },
    );
    try {
      const key = randomUUID();
      const outage = await postDeposit(player, { amount: '3000' }, key, app);
      expect(outage.statusCode).toBe(503);
      expect(apiError(outage).code).toBe('payment_provider_unavailable');
      const [intent] = await ctx.db.db
        .select()
        .from(paymentIntents)
        .where(
          and(eq(paymentIntents.userId, player.userId), eq(paymentIntents.idempotencyKey, key)),
        );
      expect(intent).toMatchObject({ status: 'created', providerRef: null });

      failure.mode = null;
      const retried = await postDeposit(player, { amount: '3000' }, key, app);
      expect(retried.statusCode).toBe(200);
      expect(DepositView.parse(retried.json())).toMatchObject({
        id: intent!.id,
        status: 'pending',
      });

      failure.mode = 'refuse';
      const refused = await postDeposit(player, { amount: '3000' }, randomUUID(), app);
      expect(refused.statusCode).toBe(201);
      expect(DepositView.parse(refused.json())).toMatchObject({
        status: 'failed',
        failureReason: 'refused_by_provider',
        initiation: null,
      });
    } finally {
      await app.close();
    }
  });

  it('tells the provider when the deposit expires', async () => {
    const seen: InitiateDepositInput[] = [];
    const app = buildApp(
      { ...ctx.deps, payments: flakyRegistry({ mode: null }, seen) },
      { logger: false, rateLimitNameSpace: `expiry-${randomBytes(4).toString('hex')}:` },
    );
    try {
      const created = DepositView.parse(
        (await postDeposit(player, { amount: '4000' }, randomUUID(), app)).json(),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.expiresAt?.toISOString()).toBe(created.expiresAt);
    } finally {
      await app.close();
    }
  });

  it('sends redirect checkouts back to the web app’s deposit page', () => {
    expect(depositReturnUrl(ctx.deps.config, 'abc')).toBe(
      new URL('/wallet/deposit?id=abc', ctx.deps.config.web.publicUrl).toString(),
    );
  });
});

describe('dev phone simulator', () => {
  let player: LoggedInUser;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
  });

  it('lists pushes for the phone, refuses a wrong PIN and credits once on approval', async () => {
    const deposit = DepositView.parse((await postDeposit(player, { amount: '50000' })).json());

    const pushes = await phonePushes(player, `?phone=${encodeURIComponent(player.phone)}`);
    expect(pushes.statusCode).toBe(200);
    expect(DevPhonePushesResponse.parse(pushes.json()).items).toEqual([
      expect.objectContaining({ depositId: deposit.id, amount: '50000' }),
    ]);

    const wrongPin = await phoneDecision(player, {
      phone: player.phone,
      depositId: deposit.id,
      decision: 'approve',
      pin: '0000',
    });
    expect(wrongPin.statusCode).toBe(422);
    expect(apiError(wrongPin).code).toBe('wrong_pin');
    expect(await cashOf(player)).toBe(0n);

    const otherPhone = await phoneDecision(player, {
      phone: '+251911000001',
      depositId: deposit.id,
      decision: 'approve',
      pin: PIN,
    });
    expect(otherPhone.statusCode).toBe(404);

    const approved = await phoneDecision(player, {
      phone: player.phone,
      depositId: deposit.id,
      decision: 'approve',
      pin: PIN,
    });
    expect(approved.statusCode).toBe(200);
    const body = DevPhoneDecisionResponse.parse(approved.json());
    expect(body.outcome).toBe('credited');
    expect(body.deposit).toMatchObject({ id: deposit.id, status: 'succeeded' });
    expect(await cashOf(player)).toBe(50_000n);

    // Pressing approve again is a redelivery of the same signed event.
    const again = await phoneDecision(player, {
      depositId: deposit.id,
      decision: 'approve',
      pin: PIN,
    });
    expect(DevPhoneDecisionResponse.parse(again.json()).outcome).toBe('duplicate');
    expect(await cashOf(player)).toBe(50_000n);

    const postings = await ctx.db.db
      .select()
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.refId, deposit.id), eq(ledgerTransactions.type, 'deposit')));
    expect(postings).toHaveLength(1);
    expect(await outboxTypes(deposit.id)).toEqual(['payment.deposit_succeeded']);

    const after = DevPhonePushesResponse.parse((await phonePushes(player)).json());
    expect(after.items).toEqual([]);
  });

  it('needs a player session and only shows and decides the player’s own pushes', async () => {
    const deposit = DepositView.parse((await postDeposit(player, { amount: '3000' })).json());
    const ofPlayer = `?phone=${encodeURIComponent(player.phone)}`;

    // Without a session the simulator shows and decides nothing.
    expect((await phonePushes(null, ofPlayer)).statusCode).toBe(401);
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/dev/payments/phone',
      payload: { phone: player.phone, depositId: deposit.id, decision: 'decline' },
    });
    expect(anonymous.statusCode).toBe(401);

    // Another player cannot see or decide this player's pushes, whatever phone they name.
    const intruder = await registerAndLogin(ctx);
    expect((await phonePushes(intruder, ofPlayer)).statusCode).toBe(404);
    expect(DevPhonePushesResponse.parse((await phonePushes(intruder)).json()).items).toEqual([]);
    for (const payload of [
      { phone: player.phone, depositId: deposit.id, decision: 'approve', pin: PIN },
      { depositId: deposit.id, decision: 'approve', pin: PIN },
      { depositId: deposit.id, decision: 'decline' },
    ]) {
      expect((await phoneDecision(intruder, payload)).statusCode).toBe(404);
    }
    expect(await cashOf(player)).toBe(50_000n);

    // The player needs no phone number: the session says whose phone it is.
    const mine = DevPhonePushesResponse.parse((await phonePushes(player)).json());
    expect(mine.items.map((item) => item.depositId)).toContain(deposit.id);
    const declined = await phoneDecision(player, { depositId: deposit.id, decision: 'decline' });
    expect(DevPhoneDecisionResponse.parse(declined.json()).outcome).toBe('failed');

    // Cookie sessions need the CSRF token, like every other state change.
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/dev/payments/phone',
      payload: { depositId: deposit.id, decision: 'decline' },
      headers: { cookie: player.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('declines without a PIN', async () => {
    const deposit = DepositView.parse((await postDeposit(player, { amount: '2000' })).json());
    const declined = await phoneDecision(player, {
      phone: player.phone,
      depositId: deposit.id,
      decision: 'decline',
    });
    expect(DevPhoneDecisionResponse.parse(declined.json())).toMatchObject({
      outcome: 'failed',
      deposit: { status: 'failed', failureReason: 'declined_by_provider' },
    });
    expect(await outboxTypes(deposit.id)).toEqual(['payment.deposit_failed']);
  });

  it('rejects malformed requests', async () => {
    expect((await phonePushes(player, '?phone=12')).statusCode).toBe(400);
    const badId = await phoneDecision(player, {
      phone: player.phone,
      depositId: 'nope',
      decision: 'approve',
      pin: PIN,
    });
    expect(badId.statusCode).toBe(404);
  });
});

describe('POST /payments/webhooks/:provider', () => {
  let player: LoggedInUser;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
  });

  async function pendingDeposit(amount: string): Promise<DepositView> {
    return DepositView.parse((await postDeposit(player, { amount })).json());
  }

  const refOf = (deposit: DepositView) => `mockdep_${deposit.id}`;

  async function eventsFor(depositId: string) {
    return ctx.db.db.select().from(paymentEvents).where(eq(paymentEvents.intentId, depositId));
  }

  it('applies a signed event once; a redelivery is a 200 duplicate', async () => {
    const deposit = await pendingDeposit('12000');
    const before = await cashOf(player);
    const webhook = mock.simulateDepositDecision({
      providerRef: refOf(deposit),
      amount: 12_000n,
      decision: 'approve',
      pin: PIN,
    });

    const first = await deliver(webhook);
    expect(first.statusCode).toBe(200);
    expect(PaymentWebhookAck.parse(first.json())).toEqual({ received: true, outcome: 'credited' });
    expect(first.headers['x-ratelimit-limit']).toBeDefined();

    const second = await deliver(webhook);
    expect(second.statusCode).toBe(200);
    expect(PaymentWebhookAck.parse(second.json()).outcome).toBe('duplicate');

    expect(await cashOf(player)).toBe(before + 12_000n);
    expect(await eventsFor(deposit.id)).toHaveLength(1);
  });

  it('verifies the signature over the exact bytes received (no re-serialisation)', async () => {
    const deposit = await pendingDeposit('3000');
    // Pretty-printed with odd spacing: re-serialising this JSON would change the bytes.
    const body = `{\n  "id" : "evt-raw-${deposit.id}",\n  "type": "deposit",  "providerRef": "${refOf(
      deposit,
    )}",\n"status":"succeeded", "amount":"3000", "currency":"ETB"   }\n`;
    const response = await deliver(mock.signWebhook(body));
    expect(response.statusCode).toBe(200);
    expect(PaymentWebhookAck.parse(response.json()).outcome).toBe('credited');

    // Any content type is read raw.
    const decline = await pendingDeposit('3000');
    const signed = mock.simulateDepositDecision({
      providerRef: refOf(decline),
      amount: 3000n,
      decision: 'decline',
    });
    const asText = await deliver({
      ...signed,
      headers: { ...signed.headers, 'content-type': 'text/plain' },
    });
    expect(PaymentWebhookAck.parse(asText.json()).outcome).toBe('failed');
  });

  it('refuses missing, bad and stale signatures (401) and records nothing', async () => {
    const deposit = await pendingDeposit('4000');
    const before = await cashOf(player);
    const valid = mock.simulateDepositDecision({
      providerRef: refOf(deposit),
      amount: 4000n,
      decision: 'approve',
      pin: PIN,
    });

    const unsigned = await deliver({
      rawBody: valid.rawBody,
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(apiError(unsigned).code).toBe('webhook_signature_invalid');

    // The amount was changed after signing.
    const tampered = await deliver({
      ...valid,
      rawBody: String(valid.rawBody).replace('"4000"', '"400000"'),
    });
    expect(tampered.statusCode).toBe(401);

    const garbage = await deliver({
      ...valid,
      headers: { ...valid.headers, [MOCK_SIGNATURE_HEADER]: 't=1,v1=deadbeef' },
    });
    expect(garbage.statusCode).toBe(401);

    const stale = await deliver(
      mock.signWebhook(String(valid.rawBody), new Date(ctx.clock.now.getTime() - 10 * MINUTE_MS)),
    );
    expect(stale.statusCode).toBe(401);

    expect(await eventsFor(deposit.id)).toHaveLength(0);
    expect(await cashOf(player)).toBe(before);

    // The genuine one still works afterwards.
    expect(PaymentWebhookAck.parse((await deliver(valid)).json()).outcome).toBe('credited');
  });

  it('answers 400 for a signed but malformed body and 413 for an oversized one', async () => {
    const malformed = await deliver(mock.signWebhook('{"hello":"world"}'));
    expect(malformed.statusCode).toBe(400);
    expect(apiError(malformed).code).toBe('webhook_malformed');

    const notJson = await deliver(mock.signWebhook('not json at all'));
    expect(notJson.statusCode).toBe(400);

    const huge = await deliver(mock.signWebhook(`{"pad":"${'x'.repeat(WEBHOOK_BODY_LIMIT)}"}`));
    expect(huge.statusCode).toBe(413);

    const empty = await ctx.app.inject({ method: 'POST', url: '/payments/webhooks/mock' });
    expect(empty.statusCode).toBe(401);
  });

  it('answers 404 for an unknown reference (recording nothing) and for disabled providers', async () => {
    const unknown = await deliver(
      mock.simulateDepositDecision({
        providerRef: `mockdep_${randomUUID()}`,
        amount: 1000n,
        decision: 'decline',
      }),
    );
    expect(unknown.statusCode).toBe(404);
    expect(apiError(unknown).code).toBe('unknown_payment_reference');
    const recorded = await ctx.db.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.outcome, 'failed'));
    expect(recorded.every((row) => row.intentId !== null)).toBe(true);

    for (const provider of ['chapa', 'telebirr', 'nope']) {
      const response = await deliver(mock.signWebhook('{}'), ctx.app, provider);
      expect(response.statusCode, provider).toBe(404);
    }
  });

  it('flags (and does not credit) an event whose amount differs from the deposit', async () => {
    const deposit = await pendingDeposit('8000');
    const before = await cashOf(player);
    const response = await deliver(
      mock.simulateDepositDecision({
        providerRef: refOf(deposit),
        amount: 80_000n,
        decision: 'approve',
        pin: PIN,
      }),
    );
    expect(PaymentWebhookAck.parse(response.json()).outcome).toBe('flagged');
    expect(await cashOf(player)).toBe(before);
    const view = await ctx.app.inject({
      method: 'GET',
      url: `/payments/deposits/${deposit.id}`,
      headers: bearer(player),
    });
    expect(DepositView.parse(view.json())).toMatchObject({ status: 'pending', underReview: true });
  });

  it('needs no session or CSRF token', async () => {
    const deposit = await pendingDeposit('1500');
    const response = await deliver(
      mock.simulateDepositDecision({
        providerRef: refOf(deposit),
        amount: 1500n,
        decision: 'decline',
      }),
    );
    expect(response.statusCode).toBe(200);
  });
});

describe('withdrawals', () => {
  let player: LoggedInUser;
  let other: LoggedInUser;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
    other = await registerAndLogin(ctx);
    await depositAndApprove(player, 2_000_000n);
  });

  it('requires KYC, the registered phone and wagered deposits', async () => {
    const noKyc = await postWithdrawal(player, { amount: '10000' });
    expect(noKyc.statusCode).toBe(403);
    expect(apiError(noKyc).code).toBe('kyc_required');

    await verifyKyc(player);

    const wagering = await postWithdrawal(player, { amount: '10000' });
    expect(wagering.statusCode).toBe(422);
    expect(apiError(wagering)).toMatchObject({
      code: 'wagering_requirement_not_met',
      details: { remaining: '2000000' },
    });
    const list = WithdrawalsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/withdrawals',
          headers: bearer(player),
        })
      ).json(),
    );
    expect(list.wageringRemaining).toBe('2000000');

    // From here on the deposits count as wagered (and the deposit-then-withdraw AML rule,
    // tested in 'AML on withdrawal requests', is off).
    await setPaymentRules({ wageringMultiplierBps: 0 });
    await setSetting(ctx.db.db, 'aml_rules', { depositThenWithdraw: { enabled: false } });

    const phone = await postWithdrawal(player, { amount: '10000', phone: other.phone });
    expect(phone.statusCode).toBe(422);
    expect(apiError(phone).code).toBe('payout_phone_mismatch');

    const small = await postWithdrawal(player, { amount: '4999' });
    expect(apiError(small).code).toBe('withdrawal_amount_out_of_range');

    const tooMuch = await postWithdrawal(player, { amount: '9000000' });
    expect(tooMuch.statusCode).toBe(422);
    expect(apiError(tooMuch).code).toBe('insufficient_funds');

    const noKey = await postWithdrawal(player, { amount: '10000' }, null);
    expect(apiError(noKey).code).toBe('idempotency_key_required');

    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: '/payments/withdrawals',
      payload: { amount: '10000' },
      headers: { cookie: player.cookie, 'idempotency-key': randomUUID() },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(await ctx.db.db.select().from(payouts).where(eq(payouts.userId, player.userId))).toEqual(
      [],
    );
  });

  it('auto-approves a small withdrawal, holds the money and replays the key', async () => {
    const before = await cashOf(player);
    const key = randomUUID();
    const response = await postWithdrawal(player, { amount: '20000' }, key);
    expect(response.statusCode).toBe(201);
    const withdrawal = WithdrawalView.parse(response.json());
    expect(withdrawal).toMatchObject({
      provider: 'mock',
      amount: '20000',
      phone: player.phone,
      status: 'approved',
      cancellable: false,
      reviewReason: null,
    });
    expect(withdrawal.steps.map((step) => [step.key, step.state])).toEqual([
      ['requested', 'done'],
      ['approved', 'done'],
      ['processing', 'current'],
      ['paid', 'upcoming'],
    ]);
    expect(await cashOf(player)).toBe(before - 20_000n);
    expect(await outboxTypes(withdrawal.id)).toEqual([
      'payment.withdrawal_requested',
      'payment.withdrawal_approved',
    ]);

    const replay = await postWithdrawal(player, { amount: '20000' }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(WithdrawalView.parse(replay.json()).id).toBe(withdrawal.id);
    expect(await cashOf(player)).toBe(before - 20_000n);

    // Approved: about to be sent, so the player can no longer cancel it.
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/payments/withdrawals/${withdrawal.id}/cancel`,
      headers: bearer(player),
    });
    expect(cancel.statusCode).toBe(409);
    expect(apiError(cancel).code).toBe('payout_not_cancellable');
  });

  it('sends large withdrawals to review; the owner can cancel while requested', async () => {
    const before = await cashOf(player);
    const response = await postWithdrawal(player, { amount: '600000' });
    expect(response.statusCode).toBe(201);
    const withdrawal = WithdrawalView.parse(response.json());
    expect(withdrawal).toMatchObject({
      status: 'requested',
      reviewReason: 'above_auto_approve_threshold',
      cancellable: true,
    });
    expect(withdrawal.steps.map((step) => step.state)).toEqual([
      'done',
      'current',
      'upcoming',
      'upcoming',
    ]);

    // Someone else's withdrawal is not found, whatever the method.
    const idor = await ctx.app.inject({
      method: 'POST',
      url: `/payments/withdrawals/${withdrawal.id}/cancel`,
      headers: bearer(other),
    });
    expect(idor.statusCode).toBe(404);
    const peek = await ctx.app.inject({
      method: 'GET',
      url: `/payments/withdrawals/${withdrawal.id}`,
      headers: bearer(other),
    });
    expect(peek.statusCode).toBe(404);

    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: `/payments/withdrawals/${withdrawal.id}/cancel`,
      headers: { cookie: player.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/payments/withdrawals/${withdrawal.id}/cancel`,
      headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
    });
    expect(cancelled.statusCode).toBe(200);
    const view = WithdrawalView.parse(cancelled.json());
    expect(view).toMatchObject({ status: 'cancelled', cancellable: false });
    expect(view.steps.map((step) => step.state)).toEqual([
      'done',
      'failed',
      'upcoming',
      'upcoming',
    ]);
    expect(await cashOf(player)).toBe(before);

    const twice = await ctx.app.inject({
      method: 'POST',
      url: `/payments/withdrawals/${withdrawal.id}/cancel`,
      headers: bearer(player),
    });
    expect(twice.statusCode).toBe(200);
    expect(await cashOf(player)).toBe(before);

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/payments/withdrawals/${withdrawal.id}`,
      headers: bearer(player),
    });
    expect(WithdrawalView.parse(own.json()).status).toBe('cancelled');
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/payments/withdrawals/not-a-uuid/cancel',
          headers: bearer(player),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is approved or rejected in the dev back office stand-in', async () => {
    // A fresh player: the withdrawal route allows 10 requests a minute per player.
    player = await registerAndLogin(ctx);
    await depositAndApprove(player, 1_000_000n);
    await verifyKyc(player);
    const toApprove = WithdrawalView.parse(
      (await postWithdrawal(player, { amount: '500000' })).json(),
    );
    const toReject = WithdrawalView.parse(
      (await postWithdrawal(player, { amount: '500000' })).json(),
    );
    const before = await cashOf(player);

    const queue = DevWithdrawalQueueResponse.parse(
      (await ctx.app.inject({ method: 'GET', url: '/dev/payments/withdrawals' })).json(),
    );
    expect(queue.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([toApprove.id, toReject.id]),
    );

    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/dev/payments/withdrawals/${toApprove.id}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    expect(WithdrawalView.parse(approved.json()).status).toBe('approved');
    const [row] = await ctx.db.db.select().from(payouts).where(eq(payouts.id, toApprove.id));
    expect(row?.approvedBy).toBe(DEV_BACK_OFFICE_ACTOR);
    expect(await outboxTypes(toApprove.id)).toEqual([
      'payment.withdrawal_requested',
      'payment.withdrawal_approved',
    ]);

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/dev/payments/withdrawals/${toReject.id}/reject`,
      payload: { reason: 'Documents needed' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(WithdrawalView.parse(rejected.json())).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Documents needed',
    });
    expect(await cashOf(player)).toBe(before + 500_000n);

    const late = await ctx.app.inject({
      method: 'POST',
      url: `/dev/payments/withdrawals/${toReject.id}/approve`,
    });
    expect(late.statusCode).toBe(409);

    const list = WithdrawalsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/withdrawals?limit=50',
          headers: bearer(player),
        })
      ).json(),
    );
    expect(list.wageringRemaining).toBe('0');
    expect(list.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([toApprove.id, toReject.id]),
    );
    const theirs = WithdrawalsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/withdrawals',
          headers: bearer(other),
        })
      ).json(),
    );
    expect(theirs.items).toEqual([]);
  });

  it('refuses a withdrawal while a deposit reversed at the provider is under review (409)', async () => {
    const reversed = await registerAndLogin(ctx);
    const depositId = await depositAndApprove(reversed, 300_000n);
    await verifyKyc(reversed);
    await setPaymentRules({ wageringMultiplierBps: 0 });
    // The provider now reports the credited deposit failed (reversed or charged back).
    const reversal = await deliver(
      mock.simulateDepositDecision({
        providerRef: mockDepositRef(depositId),
        amount: 300_000n,
        decision: 'decline',
      }),
    );
    expect(PaymentWebhookAck.parse(reversal.json()).outcome).toBe('flagged');
    const refused = await postWithdrawal(reversed, { amount: '10000' });
    expect(refused.statusCode).toBe(409);
    expect(apiError(refused)).toMatchObject({
      code: 'deposit_under_review',
      details: { depositId },
    });
    expect(await cashOf(reversed)).toBe(300_000n);
  });

  it('settles a payout from a signed provider webhook, once', async () => {
    player = await registerAndLogin(ctx);
    await depositAndApprove(player, 500_000n);
    await verifyKyc(player);
    const request = WithdrawalView.parse(
      (await postWithdrawal(player, { amount: '100000' })).json(),
    );
    const providerRef = `mockpay_p_${request.id}`;
    // What the payout worker does: sent, and the provider has not finished yet.
    await ctx.db.db.transaction(async (tx) => {
      const now = ctx.clock.now;
      const claimed = await markPayoutProcessing(tx, { payoutId: request.id, now, checkAt: now });
      await applyPayoutAttempt(tx, {
        payoutId: request.id,
        attempt: claimed.attempts,
        result: { outcome: 'pending', providerRef },
        now,
        retryAt: new Date(now.getTime() + MINUTE_MS),
        maxAttempts: 5,
      });
    });
    const webhook = mock.simulatePayoutResult({
      providerRef,
      amount: 100_000n,
      status: 'succeeded',
    });
    const first = await deliver(webhook);
    expect(PaymentWebhookAck.parse(first.json()).outcome).toBe('paid');
    expect(PaymentWebhookAck.parse((await deliver(webhook)).json()).outcome).toBe('duplicate');

    const view = WithdrawalView.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/payments/withdrawals/${request.id}`,
          headers: bearer(player),
        })
      ).json(),
    );
    expect(view.status).toBe('paid');
    expect(view.steps.every((step) => step.state === 'done')).toBe(true);
    expect(await cashOf(player)).toBe(400_000n);
    expect(await outboxTypes(request.id)).toEqual([
      'payment.withdrawal_requested',
      'payment.withdrawal_approved',
      'payment.withdrawal_paid',
    ]);
  });
});

describe('AML on withdrawal requests', () => {
  it('holds a withdrawal of an unplayed deposit for staff (high-severity flag, aml_review)', async () => {
    await setPaymentRules({ wageringMultiplierBps: 0 });
    await setSetting(ctx.db.db, 'aml_rules', {});
    const player = await registerAndLogin(ctx);
    await depositAndApprove(player, 2_000_000n);
    await verifyKyc(player);
    // Small enough to be approved automatically, but nothing of the 20,000 ETB was staked.
    const response = await postWithdrawal(player, { amount: '20000' });
    expect(response.statusCode, response.body).toBe(201);
    expect(WithdrawalView.parse(response.json())).toMatchObject({
      status: 'requested',
      reviewReason: 'aml_review',
    });
    const flags = await ctx.db.db.select().from(amlFlags).where(eq(amlFlags.userId, player.userId));
    expect(flags).toMatchObject([
      { rule: 'deposit_then_withdraw', severity: 'high', status: 'open', source: 'withdrawal' },
    ]);
    // A second request waits for staff too, and raises no second flag for the same deposit.
    const second = await postWithdrawal(player, { amount: '10000' });
    expect(WithdrawalView.parse(second.json()).reviewReason).toBe('aml_review');
    expect(
      await ctx.db.db.select().from(amlFlags).where(eq(amlFlags.userId, player.userId)),
    ).toHaveLength(1);
  });
});

describe('withdrawal status tracker', () => {
  const base = {
    requestedAt: new Date('2026-10-10T08:00:00Z'),
    approvedAt: null,
    processingAt: null,
    completedAt: null,
    updatedAt: new Date('2026-10-10T08:00:00Z'),
  };
  type Row = Parameters<typeof withdrawalSteps>[0];
  const states = (row: Partial<Row>) =>
    withdrawalSteps({ ...base, status: 'requested', ...row } as Row).map((step) => step.state);

  it('marks every step up to the furthest reached as done', () => {
    const at = new Date('2026-10-10T09:00:00Z');
    expect(states({ status: 'processing', approvedAt: at, processingAt: at })).toEqual([
      'done',
      'done',
      'done',
      'current',
    ]);
    expect(states({ status: 'paid', approvedAt: at, processingAt: at, completedAt: at })).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    // Settled by staff without being sent: processingAt is null.
    expect(states({ status: 'paid', approvedAt: at, completedAt: at })).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(states({ status: 'failed', approvedAt: at, processingAt: at, completedAt: at })).toEqual(
      ['done', 'done', 'done', 'failed'],
    );
    expect(states({ status: 'rejected', completedAt: at })).toEqual([
      'done',
      'failed',
      'upcoming',
      'upcoming',
    ]);
  });
});

describe('licensed mode and dev route gating', () => {
  /** A registry without the mock provider (what licensed mode has). */
  const noMock: PaymentProviderRegistry = {
    names: [],
    get: () => undefined,
    require: (name) => {
      throw new Error(`not enabled: ${name}`);
    },
  };

  it('never builds the mock provider outside demo mode', () => {
    expect(() =>
      createPaymentProviders(
        { ...ctx.deps.config, mode: 'licensed' },
        { fetch: globalThis.fetch, clock: () => new Date(), randomBytes },
      ),
    ).toThrow(ProviderNotConfiguredError);
  });

  it('enables the dev payment tools only in demo mode, with the mock provider, outside production', () => {
    const { config, payments } = ctx.deps;
    expect(devPaymentsEnabled({ config, payments })).toBe(true);
    expect(devPaymentsEnabled({ config: { ...config, mode: 'licensed' }, payments })).toBe(false);
    expect(devPaymentsEnabled({ config: { ...config, nodeEnv: 'production' }, payments })).toBe(
      false,
    );
    expect(devPaymentsEnabled({ config, payments: noMock })).toBe(false);
  });

  it('has no simulator, no stand-in back office and no mock webhook in licensed mode', async () => {
    const player = await registerAndLogin(ctx);
    const app = buildApp(
      { ...ctx.deps, config: { ...ctx.deps.config, mode: 'licensed' }, payments: noMock },
      { logger: false, rateLimitNameSpace: `licensed-pay-${randomBytes(4).toString('hex')}:` },
    );
    try {
      const routes = [
        { method: 'GET' as const, url: `/dev/payments/phone?phone=${player.phone}` },
        { method: 'POST' as const, url: '/dev/payments/phone' },
        { method: 'GET' as const, url: '/dev/payments/withdrawals' },
        { method: 'POST' as const, url: `/dev/payments/withdrawals/${randomUUID()}/approve` },
        { method: 'POST' as const, url: `/dev/payments/withdrawals/${randomUUID()}/reject` },
      ];
      for (const route of routes) {
        const response = await app.inject({ ...route, payload: {} });
        expect(response.statusCode, route.url).toBe(404);
        expect(apiError(response).code).toBe('not_found');
      }

      const webhook = await deliver(
        mock.simulateDepositDecision({
          providerRef: `mockdep_${randomUUID()}`,
          amount: 1000n,
          decision: 'decline',
        }),
        app,
      );
      expect(webhook.statusCode).toBe(404);

      const deposit = await postDeposit(
        player,
        { amount: '5000', provider: 'mock' },
        undefined,
        app,
      );
      expect(deposit.statusCode).toBe(422);
      expect(apiError(deposit).code).toBe('payment_provider_unavailable');
      const anyDeposit = await postDeposit(player, { amount: '5000' }, undefined, app);
      expect(apiError(anyDeposit).code).toBe('payment_provider_unavailable');

      const options = PaymentOptionsResponse.parse(
        (await app.inject({ method: 'GET', url: '/payments/options' })).json(),
      );
      expect(options).toMatchObject({ demo: false, providers: [] });
    } finally {
      await app.close();
    }
  });
});
