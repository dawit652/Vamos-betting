import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settleEvent } from '../src/tasks/settlement';
import { createEvent, finish, fundedUser, place, testSettings, type TestEvent } from './betting';
import { createWorkerTestContext, SETUP_TIMEOUT, type WorkerTestContext } from './helpers';

const BENCH = process.env.BENCH === '1';

let t: WorkerTestContext | undefined;
beforeAll(async () => {
  // No database for a file that is skipped.
  if (BENCH) t = await createWorkerTestContext();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

const EVENTS = 8;
const BETS_PER_EVENT = 400;

// Run with: BENCH=1 pnpm --filter @vamos/worker exec vitest run test/settlement-pace.bench.test.ts --reporter=verbose
describe.skipIf(!BENCH)('settlement pace (bench: only with BENCH=1)', () => {
  it('measures bets settled per second for 1, 2 and 4 events in parallel', async () => {
    if (t === undefined) throw new Error('no test context');
    const ctx = t;
    const settings = await testSettings(ctx.db.db);
    const users: string[] = [];
    for (let i = 0; i < 40; i += 1) users.push(await fundedUser(ctx.db.db, 1_000_000_000n));
    const events: TestEvent[] = [];
    for (let i = 0; i < EVENTS; i += 1) events.push(await createEvent(ctx));
    const now = ctx.clock.now;
    const t0 = Date.now();
    let n = 0;
    for (const event of events) {
      // 8 placements at a time.
      for (let start = 0; start < BETS_PER_EVENT; start += 8) {
        await Promise.all(
          Array.from({ length: 8 }, (_, k) => {
            const i = start + k;
            n += 1;
            return place(ctx.db.db, users[(n + k) % users.length]!, {
              stake: 1_000n,
              legs: [{ selectionId: i % 2 === 0 ? event.home : event.away, oddsMilli: 2000 }],
              policy: 'any',
              settings,
              now,
            });
          }),
        );
      }
    }
    console.warn(`placed ${n} bets in ${Date.now() - t0} ms`);
    ctx.clock.advance(3 * 3600_000);
    for (const event of events) await finish(ctx.db.db, event.eventId, 2, 1);

    const lanes = async (parallel: number, batch: TestEvent[]) => {
      const started = Date.now();
      const queue = [...batch];
      let bets = 0;
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
            const run = await settleEvent(ctx.ctx, e.eventId);
            expect(run.failed).toEqual([]);
            bets += run.outcomes.settled;
          }
        }),
      );
      const ms = Date.now() - started;
      console.warn(
        `settle: ${parallel} event(s) in parallel: ${bets} bets in ${ms} ms = ${Math.round((bets * 1000) / ms)} bets/s`,
      );
    };
    await lanes(1, events.slice(0, 2));
    await lanes(2, events.slice(2, 4));
    await lanes(4, events.slice(4, 8));
  }, 600_000);
});
