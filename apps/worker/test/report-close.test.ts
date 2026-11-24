import { randomUUID } from 'node:crypto';
import { addBusinessDays, birr, businessDateOf, businessDayWindow } from '@vamos/core';
import { postTransaction, schema } from '@vamos/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastClosableDay, runReportClose } from '../src/tasks/report-close';
import { createUser } from './betting';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/**
 * Owner reports (docs/plans/owner-reports.md): the worker closes every business day after
 * midnight in Addis Ababa, once, and alarms the owner when a closed day changes afterwards.
 */

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
});

async function depositAt(amount: bigint, at?: Date) {
  const userId = await createUser(t.db.db);
  await t.db.db.transaction((tx) =>
    postTransaction(tx, {
      type: 'deposit',
      idempotencyKey: `deposit:test-${randomUUID()}`,
      ...(at === undefined ? {} : { createdAt: at }),
      entries: [
        { account: { kind: 'house_psp_clearing', provider: 'chapa' }, amount: -amount },
        { account: { kind: 'player_cash', userId }, amount },
      ],
    }),
  );
}

describe('closing report days', () => {
  it('a day closes after midnight (plus 10 minutes), from midnight in Addis Ababa', () => {
    // 22 Nov 2026 00:05 in Addis Ababa: the 21st is not closable yet; at 00:10 it is.
    expect(lastClosableDay(new Date('2026-11-21T21:05:00Z'))).toBe('2026-11-20');
    expect(lastClosableDay(new Date('2026-11-21T21:10:00Z'))).toBe('2026-11-21');
  });

  it(
    'closes each day once, then alarms the owner when a closed day changes',
    async () => {
      const real = t.clock.now;
      const today = businessDateOf(real);
      try {
        await depositAt(birr(100));
        // 00:20 the next morning in Addis Ababa.
        t.clock.set(
          new Date(businessDayWindow(addBusinessDays(today, 1)).start.getTime() + 20 * 60_000),
        );
        const first = await runReportClose(t.ctx);
        expect(first.closed.at(-1)).toBe(today);
        expect(first.failed).toEqual([]);
        expect(first.changed).toEqual([]);
        const [row] = await t.db.db
          .select()
          .from(schema.reportDays)
          .where(eq(schema.reportDays.businessDate, today));
        expect(row?.checks).toMatchObject({ balanced: true, everyPostingBalanced: true });

        expect(await runReportClose(t.ctx)).toEqual({ closed: [], failed: [], changed: [] });

        // A posting back-dated into the closed day: caught, and the owner is told.
        await depositAt(birr(5), new Date(businessDayWindow(today).start.getTime() + 3_600_000));
        const alerts = {
          ...t.ctx,
          ownerAlerts: { phones: ['+251911000001'], minIntervalMinutes: 30 },
        };
        const after = await runReportClose(alerts);
        expect(after.changed).toEqual([today]);
        const outbox = await t.db.db
          .select()
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.type, 'owner.alert'));
        expect(outbox.map((row) => (row.payload as { key: string }).key)).toContain(
          `report_check_failed|${today}`,
        );
      } finally {
        t.clock.set(real);
      }
    },
    TEST_TIMEOUT,
  );
});
