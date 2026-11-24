import {
  ApiErrorSchema,
  TELEGRAM_RESET_PATH,
  TelegramResetCodeResponse,
  telegramResetSigningInput,
  type TelegramResetCodeRequest,
} from '@vamos/contracts';
import { auditLog, otpChallenges } from '@vamos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import {
  createTestContext,
  post,
  randomPhone,
  registerAndLogin,
  type TestContext,
} from './helpers';

/** The PIN reset code the Telegram bot asks for, once a person proved their number (X12). */

describe('POST /internal/telegram/password-reset', () => {
  let ctx: TestContext;
  let noBot: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({
      TELEGRAM_BOT_TOKEN: '123456789:AAHtestTokenForTheResetRouteTests0000',
    });
    noBot = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
    await noBot.close();
  });

  const nowSeconds = (c: TestContext) => Math.floor(c.deps.clock().getTime() / 1000);
  const body = (c: TestContext, phone: string, chatId = 777): TelegramResetCodeRequest => ({
    phone,
    chatId,
    timestamp: nowSeconds(c),
  });
  const send = (c: TestContext, input: TelegramResetCodeRequest, signature?: string) =>
    c.app.inject({
      method: 'POST',
      url: TELEGRAM_RESET_PATH,
      payload: input,
      headers: {
        'x-vamos-signature':
          signature ?? hmacSha256Hex(c.deps.config.sessionSecret, telegramResetSigningInput(input)),
      },
    });

  it('does not exist while no bot token is set', async () => {
    const response = await send(noBot, body(noBot, randomPhone()));
    expect(response.statusCode).toBe(404);
  });

  it('refuses an unsigned, wrongly signed or old request, saying nothing more', async () => {
    const player = await registerAndLogin(ctx);
    const input = body(ctx, player.phone);
    for (const response of [
      await ctx.app.inject({ method: 'POST', url: TELEGRAM_RESET_PATH, payload: input }),
      await send(ctx, input, '00'.repeat(32)),
      await send(
        ctx,
        { ...input, chatId: 778 },
        hmacSha256Hex(ctx.deps.config.sessionSecret, telegramResetSigningInput(input)),
      ),
      await send(ctx, { ...input, timestamp: nowSeconds(ctx) - 61 }),
    ]) {
      expect(response.statusCode).toBe(401);
      // Only the standard error: no status, no code.
      expect(Object.keys(response.json<object>())).toEqual(['error']);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('unauthorized');
    }
  });

  it('answers no_account for a number without an active account', async () => {
    const response = await send(ctx, body(ctx, randomPhone()));
    expect(response.statusCode).toBe(200);
    expect(TelegramResetCodeResponse.parse(response.json())).toEqual({ status: 'no_account' });
  });

  it('gives a code that resets the PIN on the reset page, with the usual limits', async () => {
    const player = await registerAndLogin(ctx);
    const response = await send(ctx, body(ctx, player.phone));
    expect(response.statusCode).toBe(200);
    const result = TelegramResetCodeResponse.parse(response.json());
    expect(result.status).toBe('sent');
    if (result.status !== 'sent') return;

    // The audit says which channel, never the code.
    const [audit] = await ctx.db.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, 'user.password_reset_requested'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.metadata).toMatchObject({ channel: 'telegram' });
    expect(JSON.stringify(audit)).not.toContain(result.code);

    // A second code right away: the resend cooldown of every reset code.
    expect((await send(ctx, body(ctx, player.phone))).statusCode).toBe(429);

    const reset = await post(ctx, '/auth/password/reset', {
      phone: player.phone,
      code: result.code,
      newPassword: '7031',
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const login = await post(ctx, '/auth/login', { phone: player.phone, password: '7031' });
    expect(login.statusCode).toBe(200);
  });
});

describe('Telegram codes next to other reset codes', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({
      TELEGRAM_BOT_TOKEN: '123456789:AAHtestTokenForTheResetRouteTests0000',
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const ask = async (phone: string, chatId = 777) => {
    const input: TelegramResetCodeRequest = {
      phone,
      chatId,
      timestamp: Math.floor(ctx.deps.clock().getTime() / 1000),
    };
    const response = await ctx.app.inject({
      method: 'POST',
      url: TELEGRAM_RESET_PATH,
      payload: input,
      headers: {
        'x-vamos-signature': hmacSha256Hex(
          ctx.deps.config.sessionSecret,
          telegramResetSigningInput(input),
        ),
      },
    });
    return {
      response,
      result: response.statusCode === 200 ? TelegramResetCodeResponse.parse(response.json()) : null,
    };
  };
  const reset = (phone: string, code: string, newPassword = '7031') =>
    post(ctx, '/auth/password/reset', { phone, code, newPassword });

  it('survives a code asked for on the website afterwards (the "Send code" button)', async () => {
    const player = await registerAndLogin(ctx);
    const { result } = await ask(player.phone);
    if (result?.status !== 'sent') throw new Error('no code');
    // The reset page's main button: a newer code, by SMS (nobody receives it with the mock gateway).
    expect((await post(ctx, '/auth/password/forgot', { phone: player.phone })).statusCode).toBe(
      200,
    );
    const done = await reset(player.phone, result.code);
    expect(done.statusCode, done.body).toBe(200);
    expect(
      (await post(ctx, '/auth/login', { phone: player.phone, password: '7031' })).statusCode,
    ).toBe(200);
  });

  it('a Telegram code replaces an earlier code, and the newest Telegram code wins', async () => {
    const player = await registerAndLogin(ctx);
    // A website code first (retired by the Telegram code that follows).
    await post(ctx, '/auth/password/forgot', { phone: player.phone });
    const first = (await ask(player.phone)).result;
    ctx.clock.advance(61_000);
    const second = (await ask(player.phone)).result;
    if (first?.status !== 'sent' || second?.status !== 'sent') throw new Error('no code');
    const stale = await reset(player.phone, first.code);
    expect(stale.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(stale.json()).error.code).toBe('otp_invalid');
    expect((await reset(player.phone, second.code)).statusCode).toBe(200);
    // Spent: the same code is dead now.
    expect((await reset(player.phone, second.code, '4826')).statusCode).toBe(400);
  });

  it('counts a wrong code once, on the newest code only', async () => {
    const player = await registerAndLogin(ctx);
    const { result } = await ask(player.phone);
    if (result?.status !== 'sent') throw new Error('no code');
    await post(ctx, '/auth/password/forgot', { phone: player.phone });
    const wrong = result.code === '000000' ? '111111' : '000000';
    expect((await reset(player.phone, wrong)).statusCode).toBe(400);
    const rows = await ctx.db.db
      .select({ requesterKey: otpChallenges.requesterKey, attempts: otpChallenges.attempts })
      .from(otpChallenges)
      .where(
        and(eq(otpChallenges.phone, player.phone), eq(otpChallenges.purpose, 'password_reset')),
      );
    const attempts = rows.map((row) => [row.requesterKey?.startsWith('telegram:'), row.attempts]);
    expect(attempts.sort()).toEqual([
      [false, 1],
      [true, 0],
    ]);
  });
});
