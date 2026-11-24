import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerTask } from '../worker';
import { handleUpdate, type BotDeps } from './bot';
import { TelegramError } from './client';

/**
 * The bot's long polling (getUpdates): no webhook, so nothing on the server has to accept
 * connections from Telegram. One worker polls; the offset (the next update id) is kept in Redis so
 * a restart neither repeats nor skips updates. A failed update is logged and skipped; a failed poll
 * waits and tries again. stop() aborts the poll in progress.
 *
 * Alarm (`error` line with `alarm`): `telegram_bot_unauthorized` when Telegram refuses the token
 * (it was revoked, or TELEGRAM_BOT_TOKEN is wrong); the owner alerts then go by SMS only.
 */

export const TELEGRAM_OFFSET_KEY = 'vamos:telegram:offset';

export interface TelegramBotTaskOptions {
  /** Seconds one getUpdates may wait for updates (default 25). */
  pollSeconds?: number;
  /** Wait after a failed poll (default 5 s; a refused token waits a minute). */
  retryMs?: number;
  offsetKey?: string;
}

export function telegramBotTask(
  deps: BotDeps & { redis: Pick<Redis, 'incr' | 'expire' | 'get' | 'set'>; logger: Logger },
  options: TelegramBotTaskOptions = {},
): WorkerTask {
  const pollSeconds = options.pollSeconds ?? 25;
  const retryMs = options.retryMs ?? 5_000;
  const offsetKey = options.offsetKey ?? TELEGRAM_OFFSET_KEY;
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  async function run(signal: AbortSignal): Promise<void> {
    // The bot's username, for the "Share with friends" button (none if getMe fails).
    let botDeps: BotDeps = deps;
    try {
      const me = await deps.client.getMe();
      deps.logger.info({ bot: me.username }, 'telegram bot polling');
      if (me.username !== undefined) botDeps = { ...deps, botUsername: me.username };
    } catch (error) {
      deps.logger.warn({ err: error }, 'telegram bot: getMe failed; polling anyway');
    }
    let offset: number | undefined;
    try {
      const stored = await deps.redis.get(offsetKey);
      if (stored !== null && /^\d+$/.test(stored)) offset = Number(stored);
    } catch {
      offset = undefined;
    }
    while (!signal.aborted) {
      try {
        const updates = await deps.client.getUpdates({
          ...(offset === undefined ? {} : { offset }),
          timeoutSeconds: pollSeconds,
          signal,
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(botDeps, update);
          } catch (error) {
            deps.logger.warn(
              { err: error, updateId: update.update_id },
              'telegram bot: an update failed; skipped',
            );
          }
        }
        if (updates.length > 0 && offset !== undefined) {
          await deps.redis.set(offsetKey, String(offset)).catch(() => undefined);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TelegramError && error.code === 401) {
          deps.logger.error(
            { alarm: 'telegram_bot_unauthorized' },
            'Telegram refused the bot token: owner alerts go by SMS only until it is fixed',
          );
          await pause(60_000, signal);
        } else if (error instanceof TelegramError && error.code === 409) {
          deps.logger.warn(
            'telegram bot: another process polls this bot, or a webhook is set (one poller only)',
          );
          await pause(retryMs * 6, signal);
        } else if (error instanceof TelegramError && error.retryAfterSeconds !== undefined) {
          await pause(error.retryAfterSeconds * 1000, signal);
        } else {
          deps.logger.warn({ err: error }, 'telegram bot: polling failed; retrying');
          await pause(retryMs, signal);
        }
      }
    }
  }

  return {
    name: 'telegram-bot',
    start: async () => {
      if (loop !== null) return;
      controller = new AbortController();
      loop = run(controller.signal).finally(() => {
        loop = null;
      });
    },
    stop: async () => {
      controller?.abort();
      if (loop !== null) await loop.catch(() => undefined);
    },
  };
}
