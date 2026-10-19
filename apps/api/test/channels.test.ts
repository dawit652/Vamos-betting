import { randomBytes, randomUUID } from 'node:crypto';
import {
  ChannelFlagsResponse,
  DevSmsSendResponse,
  DevUssdResponse,
  SmsInboundAck,
} from '@vamos/contracts';
import { birr, smsText, toWire } from '@vamos/core';
import { CHANNEL_SMS_REPLY } from '@vamos/db';
import { bets, inboundMessages, outboxEvents } from '@vamos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SMS_SIGNATURE_HEADER,
  signSmsBody,
  USSD_SECRET_HEADER,
  verifySmsSignature,
  verifyUssdSecret,
} from '../src/modules/channels/auth';
import { devChannelsEnabled } from '../src/modules/channels/dev-routes';
import { asStaff, seedStaff, staffLogin } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import {
  createTestContext,
  randomPhone,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

const NOW = new Date('2026-10-19T09:00:00.000Z');
const ON = { SMS_BETTING_ENABLED: 'true', USSD_ENABLED: 'true' };
const bearer = (user: LoggedInUser) => ({ authorization: `Bearer ${user.sessionToken}` });
const reply = (body: string) => smsText(body, { demo: true });

/** A football fixture two hours ahead with a 1X2 market (home 1.85). */
async function seedGame(ctx: TestContext): Promise<{ gameId: number; home: string }> {
  const db = ctx.db.db;
  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  const competition = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'epl-et',
    name: { en: 'Ethiopian Premier League' },
  });
  const home = await insertTeam(db, 'football', 'STG', { en: 'St. George' });
  const away = await insertTeam(db, 'football', 'FAS', { en: 'Fasil Kenema' });
  const event = await insertEvent(db, {
    sportId: 'football',
    competitionId: competition,
    homeTeamId: home,
    awayTeamId: away,
    startTime: new Date(NOW.getTime() + 2 * 3_600_000),
  });
  const market = await insertMarket(db, event.id, '1x2', null, ONE_X_TWO);
  return { gameId: event.gameId, home: market.selectionIds['1']! };
}

async function fundedPlayer(ctx: TestContext): Promise<LoggedInUser> {
  const user = await registerAndLogin(ctx);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/wallet/demo-topup',
    payload: { amount: toWire(birr(1_000)) },
    headers: { ...bearer(user), 'idempotency-key': randomUUID() },
  });
  expect(response.statusCode).toBe(200);
  return user;
}

function inboundSms(
  ctx: TestContext,
  body: Record<string, unknown>,
  sign: (raw: string) => string | undefined = (raw) =>
    signSmsBody(ctx.deps.config.channels.sms.webhookSecret, raw, ctx.clock.now),
): Promise<LightMyRequestResponse> {
  const raw = JSON.stringify(body);
  const signature = sign(raw);
  return ctx.app.inject({
    method: 'POST',
    url: '/channels/sms/inbound',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { [SMS_SIGNATURE_HEADER]: signature }),
    },
  });
}

const smsMessage = (from: string, text: string, messageId = `agg-${randomUUID()}`) => ({
  messageId,
  from,
  to: '8123',
  text,
});

function ussd(
  ctx: TestContext,
  body: Record<string, string>,
  secret: string | null = ctx.deps.config.channels.ussd.sharedSecret,
  form = false,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: '/channels/ussd',
    payload: form ? new URLSearchParams(body).toString() : body,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      ...(secret === null ? {} : { [USSD_SECRET_HEADER]: secret }),
    },
  });
}

