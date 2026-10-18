import { birr, DEFAULT_AML_RULES, toWire, type AmlRules } from '@vamos/core';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AML_FLAG_RAISED,
  DEPOSIT_SUCCEEDED,
  evaluateAmlForEvent,
  evaluateAmlForUser,
  getAmlFlag,
  listAmlFlags,
  loadComplianceSettings,
  requestWithdrawal,
  reviewAmlFlag,
  runAmlSweep,
  updateComplianceSetting,
  WITHDRAWAL_HELD,
  type GameSettings,
} from '../src/index';
import { amlFlags, auditLog, outboxEvents, payouts } from '../src/schema/index';
import { createBettingDatabase, createEvent, place, type TestDb } from './betting-fixtures';
import { dropTestDatabase, errorText, pgCode } from './helpers';
import {
  createPlayer,
  depositViaMock,
  domainError,
  idemKey,
  NOW,
  rules,
} from './payments-fixtures';

/**
 * AML rules on real deposits, bets and withdrawals: each rule fires once
 * per window and not below its threshold; a high-severity flag holds the
 * player's withdrawals for staff until compliance closes it.
 */

let handle: TestDb;
let settings: GameSettings;
let catalog: Awaited<ReturnType<typeof createBettingDatabase>>['ids'];
const MIN = 60_000;
const HOUR = 60 * MIN;
const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };
const T0 = NOW; // 2026-10-10 12:00 in Addis Ababa

type Player = { userId: string; phone: string };

const after = (ms: number) => new Date(T0.getTime() + ms);

function request(player: Player, amount: bigint, now: Date, amlRules?: AmlRules) {
  return handle.db.transaction((tx) =>
    requestWithdrawal(tx, {
      userId: player.userId,
      amount,
      phone: player.phone,
      provider: 'mock',
      idempotencyKey: idemKey('wd'),
      now,
      rules: rules(),
      ...(amlRules === undefined ? {} : { amlRules }),
    }),
  );
}

function evaluate(player: Player, now: Date) {
  return handle.db.transaction((tx) =>
    evaluateAmlForUser(tx, { userId: player.userId, now, source: 'event' }),
  );
}

async function flagsOf(player: Player) {
  return handle.db
    .select()
    .from(amlFlags)
    .where(eq(amlFlags.userId, player.userId))
    .orderBy(amlFlags.createdAt);
}

beforeAll(async () => {
  ({ handle, settings, ids: catalog } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

describe('velocity', () => {
  it('fires once per window, and not at the threshold', async () => {
    const player = await createPlayer(handle.db);
    for (let i = 0; i < 5; i += 1) {
      await depositViaMock(handle.db, player.userId, birr(100), { now: after(i * 10 * MIN) });
    }
    expect((await evaluate(player, after(45 * MIN))).created).toEqual([]);

    await depositViaMock(handle.db, player.userId, birr(100), { now: after(50 * MIN) });
    const fired = await evaluate(player, after(50 * MIN));
    expect(fired.created).toHaveLength(1);
    expect(fired.created[0]).toMatchObject({
      rule: 'deposit_velocity',
      severity: 'medium',
      windowKey: '2026-10-10',
      status: 'open',
      triggeredAt: after(50 * MIN),
      details: { window: 'hour', count: 6, max: 5 },
    });
    // A medium flag holds nothing.
    expect(fired.holdWithdrawals).toBe(false);
    const flagId = fired.created[0]!.id;
    const raised = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, AML_FLAG_RAISED), eq(outboxEvents.aggregateId, flagId)));
    expect(raised).toHaveLength(1);
    const audits = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, flagId));
    expect(audits.map((row) => row.action)).toEqual(['aml.flag_raised']);

    // More deposits in the same window, and the event consumer, add nothing.
    await depositViaMock(handle.db, player.userId, birr(100), { now: after(56 * MIN) });
    expect((await evaluate(player, after(57 * MIN))).created).toEqual([]);
    const viaEvent = await evaluateAmlForEvent(handle.db, {
      type: DEPOSIT_SUCCEEDED,
      payload: { userId: player.userId },
      now: after(58 * MIN),
    });
    expect(viaEvent?.created).toEqual([]);
    expect(await flagsOf(player)).toHaveLength(1);
    expect(
      await evaluateAmlForEvent(handle.db, {
        type: 'bet.placed',
        payload: { userId: player.userId },
        now: T0,
      }),
    ).toBeNull();
  });
});

