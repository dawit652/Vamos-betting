import { randomBytes } from 'node:crypto';
import { birr } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStaffUser,
  getBalance,
  getDashboard,
  getPlayerDetail,
  getStaffBet,
  getStaffSettings,
  getStaffWithdrawal,
  listAuditLog,
  listBigBets,
  listKycQueue,
  listSelectionLiabilities,
  listStaffJackpotEntries,
  listStaffJackpotRounds,
  listStaffWithdrawals,
  markPayoutPaid,
  reviewKyc,
  searchBets,
  searchPlayers,
  settleEventBets,
  staffApproveWithdrawal,
  staffCancelJackpotRound,
  staffFlagPayout,
  staffRejectWithdrawal,
  staffSettlePayout,
  updateStaffSetting,
  type CatalogIds,
  type GameSettings,
  type PasswordHasher,
  type StaffActor,
} from '../src/index';
import {
  auditLog,
  jackpotEntries,
  jackpotRounds,
  kycProfiles,
  outboxEvents,
  users,
} from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { dropTestDatabase } from './helpers';
import { createGames, enter, openRound, settle as settleJackpot } from './jackpot-fixtures';
import {
  auditCount,
  cashOf,
  createPlayer,
  depositViaMock,
  domainError,
  expectBooksBalanced,
  outboxOf,
  rules,
  withdraw,
} from './payments-fixtures';

/** A fast stand-in for argon2 (these tests are not about passwords). */
const fakeHasher: PasswordHasher = {
  hash: async (password) => `plain:${password}`,
  verify: async (hash, password) => hash === `plain:${password}`,
};

async function staffMember(db: TestDb, role: 'admin' | 'finance' | 'kyc' | 'trader' = 'admin') {
  const created = await createStaffUser(
    {
      db: db.db,
      clock: () => new Date(),
      randomBytes,
      totpKey: Buffer.alloc(32, 1),
      passwords: fakeHasher,
    },
    {
      email: `${role}-${randomBytes(4).toString('hex')}@vamos.test`,
      displayName: `Test ${role}`,
      role,
      password: 'a long enough test password',
      actor: { type: 'system', via: 'test' },
    },
  );
  return created.user;
}

