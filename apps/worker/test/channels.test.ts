import { randomUUID } from 'node:crypto';
import { smsText } from '@vamos/core';
import {
  BET_ACCEPTED,
  BET_REJECTED,
  CHANNEL_REPLY_TEMPLATE,
  CHANNEL_SMS_REPLY,
  enqueueOutbox,
  schema,
  USSD_SESSION_RETENTION_MS,
} from '@vamos/db';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '../src/lib/queues';
import {
  OUTBOX_ROUTES,
  type ChannelReplySmsJobData,
  type LiveBetSmsJobData,
} from '../src/tasks/outbox-dispatch';
import { LIVE_BET_OUTCOME_TEMPLATE, processSmsJob } from '../src/tasks/sms-notify';
import { runUssdPrune } from '../src/tasks/ussd-prune';
import { createEvent, fundedUser, place, testSettings } from './betting';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

async function outboxRow(
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: object,
) {
  const id = await enqueueOutbox(t.db.db, {
    type,
    aggregateType,
    aggregateId,
    payload: payload as Record<string, unknown>,
  });
  const [row] = await t.db.db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.id, id));
  return row!;
}

async function smsTo(phone: string) {
  return t.db.db
    .select()
    .from(schema.smsMessages)
    .where(eq(schema.smsMessages.to, phone))
    .orderBy(desc(schema.smsMessages.createdAt));
}

async function userPhone(userId: string): Promise<string> {
  const [row] = await t.db.db
    .select({ phone: schema.users.phone })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row!.phone;
}