describe('deposit then withdraw', () => {
  it('holds a withdrawal of a deposit that was barely played, until compliance closes the flag', async () => {
    const player = await createPlayer(handle.db);
    const deposit = await depositViaMock(handle.db, player.userId, birr(2_000), { now: T0 });
    const first = await request(player, birr(1_500), after(HOUR), DEFAULT_AML_RULES);
    expect(first.payout).toMatchObject({ status: 'requested', reviewReason: 'aml_review' });
    const [flag] = await flagsOf(player);
    expect(flag).toMatchObject({
      rule: 'deposit_then_withdraw',
      severity: 'high',
      windowKey: `deposit:${deposit.id}`,
      source: 'withdrawal',
      details: {
        deposit: toWire(birr(2_000)),
        stakesSince: '0',
        payoutId: first.payout.id,
      },
    });

    // Without the rules, the open high flag still sends withdrawals to staff.
    const second = await request(player, birr(100), after(HOUR + MIN));
    expect(second.payout).toMatchObject({ status: 'requested', reviewReason: 'aml_review' });
    const detail = await getAmlFlag(handle.db, flag!.id);
    expect(detail.heldWithdrawals.sort()).toEqual([first.payout.id, second.payout.id].sort());

    const reviewed = await handle.db.transaction((tx) =>
      reviewAmlFlag(tx, {
        flagId: flag!.id,
        decision: 'dismissed',
        note: 'Deposit refunded at the player request; no concern.',
        actor: STAFF,
        now: after(2 * HOUR),
      }),
    );
    expect(reviewed).toMatchObject({
      changed: true,
      flag: { status: 'dismissed', reviewedBy: STAFF.adminId },
    });
    // Closed: the same deposit is not flagged again, and small withdrawals are automatic again.
    const third = await request(player, birr(100), after(2 * HOUR + MIN), DEFAULT_AML_RULES);
    expect(third.payout).toMatchObject({ status: 'approved', reviewReason: null });
    expect(await flagsOf(player)).toHaveLength(1);
  });

  it('does not fire when enough of the deposit was staked', async () => {
    const player = await createPlayer(handle.db);
    await depositViaMock(handle.db, player.userId, birr(2_000), { now: T0 });
    const event = await createEvent(handle.db, catalog);
    await place(handle.db, player.userId, {
      stake: birr(1_000),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
      now: after(10 * MIN),
    });
    const result = await request(player, birr(500), after(HOUR), DEFAULT_AML_RULES);
    expect(result.payout).toMatchObject({ status: 'approved', reviewReason: null });
    expect(await flagsOf(player)).toEqual([]);
  });
});

describe('structuring', () => {
  it('raises a high flag and sends approved withdrawals not yet sent back to review', async () => {
    const player = await createPlayer(handle.db);
    await depositViaMock(handle.db, player.userId, birr(500), { now: T0 });
    const approved = await request(player, birr(100), after(5 * MIN));
    expect(approved.payout.status).toBe('approved');

    await depositViaMock(handle.db, player.userId, birr(95_000), { now: after(HOUR) });
    expect((await evaluate(player, after(HOUR))).created).toEqual([]);
    await depositViaMock(handle.db, player.userId, birr(95_000), { now: after(2 * HOUR) });
    const outcome = await evaluateAmlForEvent(handle.db, {
      type: DEPOSIT_SUCCEEDED,
      payload: { userId: player.userId },
      now: after(2 * HOUR),
    });
    expect(outcome?.created.map((flag) => [flag.rule, flag.severity])).toEqual([
      ['structuring', 'high'],
    ]);
    // Two deposits just below the threshold within 24 hours (the small one counts in the total).
    expect(outcome?.created[0]?.details).toMatchObject({
      reason: 'near_threshold',
      nearCount: 2,
      count: 3,
      total: toWire(birr(190_500)),
    });
    expect(outcome?.held).toEqual([approved.payout.id]);
    expect(outcome?.holdWithdrawals).toBe(true);
    const [held] = await handle.db.select().from(payouts).where(eq(payouts.id, approved.payout.id));
    expect(held).toMatchObject({
      status: 'requested',
      reviewReason: 'aml_review',
      approvedBy: null,
      approvedAt: null,
    });
    const events = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, WITHDRAWAL_HELD), eq(outboxEvents.aggregateId, held!.id)));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ rule: 'structuring', userId: player.userId });
  });
});

