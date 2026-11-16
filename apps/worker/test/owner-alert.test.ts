import type { OwnerAlertsConfig } from '@vamos/config';
import { buildOwnerAlert } from '@vamos/core';
import { enqueueOutbox, OWNER_ALERT, schema, type OwnerAlertPayload } from '@vamos/db';
import { SmsRailProvider, type PaymentProviderRegistry } from '@vamos/payments';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The scraper's own alarm code: the first end of the path under test.
import { raiseUnauthorized } from '../../scraper/src/pipeline/credit-alarms';
import { raiseOwnerAlert } from '../src/lib/owner-alert';
import type { SmsMessage, SmsSender } from '../src/lib/sms';
import type { TaskContext } from '../src/tasks/context';
import {
  createOutboxDispatcher,
  OUTBOX_ROUTES,
  type OutboxDispatcher,
  type OwnerAlertSmsJobData,
} from '../src/tasks/outbox-dispatch';
import { OWNER_ALERT_TEMPLATE, processOwnerAlertJob } from '../src/tasks/owner-alert';
import { smsNotifyTask } from '../src/tasks/sms-notify';
import { runSmsRailWatch } from '../src/tasks/smsrail';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/**
 * Alerts to the owner's phone (plan task 1.11): the `owner.alert` handler (every number, once per
 * key and interval, nothing with alerts off), the raising of an alert from worker code, and the whole
 * path from an alarm in the scraper through the outbox and the dispatcher to the SMS.
 */

const OWNER_A = '+251911000001';
const OWNER_B = '+251922000002';
const ALERTS: OwnerAlertsConfig = { phones: [OWNER_A, OWNER_B], minIntervalMinutes: 30 };
const MINUTE = 60_000;

let t: WorkerTestContext;
beforeAll(async () => {
  t = await createWorkerTestContext();
  await publishAll();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

/** Marks every outbox row published, so no dispatcher run hands it to a consumer. */
async function publishAll(): Promise<void> {
  await t.db.db
    .update(schema.outboxEvents)
    .set({ publishedAt: new Date() })
    .where(isNull(schema.outboxEvents.publishedAt));
}

const withAlerts = (extra: Partial<TaskContext> = {}): TaskContext => ({
  ...t.ctx,
  ownerAlerts: ALERTS,
  ...extra,
});

let counter = 0;
/** A unique alert key, so tests in this file do not share a window. */
const freshKey = (name: string): string => `${name}|${(counter += 1)}`;

const jobOf = (key: string, raisedAt: Date, message = 'Odds reads are stopped.') =>
  ({
    outboxId: '1',
    type: OWNER_ALERT,
    key,
    message,
    raisedAt: raisedAt.toISOString(),
  }) satisfies OwnerAlertSmsJobData;

async function ownerSms(phone: string) {
  return t.db.db
    .select()
    .from(schema.smsMessages)
    .where(eq(schema.smsMessages.to, phone))
    .orderBy(asc(schema.smsMessages.createdAt));
}

async function unpublishedAlerts() {
  return t.db.db
    .select()
    .from(schema.outboxEvents)
    .where(and(eq(schema.outboxEvents.type, OWNER_ALERT), isNull(schema.outboxEvents.publishedAt)))
    .orderBy(asc(schema.outboxEvents.id));
}

/** A logger that keeps every line. */
function recording(): {
  logger: Logger;
  lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    lines.push({ level, obj: obj ?? {}, msg: msg ?? '' });
  };
  const logger = {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    fatal: at('fatal'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

/** An SMS gateway that fails for some numbers, and counts what it sent. */
function flakySender(failFor: (to: string, attempt: number) => boolean): SmsSender & {
  sent: SmsMessage[];
} {
  const sent: SmsMessage[] = [];
  const attempts = new Map<string, number>();
  return {
    name: 'flaky',
    sent,
    send: (message) => {
      const attempt = (attempts.get(message.to) ?? 0) + 1;
      attempts.set(message.to, attempt);
      if (failFor(message.to, attempt)) return Promise.reject(new Error('gateway down'));
      sent.push(message);
      return Promise.resolve({ id: `m-${sent.length}` });
    },
  };
}

describe('the owner.alert outbox route', () => {
  const routes = OUTBOX_ROUTES[OWNER_ALERT] ?? [];

  it('hands the alert to the sms queue as it is', async () => {
    expect(routes).toHaveLength(1);
    const payload: OwnerAlertPayload = {
      key: 'budget_exhausted|theoddsapi',
      message: 'Bookmaker odds credits are used up: odds reads are stopped until the 1st.',
      raisedAt: t.clock.now.toISOString(),
    };
    const id = await enqueueOutbox(t.db.db, {
      type: OWNER_ALERT,
      aggregateType: 'owner_alert',
      aggregateId: payload.key,
      payload: { ...payload },
    });
    const [row] = await t.db.db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.id, id));
    const job = routes[0]!(row!, new Date());
    expect(job).toMatchObject({ queue: 'sms', name: OWNER_ALERT });
    expect(job!.data).toEqual({ outboxId: id.toString(), type: OWNER_ALERT, ...payload });
    await publishAll();
  });

  it('refuses a payload without a key, or with a text over 160 characters', async () => {
    for (const payload of [
      { message: 'x', raisedAt: new Date().toISOString() },
      { key: 'k', message: 'x'.repeat(161), raisedAt: new Date().toISOString() },
      { key: 'k', message: '', raisedAt: new Date().toISOString() },
    ]) {
      const id = await enqueueOutbox(t.db.db, {
        type: OWNER_ALERT,
        aggregateType: 'owner_alert',
        aggregateId: 'k',
        payload,
      });
      const [row] = await t.db.db
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, id));
      expect(() => routes[0]!(row!, new Date())).toThrow();
    }
    await publishAll();
  });
});

