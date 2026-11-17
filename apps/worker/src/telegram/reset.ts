import { createHmac } from 'node:crypto';
import {
  TELEGRAM_RESET_PATH,
  TelegramResetCodeResponse,
  telegramResetSigningInput,
  type TelegramResetCodeRequest,
} from '@vamos/contracts';
import type { ResetCodeResult } from './bot';

/**
 * Asks the API (API_INTERNAL_URL) for a PIN reset code for a number the bot has proven, signed
 * with SESSION_SECRET the way the API checks it (TelegramResetCodeRequest). A 429 is the code
 * limit of that number; anything unexpected is "unavailable". The code is returned, never logged.
 */
export function createResetCodeRequester(options: {
  baseUrl: string;
  secret: string;
  clock?: () => Date;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): (input: { phone: string; chatId: number }) => Promise<ResetCodeResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date());
  const url = `${options.baseUrl.replace(/\/$/, '')}${TELEGRAM_RESET_PATH}`;
  return async ({ phone, chatId }) => {
    const body: TelegramResetCodeRequest = {
      phone,
      chatId,
      timestamp: Math.floor(clock().getTime() / 1000),
    };
    const signature = createHmac('sha256', options.secret)
      .update(telegramResetSigningInput(body), 'utf8')
      .digest('hex');
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vamos-signature': signature },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (response.status === 429) return { status: 'limited' };
    if (!response.ok) return { status: 'unavailable' };
    const parsed = TelegramResetCodeResponse.safeParse(await response.json());
    if (!parsed.success) return { status: 'unavailable' };
    return parsed.data.status === 'sent'
      ? { status: 'sent', code: parsed.data.code }
      : { status: 'no_account' };
  };
}
