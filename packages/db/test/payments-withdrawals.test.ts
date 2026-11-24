import { birr } from '@vamos/core';
import {
  attemptPayout,
  payoutRetryDelayMs,
  ProviderRequestError,
  type PaymentProvider,
  type PayoutInitiation,
  type ProviderStatusResult,
} from '@vamos/payments';
import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDepositEvent,
  applyPayoutAttempt,
  applyPayoutEvent,
  approveWithdrawal,
  AUTO_APPROVER,
  cancelWithdrawal,
  claimDuePayouts,
  clearPayoutFlag,
  flagPayoutForStaff,
  getBalance,
  getPayout,
  getRemainingWagering,
  getUserPayout,
  listFlaggedPayouts,
  listPayoutsForReview,
  listUserPayouts,
  markPayoutFailed,
  markPayoutPaid,
  markPayoutProcessing,
  rejectWithdrawal,
  resolveFlaggedDeposit,
  settleEventBets,
  WITHDRAWAL_APPROVED,
  WITHDRAWAL_CANCELLED,
  WITHDRAWAL_FAILED,
  WITHDRAWAL_FLAGGED,
  WITHDRAWAL_PAID,
  WITHDRAWAL_REJECTED,
  WITHDRAWAL_REQUESTED,
  withdrawalHoldLedgerKey,
  withdrawalPaidLedgerKey,
  withdrawalReversalLedgerKey,
  type CatalogIds,
  type GameSettings,
  type Payout,
  type PayoutAttemptOutcome,
} from '../src/index';
import { kycProfiles, ledgerTransactions, payouts, rgExclusions, users } from '../src/schema/index';
import {
  cancel,
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
} from './betting-fixtures';
import { dropTestDatabase, fund } from './helpers';
import {
  auditCount,
  cashOf,
  createPlayer,
  depositViaMock,
  domainError,
  expectBooksBalanced,
  idemKey,
  mockProvider,
  NOW,
  outboxOf,
  PENDING,
  psp,
  rules,
  withdraw,
} from './payments-fixtures';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const ADMIN = '9a3e1d4c-5b6f-4a7e-8d9c-0b1a2c3d4e5f';
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Player = { userId: string; phone: string };

/** A KYC-verified player with `amount` deposited through the mock provider. */
async function fundedPlayer(amount = birr(1_000), suffix?: string): Promise<Player> {
  const player = await createPlayer(handle.db, suffix === undefined ? {} : { suffix });
  if (amount > 0n) await depositViaMock(handle.db, player.userId, amount);
  return player;
}

async function postingsWithKey(key: string) {
  const [row] = await handle.db
    .select({ n: count() })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, key));
  return row?.n ?? 0;
}

/**
 * One pass of the payout worker over the given payouts: claim (only these,
 * others stay untouched), mark processing, attempt through `provider`
 * outside the transaction, record the result.
 */
async function runWorker(
  only: readonly string[],
  options: { now: Date; provider?: PaymentProvider; maxAttempts?: number },
) {
  const provider: PaymentProvider = options.provider ?? mockProvider();
  const wanted = new Set(only);
  const claimed = await handle.db.transaction(async (tx) => {
    const due = await claimDuePayouts(tx, { now: options.now, limit: 500 });
    const mine: Payout[] = [];
    for (const payout of due.filter((p) => wanted.has(p.id))) {
      mine.push(
        await markPayoutProcessing(tx, {
          payoutId: payout.id,
          now: options.now,
          checkAt: new Date(options.now.getTime() + payoutRetryDelayMs(payout.attempts + 1)),
          providerRef: provider.payoutReference?.(payout.id) ?? null,
        }),
      );
    }
    return mine;
  });
  const applied = [];
  for (const payout of claimed) {
    const result = await attemptPayout(provider, {
      payoutId: payout.id,
      amount: payout.amount,
      phone: payout.phone,
      recipientName: payout.recipientName,
      providerRef: payout.providerRef,
      attempts: payout.attempts,
    });
    applied.push(
      await handle.db.transaction((tx) =>
        applyPayoutAttempt(tx, {
          payoutId: payout.id,
          attempt: payout.attempts,
          result,
          now: options.now,
          retryAt: new Date(options.now.getTime() + payoutRetryDelayMs(payout.attempts)),
          maxAttempts: options.maxAttempts ?? 5,
        }),
      ),
    );
  }
  return applied;
}

/**
 * A provider whose payout calls follow a script (the mock cannot time out).
 * With `reference`, it names payouts by our payout id before they are sent
 * (like Chapa), so the worker stores that reference first.
 */
function scriptedProvider(script: {
  initiate: Array<() => Promise<PayoutInitiation>>;
  query?: () => Promise<ProviderStatusResult>;
  reference?: boolean;
}): PaymentProvider & { calls: string[] } {
  const calls: string[] = [];
  let step = 0;
  return {
    name: 'mock',
    capabilities: { deposits: true, payouts: true },
    ...(script.reference === true ? { payoutReference: (payoutId: string) => payoutId } : {}),
    calls,
    initiateDeposit: () => Promise.reject(new Error('not used')),
    verifyWebhook: () => Promise.reject(new Error('not used')),
    queryDeposit: () => Promise.reject(new Error('not used')),
    initiatePayout: () => {
      calls.push('initiate');
      const next = script.initiate[Math.min(step, script.initiate.length - 1)];
      step += 1;
      return next ? next() : Promise.reject(new Error('no script'));
    },
    queryPayout: () => {
      calls.push('query');
      return script.query ? script.query() : Promise.reject(new Error('no query script'));
    },
  };
}

const timeout = () =>
  Promise.reject<PayoutInitiation>(
    new ProviderRequestError('mock', 'no response', { status: null, retryable: true }),
  );
const refused = () =>
  Promise.reject<PayoutInitiation>(
    new ProviderRequestError('mock', 'duplicate reference', { status: 409, retryable: false }),
  );

/** A signed mock payout webhook, verified, applied. `eventId` overrides the provider's event id. */
async function payoutWebhook(
  payout: Payout,
  status: 'succeeded' | 'failed',
  amount = payout.amount,
  eventId?: string,
) {
  const provider = mockProvider();
  const event = await provider.verifyWebhook(
    provider.simulatePayoutResult({ providerRef: payout.providerRef!, amount, status }),
  );
  return handle.db.transaction((tx) =>
    applyPayoutEvent(tx, {
      provider: 'mock',
      event: eventId === undefined ? event : { ...event, providerEventId: eventId },
      now: NOW,
    }),
  );
}