describe('processOwnerAlertJob', () => {
  it(
    'sends the text as it is to every owner number through the SMS provider and logs it',
    async () => {
      const { logger, lines } = recording();
      const before = [(await ownerSms(OWNER_A)).length, (await ownerSms(OWNER_B)).length];
      const key = freshKey('budget_exhausted');
      const message = 'Bookmaker odds credits are used up: odds reads are stopped until the 1st.';
      const result = await processOwnerAlertJob(
        withAlerts({ logger }),
        jobOf(key, t.clock.now, message),
      );
      expect(result).toMatchObject({ sent: true, template: OWNER_ALERT_TEMPLATE, recipients: 2 });
      for (const [i, phone] of [OWNER_A, OWNER_B].entries()) {
        const rows = await ownerSms(phone);
        expect(rows).toHaveLength(before[i]! + 1);
        expect(rows.at(-1)).toMatchObject({
          body: message,
          template: OWNER_ALERT_TEMPLATE,
          provider: 'mock',
          status: 'sent',
        });
      }
      const info = lines.find((l) => l.level === 'info' && l.msg === 'owner alert sent');
      expect(info?.obj).toMatchObject({ alertKey: key, message, recipients: 2, provider: 'mock' });
      // The numbers are not in the log.
      expect(JSON.stringify(lines)).not.toContain(OWNER_A);
      expect(JSON.stringify(lines)).not.toContain(OWNER_B);
    },
    TEST_TIMEOUT,
  );

  it('does nothing with OWNER_ALERT_PHONES empty or not configured', async () => {
    const count = async () => (await t.db.db.select().from(schema.smsMessages)).length;
    const before = await count();
    const job = jobOf(freshKey('off'), t.clock.now);
    for (const ctx of [
      { ...t.ctx },
      { ...t.ctx, ownerAlerts: { phones: [], minIntervalMinutes: 30 } },
    ]) {
      expect(await processOwnerAlertJob(ctx, job)).toEqual({
        sent: false,
        reason: 'owner_alerts_off',
      });
    }
    expect(await count()).toBe(before);
    // And it did not use up the window: with alerts on, the same alert goes out.
    expect(await processOwnerAlertJob(withAlerts(), job)).toMatchObject({ sent: true });
  });

  it('sends one key at most once per interval, and another key at once', async () => {
    const ctx = withAlerts();
    const key = freshKey('source_broken');
    const t0 = new Date('2026-11-13T10:00:00Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * MINUTE);
    const sent = (r: Awaited<ReturnType<typeof processOwnerAlertJob>>) => r.sent;

    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, t0)))).toBe(true);
    // Inside the window: dropped, however often it is raised.
    expect(await processOwnerAlertJob(ctx, jobOf(key, at(1)))).toEqual({
      sent: false,
      reason: 'suppressed',
    });
    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, at(29.9))))).toBe(false);
    // An older alert arriving late is inside the window too.
    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, at(-5))))).toBe(false);
    // Another key is not held back.
    expect(sent(await processOwnerAlertJob(ctx, jobOf(freshKey('source_broken'), at(1))))).toBe(
      true,
    );
    // A suppressed alert does not move the window: 30 minutes after the one that was sent.
    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, at(30))))).toBe(true);
    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, at(59))))).toBe(false);
    expect(sent(await processOwnerAlertJob(ctx, jobOf(key, at(60))))).toBe(true);
  });

  it('follows OWNER_ALERT_MIN_INTERVAL_MINUTES', async () => {
    const ctx = withAlerts({ ownerAlerts: { phones: [OWNER_A], minIntervalMinutes: 5 } });
    const key = freshKey('interval');
    const t0 = new Date('2026-11-13T10:00:00Z');
    expect((await processOwnerAlertJob(ctx, jobOf(key, t0))).sent).toBe(true);
    expect(
      (await processOwnerAlertJob(ctx, jobOf(key, new Date(t0.getTime() + 4 * MINUTE)))).sent,
    ).toBe(false);
    expect(
      (await processOwnerAlertJob(ctx, jobOf(key, new Date(t0.getTime() + 5 * MINUTE)))).sent,
    ).toBe(true);
  });

  it('sends an alert once when the same row is handled at the same moment', async () => {
    const sender = flakySender(() => false);
    const ctx = withAlerts({ sms: sender });
    const job = jobOf(freshKey('race'), t.clock.now);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => processOwnerAlertJob(ctx, job)),
    );
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(sender.sent).toHaveLength(2); // two numbers, one send each
  });

  it('gives the window back and fails the job when no number could be texted, so a retry sends', async () => {
    const sender = flakySender((_to, attempt) => attempt === 1);
    const ctx = withAlerts({ sms: sender });
    const job = jobOf(freshKey('gateway'), t.clock.now);
    await expect(processOwnerAlertJob(ctx, job)).rejects.toThrow('gateway down');
    expect(sender.sent).toHaveLength(0);
    expect(await processOwnerAlertJob(ctx, job)).toMatchObject({ sent: true, recipients: 2 });
    expect(sender.sent).toHaveLength(2);
  });

  it('keeps going when only some numbers fail, and does not retry the others', async () => {
    const sender = flakySender((to) => to === OWNER_B);
    const { logger, lines } = recording();
    const ctx = withAlerts({ sms: sender, logger });
    const result = await processOwnerAlertJob(ctx, jobOf(freshKey('partial'), t.clock.now));
    expect(result).toMatchObject({ sent: true, recipients: 1 });
    expect(sender.sent.map((m) => m.to)).toEqual([OWNER_A]);
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('some numbers'))).toBe(true);
  });
});

