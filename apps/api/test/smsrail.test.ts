import { randomUUID } from 'node:crypto';
import {
  AddPayoutAccountResponse,
  ApiErrorSchema,
  ClaimManualPayoutBatchResponse,
  DepositCheckResponse,
  DepositView,
  DevSmsResponse,
  PaymentOptionsResponse,
  PaymentWebhookAck,
  PayoutAccountView,
  PayoutAccountsResponse,
  SmsRailHealthResponse,
  StaffSmsListResponse,
  StaffWithdrawalChangeResponse,
  StaffWithdrawalListResponse,
  StaffWithdrawalView,
  WalletResponse,
  WithdrawalView,
} from '@vamos/contracts';
import { santimToBirrString } from '@vamos/core';
import { setSetting } from '@vamos/db';
import { kycProfiles } from '@vamos/db/schema';
import {
  SMS_GATEWAY_SECRET_HEADER,
  SmsRailProvider,
  type PaymentProviderRegistry,
  type ReceiptVerifier,
} from '@vamos/payments';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const GATEWAY_SECRET = 'a-live-sms-gateway-secret-of-40-characters';

let ctx: TestContext;
let simulatedRegistry: PaymentProviderRegistry;

beforeAll(async () => {
  ctx = await createTestContext({ PAYMENT_PROVIDERS: 'mock,sms' });
  simulatedRegistry = ctx.deps.payments;
  await setSetting(ctx.db.db, 'payments', { wageringMultiplierBps: 0 });
  await setSetting(ctx.db.db, 'aml_rules', { depositThenWithdraw: { enabled: false } });
  await seedStaff(ctx);
});

afterAll(async () => {
  await ctx?.close();
});

afterEach(() => {
  ctx.deps.payments = simulatedRegistry;
  delete ctx.deps.receipts;
});

const apiError = (response: LightMyRequestResponse) => ApiErrorSchema.parse(response.json()).error;
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });

function postAs(
  user: LoggedInUser,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { ...bearer(user), ...headers },
  });
}

async function openSmsDeposit(user: LoggedInUser, amount: bigint): Promise<DepositView> {
  const response = await postAs(
    user,
    '/payments/deposits',
    { amount: amount.toString(), provider: 'sms' },
    { 'idempotency-key': randomUUID() },
  );
  expect(response.statusCode).toBe(201);
  return DepositView.parse(response.json());
}