describe('channel authentication helpers', () => {
  const secret = 'test-secret-0123456789';
  const body = Buffer.from('{"messageId":"m1"}');

  it('accepts its own signature and refuses a missing, wrong, tampered or stale one', () => {
    const header = signSmsBody(secret, body, NOW);
    expect(verifySmsSignature(secret, header, body, NOW)).toBeNull();
    expect(verifySmsSignature(secret, undefined, body, NOW)).toBe('missing_signature');
    expect(verifySmsSignature(secret, 'v1=abc', body, NOW)).toBe('missing_signature');
    expect(verifySmsSignature('other-secret', header, body, NOW)).toBe('bad_signature');
    expect(verifySmsSignature(secret, header, Buffer.from('{"messageId":"m2"}'), NOW)).toBe(
      'bad_signature',
    );
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect(verifySmsSignature(secret, header, body, later)).toBe('stale_timestamp');
  });

  it('compares the USSD secret exactly', () => {
    expect(verifyUssdSecret(secret, secret)).toBe(true);
    expect(verifyUssdSecret(secret, `${secret}x`)).toBe(false);
    expect(verifyUssdSecret(secret, '')).toBe(false);
    expect(verifyUssdSecret(secret, undefined)).toBe(false);
  });

  it('enables the dev simulator only in demo mode outside production', () => {
    const config = (mode: 'demo' | 'licensed', nodeEnv: 'test' | 'production') =>
      ({ config: { mode, nodeEnv } }) as Parameters<typeof devChannelsEnabled>[0];
    expect(devChannelsEnabled(config('demo', 'test'))).toBe(true);
    expect(devChannelsEnabled(config('demo', 'production'))).toBe(false);
    expect(devChannelsEnabled(config('licensed', 'production'))).toBe(false);
  });
});

describe('channels off (the default)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    ctx.clock.now = NOW;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('answers 404 on the inbound routes, signed or not, and records nothing', async () => {
    const sms = await inboundSms(ctx, smsMessage(randomPhone(), 'BAL'));
    expect(sms.statusCode).toBe(404);
    const call = await ussd(ctx, {
      sessionId: 'sess-off-1',
      serviceCode: '*123#',
      phoneNumber: randomPhone(),
      text: '',
    });
    expect(call.statusCode).toBe(404);
    expect(await ctx.db.db.select().from(inboundMessages)).toHaveLength(0);
  });

  it('shows both flags off, and the dev routes answer 404', async () => {
    const flags = await ctx.app.inject({ method: 'GET', url: '/dev/channels' });
    expect(flags.statusCode).toBe(200);
    expect(ChannelFlagsResponse.parse(flags.json())).toMatchObject({
      sms: { enabled: false },
      ussd: { enabled: false },
      source: 'environment',
    });
    const user = await registerAndLogin(ctx);
    const sms = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/sms',
      payload: { text: 'BAL' },
      headers: bearer(user),
    });
    expect(sms.statusCode).toBe(404);
    const call = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/ussd',
      payload: { sessionId: 'dev-session-1', text: '' },
      headers: bearer(user),
    });
    expect(call.statusCode).toBe(404);
  });
});