describe('raiseOwnerAlert (worker code)', () => {
  it('writes nothing with alerts off', async () => {
    await publishAll();
    expect(await raiseOwnerAlert({ ...t.ctx }, { alarm: 'sms_gateway_silent' })).toBe(false);
    expect(
      await raiseOwnerAlert(
        { ...t.ctx, ownerAlerts: { phones: [], minIntervalMinutes: 30 } },
        { alarm: 'sms_gateway_silent' },
      ),
    ).toBe(false);
    expect(await unpublishedAlerts()).toHaveLength(0);
  });

  it('writes one outbox row per alert key and interval, however often the check runs', async () => {
    await publishAll();
    const start = new Date('2026-12-01T08:00:00Z');
    t.clock.set(start);
    const ctx = withAlerts();
    const input = { alarm: 'manual_payout_waiting' } as const;
    expect(await raiseOwnerAlert(ctx, input)).toBe(true);
    for (const minutes of [5, 10, 15, 20, 25, 29]) {
      t.clock.set(new Date(start.getTime() + minutes * MINUTE));
      expect(await raiseOwnerAlert(ctx, input)).toBe(false);
    }
    // Another alarm is its own key.
    expect(await raiseOwnerAlert(ctx, { alarm: 'sms_review_backlog' })).toBe(true);
    t.clock.set(new Date(start.getTime() + 30 * MINUTE));
    expect(await raiseOwnerAlert(ctx, input)).toBe(true);

    const rows = await unpublishedAlerts();
    expect(rows.map((r) => (r.payload as { key: string }).key)).toEqual([
      'manual_payout_waiting',
      'sms_review_backlog',
      'manual_payout_waiting',
    ]);
    expect(rows[0]).toMatchObject({
      aggregateType: 'owner_alert',
      aggregateId: 'manual_payout_waiting',
    });
    expect(rows[0]!.payload).toEqual({
      ...buildOwnerAlert(input),
      raisedAt: start.toISOString(),
    });
    await publishAll();
  });

  it('is raised by the SMS rail watch when the collection handset is silent', async () => {
    await publishAll();
    const live = new SmsRailProvider({
      mode: 'live',
      gatewaySecret: 'w'.repeat(40),
      collectionAccounts: [
        {
          id: 'telebirr:0911678426',
          institution: 'telebirr',
          account: '0911678426',
          name: 'Vamos PLC',
        },
      ],
    });
    const payments: PaymentProviderRegistry = {
      names: [...t.ctx.payments.names, 'sms'],
      get: (name) => (name === 'sms' ? live : t.ctx.payments.get(name)),
      require: (name) => (name === 'sms' ? live : t.ctx.payments.require(name)),
    };
    // 10:00 EAT, long after the last gateway SMS (there is none).
    t.clock.set(new Date('2027-03-10T07:00:00Z'));
    const { logger } = recording();
    const ctx = withAlerts({ payments, logger });
    expect((await runSmsRailWatch(ctx)).silent).toBe(true);
    const rows = await unpublishedAlerts();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as OwnerAlertPayload).key).toBe('sms_gateway_silent');
    // The watch runs again five minutes later: the alarm is logged again, no second row.
    t.clock.advance(5 * MINUTE);
    expect((await runSmsRailWatch(ctx)).silent).toBe(true);
    expect(await unpublishedAlerts()).toHaveLength(1);
    // With alerts off the same watch writes nothing and still returns its findings.
    await publishAll();
    expect((await runSmsRailWatch({ ...ctx, ownerAlerts: undefined })).silent).toBe(true);
    expect(await unpublishedAlerts()).toHaveLength(0);
  });
});