describe('requestWithdrawal', () => {
  it('auto-approves a small withdrawal: the hold, payout row, outbox and audit', async () => {
    const player = await fundedPlayer(birr(1_000));
    const heldBefore = await getBalance(handle.db, PENDING);
    const { payout, replayed } = await withdraw(handle.db, player, birr(200));
    expect(replayed).toBe(false);
    expect(payout).toMatchObject({
      userId: player.userId,
      provider: 'mock',
      amount: birr(200),
      currency: 'ETB',
      phone: player.phone,
      recipientName: 'Abebe Kebede',
      status: 'approved',
      reviewReason: null,
      approvedBy: AUTO_APPROVER,
      approvedAt: NOW,
      attempts: 0,
      providerRef: null,
      flagReason: null,
      requestedAt: NOW,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(800));
    expect(await getBalance(handle.db, PENDING)).toBe(heldBefore + birr(200));
    expect(await postingsWithKey(withdrawalHoldLedgerKey(payout.id))).toBe(1);
    const [hold] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, payout.holdLedgerTransactionId));
    expect(hold).toMatchObject({ type: 'withdrawal', refType: 'payout', refId: payout.id });
    expect(await outboxOf(handle.db, payout.id)).toEqual([
      [
        WITHDRAWAL_REQUESTED,
        {
          payoutId: payout.id,
          userId: player.userId,
          provider: 'mock',
          amount: '20000',
          status: 'approved',
          reviewReason: null,
        },
      ],
      [
        WITHDRAWAL_APPROVED,
        {
          payoutId: payout.id,
          userId: player.userId,
          provider: 'mock',
          amount: '20000',
          approvedBy: AUTO_APPROVER,
        },
      ],
    ]);
    expect(await auditCount(handle.db, payout.id, WITHDRAWAL_REQUESTED)).toBe(1);
  });

  it('sends a withdrawal at or above the threshold to manual review', async () => {
    const player = await fundedPlayer(birr(10_000));
    const { payout } = await withdraw(handle.db, player, birr(5_000));
    expect(payout).toMatchObject({
      status: 'requested',
      reviewReason: 'above_auto_approve_threshold',
      approvedBy: null,
      approvedAt: null,
    });
    expect((await outboxOf(handle.db, payout.id)).map(([type]) => type)).toEqual([
      WITHDRAWAL_REQUESTED,
    ]);
    expect(await cashOf(handle.db, player.userId)).toBe(birr(5_000));
    expect((await listPayoutsForReview(handle.db, { limit: 500 })).map((p) => p.id)).toContain(
      payout.id,
    );
  });

  it('replays an idempotency key without writing, and refuses it for another withdrawal', async () => {
    const player = await fundedPlayer(birr(1_000));
    const key = idemKey();
    const first = await withdraw(handle.db, player, birr(100), { key });
    const again = await withdraw(handle.db, player, birr(100), { key });
    expect(again).toEqual({ payout: first.payout, replayed: true });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
    expect(await outboxOf(handle.db, first.payout.id)).toHaveLength(2);
    expect(await domainError(withdraw(handle.db, player, birr(150), { key }))).toMatchObject({
      status: 422,
      code: 'idempotency_key_reused',
    });
  });

  it('requires verified KYC with a name, the registered phone and an active account', async () => {
    for (const [kyc, name] of [
      ['none', 'x'],
      ['pending', 'Abebe Kebede'],
      ['verified', null],
      ['verified', '   '],
    ] as const) {
      const player = await createPlayer(handle.db, { kyc, name });
      await fund(handle.db, player.userId, birr(500));
      expect(await domainError(withdraw(handle.db, player, birr(100)))).toMatchObject({
        status: 403,
        code: 'kyc_required',
        details: { kycStatus: kyc === 'none' ? 'unverified' : kyc },
      });
    }

    const player = await fundedPlayer(birr(500));
    const other = await createPlayer(handle.db);
    for (const phone of [other.phone, '+254711234567', 'nonsense']) {
      expect(await domainError(withdraw(handle.db, player, birr(100), { phone }))).toMatchObject({
        status: 422,
        code: 'payout_phone_mismatch',
      });
    }
    const local = `0${player.phone.slice(4)}`;
    expect((await withdraw(handle.db, player, birr(100), { phone: local })).payout.phone).toBe(
      player.phone,
    );

    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, player.userId));
    expect(await domainError(withdraw(handle.db, player, birr(100)))).toMatchObject({
      status: 403,
      code: 'account_disabled',
    });
    // Nothing above wrote a payout or moved money.
    expect(await cashOf(handle.db, player.userId)).toBe(birr(400));
  });

  it('enforces the amount limits and the 24-hour cap; reversed withdrawals do not count', async () => {
    const player = await fundedPlayer(birr(5_000));
    const r = rules({
      minWithdrawal: birr(50),
      maxWithdrawal: birr(800),
      dailyWithdrawalCap: birr(1_000),
    });
    for (const amount of [birr(49), birr(801)]) {
      expect(await domainError(withdraw(handle.db, player, amount, { rules: r }))).toMatchObject({
        status: 422,
        code: 'withdrawal_amount_out_of_range',
        details: { min: '5000', max: '80000' },
      });
    }
    const first = await withdraw(handle.db, player, birr(600), { rules: r });
    expect(await domainError(withdraw(handle.db, player, birr(500), { rules: r }))).toMatchObject({
      status: 422,
      code: 'withdrawal_daily_cap_exceeded',
      details: { cap: '100000', used: '60000', amount: '50000' },
    });
    await handle.db.transaction((tx) =>
      cancelWithdrawal(tx, { payoutId: first.payout.id, userId: player.userId, now: NOW }),
    );
    const second = await withdraw(handle.db, player, birr(500), { rules: r });
    expect(second.payout.status).toBe('approved');
    // 23 h 59 min later the 500 still counts; 24 h later it no longer does.
    const almost = new Date(NOW.getTime() + 24 * HOUR - 60_000);
    expect(
      (await domainError(withdraw(handle.db, player, birr(600), { rules: r, now: almost }))).code,
    ).toBe('withdrawal_daily_cap_exceeded');
    const nextDay = new Date(NOW.getTime() + 24 * HOUR);
    expect(
      (await withdraw(handle.db, player, birr(600), { rules: r, now: nextDay })).payout.status,
    ).toBe('approved');
  });

  it('refuses more than the balance and writes nothing', async () => {
    const player = await fundedPlayer(birr(100));
    expect(await domainError(withdraw(handle.db, player, birr(150)))).toMatchObject({
      status: 422,
      code: 'insufficient_funds',
      details: { balance: '10000', amount: '15000' },
    });
    expect(await listUserPayouts(handle.db, player.userId)).toEqual([]);
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
  });

  it('never overdraws under concurrent requests, and a raced key creates one payout', async () => {
    const player = await fundedPlayer(birr(1_000));
    const heldBefore = await getBalance(handle.db, PENDING);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => withdraw(handle.db, player, birr(300))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect((r.reason as { code?: string }).code).toBe('insufficient_funds');
      }
    }
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect(await getBalance(handle.db, PENDING)).toBe(heldBefore + birr(900));

    const rich = await fundedPlayer(birr(1_000));
    const key = idemKey('race');
    const raced = await Promise.all(
      Array.from({ length: 5 }, () => withdraw(handle.db, rich, birr(100), { key })),
    );
    expect(new Set(raced.map((r) => r.payout.id)).size).toBe(1);
    expect(raced.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await cashOf(handle.db, rich.userId)).toBe(birr(900));
    await expectBooksBalanced(handle.db);
  });
});

