import { birr, forecastPayoutFloat } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ingestSms,
  listOpenBetPayouts,
  loadFloatForecast,
  settleEventBets,
  type GameSettings,
} from '../src/index';
import {
  createBettingDatabase,
  createEvent,
  finish,
  place,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';

/** The float forecast reads open bets and the latest SMS balances (C10); it writes nothing. */

let handle: TestDb;
let settings: GameSettings;
let ids: Awaited<ReturnType<typeof createBettingDatabase>>['ids'];
beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const HOUR = 3_600_000;
const rules = { eventDurationMs: 2 * HOUR, horizonMs: 6 * HOUR, withdrawnShareBps: 5000 };

async function bet(event: TestEvent, stake: bigint) {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, birr(1_000));
  const placed = await place(handle.db, userId, {
    stake,
    legs: [{ selectionId: event.home, oddsMilli: 2000 }],
    settings,
  });
  return placed;
}

describe('loadFloatForecast', () => {
  it('is empty on a fresh database', async () => {
    const out = await loadFloatForecast(handle.db, { now: new Date(), rules });
    expect(out.forecast.expectedWithdrawals).toBe(0n);
    expect(out.forecast.betsCounted).toBe(0);
    expect(out.balances).toEqual([]);
  });

  it('counts open bets whose last event ends within the horizon, not later ones or settled ones', async () => {
    const now = new Date();
    const soon = await createEvent(handle.db, ids, { startTime: new Date(now.getTime() + HOUR) });
    const far = await createEvent(handle.db, ids, {
      startTime: new Date(now.getTime() + 20 * HOUR),
    });
    const done = await createEvent(handle.db, ids, { startTime: new Date(now.getTime() + HOUR) });
    await bet(soon, birr(100));
    await bet(far, birr(100));
    await bet(done, birr(100));
    await finish(handle.db, done.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, done.eventId, now)); // no longer open

    const open = await listOpenBetPayouts(handle.db);
    expect(open).toHaveLength(2);
    const out = await loadFloatForecast(handle.db, { now, rules });
    expect(out.forecast.betsCounted).toBe(1);
    const soonPayout = open.find((b) => b.lastEventStart.getTime() < now.getTime() + 2 * HOUR)!;
    expect(out.forecast.possiblePayouts).toBe(soonPayout.potentialNetPayout);
    expect(out.forecast.expectedWithdrawals).toBe(
      forecastPayoutFloat([soonPayout], now, rules).expectedWithdrawals,
    );
    expect(out.forecast.expectedWithdrawals).toBeGreaterThan(0n);
  });

  it('reports the newest balance per institution', async () => {
    const now = new Date();
    const send = (sender: string, text: string, minutes: number) =>
      handle.db.transaction((tx) =>
        ingestSms(tx, {
          source: 'gateway',
          sender,
          text,
          now: new Date(now.getTime() + minutes * 60_000),
        }),
      );
    await send(
      'telebirr',
      'Dear CUSTOMER, you have received ETB 100.37 from SENDER NAME (251900000000) on 15/08/2026 at 3:31:00 PM. Your transaction number is CA999DASAD. Your telebirr balance is ETB 1,234.56.',
      1,
    );
    await send(
      'telebirr',
      'Dear CUSTOMER, you have transferred ETB 500.00 to RECIPIENT NAME (251900000001) on 15/08/2026 at 4:00:00 PM. Your transaction number is CB123XYZ99. Your telebirr balance is ETB 734.56.',
      2,
    );
    const out = await loadFloatForecast(handle.db, { now, rules });
    const telebirr = out.balances.filter((b) => b.institution === 'telebirr');
    expect(telebirr).toHaveLength(1);
    // Newest by the message's own time: the 4:00 PM transfer.
    expect(telebirr[0]!.balance).toBe(73_456n);
  });
});