describe('an alarm in the scraper reaches the owner', () => {
  let dispatcher: OutboxDispatcher;
  let consumer: ReturnType<typeof smsNotifyTask>;
  let ctx: TaskContext;

  beforeAll(async () => {
    ctx = withAlerts();
    await publishAll();
    dispatcher = createOutboxDispatcher(t.ctx);
    consumer = smsNotifyTask(ctx);
    await consumer.start();
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await consumer?.stop();
    await dispatcher?.close();
  }, SETUP_TIMEOUT);

  async function waitForSms(phone: string, count: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (
      (await ownerSms(phone)).filter((m) => m.template === OWNER_ALERT_TEMPLATE).length < count
    ) {
      if (Date.now() > deadline) throw new Error(`no owner alert SMS to ${phone}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it(
    'budget alarm -> outbox row -> dispatcher -> sms queue -> mock SMS to every number',
    async () => {
      const now = new Date('2028-01-15T12:00:00Z');
      const alertsTo = async (phone: string) =>
        (await ownerSms(phone)).filter((m) => m.template === OWNER_ALERT_TEMPLATE);
      const before = (await alertsTo(OWNER_A)).length;
      // The scraper's alarm: it opens the review item and, in the same transaction, the alert.
      await t.db.db.transaction((tx) =>
        raiseUnauthorized(tx, {
          creditKey: 'theoddsapi',
          sourceId: 'odds-api',
          runId: 'run-1',
          now,
          alerts: ALERTS,
        }),
      );
      const [item] = await t.db.db.select().from(schema.scrapeReviewItems);
      expect(item).toMatchObject({ kind: 'source_broken', status: 'open' });
      const rows = await unpublishedAlerts();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({
        key: 'unauthorized|theoddsapi',
        message: 'The bookmaker odds API refused our key: reads with that key are stopped.',
        raisedAt: now.toISOString(),
      });

      const summary = await dispatcher.run();
      expect(summary).toMatchObject({ claimed: 1, published: 1, jobs: 1, failed: 0 });
      await waitForSms(OWNER_A, 1);
      await waitForSms(OWNER_B, 1);
      const sent = await alertsTo(OWNER_A);
      expect(sent).toHaveLength(before + 1);
      expect(sent.at(-1)).toMatchObject({
        body: 'The bookmaker odds API refused our key: reads with that key are stopped.',
        provider: 'mock',
        status: 'sent',
      });
      expect(sent.at(-1)!.body.length).toBeLessThanOrEqual(160);
    },
    TEST_TIMEOUT,
  );
});