describe('winnings only: deposits are never withdrawn (owner, 21 Nov 2026; multiplier 1.0)', () => {
  const wagering = rules({ wageringMultiplierBps: 10_000 });

  it('requires each deposit to be staked once; winnings of wagered deposits are withdrawable', async () => {
    const player = await fundedPlayer(birr(200));
    expect(
      await domainError(withdraw(handle.db, player, birr(100), { rules: wagering })),
    ).toMatchObject({
      status: 422,
      code: 'wagering_requirement_not_met',
      details: { remaining: '20000', withdrawable: '0' },
    });

    const event = await createEvent(handle.db, ids, { odds: { home: 2000 } });
    await place(handle.db, player.userId, {
      stake: birr(150),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(birr(50));
    expect(
      (await domainError(withdraw(handle.db, player, birr(50), { rules: wagering }))).details,
    ).toEqual({ remaining: '5000', withdrawable: '0' });

    await place(handle.db, player.userId, {
      stake: birr(50),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    // Everything is staked (cash 0) and both bets win at 2.00: 150 returns 300 less 20% tax
    // on the 150 winnings (270); the 50 winnings of the second are under the tax exemption (100).
    await finish(handle.db, event.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect(await cashOf(handle.db, player.userId)).toBe(birr(370));
    const { payout } = await withdraw(handle.db, player, birr(370), { rules: wagering });
    expect(payout.status).toBe('approved');
  });

  it('does not count stakes that were refunded (void bets)', async () => {
    const player = await fundedPlayer(birr(100));
    const event = await createEvent(handle.db, ids);
    await place(handle.db, player.userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(0n);
    await cancel(handle.db, event.eventId);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect(await cashOf(handle.db, player.userId)).toBe(birr(100));
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(birr(100));
    expect(
      (await domainError(withdraw(handle.db, player, birr(100), { rules: wagering }))).code,
    ).toBe('wagering_requirement_not_met');
  });

  it('does not let stakes made before a deposit count towards it; demo top-ups count as funding', async () => {
    const player = await createPlayer(handle.db);
    await fund(handle.db, player.userId, birr(100));
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(birr(100));
    const event = await createEvent(handle.db, ids);
    await place(handle.db, player.userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await finish(handle.db, event.eventId, 2, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect(await cashOf(handle.db, player.userId)).toBe(birr(180));
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(0n);

    await depositViaMock(handle.db, player.userId, birr(50));
    // Total staked (100) >= total funded (150) fails anyway here; the running
    // rule also refuses when old turnover would exceed it.
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(birr(50));
    // The 180 won stays withdrawable; the new 50 is for betting.
    expect(
      (await domainError(withdraw(handle.db, player, birr(200), { rules: wagering }))).details,
    ).toEqual({ remaining: '5000', withdrawable: '18000' });
    expect((await withdraw(handle.db, player, birr(180), { rules: wagering })).payout.status).toBe(
      'approved',
    );
    expect(
      (await domainError(withdraw(handle.db, player, birr(50), { rules: wagering }))).details,
    ).toEqual({ remaining: '5000', withdrawable: '0' });
    // At multiplier 0 there is no requirement.
    expect((await withdraw(handle.db, player, birr(50), { rules: rules() })).payout.status).toBe(
      'approved',
    );
  });

  it('pays the winnings at once while part of the deposit is still unplayed', async () => {
    // Deposit 1,000 and stake 200 at 4.00: the 800 not staked stays for betting, what the bet
    // returned (after tax) is withdrawable straight away.
    const player = await fundedPlayer(birr(1000));
    const event = await createEvent(handle.db, ids, { odds: { home: 4000 } });
    await place(handle.db, player.userId, {
      stake: birr(200),
      legs: [{ selectionId: event.home, oddsMilli: 4000 }],
      settings,
    });
    await finish(handle.db, event.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect(await getRemainingWagering(handle.db, player.userId, 10_000)).toBe(birr(800));
    const won = (await cashOf(handle.db, player.userId)) - birr(800);
    expect(won > 0n).toBe(true);
    expect(
      (await domainError(withdraw(handle.db, player, won + 1n, { rules: wagering }))).details,
    ).toEqual({ remaining: '80000', withdrawable: won.toString() });
    expect((await withdraw(handle.db, player, won, { rules: wagering })).payout.status).toBe(
      'approved',
    );
    expect(await cashOf(handle.db, player.userId)).toBe(birr(800));
    expect(
      (await domainError(withdraw(handle.db, player, birr(100), { rules: wagering }))).code,
    ).toBe('wagering_requirement_not_met');
  });

  it('is waived during an exclusion, which sends every withdrawal to review instead', async () => {
    const player = await fundedPlayer(birr(300));
    await handle.db.insert(rgExclusions).values({
      userId: player.userId,
      kind: 'cool_off',
      startsAt: new Date(NOW.getTime() - HOUR),
      endsAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    const { payout } = await withdraw(handle.db, player, birr(100), { rules: wagering });
    expect(payout).toMatchObject({
      status: 'requested',
      reviewReason: 'active_exclusion',
      approvedBy: null,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(200));
  });
});

describe('review: approve, reject, cancel', () => {
  it('approves a payout waiting for review once', async () => {
    const player = await fundedPlayer(birr(10_000));
    const { payout } = await withdraw(handle.db, player, birr(6_000));
    const approved = await handle.db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, now: NOW }),
    );
    expect(approved).toMatchObject({ changed: true });
    expect(approved.payout).toMatchObject({
      status: 'approved',
      approvedBy: ADMIN,
      approvedAt: NOW,
    });
    const again = await handle.db.transaction((tx) =>
      approveWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, now: NOW }),
    );
    expect(again.changed).toBe(false);
    expect((await outboxOf(handle.db, payout.id)).map(([type]) => type)).toEqual([
      WITHDRAWAL_REQUESTED,
      WITHDRAWAL_APPROVED,
    ]);
    expect(await auditCount(handle.db, payout.id, WITHDRAWAL_APPROVED)).toBe(1);
  });

  it('rejects with a reason and returns the hold; a closed payout cannot be approved', async () => {
    const player = await fundedPlayer(birr(10_000));
    const heldBefore = await getBalance(handle.db, PENDING);
    const { payout } = await withdraw(handle.db, player, birr(7_000));
    await expect(
      handle.db.transaction((tx) =>
        rejectWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, reason: '  ', now: NOW }),
      ),
    ).rejects.toThrow(RangeError);
    const rejected = await handle.db.transaction((tx) =>
      rejectWithdrawal(tx, {
        payoutId: payout.id,
        adminId: ADMIN,
        reason: 'Name does not match the wallet',
        now: NOW,
      }),
    );
    expect(rejected.payout).toMatchObject({
      status: 'rejected',
      reviewReason: 'Name does not match the wallet',
      closedBy: ADMIN,
      completedAt: NOW,
    });
    expect(rejected.payout.reversalLedgerTransactionId).not.toBeNull();
    expect(await cashOf(handle.db, player.userId)).toBe(birr(10_000));
    expect(await getBalance(handle.db, PENDING)).toBe(heldBefore);
    expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(1);
    const [reversal] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, withdrawalReversalLedgerKey(payout.id)));
    expect(reversal).toMatchObject({
      type: 'withdrawal_reversal',
      actorType: 'admin',
      actorId: ADMIN,
    });

    const again = await handle.db.transaction((tx) =>
      rejectWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, reason: 'again', now: NOW }),
    );
    expect(again.changed).toBe(false);
    expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(1);
    expect(
      await domainError(
        handle.db.transaction((tx) =>
          approveWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, now: NOW }),
        ),
      ),
    ).toMatchObject({ status: 409, code: 'payout_not_reviewable' });
    expect((await outboxOf(handle.db, payout.id)).map(([type]) => type)).toEqual([
      WITHDRAWAL_REQUESTED,
      WITHDRAWAL_REJECTED,
    ]);
  });

  it('lets the player cancel their own payout before it is sent', async () => {
    const player = await fundedPlayer(birr(1_000));
    const other = await createPlayer(handle.db);
    const { payout } = await withdraw(handle.db, player, birr(300));
    expect(
      await domainError(
        handle.db.transaction((tx) =>
          cancelWithdrawal(tx, { payoutId: payout.id, userId: other.userId, now: NOW }),
        ),
      ),
    ).toMatchObject({ status: 404 });
    const cancelled = await handle.db.transaction((tx) =>
      cancelWithdrawal(tx, { payoutId: payout.id, userId: player.userId, now: NOW }),
    );
    expect(cancelled.payout).toMatchObject({ status: 'cancelled', closedBy: player.userId });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    expect(
      (
        await handle.db.transaction((tx) =>
          cancelWithdrawal(tx, { payoutId: payout.id, userId: player.userId, now: NOW }),
        )
      ).changed,
    ).toBe(false);
    expect((await outboxOf(handle.db, payout.id)).map(([type]) => type)).toContain(
      WITHDRAWAL_CANCELLED,
    );

    // Once the worker has it, neither the player nor staff can pull it back.
    const { payout: sent } = await withdraw(handle.db, player, birr(100));
    await handle.db.transaction((tx) =>
      markPayoutProcessing(tx, {
        payoutId: sent.id,
        now: NOW,
        checkAt: new Date(NOW.getTime() + HOUR),
      }),
    );
    expect(
      (
        await domainError(
          handle.db.transaction((tx) =>
            cancelWithdrawal(tx, { payoutId: sent.id, userId: player.userId, now: NOW }),
          ),
        )
      ).code,
    ).toBe('payout_not_cancellable');
    expect(
      (
        await domainError(
          handle.db.transaction((tx) =>
            rejectWithdrawal(tx, { payoutId: sent.id, adminId: ADMIN, reason: 'x', now: NOW }),
          ),
        )
      ).code,
    ).toBe('payout_not_reviewable');
  });
});