describe('dashboard, risk and bet search (figures from the fixtures)', () => {
  let handle: TestDb;
  let ids: CatalogIds;
  let settings: GameSettings;
  let t: Date;
  let e1: TestEvent;
  let e2: TestEvent;
  let a: { userId: string; phone: string };
  let b: { userId: string; phone: string };
  const betIds: Record<string, string> = {};

  beforeAll(async () => {
    ({ handle, ids, settings } = await createBettingDatabase());
    t = new Date();
    a = await createPlayer(handle.db);
    b = await createPlayer(handle.db);
    await handle.db.update(users).set({ fullName: 'Abebe Kebede' }).where(eq(users.id, a.userId));
    await depositViaMock(handle.db, a.userId, birr(500), { now: t });
    await depositViaMock(handle.db, b.userId, birr(300), { now: t });
    e1 = await createEvent(handle.db, ids);
    e2 = await createEvent(handle.db, ids);
    const single = (userId: string, selectionId: string, oddsMilli: number, stake: bigint) =>
      place(handle.db, userId, { stake, legs: [{ selectionId, oddsMilli }], settings });
    betIds.aHome = (await single(a.userId, e1.home, 2000, birr(100))).bet.id;
    betIds.aAway = (await single(a.userId, e1.away, 3500, birr(50))).bet.id;
    betIds.bDraw = (await single(b.userId, e2.draw, 3200, birr(20))).bet.id;
    betIds.bDouble = (
      await place(handle.db, b.userId, {
        stake: birr(10),
        legs: [
          { selectionId: e1.home, oddsMilli: 2000 },
          { selectionId: e2.home, oddsMilli: 2000 },
        ],
        settings,
      })
    ).bet.id;
    await finish(handle.db, e1.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, e1.eventId, new Date()));
    // A withdraws 100 ETB: approved by staff and paid; B's 50 ETB waits for review.
    const admin = await staffMember(handle);
    const paid = await withdraw(handle.db, a, birr(100), {
      now: t,
      rules: rules({ autoApproveBelow: 0n }),
    });
    await handle.db.transaction((tx) =>
      staffApproveWithdrawal(tx, {
        payoutId: paid.payout.id,
        actor: { adminId: admin.id },
        now: t,
      }),
    );
    await handle.db.transaction((tx) => markPayoutPaid(tx, { payoutId: paid.payout.id, now: t }));
    await withdraw(handle.db, b, birr(50), { now: t, rules: rules({ autoApproveBelow: 0n }) });
  });

  afterAll(async () => {
    await dropTestDatabase(handle);
  });

  it('sums turnover, GGR, open liabilities, payments and players by formula', async () => {
    const dashboard = await getDashboard(handle.db, {
      from: new Date(t.getTime() - 3_600_000),
      to: new Date(t.getTime() + 3_600_000),
    });
    // Placed: 100 + 50 + 20 + 10.
    expect(dashboard.betting.placed).toEqual({ count: 4, amount: birr(180) });
    expect(dashboard.betting.turnover).toBe(birr(180));
    // Settled: A's two singles. 100 at 2.00 won 200 gross (100 winnings taxed 20%), 50 lost.
    expect(dashboard.betting.settled).toEqual({ count: 2, amount: birr(150) });
    expect(dashboard.betting.payouts).toBe(birr(200));
    expect(dashboard.betting.taxWithheld).toBe(birr(20));
    expect(dashboard.betting.ggr).toBe(birr(150) - birr(200));
    // The house_revenue account moved by exactly the GGR (fresh database).
    expect(await getBalance(handle.db, { kind: 'house_revenue' })).toBe(dashboard.betting.ggr);
    // Open: B's single (20 at 3.20 → 64) and double (10 at 2.00 × 2.00 → 40), both untaxed.
    expect(dashboard.openLiabilities).toEqual({
      bets: 2,
      stakes: birr(30),
      potentialPayout: birr(104),
      potentialNetPayout: birr(104),
    });
    expect(await getBalance(handle.db, { kind: 'house_stakes' })).toBe(birr(30));
    expect(dashboard.payments).toEqual({
      deposits: { count: 2, amount: birr(800) },
      withdrawals: { count: 1, amount: birr(100) },
      openWithdrawals: { count: 1, amount: birr(50) },
      awaitingReview: 1,
      flaggedWithdrawals: 0,
      flaggedDeposits: 0,
    });
    expect(dashboard.players).toEqual({ registered: 2, active: 2 });
    expect(dashboard.jackpots.entries).toEqual({ count: 0, amount: 0n });

    // A window before any of it is empty.
    const before = await getDashboard(handle.db, {
      from: new Date(t.getTime() - 10 * 3_600_000),
      to: new Date(t.getTime() - 5 * 3_600_000),
    });
    expect(before.betting.placed).toEqual({ count: 0, amount: 0n });
    expect(before.payments.deposits).toEqual({ count: 0, amount: 0n });
    // Open liabilities are "now", whatever the window.
    expect(before.openLiabilities.stakes).toBe(birr(30));
    await expect(getDashboard(handle.db, { from: t, to: t })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_range',
    });
  });

  it('lists the liability per selection over the open legs, largest first', async () => {
    const rows = await listSelectionLiabilities(handle.db);
    // E1's home leg of the double is won already: only open legs count.
    expect(rows.map((row) => [row.selectionId, row.bets, row.stake, row.liability])).toEqual([
      [e2.draw, 1, birr(20), birr(64)],
      [e2.home, 1, birr(10), birr(40)],
    ]);
    expect(rows[0]).toMatchObject({
      code: 'X',
      marketId: e2.marketIds['1x2'],
      eventId: e2.eventId,
      singlesStake: birr(20),
      singlesLiability: birr(64),
    });
    expect(rows[1]).toMatchObject({ singlesStake: 0n, singlesLiability: 0n });
    expect(await listSelectionLiabilities(handle.db, { eventId: e1.eventId })).toEqual([]);
    const big = await listSelectionLiabilities(handle.db, { minLiability: birr(50) });
    expect(big.map((row) => row.selectionId)).toEqual([e2.draw]);
  });

  it('lists big open bets over either threshold', async () => {
    const page = await listBigBets(handle.db, {
      minStake: birr(15),
      minPotentialPayout: birr(1_000),
    });
    expect(page.items.map((bet) => bet.id)).toEqual([betIds.bDraw]);
    const byPayout = await listBigBets(handle.db, {
      minStake: birr(1_000),
      minPotentialPayout: birr(40),
    });
    expect(new Set(byPayout.items.map((bet) => bet.id))).toEqual(
      new Set([betIds.bDraw, betIds.bDouble]),
    );
  });

  it('searches bets by player, phone, short id, status and event, with paging', async () => {
    const byUser = await searchBets(handle.db, { userId: a.userId });
    expect(new Set(byUser.items.map((bet) => bet.id))).toEqual(
      new Set([betIds.aHome, betIds.aAway]),
    );
    const open = await searchBets(handle.db, { statuses: ['open'] });
    expect(new Set(open.items.map((bet) => bet.id))).toEqual(
      new Set([betIds.bDraw, betIds.bDouble]),
    );
    const local = `0${b.phone.slice(4)}`;
    expect((await searchBets(handle.db, { phone: local })).items).toHaveLength(2);
    const target = await getStaffBet(handle.db, betIds.bDouble);
    expect(target).toMatchObject({ phone: b.phone, userId: b.userId });
    expect(target?.legs).toHaveLength(2);
    const byShortId = await searchBets(handle.db, { shortId: target!.shortId.toLowerCase() });
    expect(byShortId.items.map((bet) => bet.id)).toEqual([betIds.bDouble]);
    expect(byShortId.items[0]).toMatchObject({ legCount: 2, stake: birr(10), status: 'open' });
    const onEvent = await searchBets(handle.db, { eventId: e2.eventId });
    expect(onEvent.items).toHaveLength(2);
    const first = await searchBets(handle.db, { limit: 3 });
    expect(first.items).toHaveLength(3);
    const rest = await searchBets(handle.db, { limit: 3, cursor: first.nextCursor! });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const all = [...first.items, ...rest.items].map((bet) => bet.id);
    expect(new Set(all).size).toBe(4);
    expect((await searchBets(handle.db, { phone: 'not a phone' })).items).toEqual([]);
    await expect(searchBets(handle.db, { cursor: 'garbage' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_cursor',
    });
  });

  it('finds players and shows one in detail', async () => {
    expect(
      (await searchPlayers(handle.db, { q: a.phone.slice(-6) })).items.map((p) => p.id),
    ).toEqual([a.userId]);
    expect((await searchPlayers(handle.db, { q: 'abebe' })).items.map((p) => p.id)).toEqual([
      a.userId,
    ]);
    expect((await searchPlayers(handle.db, { q: a.userId })).items).toHaveLength(1);
    const verified = await searchPlayers(handle.db, { kycStatus: 'verified' });
    expect(verified.items).toHaveLength(2);
    // Cash: deposited 500, staked 150, won 180 net, withdrew 100.
    expect(verified.items.find((p) => p.id === a.userId)?.cash).toBe(birr(430));
    const detail = await getPlayerDetail(handle.db, a.userId, new Date());
    expect(detail).toMatchObject({
      phone: a.phone,
      fullName: 'Abebe Kebede',
      status: 'active',
      balances: { cash: birr(430), bonus: 0n },
      kyc: { status: 'verified' },
      openBets: { count: 0, stake: 0n },
      activeExclusion: null,
    });
    expect(detail?.recentBets.map((bet) => bet.id).sort()).toEqual(
      [betIds.aHome, betIds.aAway].sort(),
    );
    expect(detail?.recentPayments.map((payment) => payment.kind).sort()).toEqual([
      'deposit',
      'withdrawal',
    ]);
    expect(detail?.recentTransactions.length).toBeGreaterThanOrEqual(5);
    expect(detail?.limits.deposit.day).toEqual({ active: null, pending: null });
    expect(
      await getPlayerDetail(handle.db, '00000000-0000-4000-8000-000000000000', new Date()),
    ).toBeNull();
  });
});