async function simulate(user: LoggedInUser, depositId: string, variant = 'exact') {
  const response = await postAs(user, '/dev/payments/sms', { depositId, variant });
  expect(response.statusCode).toBe(200);
  return DevSmsResponse.parse(response.json());
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

/** The registry with a live SMS rail (the gateway route only answers on it). */
function goLive(options: { allowlist?: string[] } = {}): SmsRailProvider {
  const live = new SmsRailProvider({
    mode: 'live',
    gatewaySecret: GATEWAY_SECRET,
    gatewayAllowlist: options.allowlist ?? [],
    collectionAccounts: [
      { institution: 'telebirr', account: '0911678426', name: 'Vamos Betting PLC' },
    ],
  });
  ctx.deps.payments = {
    names: simulatedRegistry.names,
    get: (name) => (name === 'sms' ? live : simulatedRegistry.get(name)),
    require: (name) => (name === 'sms' ? live : simulatedRegistry.require(name)),
  };
  return live;
}

function gateway(body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/payments/webhooks/sms',
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** "dd/mm/yyyy at h:mm:ss AM" in EAT, as telebirr writes the time of a payment. */
function eatStamp(at: Date): string {
  const eat = new Date(at.getTime() + 3 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h24 = eat.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad(eat.getUTCDate())}/${pad(eat.getUTCMonth() + 1)}/${eat.getUTCFullYear()} at ${h12}:${pad(eat.getUTCMinutes())}:${pad(eat.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function telebirrCredit(amount: bigint, phone: string, reference: string): string {
  return `Dear CUSTOMER, you have received ETB ${santimToBirrString(amount)} from SENDER (${phone.slice(1)}) on ${eatStamp(ctx.clock.now)}. Your transaction number is ${reference}.`;
}

describe('payment options', () => {
  it('describes the simulated rail and its collection accounts', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/payments/options' });
    const body = PaymentOptionsResponse.parse(response.json());
    expect(body.providers).toContainEqual({
      name: 'sms',
      deposits: true,
      payouts: true,
      manual: true,
    });
    expect(body.smsRail).toMatchObject({ mode: 'simulated', maxExtraSantim: 50 });
    expect(body.smsRail?.methods[0]).toMatchObject({
      institution: 'telebirr',
      ussd: '*127#',
      accounts: [{ account: '0900000000', name: 'Vamos Demo', hint: null }],
    });
  });
});

describe('SMS deposits', () => {
  let player: LoggedInUser;
  beforeAll(async () => {
    player = await registerAndLogin(ctx);
  });

  it('opens a transfer for an exact amount and credits it from the simulator', async () => {
    const deposit = await openSmsDeposit(player, 10_000n);
    expect(deposit.initiation?.kind).toBe('transfer');
    expect(deposit.transfer?.requestedAmount).toBe('10000');
    const send = BigInt(deposit.transfer!.sendAmount);
    expect(send > 10_000n && send <= 10_050n).toBe(true);

    const before = await cashOf(player);
    const sms = await simulate(player, deposit.id);
    expect(sms.outcome).toBe('credited');
    expect(sms.deposit.status).toBe('succeeded');
    expect(await cashOf(player)).toBe(before + send);

    // Pasting the SMS afterwards says so, for its owner.
    const check = await postAs(player, '/payments/deposits/check', { text: sms.text });
    expect(DepositCheckResponse.parse(check.json()).status).toBe('already_credited');
  });

  it('flags a payment from someone else’s phone for staff', async () => {
    const deposit = await openSmsDeposit(player, 20_000n);
    const sms = await simulate(player, deposit.id, 'other_phone');
    expect(sms.outcome).toBe('flagged');
    expect(sms.deposit.underReview).toBe(true);
  });

  it('refuses the simulator for another player’s deposit and an unknown paste', async () => {
    const deposit = await openSmsDeposit(player, 30_000n);
    const stranger = await registerAndLogin(ctx);
    const response = await postAs(stranger, '/dev/payments/sms', { depositId: deposit.id });
    expect(response.statusCode).toBe(404);
    const check = await postAs(stranger, '/payments/deposits/check', { text: 'ZZ99999999' });
    expect(DepositCheckResponse.parse(check.json())).toEqual({
      status: 'not_found',
      deposit: null,
    });
  });

  it('keeps the gateway route closed on the simulated rail', async () => {
    const response = await gateway({ text: 'anything', secret: GATEWAY_SECRET });
    expect(response.statusCode).toBe(404);
  });
});

describe('the live gateway', () => {
  let player: LoggedInUser;
  beforeAll(async () => {
    player = await registerAndLogin(ctx);
  });

  it('needs the shared secret and credits a forwarded SMS once', async () => {
    const deposit = await openSmsDeposit(player, 40_000n);
    goLive();
    const text = telebirrCredit(BigInt(deposit.transfer!.sendAmount), player.phone, 'LV00000001');
    expect((await gateway({ sender: 'telebirr', text })).statusCode).toBe(401);
    expect((await gateway({ sender: 'telebirr', text, secret: 'wrong' })).statusCode).toBe(401);
    expect(
      (await gateway({ sender: 'telebirr', text }, { [SMS_GATEWAY_SECRET_HEADER]: 'wrong' }))
        .statusCode,
    ).toBe(401);
    const ok = await gateway(
      { sender: 'telebirr', text },
      { [SMS_GATEWAY_SECRET_HEADER]: GATEWAY_SECRET },
    );
    expect(ok.statusCode).toBe(200);
    expect(PaymentWebhookAck.parse(ok.json()).outcome).toBe('credited');
    const again = await gateway({ sender: 'telebirr', text, secret: GATEWAY_SECRET });
    expect(PaymentWebhookAck.parse(again.json()).outcome).toBe('duplicate');
  });

  it('refuses malformed bodies and addresses outside the allowlist', async () => {
    goLive();
    expect((await gateway({ secret: GATEWAY_SECRET })).statusCode).toBe(400);
    const raw = await ctx.app.inject({
      method: 'POST',
      url: '/payments/webhooks/sms',
      payload: 'not json',
      headers: { 'content-type': 'text/plain' },
    });
    expect(raw.statusCode).toBe(400);
    goLive({ allowlist: ['196.188.0.1'] });
    expect((await gateway({ text: 'x', secret: GATEWAY_SECRET })).statusCode).toBe(403);
  });

  it('asks the receipt page when the handset never forwarded a payment', async () => {
    const deposit = await openSmsDeposit(player, 50_000n);
    goLive();
    const send = BigInt(deposit.transfer!.sendAmount);
    const asked: string[] = [];
    const receipts: ReceiptVerifier = {
      verify: async (request) => {
        asked.push(`${request.institution}:${request.reference}`);
        return {
          status: 'verified',
          amount: send,
          facts: {
            reference: request.reference,
            amounts: [send],
            payerName: 'Test Player',
            payerAccount: '251911***123',
            receiverName: 'Vamos',
            receiverAccount: '251911***426',
            completed: true,
            occurredAt: new Date(ctx.clock.now.getTime() + 60_000),
          },
        };
      },
      state: () => ({ breaker: 'closed', consecutiveFailures: 0 }),
    };
    ctx.deps.receipts = receipts;
    const check = await postAs(player, '/payments/deposits/check', { text: 'rc00000001' });
    const body = DepositCheckResponse.parse(check.json());
    expect(asked).toEqual(['telebirr:RC00000001']);
    expect(body.status).toBe('credited');
    expect(body.deposit?.id).toBe(deposit.id);
  });
});

describe('payout accounts and manual withdrawals', () => {
  let player: LoggedInUser;
  let finance: StaffSession;
  let admin: StaffSession;

  beforeAll(async () => {
    player = await registerAndLogin(ctx);
    finance = await staffLogin(ctx, 'finance');
    admin = await staffLogin(ctx, 'admin');
  });

  it('needs KYC, then saves the player’s own wallet by itself', async () => {
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/payments/payout-accounts',
      headers: bearer(player),
    });
    expect(PayoutAccountsResponse.parse(before.json())).toMatchObject({ items: [], canAdd: false });
    await verifyKyc(player);
    const after = PayoutAccountsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/payout-accounts',
          headers: bearer(player),
        })
      ).json(),
    );
    expect(after.canAdd).toBe(true);
    expect(after.items).toEqual([
      expect.objectContaining({ institution: 'telebirr', account: player.phone, verified: true }),
    ]);
    expect(after.destinations[0]?.id).toBe('telebirr');
  });

  it('confirms a bank account in the KYC name with a code bound to it', async () => {
    const wrongName = await postAs(player, '/payments/payout-accounts', {
      institution: 'cbe',
      account: '1000123456789',
      accountName: 'Someone Else',
    });
    expect(apiError(wrongName).code).toBe('payout_account_name_mismatch');
    const added = await postAs(player, '/payments/payout-accounts', {
      institution: 'cbe',
      account: '1000123456789',
      accountName: 'TEST PLAYER',
    });
    expect(added.statusCode).toBe(201);
    const body = AddPayoutAccountResponse.parse(added.json());
    expect(body.account.verified).toBe(false);
    expect(body.otp?.demoOtp).toMatch(/^\d{6}$/);
    const wrong = await postAs(player, `/payments/payout-accounts/${body.account.id}/confirm`, {
      code: body.otp!.demoOtp === '000000' ? '111111' : '000000',
    });
    expect(apiError(wrong).code).toBe('otp_invalid');
    const confirmed = await postAs(player, `/payments/payout-accounts/${body.account.id}/confirm`, {
      code: body.otp!.demoOtp,
    });
    expect(PayoutAccountView.parse(confirmed.json()).verified).toBe(true);
  });

  it('pays a manual withdrawal under four eyes', async () => {
    // Money in through the simulator.
    const deposit = await openSmsDeposit(player, 900_000n);
    await simulate(player, deposit.id);
    const accounts = PayoutAccountsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/payout-accounts',
          headers: bearer(player),
        })
      ).json(),
    );
    const wallet = accounts.items.find((a) => a.institution === 'telebirr')!;

    const missing = await postAs(
      player,
      '/payments/withdrawals',
      { amount: '600000', provider: 'sms' },
      { 'idempotency-key': randomUUID() },
    );
    expect(apiError(missing).code).toBe('payout_account_required');

    const requested = await postAs(
      player,
      '/payments/withdrawals',
      { amount: '600000', provider: 'sms', payoutAccountId: wallet.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(requested.statusCode).toBe(201);
    const withdrawal = WithdrawalView.parse(requested.json());
    expect(withdrawal).toMatchObject({
      manual: true,
      status: 'requested',
      destination: { institution: 'telebirr', account: player.phone },
    });

    const approved = await asStaff(
      ctx,
      finance,
      'POST',
      `/admin/withdrawals/${withdrawal.id}/approve`,
    );
    expect(approved.statusCode).toBe(200);

    const queue = StaffWithdrawalListResponse.parse(
      (await asStaff(ctx, admin, 'GET', '/admin/manual-payouts')).json(),
    );
    expect(queue.items.map((w) => w.id)).toContain(withdrawal.id);

    const approverClaims = await asStaff(
      ctx,
      finance,
      'POST',
      `/admin/manual-payouts/${withdrawal.id}/claim`,
    );
    expect(apiError(approverClaims).code).toBe('manual_payout_approver_cannot_pay');
    const providerSettle = await asStaff(
      ctx,
      admin,
      'POST',
      `/admin/withdrawals/${withdrawal.id}/settle`,
      {
        outcome: 'paid',
      },
    );
    expect(apiError(providerSettle).code).toBe('manual_payout');

    const claimed = await asStaff(
      ctx,
      admin,
      'POST',
      `/admin/manual-payouts/${withdrawal.id}/claim`,
    );
    expect(StaffWithdrawalChangeResponse.parse(claimed.json()).withdrawal.payingBy).toBe(admin.id);

    // The operator's handset forwards the outgoing confirmation: proposed as the proof.
    const outgoing = await ctx.app.inject({
      method: 'POST',
      url: `/dev/payments/sms/outgoing/${withdrawal.id}`,
    });
    expect(outgoing.json()).toMatchObject({ outcome: 'proposed' });
    const proposed = StaffWithdrawalView.parse(
      (await asStaff(ctx, admin, 'GET', `/admin/withdrawals/${withdrawal.id}`)).json(),
    );
    expect(proposed.proposedSms).not.toBeNull();
    const settled = await asStaff(
      ctx,
      admin,
      'POST',
      `/admin/manual-payouts/${withdrawal.id}/settle`,
      {
        smsId: proposed.proposedSms!.id,
      },
    );
    expect(settled.statusCode).toBe(200);
    const paid = StaffWithdrawalChangeResponse.parse(settled.json()).withdrawal;
    expect(paid).toMatchObject({ status: 'paid', settledBy: admin.id });

    const mine = WithdrawalView.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/payments/withdrawals/${withdrawal.id}`,
          headers: bearer(player),
        })
      ).json(),
    );
    expect(mine.status).toBe('paid');
    expect(mine.settlementReference).toBe(proposed.proposedSms!.reference);
  });

  it('shows the review queue and health, and lets staff credit a flagged SMS', async () => {
    const deposit = await openSmsDeposit(player, 70_000n);
    await simulate(player, deposit.id, 'other_phone');
    const queue = StaffSmsListResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/sms')).json(),
    );
    const flagged = queue.items.find((sms) => sms.flaggedIntentId === deposit.id);
    expect(flagged?.status).toBe('flagged');
    const before = await cashOf(player);
    const credited = await asStaff(ctx, finance, 'POST', `/admin/sms/${flagged!.id}/credit`, {
      userId: player.userId,
      note: 'the player’s sister paid, confirmed by phone',
    });
    expect(credited.statusCode).toBe(200);
    expect(await cashOf(player)).toBe(before + BigInt(deposit.transfer!.sendAmount));
    const health = SmsRailHealthResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/sms/health')).json(),
    );
    expect(health).toMatchObject({
      mode: 'simulated',
      receiptVerify: 'audit',
      receiptBreaker: null,
    });
  });
});

describe('POST /admin/manual-payouts/claim-batch', () => {
  const URL = '/admin/manual-payouts/claim-batch';
  let finance: StaffSession;
  let admin: StaffSession;
  let payoutIds: string[];

  /** A manual payout of 6,000 ETB approved by `approver`. */
  async function approvedManualPayout(approver: StaffSession): Promise<string> {
    const player = await registerAndLogin(ctx);
    await verifyKyc(player);
    const deposit = await openSmsDeposit(player, 900_000n);
    await simulate(player, deposit.id);
    const accounts = PayoutAccountsResponse.parse(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/payments/payout-accounts',
          headers: bearer(player),
        })
      ).json(),
    );
    const requested = await postAs(
      player,
      '/payments/withdrawals',
      {
        amount: '600000',
        provider: 'sms',
        payoutAccountId: accounts.items.find((a) => a.institution === 'telebirr')!.id,
      },
      { 'idempotency-key': randomUUID() },
    );
    const { id } = WithdrawalView.parse(requested.json());
    const approved = await asStaff(ctx, approver, 'POST', `/admin/withdrawals/${id}/approve`);
    expect(approved.statusCode).toBe(200);
    return id;
  }

  beforeAll(async () => {
    finance = await staffLogin(ctx, 'finance');
    admin = await staffLogin(ctx, 'admin');
    payoutIds = [
      await approvedManualPayout(finance),
      await approvedManualPayout(finance),
      await approvedManualPayout(admin),
    ];
  });

  it('needs a staff session, the CSRF token and the payouts.settle_manual permission', async () => {
    const anonymous = await ctx.app.inject({ method: 'POST', url: URL, payload: {} });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await ctx.app.inject({
      method: 'POST',
      url: URL,
      payload: {},
      headers: { cookie: admin.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(apiError(noCsrf).code).toBe('csrf_invalid');
    const support = await staffLogin(ctx, 'support');
    const denied = await asStaff(ctx, support, 'POST', URL, {});
    expect(denied.statusCode).toBe(403);
    for (const id of payoutIds) {
      const payout = StaffWithdrawalView.parse(
        (await asStaff(ctx, admin, 'GET', `/admin/withdrawals/${id}`)).json(),
      );
      expect(payout.status).toBe('approved');
    }
  });

  it('validates the body: limit 1 to 20, at most 20 uuids', async () => {
    for (const body of [
      { limit: 0 },
      { limit: 21 },
      { limit: 1.5 },
      { limit: '5' },
      { ids: ['not-a-uuid'] },
      { ids: Array.from({ length: 21 }, () => randomUUID()) },
      { ids: 'x' },
    ]) {
      const response = await asStaff(ctx, admin, 'POST', URL, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(apiError(response).code).toBe('validation_error');
    }
    // The edges are accepted: 20 uuids that name nothing are all refused, none blocks the answer.
    const unknown = Array.from({ length: 20 }, () => randomUUID());
    const edge = await asStaff(ctx, admin, 'POST', URL, { limit: 20, ids: unknown });
    expect(edge.statusCode).toBe(200);
    const body = ClaimManualPayoutBatchResponse.parse(edge.json());
    expect(body.results).toHaveLength(20);
    expect(body.results.every((r) => !r.claimed && r.reason === 'not_found')).toBe(true);
  });

  it('claims for the signed-in operator and never tries what they approved', async () => {
    // Asked for by id, the admin's own approval is refused with the four-eyes code.
    const own = await asStaff(ctx, admin, 'POST', URL, { ids: [payoutIds[2]] });
    expect(ClaimManualPayoutBatchResponse.parse(own.json()).results).toEqual([
      { payoutId: payoutIds[2], claimed: false, reason: 'manual_payout_approver_cannot_pay' },
    ]);

    // Without ids the batch skips it and takes the others.
    const response = await asStaff(ctx, admin, 'POST', URL, { limit: 20 });
    expect(response.statusCode).toBe(200);
    const { results } = ClaimManualPayoutBatchResponse.parse(response.json());
    // Other tests of this file may have left an approved payout; only ours are checked.
    // Their order is the approval order, which can tie within a millisecond: compare by id.
    const ours = results
      .filter((r) => payoutIds.includes(r.payoutId))
      .sort((a, b) => payoutIds.indexOf(a.payoutId) - payoutIds.indexOf(b.payoutId));
    expect(ours.map((r) => [r.payoutId, r.claimed, r.reason])).toEqual([
      [payoutIds[0], true, undefined],
      [payoutIds[1], true, undefined],
    ]);
    const claimed = StaffWithdrawalView.parse(
      (await asStaff(ctx, admin, 'GET', `/admin/withdrawals/${payoutIds[0]}`)).json(),
    );
    expect(claimed).toMatchObject({ status: 'processing', payingBy: admin.id });

    // The other operator takes what is left (the one the admin approved), and the default limit is 10.
    const second = await asStaff(ctx, finance, 'POST', URL);
    expect(second.statusCode).toBe(200);
    const taken = ClaimManualPayoutBatchResponse.parse(second.json()).results;
    expect(taken.find((r) => r.payoutId === payoutIds[2])?.claimed).toBe(true);
    expect(taken.some((r) => r.payoutId === payoutIds[0])).toBe(false);
  });

  it('refuses a payout someone already claimed, by id, with the single claim code', async () => {
    const response = await asStaff(ctx, finance, 'POST', URL, { ids: [payoutIds[0]] });
    const { results } = ClaimManualPayoutBatchResponse.parse(response.json());
    expect(results).toEqual([
      { payoutId: payoutIds[0], claimed: false, reason: 'manual_payout_wrong_status' },
    ]);
  });
});
