import { randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { ApiErrorSchema, MeResponse, RgLimitsResponse, SessionResponse } from '@vamos/contracts';
import { postTransaction, type LedgerTransactionType, type PostingEntry } from '@vamos/db';
import {
  auditLog,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
  rgLimits,
  sessions,
} from '@vamos/db/schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertCanGamble } from '../src/modules/rg/guard';
import {
  LIMIT_INCREASE_DELAY_MS,
  MAX_LIMIT,
  MIN_LIMIT,
  addUtcMonths,
  assertDepositAllowed,
  assertStakeAllowed,
  decideLimitChange,
  exclusionEndsAt,
  extendsProtection,
  getActiveLimits,
  resolveLimitSlot,
  type LimitRow,
} from '../src/modules/rg/service';
import {
  createTestContext,
  post,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const bearer = (player: LoggedInUser) => ({ authorization: `Bearer ${player.sessionToken}` });

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

const NO_LIMIT = { amount: null, pending: null };
const NO_LIMITS = {
  deposit: { day: NO_LIMIT, week: NO_LIMIT, month: NO_LIMIT },
  loss: { day: NO_LIMIT, week: NO_LIMIT, month: NO_LIMIT },
  stake: { bet: NO_LIMIT },
};

describe('responsible gambling', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const at = (offsetMs: number) => new Date(ctx.clock.now.getTime() + offsetMs);

  async function getLimitsRequest(player: LoggedInUser) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/me/limits',
      headers: bearer(player),
    });
    expect(response.statusCode).toBe(200);
    return RgLimitsResponse.parse(response.json());
  }

  function putLimits(player: LoggedInUser, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: 'PUT', url: '/me/limits', payload, headers: bearer(player) });
  }

  async function setLimits(player: LoggedInUser, payload: Record<string, unknown>) {
    const response = await putLimits(player, payload);
    expect(response.statusCode).toBe(200);
    return RgLimitsResponse.parse(response.json());
  }

  function startExclusion(player: LoggedInUser, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/me/exclusions',
      payload,
      headers: bearer(player),
    });
  }

  async function audits(userId: string, action: string) {
    return ctx.db.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, userId), eq(auditLog.action, action)))
      .orderBy(asc(auditLog.id));
  }

  /** Posts a balanced ledger transaction, back-dated to `createdAt` when given. */
  async function postLedger(
    type: LedgerTransactionType,
    entries: PostingEntry[],
    createdAt?: Date,
  ) {
    const result = await ctx.db.db.transaction((tx) =>
      postTransaction(tx, { type, idempotencyKey: `test:${randomUUID()}`, entries }),
    );
    if (createdAt !== undefined) {
      await ctx.db.db
        .update(ledgerTransactions)
        .set({ createdAt })
        .where(eq(ledgerTransactions.id, result.transactionId));
    }
  }

  const cash = (userId: string) => ({ kind: 'player_cash' as const, userId });

  const deposit = (userId: string, amount: bigint, createdAt: Date) =>
    postLedger(
      'deposit',
      [
        { account: { kind: 'house_psp_clearing', provider: 'mock' }, amount: -amount },
        { account: cash(userId), amount },
      ],
      createdAt,
    );

  const topUp = (userId: string, amount: bigint) =>
    postLedger('demo_topup', [
      { account: { kind: 'house_demo_funding' }, amount: -amount },
      { account: cash(userId), amount },
    ]);

  const stake = (userId: string, amount: bigint, createdAt: Date) =>
    postLedger(
      'bet_stake',
      [
        { account: cash(userId), amount: -amount },
        { account: { kind: 'house_stakes' }, amount },
      ],
      createdAt,
    );

  const payout = (userId: string, amount: bigint, createdAt: Date) =>
    postLedger(
      'bet_payout',
      [
        { account: { kind: 'house_stakes' }, amount: -amount },
        { account: cash(userId), amount },
      ],
      createdAt,
    );

  it('requires a session for every route', async () => {
    for (const [method, url] of [
      ['GET', '/me/limits'],
      ['PUT', '/me/limits'],
      ['POST', '/me/exclusions'],
    ] as const) {
      const response = await ctx.app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(apiError(response).code).toBe('unauthorized');
    }
  });

  describe('GET /me/limits', () => {
    it('reports no limits for a new player', async () => {
      const player = await registerAndLogin(ctx);
      expect(await getLimitsRequest(player)).toEqual(NO_LIMITS);
      expect(await getActiveLimits(ctx.db.db, player.userId, ctx.clock.now)).toEqual({
        deposit: { day: null, week: null, month: null },
        loss: { day: null, week: null, month: null },
        stake: { bet: null },
      });
    });
  });

  describe('PUT /me/limits', () => {
    it('applies first limits immediately and audits them', async () => {
      const player = await registerAndLogin(ctx);
      const body = await setLimits(player, {
        deposit: { day: '50000', week: '200000' },
        loss: { month: '1000000' },
        stake: { bet: '10000' },
      });
      expect(body).toEqual({
        deposit: {
          day: { amount: '50000', pending: null },
          week: { amount: '200000', pending: null },
          month: NO_LIMIT,
        },
        loss: { day: NO_LIMIT, week: NO_LIMIT, month: { amount: '1000000', pending: null } },
        stake: { bet: { amount: '10000', pending: null } },
      });
      expect(await getLimitsRequest(player)).toEqual(body);
      expect(await getActiveLimits(ctx.db.db, player.userId, ctx.clock.now)).toEqual({
        deposit: { day: 50_000n, week: 200_000n, month: null },
        loss: { day: null, week: null, month: 1_000_000n },
        stake: { bet: 10_000n },
      });

      const [audit] = await audits(player.userId, 'rg.limits_changed');
      expect(audit!.metadata).toEqual({
        changes: expect.arrayContaining([
          {
            limit: 'deposit.day',
            from: null,
            to: '50000',
            effectiveFrom: ctx.clock.now.toISOString(),
            delayed: false,
            replacedPending: false,
          },
          expect.objectContaining({ limit: 'stake.bet', to: '10000', delayed: false }),
        ]),
      });
      expect((audit!.metadata as { changes: unknown[] }).changes).toHaveLength(4);
    });

    it('applies a lower limit at once, even several times at the same instant', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { deposit: { day: '50000' } });
      await setLimits(player, { deposit: { day: '40000' } });
      const body = await setLimits(player, { deposit: { day: '30000' } });
      expect(body.deposit.day).toEqual({ amount: '30000', pending: null });
      expect(await getLimitsRequest(player)).toEqual(body);
    });

    it('applies a higher limit only after 24 hours', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { loss: { week: '50000' } });
      const body = await setLimits(player, { loss: { week: '80000' } });
      const effectiveFrom = at(LIMIT_INCREASE_DELAY_MS);
      expect(LIMIT_INCREASE_DELAY_MS).toBe(DAY_MS);
      expect(body.loss.week).toEqual({
        amount: '50000',
        pending: { amount: '80000', effectiveFrom: effectiveFrom.toISOString() },
      });
      const [audit] = await audits(player.userId, 'rg.limits_changed').then((rows) =>
        rows.slice(-1),
      );
      expect(audit!.metadata).toEqual({
        changes: [
          {
            limit: 'loss.week',
            from: '50000',
            to: '80000',
            effectiveFrom: effectiveFrom.toISOString(),
            delayed: true,
            replacedPending: false,
          },
        ],
      });

      ctx.clock.advance(LIMIT_INCREASE_DELAY_MS - 1);
      expect((await getLimitsRequest(player)).loss.week.amount).toBe('50000');
      ctx.clock.advance(1);
      expect((await getLimitsRequest(player)).loss.week).toEqual({
        amount: '80000',
        pending: null,
      });
      expect((await getActiveLimits(ctx.db.db, player.userId, ctx.clock.now)).loss.week).toBe(
        80_000n,
      );
    });

    it('removes a limit only after 24 hours', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { stake: { bet: '10000' } });
      const body = await setLimits(player, { stake: { bet: null } });
      expect(body.stake.bet).toEqual({
        amount: '10000',
        pending: { amount: null, effectiveFrom: at(DAY_MS).toISOString() },
      });
      ctx.clock.advance(DAY_MS);
      expect((await getLimitsRequest(player)).stake.bet).toEqual(NO_LIMIT);
    });

    it('lets a lower limit cancel a pending raise for good', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { deposit: { month: '500000' } });
      await setLimits(player, { deposit: { month: '900000' } });
      ctx.clock.advance(HOUR_MS);
      const body = await setLimits(player, { deposit: { month: '400000' } });
      expect(body.deposit.month).toEqual({ amount: '400000', pending: null });
      ctx.clock.advance(2 * DAY_MS);
      expect((await getLimitsRequest(player)).deposit.month).toEqual({
        amount: '400000',
        pending: null,
      });
    });

    it('replaces a pending raise with a newer one and restarts the delay', async () => {
      const player = await registerAndLogin(ctx);
      const start = ctx.clock.now;
      await setLimits(player, { deposit: { day: '50000' } });
      await setLimits(player, { deposit: { day: '90000' } });
      ctx.clock.advance(12 * HOUR_MS);
      const body = await setLimits(player, { deposit: { day: '70000' } });
      const effectiveFrom = new Date(start.getTime() + 36 * HOUR_MS);
      expect(body.deposit.day).toEqual({
        amount: '50000',
        pending: { amount: '70000', effectiveFrom: effectiveFrom.toISOString() },
      });
      expect((await audits(player.userId, 'rg.limits_changed')).at(-1)!.metadata).toMatchObject({
        changes: [{ limit: 'deposit.day', from: '50000', to: '70000', replacedPending: true }],
      });

      // The superseded 90,000 never comes into force.
      ctx.clock.advance(12 * HOUR_MS);
      expect((await getLimitsRequest(player)).deposit.day.amount).toBe('50000');
      ctx.clock.now = effectiveFrom;
      expect((await getLimitsRequest(player)).deposit.day).toEqual({
        amount: '70000',
        pending: null,
      });
    });

    it('keeps the schedule when the pending value is sent again', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { loss: { day: '20000' } });
      const first = await setLimits(player, { loss: { day: '30000' } });
      ctx.clock.advance(HOUR_MS);
      const again = await setLimits(player, { loss: { day: '30000' } });
      expect(again.loss.day).toEqual(first.loss.day);
      expect(await audits(player.userId, 'rg.limits_changed')).toHaveLength(2);
    });

    it('cancels a pending change when the active value is sent again', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { loss: { day: '20000' } });
      await setLimits(player, { loss: { day: null } });
      const body = await setLimits(player, { loss: { day: '20000' } });
      expect(body.loss.day).toEqual({ amount: '20000', pending: null });
      ctx.clock.advance(2 * DAY_MS);
      expect((await getLimitsRequest(player)).loss.day).toEqual({ amount: '20000', pending: null });
    });

    it('writes nothing when nothing changes', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { stake: { bet: '10000' } });
      await setLimits(player, { stake: { bet: '10000' } });
      expect(await setLimits(player, {})).toMatchObject({
        stake: { bet: { amount: '10000', pending: null } },
      });
      expect(await setLimits(player, { deposit: { day: null } })).toMatchObject({
        deposit: { day: NO_LIMIT },
      });
      const rows = await ctx.db.db
        .select()
        .from(rgLimits)
        .where(eq(rgLimits.userId, player.userId));
      expect(rows).toHaveLength(1);
      expect(await audits(player.userId, 'rg.limits_changed')).toHaveLength(1);
    });

    it('accepts limits from 1 ETB to 10,000,000 ETB', async () => {
      const player = await registerAndLogin(ctx);
      expect(MIN_LIMIT).toBe(birr(1));
      expect(MAX_LIMIT).toBe(birr(10_000_000));
      const body = await setLimits(player, {
        deposit: { day: MIN_LIMIT.toString(), week: MAX_LIMIT.toString() },
      });
      expect(body.deposit.day.amount).toBe('100');
      expect(body.deposit.week.amount).toBe('1000000000');
    });

    it('rejects out-of-range amounts without writing anything', async () => {
      const player = await registerAndLogin(ctx);
      for (const value of ['99', '0', '-500', '1000000001', '99999999999999999999999']) {
        const response = await putLimits(player, {
          deposit: { day: '50000' },
          loss: { week: value },
        });
        expect(response.statusCode).toBe(400);
        expect(apiError(response)).toMatchObject({
          code: 'invalid_limit',
          details: { field: 'loss.week', min: '100', max: '1000000000' },
        });
      }
      for (const payload of [
        { deposit: { day: 'abc' } },
        { deposit: { day: 500 } },
        { deposit: { day: '12.50' } },
      ]) {
        const response = await putLimits(player, payload);
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('validation_error');
      }
      expect(await getLimitsRequest(player)).toEqual(NO_LIMITS);
      expect(await audits(player.userId, 'rg.limits_changed')).toHaveLength(0);
    });

    it('requires the CSRF header with cookie authentication', async () => {
      const player = await registerAndLogin(ctx);
      const forged = await ctx.app.inject({
        method: 'PUT',
        url: '/me/limits',
        payload: { deposit: { day: '50000' } },
        headers: { cookie: player.cookie },
      });
      expect(forged.statusCode).toBe(403);
      expect(apiError(forged).code).toBe('csrf_invalid');
      const ok = await ctx.app.inject({
        method: 'PUT',
        url: '/me/limits',
        payload: { deposit: { day: '50000' } },
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
      });
      expect(ok.statusCode).toBe(200);
    });
  });

  describe('assertDepositAllowed', () => {
    it('allows deposits when there is no limit', async () => {
      const player = await registerAndLogin(ctx);
      await deposit(player.userId, birr(50_000), at(-HOUR_MS));
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(100_000), ctx.clock.now),
      ).resolves.toBeUndefined();
    });

    it('enforces the 24-hour limit over a rolling window', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { deposit: { day: birr(1_000).toString() } });
      await deposit(player.userId, birr(800), at(-23 * HOUR_MS));
      await deposit(player.userId, birr(300), at(-25 * HOUR_MS));
      const now = ctx.clock.now;

      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(200), now),
      ).resolves.toBeUndefined();
      const error = await assertDepositAllowed(ctx.db.db, player.userId, birr(200.01), now).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'deposit_limit_exceeded',
        details: { period: 'day', limit: '100000', used: '80000' },
      });

      // Two hours later the 800 ETB deposit has left the window.
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(1_000), at(2 * HOUR_MS)),
      ).resolves.toBeUndefined();
    });

    it('enforces the 7-day and 30-day limits', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, {
        deposit: { week: birr(2_000).toString(), month: birr(5_000).toString() },
      });
      await deposit(player.userId, birr(1_500), at(-3 * DAY_MS));
      await deposit(player.userId, birr(2_000), at(-10 * DAY_MS));
      await deposit(player.userId, birr(1_000), at(-29 * DAY_MS));
      await deposit(player.userId, birr(9_000), at(-31 * DAY_MS));
      const now = ctx.clock.now;

      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(500), now),
      ).resolves.toBeUndefined();
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(600), now),
      ).rejects.toMatchObject({
        code: 'deposit_limit_exceeded',
        details: { period: 'week', limit: '200000', used: '150000' },
      });

      const monthly = await registerAndLogin(ctx);
      await setLimits(monthly, { deposit: { month: birr(5_000).toString() } });
      await deposit(monthly.userId, birr(2_000), at(-10 * DAY_MS));
      await deposit(monthly.userId, birr(2_500), at(-29 * DAY_MS));
      await deposit(monthly.userId, birr(9_000), at(-31 * DAY_MS));
      await expect(
        assertDepositAllowed(ctx.db.db, monthly.userId, birr(500), now),
      ).resolves.toBeUndefined();
      await expect(
        assertDepositAllowed(ctx.db.db, monthly.userId, birr(501), now),
      ).rejects.toMatchObject({
        code: 'deposit_limit_exceeded',
        details: { period: 'month', limit: '500000', used: '450000' },
      });
    });

    it('counts deposits only, not top-ups or winnings', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { deposit: { day: birr(100).toString() } });
      await topUp(player.userId, birr(1_000));
      await payout(player.userId, birr(500), at(-HOUR_MS));
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(100), ctx.clock.now),
      ).resolves.toBeUndefined();
    });

    it('uses the active limit, not a pending raise', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { deposit: { week: birr(1_000).toString() } });
      await setLimits(player, { deposit: { week: birr(5_000).toString() } });
      await deposit(player.userId, birr(900), at(-HOUR_MS));
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(200), ctx.clock.now),
      ).rejects.toMatchObject({ code: 'deposit_limit_exceeded', details: { limit: '100000' } });
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(200), at(DAY_MS)),
      ).resolves.toBeUndefined();
    });

    it('refuses deposits during a cool-off or self-exclusion', async () => {
      const player = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'cool_off',
        startsAt: ctx.clock.now,
        endsAt: at(DAY_MS),
      });
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, birr(10), ctx.clock.now),
      ).rejects.toMatchObject({ statusCode: 403, code: 'cooling_off' });
    });

    it('rejects a non-positive amount as a programming error', async () => {
      const player = await registerAndLogin(ctx);
      await expect(
        assertDepositAllowed(ctx.db.db, player.userId, 0n, ctx.clock.now),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('assertStakeAllowed', () => {
    it('enforces the per-bet stake limit', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { stake: { bet: birr(100).toString() } });
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(100), ctx.clock.now),
      ).resolves.toBeUndefined();
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(100.01), ctx.clock.now),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'stake_limit_exceeded',
        details: { period: 'bet', limit: '10000', stake: '10001' },
      });
    });

    it('enforces the 24-hour loss limit on net losses', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, { loss: { day: birr(500).toString() } });
      await topUp(player.userId, birr(10_000));
      await stake(player.userId, birr(300), at(-2 * HOUR_MS));
      await payout(player.userId, birr(100), at(-HOUR_MS));
      await stake(player.userId, birr(1_000), at(-30 * HOUR_MS));
      const now = ctx.clock.now;

      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(300), now),
      ).resolves.toBeUndefined();
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(300.01), now),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'loss_limit_exceeded',
        details: { period: 'day', limit: '50000', used: '20000' },
      });
    });

    it('enforces the 7-day and 30-day loss limits and counts winnings in favour', async () => {
      const player = await registerAndLogin(ctx);
      await setLimits(player, {
        loss: { week: birr(100).toString(), month: birr(2_000).toString() },
      });
      await topUp(player.userId, birr(10_000));
      await stake(player.userId, birr(100), at(-DAY_MS));
      await payout(player.userId, birr(500), at(-DAY_MS));
      await stake(player.userId, birr(1_600), at(-20 * DAY_MS));
      const now = ctx.clock.now;

      // Net winnings this week (-400 ETB of loss) leave room for 500 ETB.
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(500), now),
      ).resolves.toBeUndefined();
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(500.01), now),
      ).rejects.toMatchObject({
        code: 'loss_limit_exceeded',
        details: { period: 'week', limit: '10000', used: '-40000' },
      });

      // Over 30 days the net loss is 1,200 ETB.
      await setLimits(player, { loss: { week: null } });
      ctx.clock.advance(DAY_MS);
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(800), ctx.clock.now),
      ).resolves.toBeUndefined();
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(801), ctx.clock.now),
      ).rejects.toMatchObject({
        code: 'loss_limit_exceeded',
        details: { period: 'month', limit: '200000', used: '120000' },
      });
    });

    it('refuses stakes while excluded', async () => {
      const player = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'self_exclusion',
        startsAt: ctx.clock.now,
        endsAt: null,
      });
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, birr(5), ctx.clock.now),
      ).rejects.toMatchObject({ statusCode: 403, code: 'self_excluded' });
      await expect(
        assertStakeAllowed(ctx.db.db, player.userId, -1n, ctx.clock.now),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe('POST /me/exclusions', () => {
    async function exclusionEvents(userId: string) {
      return ctx.db.db
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(
          and(eq(outboxEvents.aggregateId, userId), eq(outboxEvents.type, 'rg.exclusion_started')),
        )
        .orderBy(asc(outboxEvents.id));
    }

    it('starts a cool-off that keeps the session but stops gambling', async () => {
      const player = await registerAndLogin(ctx);
      const response = await startExclusion(player, { kind: 'cool_off', duration: '24h' });
      expect(response.statusCode).toBe(201);
      const endsAt = at(DAY_MS).toISOString();
      expect(response.json()).toEqual({
        exclusion: { kind: 'cool_off', startsAt: ctx.clock.now.toISOString(), endsAt },
      });
      expect(response.cookies).toHaveLength(0);

      const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(player) });
      expect(me.statusCode).toBe(200);
      expect(MeResponse.parse(me.json())).toMatchObject({
        canGamble: false,
        exclusion: { kind: 'cool_off', endsAt },
      });
      await expect(assertCanGamble(ctx.db.db, player.userId, ctx.clock.now)).rejects.toMatchObject({
        code: 'cooling_off',
      });

      const [audit] = await audits(player.userId, 'rg.exclusion_started');
      expect(audit!.metadata).toMatchObject({
        kind: 'cool_off',
        duration: '24h',
        endsAt,
        revokedSessions: 0,
        extended: null,
      });
      const events = await exclusionEvents(player.userId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        userId: player.userId,
        kind: 'cool_off',
        duration: '24h',
        startsAt: ctx.clock.now.toISOString(),
        endsAt,
      });
      const [row] = await ctx.db.db
        .select()
        .from(rgExclusions)
        .where(eq(rgExclusions.userId, player.userId));
      expect(row).toMatchObject({ kind: 'cool_off', reason: 'player_request:24h' });
      expect((events[0]!.payload as { exclusionId: string }).exclusionId).toBe(row!.id);

      // Once it ends the player can start another one.
      ctx.clock.advance(DAY_MS);
      const again = await startExclusion(player, { kind: 'cool_off', duration: '7d' });
      expect(again.statusCode).toBe(201);
      expect(again.json()).toMatchObject({ exclusion: { endsAt: at(7 * DAY_MS).toISOString() } });
    });

    it('only lets a new exclusion extend protection (409 exclusion_active)', async () => {
      const player = await registerAndLogin(ctx);
      const first = await startExclusion(player, { kind: 'cool_off', duration: '7d' });
      expect(first.statusCode).toBe(201);
      const endsAt = at(7 * DAY_MS).toISOString();

      for (const duration of ['24h', '7d']) {
        const shorter = await startExclusion(player, { kind: 'cool_off', duration });
        expect(shorter.statusCode).toBe(409);
        expect(apiError(shorter)).toMatchObject({
          code: 'exclusion_active',
          details: { kind: 'cool_off', endsAt },
        });
      }

      ctx.clock.advance(HOUR_MS);
      const longer = await startExclusion(player, { kind: 'cool_off', duration: '30d' });
      expect(longer.statusCode).toBe(201);
      expect((await audits(player.userId, 'rg.exclusion_started')).at(-1)!.metadata).toMatchObject({
        extended: { kind: 'cool_off', endsAt },
      });
      const rows = await ctx.db.db
        .select()
        .from(rgExclusions)
        .where(eq(rgExclusions.userId, player.userId));
      expect(rows).toHaveLength(2);
    });

    it('self-excludes: revokes every session, clears cookies and blocks login', async () => {
      const player = await registerAndLogin(ctx);
      const login = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      const second = SessionResponse.parse(login.json());

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/me/exclusions',
        payload: { kind: 'self_exclusion', duration: '6m' },
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrfToken },
      });
      expect(response.statusCode).toBe(201);
      const endsAt = addUtcMonths(ctx.clock.now, 6).toISOString();
      expect(response.json()).toEqual({
        exclusion: { kind: 'self_exclusion', startsAt: ctx.clock.now.toISOString(), endsAt },
      });
      const cleared = response.cookies.filter((cookie) => cookie.value === '');
      expect(cleared.map((cookie) => cookie.name).sort()).toEqual(['vamos_csrf', 'vamos_session']);

      const live = await ctx.db.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, player.userId), isNull(sessions.revokedAt)));
      expect(live).toHaveLength(0);
      for (const token of [player.sessionToken, second.sessionToken]) {
        const me = await ctx.app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(me.statusCode).toBe(401);
      }
      const blocked = await post(ctx, '/auth/login', {
        phone: player.phone,
        password: player.password,
      });
      expect(blocked.statusCode).toBe(403);
      expect(apiError(blocked).code).toBe('self_excluded');

      expect((await audits(player.userId, 'rg.exclusion_started'))[0]!.metadata).toMatchObject({
        kind: 'self_exclusion',
        duration: '6m',
        revokedSessions: 2,
      });
      expect((await exclusionEvents(player.userId))[0]!.payload).toMatchObject({
        kind: 'self_exclusion',
        duration: '6m',
        endsAt,
      });
    });

    it('supports a permanent self-exclusion and lets it replace a cool-off', async () => {
      const player = await registerAndLogin(ctx);
      expect((await startExclusion(player, { kind: 'cool_off', duration: '30d' })).statusCode).toBe(
        201,
      );
      const response = await startExclusion(player, {
        kind: 'self_exclusion',
        duration: 'permanent',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        exclusion: {
          kind: 'self_exclusion',
          startsAt: ctx.clock.now.toISOString(),
          endsAt: null,
        },
      });
      await expect(
        assertCanGamble(ctx.db.db, player.userId, at(100 * 365 * DAY_MS)),
      ).rejects.toMatchObject({ code: 'self_excluded', details: { endsAt: null } });
    });

    it('cannot shorten an active self-exclusion', async () => {
      const player = await registerAndLogin(ctx);
      // Inserted directly, so the session is still alive.
      await ctx.db.db.insert(rgExclusions).values({
        userId: player.userId,
        kind: 'self_exclusion',
        startsAt: at(-DAY_MS),
        endsAt: null,
      });
      for (const payload of [
        { kind: 'cool_off', duration: '24h' },
        { kind: 'self_exclusion', duration: '5y' },
        { kind: 'self_exclusion', duration: 'permanent' },
      ]) {
        const response = await startExclusion(player, payload);
        expect(response.statusCode).toBe(409);
        expect(apiError(response)).toMatchObject({
          code: 'exclusion_active',
          message: 'A permanent exclusion is already in place.',
          details: { kind: 'self_exclusion', endsAt: null },
        });
      }
      expect(await exclusionEvents(player.userId)).toHaveLength(0);
    });

    it('validates the body with the contract', async () => {
      const player = await registerAndLogin(ctx);
      for (const payload of [
        {},
        { kind: 'cool_off', duration: '6m' },
        { kind: 'self_exclusion', duration: '24h' },
        { kind: 'nap', duration: '24h' },
      ]) {
        const response = await startExclusion(player, payload);
        expect(response.statusCode).toBe(400);
        expect(apiError(response).code).toBe('validation_error');
      }
      expect(
        await ctx.db.db.select().from(rgExclusions).where(eq(rgExclusions.userId, player.userId)),
      ).toHaveLength(0);
    });

    it('requires the CSRF header with cookie authentication', async () => {
      const player = await registerAndLogin(ctx);
      const forged = await ctx.app.inject({
        method: 'POST',
        url: '/me/exclusions',
        payload: { kind: 'cool_off', duration: '24h' },
        headers: { cookie: player.cookie },
      });
      expect(forged.statusCode).toBe(403);
      expect(apiError(forged).code).toBe('csrf_invalid');
    });
  });

  describe('helpers', () => {
    it('computes exclusion end dates', () => {
      const now = new Date('2026-08-31T10:15:00.000Z');
      const end = (input: Parameters<typeof exclusionEndsAt>[0]) =>
        exclusionEndsAt(input, now)?.toISOString() ?? null;
      expect(end({ kind: 'cool_off', duration: '24h' })).toBe('2026-09-01T10:15:00.000Z');
      expect(end({ kind: 'cool_off', duration: '7d' })).toBe('2026-09-07T10:15:00.000Z');
      expect(end({ kind: 'cool_off', duration: '30d' })).toBe('2026-09-30T10:15:00.000Z');
      expect(end({ kind: 'self_exclusion', duration: '6m' })).toBe('2027-02-28T10:15:00.000Z');
      expect(end({ kind: 'self_exclusion', duration: '1y' })).toBe('2027-08-31T10:15:00.000Z');
      expect(end({ kind: 'self_exclusion', duration: '5y' })).toBe('2031-08-31T10:15:00.000Z');
      expect(end({ kind: 'self_exclusion', duration: 'permanent' })).toBeNull();
    });

    it('adds calendar months, clamping to the end of shorter months', () => {
      const add = (iso: string, months: number) =>
        addUtcMonths(new Date(iso), months).toISOString();
      expect(add('2027-08-31T00:00:00.000Z', 6)).toBe('2028-02-29T00:00:00.000Z');
      expect(add('2026-01-31T23:59:59.999Z', 1)).toBe('2026-02-28T23:59:59.999Z');
      expect(add('2026-11-15T08:00:00.000Z', 3)).toBe('2027-02-15T08:00:00.000Z');
      expect(add('2024-02-29T12:00:00.000Z', 12)).toBe('2025-02-28T12:00:00.000Z');
    });

    it('decides when a limit change applies', () => {
      expect(decideLimitChange(null, null, 500n)).toBe('immediate');
      expect(decideLimitChange(500n, null, 400n)).toBe('immediate');
      expect(decideLimitChange(500n, null, 600n)).toBe('delayed');
      expect(decideLimitChange(500n, null, null)).toBe('delayed');
      expect(decideLimitChange(500n, null, 500n)).toBe('unchanged');
      expect(decideLimitChange(null, null, null)).toBe('unchanged');
      expect(decideLimitChange(500n, { amount: 900n }, 900n)).toBe('unchanged');
      expect(decideLimitChange(500n, { amount: 900n }, 500n)).toBe('immediate');
      expect(decideLimitChange(500n, { amount: 900n }, 700n)).toBe('delayed');
      expect(decideLimitChange(500n, { amount: null }, 400n)).toBe('immediate');
    });

    it('resolves limit history, dropping changes superseded before they applied', () => {
      const t = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * HOUR_MS);
      const row = (
        amount: bigint | null,
        createdHour: number,
        effectiveHour: number,
      ): LimitRow => ({
        kind: 'deposit',
        period: 'day',
        amount,
        createdAt: t(createdHour),
        effectiveFrom: t(effectiveHour),
      });
      // Set 500, ask for 900 an hour later, lower to 400 before it applies, then ask for 800.
      const history = [row(500n, 0, 0), row(900n, 1, 25), row(400n, 2, 2), row(800n, 30, 54)];
      const amounts = (hour: number) => {
        const known = history.filter((r) => r.createdAt.getTime() <= t(hour).getTime());
        const state = resolveLimitSlot(known, t(hour));
        return [state.active?.amount ?? null, state.pending?.amount ?? null];
      };
      expect(amounts(0)).toEqual([500n, null]);
      expect(amounts(1)).toEqual([500n, 900n]);
      expect(amounts(2)).toEqual([400n, null]);
      expect(amounts(26)).toEqual([400n, null]);
      expect(amounts(30)).toEqual([400n, 800n]);
      expect(amounts(54)).toEqual([800n, null]);
      expect(resolveLimitSlot([], t(0))).toEqual({ active: null, pending: null });
    });

    it('compares exclusions by the protection they give', () => {
      const day = new Date(Date.UTC(2026, 0, 2));
      const week = new Date(Date.UTC(2026, 0, 8));
      expect(
        extendsProtection({ kind: 'cool_off', endsAt: day }, { kind: 'cool_off', endsAt: week }),
      ).toBe(true);
      expect(
        extendsProtection({ kind: 'cool_off', endsAt: week }, { kind: 'cool_off', endsAt: day }),
      ).toBe(false);
      expect(
        extendsProtection({ kind: 'cool_off', endsAt: week }, { kind: 'cool_off', endsAt: week }),
      ).toBe(false);
      expect(
        extendsProtection(
          { kind: 'cool_off', endsAt: week },
          { kind: 'self_exclusion', endsAt: week },
        ),
      ).toBe(true);
      expect(
        extendsProtection(
          { kind: 'self_exclusion', endsAt: null },
          { kind: 'self_exclusion', endsAt: null },
        ),
      ).toBe(false);
      expect(
        extendsProtection(
          { kind: 'cool_off', endsAt: null },
          { kind: 'self_exclusion', endsAt: null },
        ),
      ).toBe(true);
      expect(
        extendsProtection(
          { kind: 'self_exclusion', endsAt: week },
          { kind: 'self_exclusion', endsAt: null },
        ),
      ).toBe(true);
    });
  });
});
