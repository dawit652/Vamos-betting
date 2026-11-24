import {
  TELEGRAM_RESET_MAX_AGE_SECONDS,
  TELEGRAM_RESET_PATH,
  TelegramResetCodeRequest,
  telegramResetSigningInput,
  type TelegramResetCodeResponse,
} from '@vamos/contracts';
import type { FastifyInstance } from 'fastify';
import { hmacSha256Hex, safeEqualHex } from '../../lib/crypto';
import { parseInput, unauthorized } from '../../lib/errors';
import { issueTelegramResetCode } from '../auth/service';

/**
 * The Telegram bot's door into the API (the worker calls it over the compose network): a PIN reset
 * code for a number the bot has proven, sent in that chat (docs/plans/telegram-pin-reset.md).
 * Signed with SESSION_SECRET over the timestamp, the phone and the chat (TelegramResetCodeRequest);
 * a wrong or old signature is a 401 that says nothing more. Mounted only while a bot token is set.
 */
export default async function telegramRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.deps;
  if (deps.config.telegram.botToken === undefined) return;

  app.post(TELEGRAM_RESET_PATH, async (request): Promise<TelegramResetCodeResponse> => {
    const input = parseInput(TelegramResetCodeRequest, request.body);
    const signature = request.headers['x-vamos-signature'];
    const expected = hmacSha256Hex(deps.config.sessionSecret, telegramResetSigningInput(input));
    const age = Math.abs(deps.clock().getTime() / 1000 - input.timestamp);
    if (
      typeof signature !== 'string' ||
      !safeEqualHex(signature, expected) ||
      age > TELEGRAM_RESET_MAX_AGE_SECONDS
    ) {
      throw unauthorized();
    }
    const userAgent = request.headers['user-agent'];
    const result = await issueTelegramResetCode(
      deps,
      { phone: input.phone, chatId: input.chatId },
      { ip: request.ip, userAgent: userAgent ?? null, log: request.log },
    );
    return result.status === 'sent'
      ? { status: 'sent', code: result.code, expiresAt: result.expiresAt.toISOString() }
      : { status: 'no_account' };
  });
}