describe('KYC review, withdrawals, jackpots and the audit log', () => {
  let handle: TestDb;
  let ids: CatalogIds;
  let actor: StaffActor;
  let adminEmail: string;

  beforeAll(async () => {
    ({ handle, ids } = await createBettingDatabase());
    const admin = await staffMember(handle, 'admin');
    actor = { adminId: admin.id, ip: '10.9.8.7' };
    adminEmail = admin.email;
  });

  afterAll(async () => {
    await dropTestDatabase(handle);
  });

  it('approves and rejects pending KYC profiles, with the staff member in the audit log', async () => {
    const c = await createPlayer(handle.db, { kyc: 'pending' });
    const d = await createPlayer(handle.db, { kyc: 'pending' });
    const queue = await listKycQueue(handle.db);
    expect(queue.items.map((item) => item.userId)).toEqual([c.userId, d.userId]);
    expect(queue.items[0]).toMatchObject({ phone: c.phone, status: 'pending' });

    const approved = await handle.db.transaction((tx) =>
      reviewKyc(tx, { userId: c.userId, decision: 'approve', actor, now: new Date() }),
    );
    expect(approved).toMatchObject({
      changed: true,
      profile: {
        status: 'verified',
        verifiedName: 'Abebe Kebede',
        verifiedDateOfBirth: '1990-01-01',
      },
    });
    expect(await auditCount(handle.db, c.userId, 'kyc.approved')).toBe(1);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'kyc.approved'), eq(auditLog.targetId, c.userId)));
    expect(audit).toMatchObject({ actorType: 'admin', actorId: actor.adminId, ip: '10.9.8.7' });
    expect((await outboxOf(handle.db, c.userId)).map(([type]) => type)).toEqual([
      'kyc.status_changed',
    ]);
    // The same decision again changes nothing; another decision is refused.
    const again = await handle.db.transaction((tx) =>
      reviewKyc(tx, { userId: c.userId, decision: 'approve', actor, now: new Date() }),
    );
    expect(again.changed).toBe(false);
    expect(await auditCount(handle.db, c.userId, 'kyc.approved')).toBe(1);
    await expect(
      handle.db.transaction((tx) =>
        reviewKyc(tx, {
          userId: c.userId,
          decision: 'reject',
          reason: 'x',
          actor,
          now: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'kyc_not_pending' });

    await expect(
      handle.db.transaction((tx) =>
        reviewKyc(tx, {
          userId: d.userId,
          decision: 'reject',
          reason: ' ',
          actor,
          now: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'reason_required' });
    const rejected = await handle.db.transaction((tx) =>
      reviewKyc(tx, {
        userId: d.userId,
        decision: 'reject',
        reason: 'The photo does not match the ID',
        actor,
        now: new Date(),
      }),
    );
    expect(rejected.profile).toMatchObject({
      status: 'rejected',
      rejectionReason: 'The photo does not match the ID',
    });
    expect(await auditCount(handle.db, d.userId, 'kyc.rejected')).toBe(1);
    expect((await listKycQueue(handle.db)).items).toEqual([]);
    expect(
      (await listKycQueue(handle.db, { status: 'rejected' })).items.map((i) => i.userId),
    ).toEqual([d.userId]);

    // A player under 21 cannot be approved.
    const young = await createPlayer(handle.db, { kyc: 'pending', name: null });
    await handle.db
      .update(users)
      .set({ dateOfBirth: '2010-01-01' })
      .where(eq(users.id, young.userId));
    await expect(
      handle.db.transaction((tx) =>
        reviewKyc(tx, { userId: young.userId, decision: 'approve', actor, now: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'kyc_underage' });
    const [profile] = await handle.db
      .select({ status: kycProfiles.status })
      .from(kycProfiles)
      .where(eq(kycProfiles.userId, young.userId));
    expect(profile?.status).toBe('pending');
  });

  it('approves, rejects, flags and fails withdrawals through the Phase 6 services', async () => {
    const player = await createPlayer(handle.db);
    const now = new Date();
    await depositViaMock(handle.db, player.userId, birr(1_000), { now });
    const review = rules({ autoApproveBelow: 0n });
    const first = await withdraw(handle.db, player, birr(300), { now, rules: review });
    const second = await withdraw(handle.db, player, birr(200), { now, rules: review });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(500));

    const queue = await listStaffWithdrawals(handle.db, { statuses: ['requested'] });
    expect(queue.items.map((item) => item.id)).toEqual([first.payout.id, second.payout.id]);
    expect(queue.items[0]?.player).toEqual({
      phone: player.phone,
      fullName: null,
      status: 'active',
      kycStatus: 'verified',
    });

    const approved = await handle.db.transaction((tx) =>
      staffApproveWithdrawal(tx, { payoutId: first.payout.id, actor, now }),
    );
    expect(approved).toMatchObject({
      changed: true,
      payout: { status: 'approved', approvedBy: actor.adminId },
    });
    expect(await auditCount(handle.db, first.payout.id, 'payment.withdrawal_approved')).toBe(1);
    const repeat = await handle.db.transaction((tx) =>
      staffApproveWithdrawal(tx, { payoutId: first.payout.id, actor, now }),
    );
    expect(repeat.changed).toBe(false);
    expect(
      (await outboxOf(handle.db, first.payout.id)).filter(
        ([type]) => type === 'payment.withdrawal_approved',
      ),
    ).toHaveLength(1);

    expect(
      await domainError(
        handle.db.transaction((tx) =>
          staffRejectWithdrawal(tx, { payoutId: second.payout.id, reason: '', actor, now }),
        ),
      ),
    ).toMatchObject({ status: 422, code: 'reason_required' });
    const rejected = await handle.db.transaction((tx) =>
      staffRejectWithdrawal(tx, {
        payoutId: second.payout.id,
        reason: 'Name on the wallet does not match',
        actor,
        now,
      }),
    );
    expect(rejected.payout).toMatchObject({ status: 'rejected', closedBy: actor.adminId });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(700));
    const [rejectAudit] = await handle.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'payment.withdrawal_rejected'),
          eq(auditLog.targetId, second.payout.id),
        ),
      );
    expect(rejectAudit).toMatchObject({ actorType: 'admin', actorId: actor.adminId });

    // Finance takes the approved payout over and settles it as failed: the hold goes back.
    await handle.db.transaction((tx) =>
      staffFlagPayout(tx, {
        payoutId: first.payout.id,
        note: 'Provider support ticket 123',
        actor,
        now,
      }),
    );
    const flagged = await listStaffWithdrawals(handle.db, { flagged: true });
    expect(flagged.items.map((item) => item.id)).toEqual([first.payout.id]);
    expect(flagged.items[0]?.flagReason).toBe('staff_review');
    expect(
      await domainError(
        handle.db.transaction((tx) =>
          staffSettlePayout(tx, { payoutId: first.payout.id, outcome: 'failed', actor, now }),
        ),
      ),
    ).toMatchObject({ status: 422, code: 'reason_required' });
    const failed = await handle.db.transaction((tx) =>
      staffSettlePayout(tx, {
        payoutId: first.payout.id,
        outcome: 'failed',
        reason: 'Provider confirmed nothing was sent',
        actor,
        now,
      }),
    );
    expect(failed.payout.status).toBe('failed');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    expect(await getStaffWithdrawal(handle.db, first.payout.id)).toMatchObject({
      status: 'failed',
      player: { phone: player.phone },
    });
    expect(await getStaffWithdrawal(handle.db, 'nope')).toBeNull();
    expect(
      await domainError(
        handle.db.transaction((tx) => staffApproveWithdrawal(tx, { payoutId: 'nope', actor, now })),
      ),
    ).toMatchObject({ status: 404 });
    await expectBooksBalanced(handle.db);
  });

  it('cancels a jackpot round before kick-off and refunds every entry through settlement', async () => {
    const player = await createPlayer(handle.db);
    await depositViaMock(handle.db, player.userId, birr(100), { now: new Date() });
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + 2 * 3_600_000));
    const round = await openRound(handle.db, games);
    const before = await cashOf(handle.db, player.userId);
    const jackpotBefore = await getBalance(handle.db, { kind: 'house_jackpot' });
    const entry = await enter(handle.db, player.userId, round.id, [['1', 'X'], ['X'], ['2']]);
    expect(await cashOf(handle.db, player.userId)).toBe(before - birr(20));

    await expect(
      handle.db.transaction((tx) =>
        staffCancelJackpotRound(tx, { roundId: round.id, reason: ' ', actor, now: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'reason_required' });
    // After the first kick-off it is too late.
    await expect(
      handle.db.transaction((tx) =>
        staffCancelJackpotRound(tx, {
          roundId: round.id,
          reason: 'too late',
          actor,
          now: new Date(round.closesAt.getTime() + 60_000),
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'jackpot_round_not_cancellable' });

    const cancelled = await handle.db.transaction((tx) =>
      staffCancelJackpotRound(tx, {
        roundId: round.id,
        reason: 'Fixture list changed',
        actor,
        now: new Date(),
      }),
    );
    expect(cancelled).toEqual({
      outcome: 'cancelled',
      status: 'closed',
      entries: 1,
      refunds: birr(20),
    });
    expect(await auditCount(handle.db, round.id, 'jackpot.round_cancelled')).toBe(1);
    const listed = await listStaffJackpotRounds(handle.db);
    const shown = listed.items.find((item) => item.id === round.id);
    expect(shown).toMatchObject({
      status: 'closed',
      entries: 1,
      stakes: birr(20),
      openEntries: 1,
      decision: { void: true, voidReason: 'cancelled_by_staff', refunds: birr(20) },
    });

    await settleJackpot(handle.db, round.id);
    const [row] = await handle.db
      .select()
      .from(jackpotRounds)
      .where(eq(jackpotRounds.id, round.id));
    expect(row?.status).toBe('cancelled');
    const [entryRow] = await handle.db
      .select()
      .from(jackpotEntries)
      .where(eq(jackpotEntries.id, entry.entry.id));
    expect(entryRow?.status).toBe('void');
    expect(await cashOf(handle.db, player.userId)).toBe(before);
    expect(await getBalance(handle.db, { kind: 'house_jackpot' })).toBe(jackpotBefore);
    const entries = await listStaffJackpotEntries(handle.db, round.id);
    expect(entries.items).toMatchObject([
      { id: entry.entry.id, phone: player.phone, status: 'void' },
    ]);

    const again = await handle.db.transaction((tx) =>
      staffCancelJackpotRound(tx, { roundId: round.id, reason: 'again', actor, now: new Date() }),
    );
    expect(again.outcome).toBe('unchanged');

    // Without entries the round is cancelled at once.
    const empty = await openRound(
      handle.db,
      await createGames(handle.db, ids, 3, new Date(Date.now() + 5 * 3_600_000)),
    );
    const result = await handle.db.transaction((tx) =>
      staffCancelJackpotRound(tx, {
        roundId: empty.id,
        reason: 'No interest',
        actor,
        now: new Date(),
      }),
    );
    expect(result).toEqual({ outcome: 'cancelled', status: 'cancelled', entries: 0, refunds: 0n });
    await expectBooksBalanced(handle.db);
  });

  it('shows the audit log newest first, filtered, paged and with the staff member', async () => {
    const all = await listAuditLog(handle.db, { actorId: actor.adminId });
    expect(all.items.length).toBeGreaterThan(5);
    expect(all.items[0]?.actorEmail).toBe(adminEmail);
    const ids_ = all.items.map((item) => BigInt(item.id));
    expect([...ids_].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))).toEqual(ids_);

    const payments = await listAuditLog(handle.db, { action: 'payment.*' });
    expect(payments.items.length).toBeGreaterThan(0);
    expect(payments.items.every((item) => item.action.startsWith('payment.'))).toBe(true);
    const exact = await listAuditLog(handle.db, { action: 'kyc.approved' });
    expect(exact.items.every((item) => item.action === 'kyc.approved')).toBe(true);
    expect(exact.items[0]).toMatchObject({ actorType: 'admin', actorName: 'Test admin' });

    const first = await listAuditLog(handle.db, { actorId: actor.adminId, limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await listAuditLog(handle.db, {
      actorId: actor.adminId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(BigInt(second.items[0]!.id)).toBeLessThan(BigInt(first.items[1]!.id));
    await expect(listAuditLog(handle.db, { cursor: 'not-a-cursor!' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_cursor',
    });
    const none = await listAuditLog(handle.db, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 7_200_000),
    });
    expect(none.items).toEqual([]);
  });
});

describe('settings', () => {
  let handle: TestDb;
  let actor: StaffActor;

  beforeAll(async () => {
    ({ handle } = await createBettingDatabase());
    actor = { adminId: (await staffMember(handle, 'admin')).id };
  });

  afterAll(async () => {
    await dropTestDatabase(handle);
  });

  it('validates each setting, stores it and audits the change', async () => {
    const before = (await getStaffSettings(handle.db)).settings.tax;
    const updated = await handle.db.transaction((tx) =>
      updateStaffSetting(tx, {
        key: 'tax',
        value: { rateBps: 1_500, base: 'net_winnings', exemptBelow: '5000' },
        actor,
      }),
    );
    expect(updated.tax).toEqual({ rateBps: 1_500, base: 'net_winnings', exemptBelow: 5_000n });
    const view = await getStaffSettings(handle.db);
    expect(view.settings.tax.rateBps).toBe(1_500);
    expect(view.changes.find((change) => change.key === 'tax')?.updatedBy).toBe(actor.adminId);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'settings.updated'), eq(auditLog.targetId, 'tax')));
    expect(audit).toMatchObject({ actorType: 'admin', actorId: actor.adminId });
    expect(audit?.metadata).toEqual({
      key: 'tax',
      before: {
        rateBps: before.rateBps,
        base: before.base,
        exemptBelow: before.exemptBelow.toString(),
      },
      after: { rateBps: 1_500, base: 'net_winnings', exemptBelow: '5000' },
    });

    const delay = await handle.db.transaction((tx) =>
      updateStaffSetting(tx, { key: 'live_bet_delay_ms', value: 4_000, actor }),
    );
    expect(delay.liveBetDelayMs).toBe(4_000);
    const ladder = await handle.db.transaction((tx) =>
      updateStaffSetting(tx, {
        key: 'multi_bonus',
        value: {
          enabled: true,
          minLegOddsMilli: 1_300,
          maxBonus: '1000000',
          tiers: [
            { minLegs: 3, percentBps: 500 },
            { minLegs: 5, percentBps: 1_000 },
          ],
        },
        actor,
      }),
    );
    expect(ladder.multiBonus.tiers).toHaveLength(2);
    const minAge = await handle.db.transaction((tx) =>
      updateStaffSetting(tx, { key: 'responsible_gambling', value: { minAge: 25 }, actor }),
    );
    expect(minAge.responsibleGambling.minAge).toBe(25);
  });

  it('refuses invalid values with the issues and writes nothing', async () => {
    const auditsBefore = (
      await handle.db.select().from(auditLog).where(eq(auditLog.action, 'settings.updated'))
    ).length;
    const cases: Array<[Parameters<typeof updateStaffSetting>[1]['key'], unknown]> = [
      ['tax', { rateBps: 20_000, base: 'net_winnings', exemptBelow: '0' }],
      ['tax', { rateBps: 1_000, base: 'net_winnings', exemptBelow: '-1' }],
      [
        'bet_rules',
        {
          minStake: '100000',
          maxStake: '500',
          maxPayout: '50000000',
          maxLegs: 40,
          minLegOddsMilli: 1_010,
          maxTotalOddsMilli: '1000000000',
        },
      ],
      ['responsible_gambling', { minAge: 18 }],
      ['live_bet_delay_ms', -1],
      ['cash_out', { enabled: true, marginBps: 500 }],
      ['jackpot_template', { code: 'monthly' }],
      ['payments', null],
    ];
    for (const [key, value] of cases) {
      const error = await domainError(
        handle.db.transaction((tx) => updateStaffSetting(tx, { key, value, actor })),
      );
      expect(error.status, key).toBe(422);
      expect(error.code, key).toBe('invalid_setting');
      expect((error.details as { issues: string[] }).issues.length, key).toBeGreaterThan(0);
    }
    expect(
      await domainError(
        handle.db.transaction((tx) =>
          updateStaffSetting(tx, { key: 'nope' as never, value: {}, actor }),
        ),
      ),
    ).toMatchObject({ status: 422, code: 'invalid_setting' });
    const auditsAfter = (
      await handle.db.select().from(auditLog).where(eq(auditLog.action, 'settings.updated'))
    ).length;
    expect(auditsAfter).toBe(auditsBefore);
    expect((await getStaffSettings(handle.db)).settings.responsibleGambling.minAge).toBe(25);
    const outbox = await handle.db.select().from(outboxEvents);
    expect(outbox.filter((row) => row.type.startsWith('settings'))).toEqual([]);
  });
});