describe('channels on', () => {
  let ctx: TestContext;
  let game: { gameId: number; home: string };

  beforeAll(async () => {
    ctx = await createTestContext(ON);
    ctx.clock.now = NOW;
    game = await seedGame(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('refuses an unsigned, wrongly signed or stale SMS with 401 and records nothing', async () => {
    const phone = randomPhone();
    const missing = await inboundSms(ctx, smsMessage(phone, 'BAL'), () => undefined);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: 'missing_signature' } });
    const wrong = await inboundSms(ctx, smsMessage(phone, 'BAL'), (raw) =>
      signSmsBody('not-the-secret', raw, ctx.clock.now),
    );
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'bad_signature' } });
    const stale = await inboundSms(ctx, smsMessage(phone, 'BAL'), (raw) =>
      signSmsBody(
        ctx.deps.config.channels.sms.webhookSecret,
        raw,
        new Date(NOW.getTime() - 10 * 60_000),
      ),
    );
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: { code: 'stale_timestamp' } });
    const malformed = await inboundSms(ctx, { messageId: 'x y', from: phone, text: 'BAL' });
    expect(malformed.statusCode).toBe(400);
    const rows = await ctx.db.db
      .select()
      .from(inboundMessages)
      .where(eq(inboundMessages.phone, phone));
    expect(rows).toHaveLength(0);
  });

  it('places a bet by SMS once, replies through the outbox and replays a redelivery', async () => {
    const player = await fundedPlayer(ctx);
    const message = smsMessage(player.phone, ` ${game.gameId} * 1 # 50 `);
    const first = await inboundSms(ctx, message);
    expect(first.statusCode).toBe(200);
    const ack = SmsInboundAck.parse(first.json());
    expect(ack).toMatchObject({ received: true, outcome: 'bet_placed', replayed: false });

    const placed = await ctx.db.db.select().from(bets).where(eq(bets.userId, player.userId));
    expect(placed).toHaveLength(1);
    const bet = placed[0]!;
    expect(bet).toMatchObject({ channel: 'sms', stake: birr(50), totalOddsMilli: 1_850n });
    expect(ack.reply).toBe(
      reply(`Bet ${bet.shortId} placed. Odds 1.85, stake ETB 50.00, possible win ETB 92.50.`),
    );

    const [row] = await ctx.db.db
      .select()
      .from(inboundMessages)
      .where(eq(inboundMessages.externalId, message.messageId));
    expect(row).toMatchObject({ userId: player.userId, betId: bet.id, outcome: 'bet_placed' });
    const replies = await ctx.db.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, CHANNEL_SMS_REPLY), eq(outboxEvents.aggregateId, row!.id)));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload).toMatchObject({ to: player.phone, body: ack.reply, send: 1 });

    // The aggregator redelivers at once: same answer, no second bet, no second reply.
    const again = await inboundSms(ctx, message);
    expect(again.statusCode).toBe(200);
    expect(SmsInboundAck.parse(again.json())).toEqual({ ...ack, replayed: true });
    expect(await ctx.db.db.select().from(bets).where(eq(bets.userId, player.userId))).toHaveLength(
      1,
    );
    const repliesAfter = await ctx.db.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, CHANNEL_SMS_REPLY), eq(outboxEvents.aggregateId, row!.id)));
    expect(repliesAfter).toHaveLength(1);
  });

  it('gives every unregistered number the same generic reply and places nothing', async () => {
    const one = SmsInboundAck.parse(
      (await inboundSms(ctx, smsMessage(randomPhone(), `${game.gameId}#1#50`))).json(),
    );
    const two = SmsInboundAck.parse(
      (await inboundSms(ctx, smsMessage(randomPhone(), 'BAL'))).json(),
    );
    expect(one.outcome).toBe('not_available');
    expect(two.outcome).toBe('not_available');
    expect(one.reply).not.toBeNull();
    expect(two.reply).toBe(one.reply);
  });

  it('answers BAL in the player language', async () => {
    const player = await fundedPlayer(ctx);
    const ack = SmsInboundAck.parse(
      (await inboundSms(ctx, smsMessage(player.phone, 'bal'))).json(),
    );
    expect(ack.outcome).toBe('info');
    expect(ack.reply).toContain('1,000.00');
  });

  it('refuses a USSD callback without the shared secret (401)', async () => {
    const body = {
      sessionId: 'sess-auth-1',
      serviceCode: '*123#',
      phoneNumber: randomPhone(),
      text: '',
    };
    expect((await ussd(ctx, body, null)).statusCode).toBe(401);
    expect((await ussd(ctx, body, 'wrong-secret')).statusCode).toBe(401);
    expect((await ussd(ctx, { ...body, sessionId: '' })).statusCode).toBe(400);
  });

  it('places a bet through the USSD menus (form-encoded) and replays a repeated confirm', async () => {
    const player = await fundedPlayer(ctx);
    const sessionId = `ussd-${randomUUID()}`;
    const call = async (text: string) => {
      const response = await ussd(
        ctx,
        { sessionId, serviceCode: '*123#', phoneNumber: player.phone, text },
        ctx.deps.config.channels.ussd.sharedSecret,
        true,
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body.length).toBeLessThanOrEqual(182);
      return response.body;
    };
    expect(await call('')).toMatch(/^CON Vamos DEMO\n1 Place bet/);
    expect(await call('1')).toBe('CON Enter Game ID:\n00 Main menu');
    expect(await call(`1*${game.gameId}`)).toContain('1 St. George 1.85');
    expect(await call(`1*${game.gameId}*1`)).toMatch(/^CON St\. George @1\.85\nEnter stake/);
    expect(await call(`1*${game.gameId}*1*50`)).toContain('Stake ETB 50.00');
    const confirm = `1*${game.gameId}*1*50*1`;
    const placed = await call(confirm);
    const [bet] = await ctx.db.db.select().from(bets).where(eq(bets.userId, player.userId));
    expect(bet).toMatchObject({ channel: 'ussd', stake: birr(50), totalOddsMilli: 1_850n });
    expect(placed).toBe(
      `END Bet ${bet!.shortId} placed. Odds 1.85, stake ETB 50.00, possible win ETB 92.50.`,
    );
    // The aggregator retries the confirmation: same END, still one bet.
    expect(await call(confirm)).toBe(placed);
    expect(await ctx.db.db.select().from(bets).where(eq(bets.userId, player.userId))).toHaveLength(
      1,
    );
  });

  it('ends the session generically for an unregistered number', async () => {
    const response = await ussd(ctx, {
      sessionId: `ussd-${randomUUID()}`,
      serviceCode: '*123#',
      phoneNumber: randomPhone(),
      text: '',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/^END /);
  });

  it('drives both channels through the dev simulator as the signed-in player', async () => {
    const player = await fundedPlayer(ctx);
    const flags = ChannelFlagsResponse.parse(
      (await ctx.app.inject({ method: 'GET', url: '/dev/channels' })).json(),
    );
    expect(flags).toMatchObject({ sms: { enabled: true }, ussd: { enabled: true } });

    const unauthenticated = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/sms',
      payload: { text: 'BAL' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const sent = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/sms',
      payload: { text: `${game.gameId}#1#20`, messageId: 'dev-message-0001' },
      headers: bearer(player),
    });
    expect(sent.statusCode).toBe(200);
    const sms = DevSmsSendResponse.parse(sent.json());
    expect(sms).toMatchObject({ messageId: 'dev-message-0001', outcome: 'bet_placed' });
    const redelivered = DevSmsSendResponse.parse(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/dev/channels/sms',
          payload: { text: `${game.gameId}#1#20`, messageId: 'dev-message-0001' },
          headers: bearer(player),
        })
      ).json(),
    );
    expect(redelivered).toEqual({ ...sms, replayed: true });

    const dialled = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/ussd',
      payload: { sessionId: 'dev-ussd-session-1', text: '2' },
      headers: bearer(player),
    });
    expect(dialled.statusCode).toBe(200);
    // A first callback that already carries input is a session we did not start.
    expect(DevUssdResponse.parse(dialled.json()).ended).toBe(true);
    const menu = DevUssdResponse.parse(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/dev/channels/ussd',
          payload: { sessionId: 'dev-ussd-session-2', text: '' },
          headers: bearer(player),
        })
      ).json(),
    );
    expect(menu).toMatchObject({ sessionId: 'dev-ussd-session-2', ended: false });
    expect(menu.response).toMatch(/^CON /);
    const balance = DevUssdResponse.parse(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/dev/channels/ussd',
          payload: { sessionId: 'dev-ussd-session-2', text: '2' },
          headers: bearer(player),
        })
      ).json(),
    );
    expect(balance.ended).toBe(true);
    expect(balance.response).toContain('980.00');
  });

  it('shows the flags read-only to staff with settings.view, and refuses the others', async () => {
    await seedStaff(ctx);
    const admin = await staffLogin(ctx, 'admin');
    const response = await asStaff(ctx, admin, 'GET', '/admin/channels');
    expect(response.statusCode).toBe(200);
    expect(ChannelFlagsResponse.parse(response.json())).toEqual({
      sms: { enabled: true, aggregator: 'mock', shortCode: ctx.deps.config.channels.sms.shortCode },
      ussd: {
        enabled: true,
        aggregator: 'mock',
        serviceCode: ctx.deps.config.channels.ussd.serviceCode,
      },
      source: 'environment',
    });
    const support = await staffLogin(ctx, 'support');
    expect((await asStaff(ctx, support, 'GET', '/admin/channels')).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/channels' })).statusCode).toBe(401);
  });
});

describe('dev channel routes outside demo development', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      ...ON,
      NODE_ENV: 'production',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      ADMIN_TOTP_KEY: randomBytes(32).toString('hex'),
      MOCK_PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
      SMS_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
      USSD_SHARED_SECRET: randomBytes(32).toString('hex'),
    });
    ctx.clock.now = NOW;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('has no simulator in production, while the inbound routes still work', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/dev/channels' })).statusCode).toBe(404);
    const sms = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/sms',
      payload: { text: 'BAL' },
    });
    expect(sms.statusCode).toBe(404);
    const call = await ctx.app.inject({
      method: 'POST',
      url: '/dev/channels/ussd',
      payload: { sessionId: 'dev-session-1', text: '' },
    });
    expect(call.statusCode).toBe(404);
    const inbound = await inboundSms(ctx, smsMessage(randomPhone(), 'HELP'));
    expect(inbound.statusCode).toBe(200);
    expect(SmsInboundAck.parse(inbound.json()).outcome).toBe('not_available');
  });
});