describe('payout worker', () => {
  const T = new Date('2026-10-15T10:00:00Z');

  it('pays an approved payout through the mock provider', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(400));
    const pspBefore = await getBalance(handle.db, psp());
    const heldBefore = await getBalance(handle.db, PENDING);
    const [applied] = await runWorker([payout.id], { now: T });
    expect(applied?.applied).toBe('paid');
    expect(applied?.payout).toMatchObject({
      status: 'paid',
      attempts: 1,
      providerRef: `mockpay_s_${payout.id}`,
      processingAt: T,
      completedAt: T,
      nextAttemptAt: null,
    });
    expect(await getBalance(handle.db, PENDING)).toBe(heldBefore - birr(400));
    expect(await getBalance(handle.db, psp())).toBe(pspBefore + birr(400));
    expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(1);
    expect(await cashOf(handle.db, player.userId)).toBe(birr(600));
    expect((await outboxOf(handle.db, payout.id)).at(-1)).toEqual([
      WITHDRAWAL_PAID,
      {
        payoutId: payout.id,
        userId: player.userId,
        provider: 'mock',
        amount: '40000',
        providerRef: `mockpay_s_${payout.id}`,
      },
    ]);
    // Nothing left to do for it.
    expect(await runWorker([payout.id], { now: new Date(T.getTime() + HOUR) })).toEqual([]);
    await expectBooksBalanced(handle.db);
  });

  it('returns the hold when the provider fails the payout', async () => {
    const player = await fundedPlayer(birr(1_000), '0000');
    const { payout } = await withdraw(handle.db, player, birr(250));
    const [applied] = await runWorker([payout.id], { now: T });
    expect(applied?.applied).toBe('failed');
    expect(applied?.payout).toMatchObject({
      status: 'failed',
      failureReason: 'failed_at_provider',
      providerRef: `mockpay_f_${payout.id}`,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(1);
    expect((await outboxOf(handle.db, payout.id)).at(-1)?.[0]).toBe(WITHDRAWAL_FAILED);
  });

  it('keeps a payout the provider has not finished, and asks about it later', async () => {
    const player = await fundedPlayer(birr(1_000), '9999');
    const { payout } = await withdraw(handle.db, player, birr(100));
    const [first] = await runWorker([payout.id], { now: T });
    expect(first?.applied).toBe('pending');
    expect(first?.payout).toMatchObject({
      status: 'processing',
      providerRef: `mockpay_p_${payout.id}`,
      nextAttemptAt: new Date(T.getTime() + payoutRetryDelayMs(1)),
    });
    // Not due yet.
    expect(await runWorker([payout.id], { now: new Date(T.getTime() + 30_000) })).toEqual([]);
    const later = new Date(T.getTime() + payoutRetryDelayMs(1));
    const [second] = await runWorker([payout.id], { now: later });
    expect(second).toMatchObject({ applied: 'paid', payout: { status: 'paid', attempts: 2 } });
  });

  it('retries without an answer, then flags the payout for staff', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const provider = scriptedProvider({ initiate: [timeout] });
    let now = T;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const [applied] = await runWorker([payout.id], { now, provider, maxAttempts: 3 });
      expect(applied).toMatchObject({
        applied: 'retry_scheduled',
        payout: {
          status: 'processing',
          attempts: attempt,
          lastError: expect.stringContaining('no response'),
        },
      });
      now = applied!.payout.nextAttemptAt!;
    }
    // Staff cannot settle it while the worker owns it.
    expect(
      await domainError(
        handle.db.transaction((tx) =>
          markPayoutFailed(tx, {
            payoutId: payout.id,
            reason: 'x',
            now,
            admin: { adminId: ADMIN },
          }),
        ),
      ),
    ).toMatchObject({ status: 409, code: 'payout_in_progress' });

    const [third] = await runWorker([payout.id], { now, provider, maxAttempts: 3 });
    expect(third).toMatchObject({
      applied: 'flagged',
      payout: {
        status: 'processing',
        attempts: 3,
        flagReason: 'attempts_exhausted',
        flaggedAt: now,
      },
    });
    expect((await outboxOf(handle.db, payout.id)).at(-1)).toEqual([
      WITHDRAWAL_FLAGGED,
      expect.objectContaining({ reason: 'attempts_exhausted', attempts: 3 }),
    ]);
    // The worker leaves a flagged payout alone.
    expect(
      await runWorker([payout.id], { now: new Date(now.getTime() + 24 * HOUR), provider }),
    ).toEqual([]);
    expect(
      (
        await domainError(
          handle.db.transaction((tx) =>
            markPayoutProcessing(tx, { payoutId: payout.id, now, checkAt: now }),
          ),
        )
      ).code,
    ).toBe('payout_flagged');
    expect((await listFlaggedPayouts(handle.db, { limit: 500 })).map((p) => p.id)).toContain(
      payout.id,
    );
    expect(provider.calls).toEqual(['initiate', 'initiate', 'initiate']);

    // Staff confirm with the provider that it never arrived: the hold goes back.
    const failed = await handle.db.transaction((tx) =>
      markPayoutFailed(tx, {
        payoutId: payout.id,
        reason: 'not received by the provider',
        now,
        admin: { adminId: ADMIN },
      }),
    );
    expect(failed.payout).toMatchObject({
      status: 'failed',
      flagReason: null,
      flaggedAt: null,
      closedBy: ADMIN,
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    expect(await auditCount(handle.db, payout.id, WITHDRAWAL_FAILED)).toBe(1);
  });

  it('flags an ambiguous refusal of a resubmission; staff hand it back and it is paid', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const provider = scriptedProvider({
      initiate: [
        timeout,
        refused,
        () => Promise.resolve({ providerRef: `ref-${payout.id}`, status: 'succeeded' as const }),
      ],
    });
    const [first] = await runWorker([payout.id], { now: T, provider });
    expect(first?.applied).toBe('retry_scheduled');
    const t2 = first!.payout.nextAttemptAt!;
    const [second] = await runWorker([payout.id], { now: t2, provider });
    // The first submission may have reached the provider: never return the hold here.
    expect(second).toMatchObject({
      applied: 'flagged',
      payout: { status: 'processing', flagReason: 'ambiguous_result' },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));

    const cleared = await handle.db.transaction((tx) =>
      clearPayoutFlag(tx, {
        payoutId: payout.id,
        adminId: ADMIN,
        note: 'Provider says it was never created; send again',
        now: t2,
      }),
    );
    expect(cleared.payout).toMatchObject({
      flagReason: null,
      flaggedAt: null,
      nextAttemptAt: null,
    });
    expect(
      (
        await handle.db.transaction((tx) =>
          clearPayoutFlag(tx, { payoutId: payout.id, adminId: ADMIN, note: 'again', now: t2 }),
        )
      ).changed,
    ).toBe(false);
    const [third] = await runWorker([payout.id], { now: t2, provider });
    expect(third).toMatchObject({
      applied: 'paid',
      payout: { status: 'paid', attempts: 3, providerRef: `ref-${payout.id}` },
    });
    expect(await auditCount(handle.db, payout.id, 'payment.withdrawal_flag_cleared')).toBe(1);
  });

  it('fails a payout refused at its very first submission', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const provider = scriptedProvider({ initiate: [refused] });
    const [applied] = await runWorker([payout.id], { now: T, provider });
    expect(applied).toMatchObject({
      applied: 'failed',
      payout: { status: 'failed', failureReason: 'refused_by_provider' },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
  });

  it('claims each due payout for one worker at a time (SKIP LOCKED)', async () => {
    const player = await fundedPlayer(birr(2_000));
    const mine: string[] = [];
    for (let i = 0; i < 6; i += 1)
      mine.push((await withdraw(handle.db, player, birr(100))).payout.id);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let first: string[] = [];
    let claimedFirst!: () => void;
    const firstClaimed = new Promise<void>((resolve) => (claimedFirst = resolve));
    const a = handle.db.transaction(async (tx) => {
      first = (await claimDuePayouts(tx, { now: T, limit: 500 }))
        .map((p) => p.id)
        .filter((id) => mine.includes(id))
        .slice(0, 3);
      // Keep only three of ours locked (the rest is released at once by a new claim below).
      claimedFirst();
      await hold;
    });
    await firstClaimed;
    const second = await handle.db.transaction(async (tx) =>
      (await claimDuePayouts(tx, { now: T, limit: 500 }))
        .map((p) => p.id)
        .filter((id) => mine.includes(id)),
    );
    release();
    await a;
    expect(first.length).toBeGreaterThan(0);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    // Every one of them is still due afterwards (claiming changes nothing by itself).
    const again = await handle.db.transaction(async (tx) =>
      (await claimDuePayouts(tx, { now: T, limit: 500 })).map((p) => p.id),
    );
    expect(again).toEqual(expect.arrayContaining(mine));
    // Settle them so later tests start clean.
    await runWorker(mine, { now: T });
  });
});

