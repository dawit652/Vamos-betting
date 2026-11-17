import {
  ApiErrorSchema,
  TELEGRAM_RESET_PATH,
  TelegramResetCodeResponse,
  telegramResetSigningInput,
  type TelegramResetCodeRequest,
} from '@vamos/contracts';
import { auditLog } from '@vamos/db/schema';
import { desc, eq } from 'drizzle-orm';
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