describe('the sweep, reviews and settings', () => {
  it('re-evaluates recent players without repeating flags', async () => {
    const before = await handle.db.select({ id: amlFlags.id }).from(amlFlags);
    const swept = await runAmlSweep(handle.db, { now: after(3 * HOUR) });
    expect(swept.evaluated).toBeGreaterThanOrEqual(4);
    expect(swept.flagged).toBe(0);
    expect(await handle.db.select({ id: amlFlags.id }).from(amlFlags)).toHaveLength(before.length);
  });

  it('moves a flag open → escalated → reviewed, and keeps it closed', async () => {
    const [flag] = await handle.db
      .select()
      .from(amlFlags)
      .where(and(eq(amlFlags.rule, 'deposit_velocity'), eq(amlFlags.status, 'open')));
    const review = (decision: 'reviewed' | 'dismissed' | 'escalated', note = 'checked') =>
      handle.db.transaction((tx) =>
        reviewAmlFlag(tx, { flagId: flag!.id, decision, note, actor: STAFF, now: after(4 * HOUR) }),
      );
    expect((await domainError(review('escalated', '  '))).code).toBe('note_required');
    expect(await review('escalated')).toMatchObject({
      changed: true,
      flag: { status: 'escalated' },
    });
    expect((await review('escalated')).changed).toBe(false);
    expect(await review('reviewed')).toMatchObject({ changed: true, flag: { status: 'reviewed' } });
    expect(await domainError(review('dismissed'))).toMatchObject({
      status: 409,
      code: 'aml_flag_closed',
    });
    const audits = await handle.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, flag!.id), eq(auditLog.action, 'aml.flag_reviewed')));
    expect(audits.map((row) => (row.metadata as { to: string }).to)).toEqual([
      'escalated',
      'reviewed',
    ]);

    const open = await listAmlFlags(handle.db, { status: ['open'] });
    expect(open.items.every((item) => item.status === 'open')).toBe(true);
    expect(open.items.some((item) => item.rule === 'structuring')).toBe(true);
    const page = await listAmlFlags(handle.db, { limit: 1 });
    expect(page.items).toHaveLength(1);
    const next = await listAmlFlags(handle.db, { limit: 1, cursor: page.nextCursor! });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);

    for (const statement of [
      sql`UPDATE aml_flags SET rule = 'other' WHERE id = ${flag!.id}`,
      sql`UPDATE aml_flags SET status = 'open', reviewed_by = NULL, reviewed_at = NULL WHERE id = ${flag!.id}`,
      sql`DELETE FROM aml_flags WHERE id = ${flag!.id}`,
    ]) {
      const error = await handle.db.execute(statement).catch((caught: unknown) => caught);
      expect(pgCode(error), errorText(error)).toBe('23001');
    }
  });

  it('reads and validates the aml_rules setting, and can switch the rules off', async () => {
    const invalid = await domainError(
      handle.db.transaction((tx) =>
        updateComplianceSetting(tx, {
          key: 'aml_rules',
          value: { ...DEFAULT_AML_RULES, structuring: { reportingThreshold: '0' } },
          actor: STAFF,
        }),
      ),
    );
    expect(invalid).toMatchObject({ status: 422, code: 'invalid_setting' });
    const updated = await handle.db.transaction((tx) =>
      updateComplianceSetting(tx, {
        key: 'aml_rules',
        value: { ...DEFAULT_AML_RULES, enabled: false },
        actor: STAFF,
      }),
    );
    expect(updated.amlRules.enabled).toBe(false);
    expect(updated.amlRules.structuring.reportingThreshold).toBe(birr(100_000));
    const player = await createPlayer(handle.db);
    for (let i = 0; i < 7; i += 1) {
      await depositViaMock(handle.db, player.userId, birr(100), { now: after(i * MIN) });
    }
    expect((await evaluate(player, after(10 * MIN))).created).toEqual([]);
    expect((await runAmlSweep(handle.db, { now: after(10 * MIN) })).evaluated).toBe(0);

    const commission = await handle.db.transaction((tx) =>
      updateComplianceSetting(tx, {
        key: 'els_commission',
        value: { rateBps: 1200 },
        actor: STAFF,
      }),
    );
    expect(commission.elsCommission.rateBps).toBe(1200);
    expect((await loadComplianceSettings(handle.db)).elsCommission.rateBps).toBe(1200);
  });
});