describe('payout webhooks and conflicts', () => {
  const T = new Date('2026-10-16T10:00:00Z');

  /** A payout the provider holds as pending (phone …9999), with its reference stored. */
  async function pendingPayout(amount = birr(100)): Promise<{ player: Player; payout: Payout }> {
    const player = await fundedPlayer(birr(1_000), '9999');
    const { payout } = await withdraw(handle.db, player, amount);
    const [applied] = await runWorker([payout.id], { now: T });
    expect(applied?.applied).toBe('pending');
    return { player, payout: applied!.payout };
  }

  it('settles a payout from a signed webhook once; a redelivery is a duplicate', async () => {
    const { payout } = await pendingPayout();
    const paid = await payoutWebhook(payout, 'succeeded');
    expect(paid).toMatchObject({ outcome: 'paid', payout: { status: 'paid', flagReason: null } });
    expect((await payoutWebhook(payout, 'succeeded')).outcome).toBe('duplicate');
    expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(1);
    // The worker's own late answer agrees: nothing changes.
    const late = await handle.db.transaction((tx) =>
      applyPayoutAttempt(tx, {
        payoutId: payout.id,
        attempt: payout.attempts,
        result: { outcome: 'paid', providerRef: payout.providerRef! },
        now: T,
        retryAt: T,
        maxAttempts: 5,
      }),
    );
    expect(late.applied).toBe('unchanged');
  });

  it('returns the hold on a failure webhook', async () => {
    const { player, payout } = await pendingPayout();
    const failed = await payoutWebhook(payout, 'failed');
    expect(failed).toMatchObject({
      outcome: 'failed',
      payout: { status: 'failed', failureReason: 'failed_at_provider' },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
  });

  it('flags a payment reported after the hold went back, and holds later events', async () => {
    const { player, payout } = await pendingPayout();
    await payoutWebhook(payout, 'failed');
    const conflict = await payoutWebhook(payout, 'succeeded');
    expect(conflict).toMatchObject({
      outcome: 'conflict',
      payout: { status: 'failed', flagReason: 'provider_conflict' },
    });
    expect((await outboxOf(handle.db, payout.id)).at(-1)).toEqual([
      WITHDRAWAL_FLAGGED,
      expect.objectContaining({ reason: 'provider_conflict', reportedStatus: 'succeeded' }),
    ]);
    // Money did not move twice in the books: the player keeps the returned hold.
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(0);
    const held = await payoutWebhook(payout, 'failed', payout.amount, `another-${payout.id}`);
    expect(held.outcome).toBe('held');
    expect((await listFlaggedPayouts(handle.db, { limit: 500 })).map((p) => p.id)).toContain(
      payout.id,
    );
    const cleared = await handle.db.transaction((tx) =>
      clearPayoutFlag(tx, {
        payoutId: payout.id,
        adminId: ADMIN,
        note: 'Recovered the double payment from the player',
        now: T,
      }),
    );
    expect(cleared.payout).toMatchObject({ status: 'failed', flagReason: null });
  });

  it('flags a failure reported after payment and another amount; staff settle a flagged payout', async () => {
    const { payout } = await pendingPayout();
    await payoutWebhook(payout, 'succeeded');
    expect(await payoutWebhook(payout, 'failed')).toMatchObject({
      outcome: 'conflict',
      payout: { status: 'paid', flagReason: 'provider_conflict' },
    });

    const { player, payout: other } = await pendingPayout(birr(100));
    const wrongAmount = await payoutWebhook(other, 'succeeded', birr(1_000));
    expect(wrongAmount).toMatchObject({
      outcome: 'conflict',
      payout: { status: 'processing', flagReason: 'provider_conflict' },
    });
    expect(await runWorker([other.id], { now: new Date(T.getTime() + 24 * HOUR) })).toEqual([]);
    const settled = await handle.db.transaction((tx) =>
      markPayoutPaid(tx, { payoutId: other.id, now: T, admin: { adminId: ADMIN } }),
    );
    expect(settled.payout).toMatchObject({ status: 'paid', flagReason: null, flaggedAt: null });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
    const [paidPosting] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, withdrawalPaidLedgerKey(other.id)));
    expect(paidPosting).toMatchObject({ actorType: 'admin', actorId: ADMIN });
  });

  it('lets a provider conflict take over a softer flag, so later events are held', async () => {
    const { payout } = await pendingPayout();
    const exhausted = await handle.db.transaction((tx) =>
      applyPayoutAttempt(tx, {
        payoutId: payout.id,
        attempt: payout.attempts,
        result: { outcome: 'retry', providerRef: payout.providerRef, error: 'timeout' },
        now: T,
        retryAt: T,
        maxAttempts: 1,
      }),
    );
    expect(exhausted.payout.flagReason).toBe('attempts_exhausted');
    // An answer settles a payout flagged only for lack of one…
    const { payout: answered } = await pendingPayout();
    await handle.db.transaction((tx) =>
      applyPayoutAttempt(tx, {
        payoutId: answered.id,
        attempt: answered.attempts,
        result: { outcome: 'retry', providerRef: answered.providerRef, error: 'timeout' },
        now: T,
        retryAt: T,
        maxAttempts: 1,
      }),
    );
    expect((await payoutWebhook(answered, 'succeeded')).payout).toMatchObject({
      status: 'paid',
      flagReason: null,
    });
    // …but not one whose provider contradicted itself.
    const conflict = await payoutWebhook(payout, 'succeeded', birr(5));
    expect(conflict).toMatchObject({
      outcome: 'conflict',
      payout: {
        status: 'processing',
        flagReason: 'provider_conflict',
        flaggedAt: exhausted.payout.flaggedAt,
      },
    });
    expect((await payoutWebhook(payout, 'succeeded')).outcome).toBe('duplicate');
    const later = await payoutWebhook(payout, 'succeeded', payout.amount, `later-${payout.id}`);
    expect(later.outcome).toBe('held');
    expect((await getPayout(handle.db, payout.id))?.status).toBe('processing');
  });

  it('flags a worker result that contradicts a settled payout', async () => {
    const { payout } = await pendingPayout();
    await payoutWebhook(payout, 'failed');
    const contradiction = await handle.db.transaction((tx) =>
      applyPayoutAttempt(tx, {
        payoutId: payout.id,
        attempt: payout.attempts,
        result: { outcome: 'paid', providerRef: payout.providerRef! },
        now: T,
        retryAt: T,
        maxAttempts: 5,
      }),
    );
    expect(contradiction).toMatchObject({
      applied: 'flagged',
      payout: { status: 'failed', flagReason: 'provider_conflict' },
    });
    const { payout: open } = await pendingPayout();
    const otherRef = await handle.db.transaction((tx) =>
      applyPayoutAttempt(tx, {
        payoutId: open.id,
        attempt: open.attempts,
        result: { outcome: 'pending', providerRef: 'a-different-reference' },
        now: T,
        retryAt: T,
        maxAttempts: 5,
      }),
    );
    expect(otherRef).toMatchObject({
      applied: 'flagged',
      payout: { flagReason: 'provider_conflict' },
    });
  });

  it('refuses an unknown reference without recording it', async () => {
    const provider = mockProvider();
    const event = await provider.verifyWebhook(
      provider.simulatePayoutResult({
        providerRef: 'mockpay_s_unknown',
        amount: 100n,
        status: 'succeeded',
      }),
    );
    expect(
      await domainError(
        handle.db.transaction((tx) => applyPayoutEvent(tx, { provider: 'mock', event, now: T })),
      ),
    ).toMatchObject({ status: 404, code: 'unknown_payment_reference' });
    await expect(
      handle.db.transaction((tx) =>
        applyPayoutEvent(tx, { provider: 'mock', event: { ...event, kind: 'deposit' }, now: T }),
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe('payout safety: ambiguous answers, stale attempts, budgets', () => {
  const T = new Date('2026-10-17T10:00:00Z');

  const statusOf = (status: ProviderStatusResult['status']) => () =>
    Promise.resolve<ProviderStatusResult>({
      providerRef: 'as-asked',
      status,
      amount: null,
      currency: 'ETB',
      raw: { status },
    });
  const queryTimeout = () =>
    Promise.reject<ProviderStatusResult>(
      new ProviderRequestError('mock', 'no response', { status: null, retryable: true }),
    );

  it('keeps the hold when a transfer is answered with an unreadable 2xx; the late webhook pays it', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const unreadable = () =>
      Promise.reject<PayoutInitiation>(
        new ProviderRequestError('mock', 'unreadable 2xx', {
          status: 200,
          body: '<html>',
          retryable: false,
        }),
      );
    const provider = scriptedProvider({ initiate: [unreadable], reference: true });
    const [first] = await runWorker([payout.id], { now: T, provider });
    expect(first).toMatchObject({
      applied: 'retry_scheduled',
      payout: { status: 'processing', providerRef: payout.id, flaggedAt: null },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
    expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(0);
    // The provider's late success webhook finds the payout by the reference stored before sending.
    const paid = await payoutWebhook({ ...first!.payout, providerRef: payout.id }, 'succeeded');
    expect(paid).toMatchObject({ outcome: 'paid', payout: { status: 'paid' } });
    await expectBooksBalanced(handle.db);
  });

  it('flags (never 404s) a success reported for a payout failed on its refused first submission', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const provider = scriptedProvider({ initiate: [refused], reference: true });
    const [applied] = await runWorker([payout.id], { now: T, provider });
    expect(applied).toMatchObject({
      applied: 'failed',
      payout: { status: 'failed', failureReason: 'refused_by_provider' },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    const late = await payoutWebhook({ ...applied!.payout, providerRef: payout.id }, 'succeeded');
    expect(late).toMatchObject({
      outcome: 'conflict',
      payout: { status: 'failed', flagReason: 'provider_conflict' },
    });
    expect((await listFlaggedPayouts(handle.db, { limit: 500 })).map((p) => p.id)).toContain(
      payout.id,
    );
  });

  it('ignores a stale attempt that another worker overtook; the hold stays', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const claim = (now: Date) =>
      handle.db.transaction((tx) =>
        markPayoutProcessing(tx, {
          payoutId: payout.id,
          now,
          checkAt: new Date(now.getTime() + MINUTE),
          providerRef: payout.id,
        }),
      );
    const a = await claim(T); // worker A: slow
    const later = new Date(T.getTime() + MINUTE);
    const b = await claim(later); // A's lease ran out: worker B
    expect([a.attempts, b.attempts]).toEqual([1, 2]);
    const apply = (attempt: number, result: PayoutAttemptOutcome) =>
      handle.db.transaction((tx) =>
        applyPayoutAttempt(tx, {
          payoutId: payout.id,
          attempt,
          result,
          now: later,
          retryAt: new Date(later.getTime() + MINUTE),
          maxAttempts: 5,
        }),
      );
    // B found the payout at the provider.
    expect((await apply(2, { outcome: 'pending', providerRef: payout.id })).applied).toBe(
      'pending',
    );
    // A's late answer: its own submission refused as a duplicate of B's.
    for (const providerRef of [null, payout.id]) {
      const stale = await apply(1, {
        outcome: 'failed',
        providerRef,
        reason: 'refused_by_provider',
      });
      expect(stale).toMatchObject({
        applied: 'stale',
        payout: { status: 'processing', flaggedAt: null },
      });
    }
    // A current failure without the reference the payout already has is not trusted either.
    const noRef = await apply(2, {
      outcome: 'failed',
      providerRef: null,
      reason: 'refused_by_provider',
    });
    expect(noRef.applied).not.toBe('failed');
    expect(noRef.payout.status).toBe('processing');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
    expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(0);

    // Paid by the current attempt: a stale duplicate refusal changes nothing, flags nothing.
    await handle.db.transaction((tx) =>
      clearPayoutFlag(tx, { payoutId: payout.id, adminId: ADMIN, note: 'carry on', now: later }),
    );
    const c = await claim(new Date(later.getTime() + MINUTE));
    expect(
      (await apply(c.attempts, { outcome: 'paid', providerRef: payout.id })).payout.status,
    ).toBe('paid');
    const late = await apply(1, {
      outcome: 'failed',
      providerRef: payout.id,
      reason: 'refused_by_provider',
    });
    expect(late).toMatchObject({ applied: 'stale', payout: { status: 'paid', flaggedAt: null } });
  });

  it('counts only attempts that got no answer against the budget; clearing a flag starts it again', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    let answering = true;
    const provider = scriptedProvider({
      initiate: [() => Promise.resolve({ providerRef: `ref-${payout.id}`, status: 'pending' })],
      query: () => (answering ? statusOf('pending')() : queryTimeout()),
    });
    let now = T;
    const run = async () => {
      const [result] = await runWorker([payout.id], { now, provider, maxAttempts: 3 });
      if (result?.payout.nextAttemptAt) now = result.payout.nextAttemptAt;
      return result;
    };
    for (let i = 0; i < 4; i += 1) expect((await run())?.applied).toBe('pending');
    answering = false;
    // Four status polls already happened: one attempt without an answer is not the end.
    expect(await run()).toMatchObject({
      applied: 'retry_scheduled',
      payout: { attempts: 5, unansweredAttempts: 1, flaggedAt: null },
    });
    expect((await run())?.applied).toBe('retry_scheduled');
    expect(await run()).toMatchObject({
      applied: 'flagged',
      payout: { flagReason: 'attempts_exhausted', unansweredAttempts: 3 },
    });
    const cleared = await handle.db.transaction((tx) =>
      clearPayoutFlag(tx, { payoutId: payout.id, adminId: ADMIN, note: 'Look again', now }),
    );
    expect(cleared.payout).toMatchObject({ unansweredAttempts: 0, nextAttemptAt: null });
    expect((await run())?.applied).toBe('retry_scheduled');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
  });

  it('flags a payout the provider keeps pending for a day; staff may then settle it', async () => {
    const player = await fundedPlayer(birr(1_000));
    const { payout } = await withdraw(handle.db, player, birr(100));
    const provider = scriptedProvider({
      initiate: [() => Promise.resolve({ providerRef: `ref-${payout.id}`, status: 'pending' })],
      query: statusOf('pending'),
    });
    expect((await runWorker([payout.id], { now: T, provider }))[0]?.applied).toBe('pending');
    const [late] = await runWorker([payout.id], {
      now: new Date(T.getTime() + 24 * HOUR),
      provider,
    });
    expect(late).toMatchObject({
      applied: 'flagged',
      payout: { status: 'processing', flagReason: 'pending_too_long' },
    });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(900));
    const failed = await handle.db.transaction((tx) =>
      markPayoutFailed(tx, {
        payoutId: payout.id,
        reason: 'provider confirmed it was never paid',
        now: T,
        admin: { adminId: ADMIN },
      }),
    );
    expect(failed.payout.status).toBe('failed');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
  });

  it('lets staff flag a payout that is being processed, so they can settle it', async () => {
    const player = await fundedPlayer(birr(1_000), '9999');
    const { payout } = await withdraw(handle.db, player, birr(100));
    const [pending] = await runWorker([payout.id], { now: T });
    expect(pending?.applied).toBe('pending');
    const settle = () =>
      handle.db.transaction((tx) =>
        markPayoutPaid(tx, { payoutId: payout.id, now: T, admin: { adminId: ADMIN } }),
      );
    expect((await domainError(settle())).code).toBe('payout_in_progress');
    const flag = () =>
      handle.db.transaction((tx) =>
        flagPayoutForStaff(tx, {
          payoutId: payout.id,
          adminId: ADMIN,
          note: 'Provider support says it was paid',
          now: T,
        }),
      );
    expect(await flag()).toMatchObject({
      changed: true,
      payout: { status: 'processing', flagReason: 'staff_review', flaggedAt: T },
    });
    expect((await outboxOf(handle.db, payout.id)).at(-1)).toEqual([
      WITHDRAWAL_FLAGGED,
      expect.objectContaining({ reason: 'staff_review' }),
    ]);
    expect(await auditCount(handle.db, payout.id, WITHDRAWAL_FLAGGED)).toBe(1);
    expect((await flag()).changed).toBe(false);
    expect((await settle()).payout.status).toBe('paid');
    expect((await domainError(flag())).code).toBe('payout_already_closed');
  });
});

describe('deposits under review', () => {
  it('refuses a withdrawal while a deposit reversed at the provider waits for staff', async () => {
    const player = await createPlayer(handle.db);
    const intent = await depositViaMock(handle.db, player.userId, birr(1_000));
    // The provider reports the credited deposit failed (reversed or charged back).
    const provider = mockProvider();
    const reversal = await provider.verifyWebhook(
      provider.simulateDepositDecision({
        providerRef: intent.providerRef!,
        amount: intent.amount,
        decision: 'decline',
      }),
    );
    const flagged = await handle.db.transaction((tx) =>
      applyDepositEvent(tx, { provider: 'mock', event: reversal, now: NOW }),
    );
    expect(flagged).toMatchObject({ outcome: 'flagged', flagReason: 'failure_after_success' });
    const refused = await domainError(withdraw(handle.db, player, birr(100)));
    expect(refused).toMatchObject({ status: 409, code: 'deposit_under_review' });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));

    // Staff confirm the deposit stands: withdrawals work again.
    await handle.db.transaction((tx) =>
      resolveFlaggedDeposit(tx, {
        intentId: intent.id,
        adminId: ADMIN,
        resolution: 'close',
        note: 'The reversal notice was a provider error',
        now: NOW,
      }),
    );
    expect((await withdraw(handle.db, player, birr(100))).payout.status).toBe('approved');
  });
});

describe('settling by hand: guards and idempotency', () => {
  const paid = (payoutId: string, providerRef?: string) =>
    handle.db.transaction((tx) =>
      markPayoutPaid(tx, { payoutId, now: NOW, ...(providerRef ? { providerRef } : {}) }),
    );
  const failed = (payoutId: string) =>
    handle.db.transaction((tx) => markPayoutFailed(tx, { payoutId, reason: 'x', now: NOW }));

  it('refuses settling payouts that are not open, and repeats are no-ops', async () => {
    const player = await fundedPlayer(birr(10_000));
    const { payout: review } = await withdraw(handle.db, player, birr(6_000));
    expect((await domainError(paid(review.id))).code).toBe('payout_not_approved');
    expect(
      (
        await domainError(
          handle.db.transaction((tx) =>
            markPayoutProcessing(tx, { payoutId: review.id, now: NOW, checkAt: NOW }),
          ),
        )
      ).code,
    ).toBe('payout_not_processable');
    await handle.db.transaction((tx) =>
      rejectWithdrawal(tx, { payoutId: review.id, adminId: ADMIN, reason: 'no', now: NOW }),
    );
    expect((await domainError(paid(review.id))).code).toBe('payout_already_closed');
    expect((await domainError(failed(review.id))).code).toBe('payout_already_closed');

    const { payout } = await withdraw(handle.db, player, birr(100));
    expect((await paid(payout.id)).changed).toBe(true);
    expect((await paid(payout.id)).changed).toBe(false);
    expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(1);
    expect((await domainError(failed(payout.id))).code).toBe('payout_already_paid');
    expect(
      (
        await handle.db.transaction((tx) =>
          approveWithdrawal(tx, { payoutId: payout.id, adminId: ADMIN, now: NOW }),
        )
      ).changed,
    ).toBe(false);

    const { payout: toFail } = await withdraw(handle.db, player, birr(100));
    expect((await failed(toFail.id)).changed).toBe(true);
    expect((await failed(toFail.id)).changed).toBe(false);
    expect(await postingsWithKey(withdrawalReversalLedgerKey(toFail.id))).toBe(1);
  });

  it('refuses another provider reference for a payout that has one', async () => {
    const player = await fundedPlayer(birr(1_000), '9999');
    const { payout } = await withdraw(handle.db, player, birr(100));
    const [pending] = await runWorker([payout.id], { now: new Date('2026-10-17T10:00:00Z') });
    expect(pending?.payout.providerRef).toBe(`mockpay_p_${payout.id}`);
    expect(await domainError(paid(payout.id, 'another-reference'))).toMatchObject({
      status: 409,
      code: 'provider_ref_conflict',
    });
    expect((await paid(payout.id, `mockpay_p_${payout.id}`)).payout.status).toBe('paid');
  });
});

describe('queries and reconciliation', () => {
  it('lists the player’s payouts and hides other players’', async () => {
    const player = await fundedPlayer(birr(1_000));
    const other = await createPlayer(handle.db);
    const first = await withdraw(handle.db, player, birr(100), { now: NOW });
    const second = await withdraw(handle.db, player, birr(100), {
      now: new Date(NOW.getTime() + 60_000),
    });
    expect((await listUserPayouts(handle.db, player.userId)).map((p) => p.id)).toEqual([
      second.payout.id,
      first.payout.id,
    ]);
    expect(await getUserPayout(handle.db, other.userId, first.payout.id)).toBeNull();
    expect((await getUserPayout(handle.db, player.userId, first.payout.id))?.id).toBe(
      first.payout.id,
    );
    expect((await getPayout(handle.db, first.payout.id))?.amount).toBe(birr(100));
  });

  it('reconciles: books balance, the hold equals open payouts, reversals return exactly the hold', async () => {
    await expectBooksBalanced(handle.db);
    const reversed = await handle.db
      .select({ id: payouts.id, amount: payouts.amount, userId: payouts.userId })
      .from(payouts)
      .where(inArray(payouts.status, ['failed', 'rejected', 'cancelled']));
    expect(reversed.length).toBeGreaterThan(3);
    for (const payout of reversed) {
      expect(await postingsWithKey(withdrawalHoldLedgerKey(payout.id))).toBe(1);
      expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(1);
      expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(0);
    }
    const paid = await handle.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(eq(payouts.status, 'paid'));
    for (const payout of paid) {
      expect(await postingsWithKey(withdrawalReversalLedgerKey(payout.id))).toBe(0);
      expect(await postingsWithKey(withdrawalPaidLedgerKey(payout.id))).toBe(1);
    }
    // KYC rows exist for every payout's player (payouts only go out in a verified name).
    const [unverified] = await handle.db
      .select({ n: count() })
      .from(payouts)
      .leftJoin(kycProfiles, eq(kycProfiles.userId, payouts.userId))
      .where(and(eq(payouts.status, 'paid'), eq(kycProfiles.status, 'pending')));
    expect(unverified?.n).toBe(0);
  });
});