describe('SMS channel replies (Phase 11)', () => {
  it(
    'routes channel.sms_reply to the sms queue and sends the stored text as it is',
    async () => {
      const inboundMessageId = randomUUID();
      const to = '+251911000111';
      const body = smsText('Bet ABCD1234 placed. Odds 1.85, stake ETB 50.00.', { demo: true });
      const row = await outboxRow(CHANNEL_SMS_REPLY, 'inbound_message', inboundMessageId, {
        inboundMessageId,
        to,
        body,
        template: CHANNEL_REPLY_TEMPLATE,
        userId: null,
        send: 1,
      });
      const routes = OUTBOX_ROUTES[CHANNEL_SMS_REPLY] ?? [];
      expect(routes).toHaveLength(1);
      const job = routes[0]!(row, new Date());
      expect(job).toMatchObject({ queue: QUEUE_NAMES.sms, name: CHANNEL_SMS_REPLY });
      const data = job!.data as ChannelReplySmsJobData;
      expect(data).toEqual({
        outboxId: row.id.toString(),
        type: CHANNEL_SMS_REPLY,
        inboundMessageId,
        to,
        body,
        template: CHANNEL_REPLY_TEMPLATE,
      });

      const sent = await processSmsJob(t.ctx, data);
      expect(sent).toMatchObject({ sent: true, template: CHANNEL_REPLY_TEMPLATE });
      const [message] = await smsTo(to);
      expect(message).toMatchObject({ body, template: CHANNEL_REPLY_TEMPLATE, provider: 'mock' });
    },
    TEST_TIMEOUT,
  );

  it('refuses a malformed reply payload (the row backs off instead of sending)', async () => {
    const row = await outboxRow(CHANNEL_SMS_REPLY, 'inbound_message', randomUUID(), {
      inboundMessageId: randomUUID(),
      to: 'not-a-number',
      body: 'x',
      template: CHANNEL_REPLY_TEMPLATE,
    });
    expect(() => OUTBOX_ROUTES[CHANNEL_SMS_REPLY]![0]!(row, new Date())).toThrow();
    // A live bet outcome without what the text needs gets no SMS job (and blocks nothing).
    const outcome = await outboxRow(BET_ACCEPTED, 'bet', randomUUID(), { shortId: 'X' });
    const smsJobs = OUTBOX_ROUTES[BET_ACCEPTED]!.map((route) => route(outcome, new Date())).filter(
      (job) => job?.queue === QUEUE_NAMES.sms,
    );
    expect(smsJobs).toHaveLength(0);
  });

  it(
    'texts the outcome of a live bet placed by SMS or USSD, and skips web bets',
    async () => {
      const settings = await testSettings(t.db.db);
      const event = await createEvent(t);
      const now = t.clock.now;
      const placeOne = async () => {
        const userId = await fundedUser(t.db.db, 100_000n);
        const result = await place(t.db.db, userId, {
          stake: 5_000n,
          legs: [{ selectionId: event.home, oddsMilli: 2_000 }],
          settings,
          now,
        });
        return { userId, bet: result.bet };
      };

      const sms = await placeOne();
      await t.db.db
        .update(schema.bets)
        .set({ channel: 'sms' })
        .where(eq(schema.bets.id, sms.bet.id));
      // English for this player; the USSD one below keeps the default (Amharic).
      await t.db.db
        .update(schema.users)
        .set({ locale: 'en' })
        .where(eq(schema.users.id, sms.userId));
      const accepted = await outboxRow(BET_ACCEPTED, 'bet', sms.bet.id, {
        betId: sms.bet.id,
        userId: sms.userId,
        shortId: sms.bet.shortId,
        oddsChanged: [],
      });
      const smsRoute = OUTBOX_ROUTES[BET_ACCEPTED]!.map((route) => route(accepted, now)).find(
        (job) => job?.queue === QUEUE_NAMES.sms,
      );
      expect(smsRoute).toBeDefined();
      const sent = await processSmsJob(t.ctx, smsRoute!.data as LiveBetSmsJobData);
      expect(sent).toMatchObject({ sent: true, template: LIVE_BET_OUTCOME_TEMPLATE });
      const phone = await userPhone(sms.userId);
      expect((await smsTo(phone))[0]?.body).toBe(
        smsText(`Live bet ${sms.bet.shortId} accepted.`, { demo: true }),
      );

      const ussd = await placeOne();
      await t.db.db
        .update(schema.bets)
        .set({ channel: 'ussd' })
        .where(eq(schema.bets.id, ussd.bet.id));
      const rejected = await outboxRow(BET_REJECTED, 'bet', ussd.bet.id, {
        betId: ussd.bet.id,
        userId: ussd.userId,
        shortId: ussd.bet.shortId,
        reason: 'odds_changed',
        refund: '5000',
      });
      const rejectJob = OUTBOX_ROUTES[BET_REJECTED]!.map((route) => route(rejected, now)).find(
        (job) => job?.queue === QUEUE_NAMES.sms,
      );
      expect(rejectJob!.data).toMatchObject({ reason: 'odds_changed', refund: '5000' });
      expect(await processSmsJob(t.ctx, rejectJob!.data as LiveBetSmsJobData)).toMatchObject({
        sent: true,
      });
      const rejectText = (await smsTo(await userPhone(ussd.userId)))[0]?.body ?? '';
      expect(rejectText).toContain(ussd.bet.shortId);
      expect(rejectText).toContain('50.00 ብር');

      const web = await placeOne();
      const webJob: LiveBetSmsJobData = {
        outboxId: '1',
        type: BET_ACCEPTED,
        betId: web.bet.id,
        userId: web.userId,
        shortId: web.bet.shortId,
      };
      expect(await processSmsJob(t.ctx, webJob)).toEqual({
        sent: false,
        reason: 'not_channel_bet',
      });
      expect(await smsTo(await userPhone(web.userId))).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});

describe('ussd-session-prune', () => {
  it('deletes expired sessions without a bet past retention, in bounded batches per run', async () => {
    const now = t.ctx.clock();
    const expiredAt = new Date(now.getTime() - USSD_SESSION_RETENTION_MS - 60_000);
    const phone = `+2519${String(Date.now()).slice(-8)}`;
    const rows = Array.from({ length: 5 }, (_, i) => ({
      aggregator: 'mock',
      sessionId: `prune-${randomUUID()}-${i}`,
      phone,
      serviceCode: '*123#',
      state: { screen: 'ended' },
      lastText: '',
      lastResponse: 'END Bye',
      createdAt: expiredAt,
      updatedAt: expiredAt,
      expiresAt: i === 4 ? now : expiredAt,
    }));
    await t.db.db.insert(schema.ussdSessions).values(rows);
    const left = async () =>
      (
        await t.db.db
          .select({ id: schema.ussdSessions.id })
          .from(schema.ussdSessions)
          .where(eq(schema.ussdSessions.phone, phone))
      ).length;
    // Four are past retention; one stays (expired just now).
    expect(await runUssdPrune(t.ctx, { batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await left()).toBe(3);
    expect(await runUssdPrune(t.ctx, { batchSize: 2, maxBatches: 5 })).toBe(2);
    expect(await left()).toBe(1);
  });
});
