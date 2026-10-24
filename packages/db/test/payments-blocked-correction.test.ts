import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveWithdrawal,
  settleEventBets,
  settlePlacedBet,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { bets } from '../src/schema/betting';
import { payouts } from '../src/schema/payments';
import { outboxEvents } from '../src/schema/platform';
import { createBettingDatabase, createEvent, finish, place, type TestDb } from './betting-fixtures';
import { dropTestDatabase, fund } from './helpers';
import { cashOf, createPlayer, domainError, rules, withdraw } from './payments-fixtures';

/**
 * A settlement correction that would overdraw the player is blocked
 * (settlement_retry_at, retried by the sweep). While it is blocked the
 * player must not be able to take money out, or the house never recovers
 * the wrongly paid winnings.
 */
let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const ADMIN = '00000000-0000-4000-8000-0000000000ad';

/**
 * A player whose 1,000 ETB single was settled won on a wrong result; the
 * winnings went into another open bet (stake `afterWin − keep`), then the
 * result was corrected and the correction blocked.
 */
async function blockedPlayer(keep: bigint) {
  const player = await createPlayer(handle.db);
  await fund(handle.db, player.userId, birr(1_000));
  const e1 = await createEvent(handle.db, ids);
  const e2 = await createEvent(handle.db, ids);
  const wrong = await place(handle.db, player.userId, {
    stake: birr(1_000),
    legs: [{ selectionId: e1.home, oddsMilli: 2000 }],
    settings,
  });
  await finish(handle.db, e1.eventId, 2, 1); // wrong result: home win
  await handle.db.transaction((tx) => settleEventBets(tx, e1.eventId, new Date()));
  const afterWin = await cashOf(handle.db, player.userId);
  const other = await place(handle.db, player.userId, {
    stake: afterWin - keep,
    legs: [{ selectionId: e2.home, oddsMilli: 2000 }],
    settings,
  });
  return { player, e1, e2, wrong, other };
}

async function correct(eventId: string, betId: string) {
  await finish(handle.db, eventId, 0, 1); // corrected result: away win
  return handle.db.transaction((tx) => settlePlacedBet(tx, betId, new Date()));
}

describe('withdrawals while a settlement correction is blocked', () => {
  it('refuses a new withdrawal with 409 settlement_correction_pending until the correction goes through', async () => {
    const { player, e1, e2, wrong } = await blockedPlayer(birr(400));
    const blocked = await correct(e1.eventId, wrong.bet.id);
    expect(blocked.outcome).toBe('correction_blocked');

    const refused = await domainError(
      withdraw(handle.db, player, birr(390), { now: new Date(), rules: rules() }),
    );
    expect(refused).toMatchObject({ status: 409, code: 'settlement_correction_pending' });
    expect(await cashOf(handle.db, player.userId)).toBe(birr(400));
    expect(await payoutsOf(player.userId)).toHaveLength(0);

    // The other bet wins: the player can now cover the correction, the retry posts it.
    await finish(handle.db, e2.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, e2.eventId, new Date()));
    const retried = await handle.db.transaction((tx) =>
      settlePlacedBet(tx, wrong.bet.id, new Date()),
    );
    expect(retried.outcome).toBe('resettled');
    const ok = await withdraw(handle.db, player, birr(100), { now: new Date(), rules: rules() });
    expect(ok.payout.status).toBe('approved');
  });

  it('sends approved, unsent withdrawals back to review and refuses staff approval while blocked', async () => {
    const { player, e1, wrong } = await blockedPlayer(birr(1_400));
    // Auto-approved withdrawal (below the threshold), not yet taken by a payout worker.
    const small = await withdraw(handle.db, player, birr(1_000), { rules: rules() });
    expect(small.payout.status).toBe('approved');
    // A large one waiting for staff.
    await fund(handle.db, player.userId, birr(6_000));
    const large = await withdraw(handle.db, player, birr(5_000), { rules: rules() });
    expect(large.payout).toMatchObject({
      status: 'requested',
      reviewReason: 'above_auto_approve_threshold',
    });
    // Cash is 1,400 ETB: the 2,000 ETB clawback is blocked.
    const blocked = await correct(e1.eventId, wrong.bet.id);
    expect(blocked.outcome).toBe('correction_blocked');

    const [heldBack] = await handle.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, small.payout.id));
    expect(heldBack).toMatchObject({
      status: 'requested',
      reviewReason: 'settlement_correction',
      approvedBy: null,
      approvedAt: null,
    });
    const events = await handle.db
      .select({ type: outboxEvents.type })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, small.payout.id));
    expect(events.map((e) => e.type)).toContain('payment.withdrawal_held');

    for (const payoutId of [small.payout.id, large.payout.id]) {
      const refused = await domainError(
        handle.db.transaction((tx) =>
          approveWithdrawal(tx, { payoutId, adminId: ADMIN, now: new Date(), amlReviewer: true }),
        ),
      );
      expect(refused).toMatchObject({ status: 409, code: 'settlement_correction_pending' });
    }
    const [bet] = await handle.db.select().from(bets).where(eq(bets.id, wrong.bet.id));
    expect(bet?.settlementRetryAt).not.toBeNull();
  });
});

async function payoutsOf(userId: string) {
  return handle.db.select().from(payouts).where(eq(payouts.userId, userId));
}
