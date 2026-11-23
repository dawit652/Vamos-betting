import type { OwnerAlertsConfig } from '@vamos/config';
import {
  OWNER_ALERT,
  recordServiceFailure,
  recordServiceOk,
  schema,
  setBoardPricing,
} from '@vamos/db';
import { and, asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskContext } from '../src/tasks/context';
import { processOwnerAlertJob } from '../src/tasks/owner-alert';
import { runServiceHealth } from '../src/tasks/service-health';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/**
 * The service health watch (docs/plans/counter-codes-and-deposit-recovery.md, G7; owner, 21 Nov
 * 2026): a service failing for 3 minutes raises "down" on Telegram every 15 minutes, never by SMS;
 * when it works again, "works again" once.
 */

const OWNER = '+251911000009';
const ALERTS: OwnerAlertsConfig = {
  phones: [OWNER],
  telegramChatIds: [111],
  minIntervalMinutes: 30,
};
const MINUTE = 60_000;

let t: WorkerTestContext;
beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

const sent: Array<{ chatId: number; text: string }> = [];
const ctxWith = (): TaskContext => ({
  ...t.ctx,
  ownerAlerts: ALERTS,
  telegram: {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  } as unknown as TaskContext['telegram'],
});

const alertRows = (prefix: string) =>
  t.db.db
    .select({ payload: schema.outboxEvents.payload })
    .from(schema.outboxEvents)
    .where(
      and(
        eq(schema.outboxEvents.type, OWNER_ALERT),
        like(schema.outboxEvents.aggregateId, `${prefix}%`),
      ),
    )
    .orderBy(asc(schema.outboxEvents.id));

describe('service health', () => {
  it(
    'down after 3 minutes, repeated every 15 on Telegram only, then "works again" once',
    async () => {
      const ctx = ctxWith();
      const t0 = new Date('2026-11-21T10:00:00Z');
      t.clock.set(t0);
      await recordServiceFailure(t.db.db, 'test-provider', t0, 'HTTP 503');

      t.clock.advance(2 * MINUTE);
      expect((await runServiceHealth(ctx)).down).toEqual([]);
      t.clock.advance(MINUTE);
      expect((await runServiceHealth(ctx)).down).toEqual(['test-provider']);
      let rows = await alertRows('service_down|test-provider');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({
        key: 'service_down|test-provider',
        message:
          'test-provider is down for 3 min: HTTP 503. Repeated every 15 min until it works again.',
        repeatMs: 15 * MINUTE,
        exactRepeat: true,
        telegramOnly: true,
      });

      // Every minute it is looked at, but the owner hears it again only after 15 minutes.
      t.clock.advance(10 * MINUTE);
      await runServiceHealth(ctx);
      expect(await alertRows('service_down|test-provider')).toHaveLength(1);
      t.clock.advance(5 * MINUTE);
      await runServiceHealth(ctx);
      rows = await alertRows('service_down|test-provider');
      expect(rows).toHaveLength(2);

      // Sent to Telegram only, at its own 15 minutes although OWNER_ALERT_MIN_INTERVAL is 30.
      const payload = rows[1]!.payload as Record<string, unknown>;
      const result = await processOwnerAlertJob(ctx, {
        outboxId: '1',
        type: OWNER_ALERT,
        key: payload.key as string,
        message: payload.message as string,
        raisedAt: payload.raisedAt as string,
        repeatMs: 15 * MINUTE,
        exactRepeat: true,
        telegramOnly: true,
      });
      expect(result.sent).toBe(true);
      expect(sent.at(-1)).toMatchObject({ chatId: 111 });
      const sms = await t.db.db
        .select()
        .from(schema.smsMessages)
        .where(eq(schema.smsMessages.to, OWNER));
      expect(sms).toHaveLength(0);

      // It works again: one "works again", and no more "down".
      await recordServiceOk(t.db.db, 'test-provider', t.clock.now);
      expect((await runServiceHealth(ctx)).recovered).toEqual(['test-provider']);
      const back = await alertRows('service_recovered|test-provider|');
      expect(back).toHaveLength(1);
      expect((back[0]!.payload as { message: string }).message).toBe(
        'test-provider works again, after 18 min down.',
      );
      t.clock.advance(20 * MINUTE);
      expect(await runServiceHealth(ctx)).toEqual({ down: [], recovered: [], off: [] });
      expect(await alertRows('service_down|test-provider')).toHaveLength(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'a service switched off raises nothing more, at once, and starts clean when switched on',
    async () => {
      const ctx = ctxWith();
      const SYSTEM = { system: 'test' };
      const hulusport = (enabled: boolean) =>
        t.db.db.transaction((tx) => setBoardPricing(tx, 'hulusport', enabled, SYSTEM));
      const t0 = new Date('2026-11-23T10:00:00Z');
      t.clock.set(t0);
      await hulusport(true);
      await recordServiceFailure(t.db.db, 'mrx', t0, 'mr-x has not read Hulusport lately');
      // A payment provider this deployment does not use (PAYMENT_PROVIDERS) is never watched.
      await recordServiceFailure(t.db.db, 'payments:chapa', t0, 'HTTP 503');
      t.clock.advance(4 * MINUTE);
      const first = await runServiceHealth(ctx);
      expect(first.down).toContain('mrx');
      expect(first.off).toContain('payments:chapa');
      expect(await alertRows('service_down|mr-x')).toHaveLength(1);
      expect(await alertRows('service_down|Chapa')).toHaveLength(0);

      // The owner switches Hulusport off: no "down" and no "works again", and its health is forgotten.
      await hulusport(false);
      t.clock.advance(15 * MINUTE);
      const off = await runServiceHealth(ctx);
      expect(off.down).not.toContain('mrx');
      expect(off.recovered).toEqual([]);
      expect(off.off).toContain('mrx');
      expect(await alertRows('service_down|mr-x')).toHaveLength(1);
      expect(await alertRows('service_recovered|mr-x')).toHaveLength(0);
      const [row] = await t.db.db
        .select()
        .from(schema.serviceStatus)
        .where(eq(schema.serviceStatus.service, 'mrx'));
      expect(row).toMatchObject({ lastOkAt: null, failingSince: null, alertedDownSince: null });

      // Switched on again: "not reported yet" until mr-x is read, so the old outage is not alerted.
      await hulusport(true);
      t.clock.advance(MINUTE);
      expect((await runServiceHealth(ctx)).down).not.toContain('mrx');
      expect(await alertRows('service_down|mr-x')).toHaveLength(1);
      await hulusport(false);
    },
    TEST_TIMEOUT,
  );
});
