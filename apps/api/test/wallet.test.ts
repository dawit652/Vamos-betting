import { randomBytes, randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  WalletResponse,
  WalletTransactionsResponse,
  type WalletTransaction,
} from '@vamos/contracts';
import {
  accountKey,
  claimOperatingMode,
  getDatabaseOperatingMode,
  OperatingModeMismatchError,
  postTransaction,
  type AccountRef,
} from '@vamos/db';
import {
  auditLog,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
} from '@vamos/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { AppError } from '../src/lib/errors';
import { IDEMPOTENT_REPLAYED_HEADER } from '../src/modules/wallet/routes';
import {
  DEMO_BALANCE_CAP,
  DEMO_TOPUP_DEFAULT,
  DEMO_TOPUP_MAX,
  demoTopUp,
  demoTopUpLedgerKey,
} from '../src/modules/wallet/service';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const DAY_MS = 24 * 60 * 60_000;

function apiError(response: LightMyRequestResponse) {
  return ApiErrorSchema.parse(response.json()).error;
}

const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });
const newKey = () => randomUUID();
const cashOf = (userId: string): AccountRef => ({ kind: 'player_cash', userId });

describe('wallet', () => {
  let ctx: TestContext;
  /** Same deps, but configured for licensed (real-money) mode. */
  let licensed: FastifyInstance;

  beforeAll(async () => {
    ctx = await createTestContext();
    licensed = buildApp(
      { ...ctx.deps, config: { ...ctx.deps.config, mode: 'licensed' } },
      { logger: false, rateLimitNameSpace: `wallet-licensed-${randomBytes(6).toString('hex')}:` },
    );
    await licensed.ready();
  });

  afterAll(async () => {
    await licensed?.close();
    await ctx?.close();
  });

  function topUp(
    user: LoggedInUser,
    key: string | undefined,
    payload?: Record<string, unknown>,
    app: FastifyInstance = ctx.app,
  ) {
    return app.inject({
      method: 'POST',
      url: '/wallet/demo-topup',
      headers: { ...bearer(user), ...(key === undefined ? {} : { 'idempotency-key': key }) },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function wallet(user: LoggedInUser, app: FastifyInstance = ctx.app) {
    const response = await app.inject({ method: 'GET', url: '/wallet', headers: bearer(user) });
    expect(response.statusCode).toBe(200);
    return WalletResponse.parse(response.json());
  }

  async function transactions(user: LoggedInUser, query = '') {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/wallet/transactions${query}`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);
    return WalletTransactionsResponse.parse(response.json());
  }

  async function ledgerTransactionFor(userId: string, key: string) {
    const rows = await ctx.db.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, demoTopUpLedgerKey(userId, key)));
    return rows;
  }

  async function topUpEvents(userId: string) {
    const outbox = await ctx.db.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, 'wallet.demo_topup'), eq(outboxEvents.aggregateId, userId)))
      .orderBy(asc(outboxEvents.id));
    const audit = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'wallet.demo_topup'), eq(auditLog.actorId, userId)))
      .orderBy(asc(auditLog.id));
    return { outbox, audit };
  }

  /** Moves cash out of the player's account as a bet stake would (bypassing the API). */
  async function stake(userId: string, amount: bigint) {
    await ctx.db.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'bet_stake',
        idempotencyKey: `test-stake:${randomUUID()}`,
        refType: 'bet',
        refId: randomUUID(),
        entries: [
          { account: cashOf(userId), amount: -amount },
          { account: { kind: 'house_stakes' }, amount },
        ],
      }),
    );
  }

  describe('GET /wallet', () => {
    it('requires authentication', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/wallet' });
      expect(response.statusCode).toBe(401);
      expect(apiError(response).code).toBe('unauthorized');
    });

    it('shows empty play-money balances for a new player (cookie or bearer)', async () => {
      const user = await registerAndLogin(ctx);
      expect(await wallet(user)).toEqual({ currency: 'ETB', demo: true, cash: '0', bonus: '0' });

      const viaCookie = await ctx.app.inject({
        method: 'GET',
        url: '/wallet',
        headers: { cookie: user.cookie },
      });
      expect(viaCookie.statusCode).toBe(200);
      expect(WalletResponse.parse(viaCookie.json()).cash).toBe('0');
    });

    it('reports the cached cash and bonus ledger balances as santim strings', async () => {
      const user = await registerAndLogin(ctx);
      expect((await topUp(user, newKey(), { amount: '123456' })).statusCode).toBe(200);
      await ctx.db.db.transaction((tx) =>
        postTransaction(tx, {
          type: 'bonus',
          idempotencyKey: `test-bonus:${randomUUID()}`,
          entries: [
            { account: { kind: 'house_promotions' }, amount: -7_550n },
            { account: { kind: 'player_bonus', userId: user.userId }, amount: 7_550n },
          ],
        }),
      );
      expect(await wallet(user)).toEqual({
        currency: 'ETB',
        demo: true,
        cash: '123456',
        bonus: '7550',
      });
    });
  });

  describe('POST /wallet/demo-topup', () => {
    it('credits 1,000 ETB by default through one balanced ledger transaction', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      const response = await topUp(user, key);
      expect(response.statusCode).toBe(200);
      expect(response.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
      expect(WalletResponse.parse(response.json())).toEqual({
        currency: 'ETB',
        demo: true,
        cash: DEMO_TOPUP_DEFAULT.toString(),
        bonus: '0',
      });
      expect(DEMO_TOPUP_DEFAULT).toBe(100_000n);

      const [transaction, ...others] = await ledgerTransactionFor(user.userId, key);
      expect(others).toHaveLength(0);
      expect(transaction).toMatchObject({
        type: 'demo_topup',
        idempotencyKey: `demo_topup:${user.userId}:${key}`,
        actorType: 'user',
        actorId: user.userId,
      });

      const entries = await ctx.db.db
        .select({ key: ledgerAccounts.key, amount: ledgerEntries.amount })
        .from(ledgerEntries)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
        .where(eq(ledgerEntries.transactionId, transaction!.id))
        .orderBy(asc(ledgerAccounts.key));
      expect(entries).toEqual([
        { key: 'house:demo_funding', amount: -100_000n },
        { key: accountKey(cashOf(user.userId)), amount: 100_000n },
      ]);

      const { outbox, audit } = await topUpEvents(user.userId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        aggregateType: 'user',
        aggregateId: user.userId,
        payload: {
          userId: user.userId,
          transactionId: transaction!.id,
          amount: '100000',
          balanceAfter: '100000',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'user',
        targetType: 'ledger_transaction',
        targetId: transaction!.id,
        metadata: { amount: '100000', balanceAfter: '100000' },
      });
    });

    it('accepts an explicit amount from 1 ETB up to 5,000 ETB', async () => {
      const user = await registerAndLogin(ctx);
      const first = await topUp(user, newKey(), { amount: '100' });
      expect(first.statusCode).toBe(200);
      expect(WalletResponse.parse(first.json()).cash).toBe('100');

      const second = await topUp(user, newKey(), { amount: DEMO_TOPUP_MAX.toString() });
      expect(second.statusCode).toBe(200);
      expect(WalletResponse.parse(second.json()).cash).toBe('500100');

      const third = await topUp(user, newKey(), { amount: '250050' });
      expect(WalletResponse.parse(third.json()).cash).toBe('750150');
      expect((await wallet(user)).cash).toBe('750150');
    });

    it('rejects amounts outside 1–5,000 ETB with invalid_amount', async () => {
      const user = await registerAndLogin(ctx);
      for (const amount of ['0', '99', '500001', '-100000', '00', '1000000000000000000000000']) {
        const response = await topUp(user, newKey(), { amount });
        expect(response.statusCode, amount).toBe(400);
        expect(apiError(response).code, amount).toBe('invalid_amount');
      }
      for (const amount of ['abc', '1.5', '', 1000, null]) {
        const response = await topUp(user, newKey(), { amount });
        expect(response.statusCode, String(amount)).toBe(400);
        expect(apiError(response).code, String(amount)).toBe('validation_error');
      }
      expect((await wallet(user)).cash).toBe('0');
    });

    it('requires an Idempotency-Key header of 8 to 100 characters', async () => {
      const user = await registerAndLogin(ctx);
      for (const key of [undefined, '', 'short-7', 'k'.repeat(101), 'naïve-key-ü']) {
        const response = await topUp(user, key);
        expect(response.statusCode, String(key)).toBe(400);
        expect(apiError(response).code, String(key)).toBe('idempotency_key_required');
      }
      for (const key of ['exactly8', 'k'.repeat(100)]) {
        expect((await topUp(user, key, { amount: '100' })).statusCode, key).toBe(200);
      }
      expect((await wallet(user)).cash).toBe('200');
    });

    it('replays a repeated idempotency key without crediting twice', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      const first = await topUp(user, key, { amount: '50000' });
      const second = await topUp(user, key, { amount: '50000' });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
      expect(WalletResponse.parse(second.json()).cash).toBe('50000');

      expect((await wallet(user)).cash).toBe('50000');
      expect(await ledgerTransactionFor(user.userId, key)).toHaveLength(1);
      const { outbox, audit } = await topUpEvents(user.userId);
      expect(outbox).toHaveLength(1);
      expect(audit).toHaveLength(1);
      const statement = await transactions(user);
      expect(statement.items).toHaveLength(1);
    });

    it('replays with the balance right after the original top-up', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      expect((await topUp(user, key)).statusCode).toBe(200);
      await stake(user.userId, 30_000n);
      expect((await topUp(user, newKey(), { amount: '1000' })).statusCode).toBe(200);

      const replay = await topUp(user, key);
      expect(replay.statusCode).toBe(200);
      expect(WalletResponse.parse(replay.json()).cash).toBe('100000');
      expect((await wallet(user)).cash).toBe('71000');
    });

    it('rejects reusing a key for a different amount', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      expect((await topUp(user, key, { amount: '10000' })).statusCode).toBe(200);

      const reused = await topUp(user, key, { amount: '20000' });
      expect(reused.statusCode).toBe(422);
      expect(apiError(reused)).toMatchObject({
        code: 'idempotency_key_reused',
        details: { amount: '10000' },
      });
      // The default amount differs from the original too.
      expect((await topUp(user, key)).statusCode).toBe(422);
      expect((await wallet(user)).cash).toBe('10000');
    });

    it('scopes idempotency keys to the player', async () => {
      const alice = await registerAndLogin(ctx);
      const bob = await registerAndLogin(ctx);
      const key = newKey();
      expect((await topUp(alice, key, { amount: '1000' })).statusCode).toBe(200);
      const forBob = await topUp(bob, key, { amount: '2000' });
      expect(forBob.statusCode).toBe(200);
      expect(forBob.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
      expect((await wallet(alice)).cash).toBe('1000');
      expect((await wallet(bob)).cash).toBe('2000');
    });

    it('credits concurrent requests with the same key exactly once', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => topUp(user, key, { amount: '40000' })),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(WalletResponse.parse(response.json()).cash).toBe('40000');
      }
      expect(
        responses.filter((r) => r.headers[IDEMPOTENT_REPLAYED_HEADER] === 'true'),
      ).toHaveLength(5);
      expect((await wallet(user)).cash).toBe('40000');
      expect(await ledgerTransactionFor(user.userId, key)).toHaveLength(1);
    });

    it('refuses top-ups that would take the cash balance above 20,000 ETB', async () => {
      const user = await registerAndLogin(ctx);
      for (let i = 0; i < 3; i += 1) {
        expect((await topUp(user, newKey(), { amount: '500000' })).statusCode).toBe(200);
      }
      expect((await topUp(user, newKey(), { amount: '450000' })).statusCode).toBe(200);
      expect((await wallet(user)).cash).toBe('1950000');

      const overKey = newKey();
      const over = await topUp(user, overKey); // default 1,000 ETB -> 20,500 ETB
      expect(over.statusCode).toBe(409);
      expect(apiError(over)).toMatchObject({
        code: 'demo_balance_cap',
        details: { cap: DEMO_BALANCE_CAP.toString(), balance: '1950000', maxTopUp: '50000' },
      });
      // Nothing was written for the refused attempt.
      expect(await ledgerTransactionFor(user.userId, overKey)).toHaveLength(0);
      expect((await wallet(user)).cash).toBe('1950000');

      // Exactly reaching the cap is allowed; one santim more is not.
      expect((await topUp(user, newKey(), { amount: '50000' })).statusCode).toBe(200);
      expect((await wallet(user)).cash).toBe(DEMO_BALANCE_CAP.toString());
      const atCap = await topUp(user, newKey(), { amount: '100' });
      expect(atCap.statusCode).toBe(409);
      expect(apiError(atCap).details).toMatchObject({ maxTopUp: '0' });

      // The refused key was not consumed: after spending, it can be used.
      await stake(user.userId, 100_000n);
      const retried = await topUp(user, overKey);
      expect(retried.statusCode).toBe(200);
      expect(WalletResponse.parse(retried.json()).cash).toBe(DEMO_BALANCE_CAP.toString());
      expect(await ledgerTransactionFor(user.userId, overKey)).toHaveLength(1);
      expect((await topUpEvents(user.userId)).outbox).toHaveLength(6);
    });

    it('never exceeds the cap under concurrent top-ups', async () => {
      const user = await registerAndLogin(ctx);
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => topUp(user, newKey(), { amount: '500000' })),
      );
      const codes = responses.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 200, 200, 200, 409, 409]);
      expect((await wallet(user)).cash).toBe(DEMO_BALANCE_CAP.toString());
      expect((await topUpEvents(user.userId)).outbox).toHaveLength(4);
    });

    it('refuses players on a cool-off break or self-exclusion', async () => {
      const coolingOff = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: coolingOff.userId,
        kind: 'cool_off',
        startsAt: new Date(ctx.clock.now.getTime() - 60_000),
        endsAt: new Date(ctx.clock.now.getTime() + DAY_MS),
      });
      const refused = await topUp(coolingOff, newKey());
      expect(refused.statusCode).toBe(403);
      expect(apiError(refused).code).toBe('cooling_off');

      const excluded = await registerAndLogin(ctx);
      await ctx.db.db.insert(rgExclusions).values({
        userId: excluded.userId,
        kind: 'self_exclusion',
        startsAt: new Date(ctx.clock.now.getTime() - 60_000),
        endsAt: null,
      });
      const response = await topUp(excluded, newKey());
      expect(response.statusCode).toBe(403);
      expect(apiError(response).code).toBe('self_excluded');

      expect((await wallet(coolingOff)).cash).toBe('0');
      expect((await wallet(excluded)).cash).toBe('0');
      expect((await topUpEvents(coolingOff.userId)).outbox).toHaveLength(0);
    });

    it('requires authentication and, for cookie sessions, the CSRF token', async () => {
      const anonymous = await ctx.app.inject({
        method: 'POST',
        url: '/wallet/demo-topup',
        headers: { 'idempotency-key': newKey() },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(apiError(anonymous).code).toBe('unauthorized');

      const user = await registerAndLogin(ctx);
      const viaCookie = (headers: Record<string, string>) =>
        ctx.app.inject({
          method: 'POST',
          url: '/wallet/demo-topup',
          headers: { cookie: user.cookie, 'idempotency-key': newKey(), ...headers },
          payload: { amount: '1000' },
        });

      const missing = await viaCookie({});
      expect(missing.statusCode).toBe(403);
      expect(apiError(missing).code).toBe('csrf_invalid');
      const wrong = await viaCookie({ 'x-csrf-token': 'not-the-token' });
      expect(wrong.statusCode).toBe(403);
      expect(apiError(wrong).code).toBe('csrf_invalid');
      expect((await wallet(user)).cash).toBe('0');

      const ok = await viaCookie({ 'x-csrf-token': user.csrfToken });
      expect(ok.statusCode).toBe(200);
      expect(WalletResponse.parse(ok.json()).cash).toBe('1000');
    });
  });

  describe('GET /wallet/transactions', () => {
    it('requires authentication', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/wallet/transactions' });
      expect(response.statusCode).toBe(401);
    });

    it('is empty for a new player', async () => {
      const user = await registerAndLogin(ctx);
      expect(await transactions(user)).toEqual({ items: [], nextCursor: null });
    });

    it('lists the cash-account statement newest first and pages with a cursor', async () => {
      const user = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);
      const amounts = ['1000', '2000', '3000', '4000', '5000', '6000', '7000'];
      for (const amount of amounts) {
        expect((await topUp(user, newKey(), { amount })).statusCode).toBe(200);
        // Interleave another player's activity; it must not show up.
        expect((await topUp(other, newKey(), { amount })).statusCode).toBe(200);
      }
      await stake(user.userId, 2_500n);
      // Bonus-account entries are not part of the cash statement.
      await ctx.db.db.transaction((tx) =>
        postTransaction(tx, {
          type: 'bonus',
          idempotencyKey: `test-bonus:${randomUUID()}`,
          entries: [
            { account: { kind: 'house_promotions' }, amount: -999n },
            { account: { kind: 'player_bonus', userId: user.userId }, amount: 999n },
          ],
        }),
      );

      const all = await transactions(user, '?limit=100');
      expect(all.nextCursor).toBeNull();
      expect(all.items).toHaveLength(8);
      const [newest] = all.items;
      expect(newest).toMatchObject({
        type: 'bet_stake',
        amount: '-2500',
        balanceAfter: '25500',
        refType: 'bet',
      });
      expect(all.items.slice(1).map((item) => item.amount)).toEqual([...amounts].reverse());
      for (const item of all.items.slice(1)) {
        expect(item).toMatchObject({
          type: 'demo_topup',
          description: 'Demo top-up (play money)',
          refType: null,
          refId: null,
        });
        expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      }
      // Strictly decreasing ids and a consistent running balance.
      for (let i = 0; i + 1 < all.items.length; i += 1) {
        const current = all.items[i]!;
        const older = all.items[i + 1]!;
        expect(BigInt(current.id) > BigInt(older.id)).toBe(true);
        expect(BigInt(current.balanceAfter) - BigInt(current.amount)).toBe(
          BigInt(older.balanceAfter),
        );
      }
      expect(all.items.at(-1)?.balanceAfter).toBe('1000');
      expect(all.items[0]?.balanceAfter).toBe((await wallet(user)).cash);

      // Pages of 3: 3 + 3 + 2.
      const pages: WalletTransaction[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = `?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
        const page = await transactions(user, query);
        pages.push(page.items);
        if (page.nextCursor !== null) {
          expect(page.nextCursor).toBe(page.items.at(-1)?.id);
        }
        cursor = page.nextCursor;
      } while (cursor !== null && pages.length < 10);
      expect(pages.map((page) => page.length)).toEqual([3, 3, 2]);
      expect(pages.flat()).toEqual(all.items);

      // An exact multiple of the page size ends without a dangling cursor.
      const firstHalf = await transactions(user, '?limit=4');
      expect(firstHalf.items).toHaveLength(4);
      expect(firstHalf.nextCursor).toBe(all.items[3]?.id);
      const secondHalf = await transactions(user, `?limit=4&cursor=${firstHalf.nextCursor}`);
      expect(secondHalf.items).toEqual(all.items.slice(4));
      expect(secondHalf.nextCursor).toBeNull();

      // The default page size is 20.
      expect((await transactions(user)).items).toHaveLength(8);
    });

    it('validates limit and cursor', async () => {
      const user = await registerAndLogin(ctx);
      for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?limit=2.5']) {
        const response = await ctx.app.inject({
          method: 'GET',
          url: `/wallet/transactions${query}`,
          headers: bearer(user),
        });
        expect(response.statusCode, query).toBe(400);
        expect(apiError(response).code, query).toBe('validation_error');
      }
      for (const cursor of [
        'abc',
        '-1',
        '0',
        '1.5',
        '',
        '99999999999999999999',
        '9223372036854775808',
      ]) {
        const response = await ctx.app.inject({
          method: 'GET',
          url: `/wallet/transactions?cursor=${encodeURIComponent(cursor)}`,
          headers: bearer(user),
        });
        expect(response.statusCode, cursor).toBe(400);
        expect(apiError(response).code, cursor).toBe('invalid_cursor');
      }
      expect(await transactions(user, '?limit=100&cursor=9223372036854775807')).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('licensed mode', () => {
    it('has no demo top-up route (404) and reports real-money balances', async () => {
      const user = await registerAndLogin(ctx);
      const key = newKey();
      const response = await topUp(user, key, { amount: '1000' }, licensed);
      expect(response.statusCode).toBe(404);
      expect(apiError(response).code).toBe('not_found');
      expect(await ledgerTransactionFor(user.userId, key)).toHaveLength(0);

      expect(await wallet(user, licensed)).toEqual({
        currency: 'ETB',
        demo: false,
        cash: '0',
        bonus: '0',
      });
      const statement = await licensed.inject({
        method: 'GET',
        url: '/wallet/transactions',
        headers: bearer(user),
      });
      expect(statement.statusCode).toBe(200);
    });

    it('cannot start on this database, which holds play money', async () => {
      const user = await registerAndLogin(ctx);
      expect((await topUp(user, newKey(), { amount: '500000' })).statusCode).toBe(200);
      // server.ts claims the configured mode before serving; licensed is refused here.
      const claim = claimOperatingMode(ctx.db.db, 'licensed');
      await expect(claim).rejects.toBeInstanceOf(OperatingModeMismatchError);
      await expect(claim).rejects.toThrow(/play money from demo mode/);
      expect(await getDatabaseOperatingMode(ctx.db.db)).toBeNull();
    });

    it('refuses demo top-ups in the service as well', async () => {
      const user = await registerAndLogin(ctx);
      const attempt = demoTopUp(
        { ...ctx.deps, config: { ...ctx.deps.config, mode: 'licensed' } },
        { userId: user.userId, idempotencyKey: newKey() },
      );
      await expect(attempt).rejects.toBeInstanceOf(AppError);
      await expect(attempt).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });
      expect((await wallet(user)).cash).toBe('0');
    });
  });

  describe('ledger integrity', () => {
    it('keeps every transaction balanced and every cached balance equal to its entries', async () => {
      // Self-contained: its own activity, whatever else ran before in this file.
      const players = [await registerAndLogin(ctx), await registerAndLogin(ctx)];
      const topUps: Array<{ userId: string; key: string; amount: bigint }> = [];
      for (const [index, player] of players.entries()) {
        for (const amount of [25_000n, 1_000n, 333_333n]) {
          const key = newKey();
          expect((await topUp(player, key, { amount: amount.toString() })).statusCode).toBe(200);
          topUps.push({ userId: player.userId, key, amount });
        }
        await stake(player.userId, 10_000n * BigInt(index + 1));
      }
      // A replay and a refusal must not leave anything behind either.
      const first = topUps[0]!;
      expect((await topUp(players[0]!, first.key, { amount: '25000' })).statusCode).toBe(200);
      expect((await topUp(players[1]!, newKey(), { amount: '0' })).statusCode).toBe(400);
      expect(await wallet(players[0]!)).toMatchObject({ cash: (359_333n - 10_000n).toString() });
      expect(await wallet(players[1]!)).toMatchObject({ cash: (359_333n - 20_000n).toString() });
      for (const topUpRow of topUps) {
        expect(await ledgerTransactionFor(topUpRow.userId, topUpRow.key)).toHaveLength(1);
      }

      const unbalanced = await ctx.db.db.execute<{ transaction_id: string }>(sql`
        SELECT transaction_id FROM ledger_entries
        GROUP BY transaction_id HAVING SUM(amount) <> 0 OR COUNT(*) < 2
      `);
      expect(unbalanced.rows).toEqual([]);

      const [total] = (
        await ctx.db.db.execute<{ total: string }>(
          sql`SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries`,
        )
      ).rows;
      expect(total?.total).toBe('0');

      const stale = await ctx.db.db.execute<{ key: string }>(sql`
        SELECT a.key FROM ledger_accounts a
        LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.id, a.key, a.balance
        HAVING a.balance <> COALESCE(SUM(e.amount), 0)
      `);
      expect(stale.rows).toEqual([]);

      // Demo funding is exactly the play money credited by top-ups.
      const [funding] = await ctx.db.db
        .select({ balance: ledgerAccounts.balance })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.key, 'house:demo_funding'));
      const [credited] = (
        await ctx.db.db.execute<{ total: string; count: string }>(sql`
          SELECT COALESCE(SUM(e.amount), 0)::text AS total, COUNT(DISTINCT t.id)::text AS count
          FROM ledger_entries e
          JOIN ledger_transactions t ON t.id = e.transaction_id
          JOIN ledger_accounts a ON a.id = e.account_id
          WHERE t.type = 'demo_topup' AND a.kind = 'player_cash'
        `)
      ).rows;
      expect(Number(credited?.count)).toBeGreaterThanOrEqual(topUps.length);
      expect(funding?.balance).toBe(-BigInt(credited!.total));

      // Every demo top-up has exactly one outbox event and one audit record.
      const [counts] = (
        await ctx.db.db.execute<{ topups: string; events: string; audits: string }>(sql`
          SELECT
            (SELECT COUNT(*) FROM ledger_transactions WHERE type = 'demo_topup')::text AS topups,
            (SELECT COUNT(*) FROM outbox_events WHERE type = 'wallet.demo_topup')::text AS events,
            (SELECT COUNT(*) FROM audit_log WHERE action = 'wallet.demo_topup')::text AS audits
        `)
      ).rows;
      expect(counts?.events).toBe(counts?.topups);
      expect(counts?.audits).toBe(counts?.topups);
    });
  });
});
