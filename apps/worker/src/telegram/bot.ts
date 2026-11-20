import { normalizeEthiopianMsisdn } from '@vamos/core';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { CatalogReader } from './catalog';
import type { TelegramClient, TelegramMessage, TelegramUpdate } from './client';
import {
  botLocale,
  leaguesMessage,
  matchListMessage,
  menuMessage,
  parseCommand,
  resetAskMessage,
  resetCodeMessage,
  shareMessage,
  startPayload,
  statusMessage,
  textOf,
  type BotLocale,
  type BotMessage,
} from './format';

/**
 * What the bot does with one update. Read-only by design: it shows matches and odds and links to
 * the website, tells a chat its id (for setting up the owner alerts) and gives the owner a status;
 * it never places a bet, moves money, reads an account or stores who wrote to it.
 *
 * - Players write in private chats; group chats are answered only when they are owner chats.
 * - Each chat may send BOT_RATE_LIMIT messages a minute; the rest are ignored silently.
 * - /status is for the owner chats only; for anyone else it is an unknown command.
 * - Forgot PIN (X12, while `resetCode` is set): /reset, the menu button or the website's link
 *   (/start reset) ask the person to share their own number; the code for a new PIN comes back in
 *   the chat. Only a card with the sender's own user id counts (Telegram verified that number). The
 *   code and the number are never logged.
 */

/** What the API answered for a reset code (`unavailable`: it could not be asked). */
export type ResetCodeResult =
  | { status: 'sent'; code: string }
  | { status: 'no_account' }
  | { status: 'limited' }
  | { status: 'cooldown'; seconds: number }
  | { status: 'unavailable' };

export interface BotDeps {
  client: TelegramClient;
  catalog: CatalogReader;
  redis: Pick<Redis, 'incr' | 'expire'>;
  logger: Pick<Logger, 'warn' | 'info'>;
  clock: () => Date;
  /** The website (PUBLIC_WEB_URL): every match button opens it there. */
  webUrl: string;
  ownerChatIds: ReadonlySet<number>;
  /** TELEGRAM_PLAYER_MENU: players may ask for matches. Off: only /id and the owner's commands. */
  playerMenu: boolean;
  /** Play-money mode: every match list says DEMO. */
  demo: boolean;
  /** The owner's /status (the SMS rail health), or null when it cannot be read. */
  status?: () => Promise<{
    lastGatewaySmsAt: Date | null;
    reviewQueue: number;
    manualPayoutsOpen: number;
  } | null>;
  /** Redis key prefix of the per-chat rate limit (tests use their own). */
  rateKeyPrefix?: string;
  /** The bot's own username (from getMe), for "Share with friends". Unset: no share button. */
  botUsername?: string;
  /** Asks the API for a PIN reset code for a proven number. Unset: no reset in the bot. */
  resetCode?: (input: { phone: string; chatId: number }) => Promise<ResetCodeResult>;
}

/** Messages (and button presses) one chat may send per minute. */
export const BOT_RATE_LIMIT = 20;

async function withinRate(deps: BotDeps, chatId: number): Promise<boolean> {
  const key = `${deps.rateKeyPrefix ?? 'vamos:telegram:rate:'}${chatId}`;
  try {
    const count = await deps.redis.incr(key);
    if (count === 1) await deps.redis.expire(key, 60);
    return count <= BOT_RATE_LIMIT;
  } catch {
    // Redis down: answer anyway (the bot only reads public data).
    return true;
  }
}

async function send(deps: BotDeps, chatId: number, message: BotMessage | string): Promise<void> {
  const body = typeof message === 'string' ? { text: message } : message;
  await deps.client.sendMessage(
    chatId,
    body.text,
    body.replyMarkup === undefined ? {} : { replyMarkup: body.replyMarkup },
  );
}

async function matches(
  deps: BotDeps,
  chatId: number,
  locale: BotLocale,
  title: string,
  query: Parameters<CatalogReader['events']>[0],
): Promise<void> {
  const t = textOf(locale);
  let events;
  try {
    events = await deps.catalog.events(query);
  } catch (error) {
    deps.logger.warn({ err: error }, 'telegram bot: the catalogue could not be read');
    await send(deps, chatId, t.unavailable);
    return;
  }
  await send(
    deps,
    chatId,
    matchListMessage({ title, events, locale, webUrl: deps.webUrl, demo: deps.demo }),
  );
}

async function leagues(deps: BotDeps, chatId: number, locale: BotLocale): Promise<void> {
  try {
    await send(deps, chatId, leaguesMessage(await deps.catalog.featuredLeagues(), locale));
  } catch (error) {
    deps.logger.warn({ err: error }, 'telegram bot: the leagues could not be read');
    await send(deps, chatId, textOf(locale).unavailable);
  }
}

/** Runs one player action ("today", "live", "top", "leagues", "start"…) for a chat. */
async function act(
  deps: BotDeps,
  chatId: number,
  locale: BotLocale,
  action: string,
  owner: boolean,
): Promise<void> {
  const t = textOf(locale);
  if (action === 'id') {
    await send(deps, chatId, `${t.chatId} ${chatId}`);
    return;
  }
  if (action === 'status' && owner) {
    const health = deps.status === undefined ? null : await deps.status().catch(() => null);
    await send(
      deps,
      chatId,
      health === null ? t.statusUnavailable : statusMessage(health, deps.clock(), locale),
    );
    return;
  }
  if (action === 'reset' && deps.resetCode !== undefined) {
    await send(deps, chatId, resetAskMessage(locale));
    return;
  }
  if (!deps.playerMenu) {
    await send(deps, chatId, `${t.alertsOnly}\n${owner ? '/status, /id' : '/id'}`);
    return;
  }
  switch (action) {
    case 'today':
      return matches(deps, chatId, locale, t.titleToday, { filter: 'today', limit: 10 });
    case 'live':
      return matches(deps, chatId, locale, t.titleLive, { filter: 'live', limit: 10 });
    case 'top':
    case 'highlights':
      return matches(deps, chatId, locale, t.titleTop, { filter: 'highlights', limit: 10 });
    case 'leagues':
      return leagues(deps, chatId, locale);
    case 'share':
      if (deps.botUsername !== undefined) {
        await send(deps, chatId, shareMessage(deps.botUsername, locale));
        return;
      }
      break;
    default:
      break;
  }
  await send(
    deps,
    chatId,
    menuMessage(locale, deps.demo, {
      reset: deps.resetCode !== undefined,
      ...(deps.botUsername === undefined ? {} : { botUsername: deps.botUsername }),
    }),
  );
}

/**
 * A shared contact, for the PIN reset: the sender's own card only, then the code (or why not)
 * in the chat. Nothing about the account is said before the number is proven.
 */
async function resetWithContact(
  deps: BotDeps,
  message: TelegramMessage,
  locale: BotLocale,
): Promise<void> {
  const t = textOf(locale);
  const chatId = message.chat.id;
  const contact = message.contact!;
  if (message.from === undefined || contact.user_id !== message.from.id) {
    await send(deps, chatId, { ...resetAskMessage(locale), text: t.resetNotOwn });
    return;
  }
  const raw = contact.phone_number.trim();
  const phone = normalizeEthiopianMsisdn(raw.startsWith('+') ? raw : `+${raw}`);
  const done = { remove_keyboard: true } as const;
  if (phone === null) {
    // Not an Ethiopian mobile number: no Nahubet account can have it.
    await send(deps, chatId, { text: t.resetNoAccount, replyMarkup: done });
    return;
  }
  let result: ResetCodeResult;
  try {
    result = await deps.resetCode!({ phone, chatId });
  } catch (error) {
    deps.logger.warn({ err: error }, 'telegram bot: the reset code could not be asked for');
    result = { status: 'unavailable' };
  }
  if (result.status === 'sent') {
    await send(deps, chatId, resetCodeMessage(result.code, locale, deps.webUrl));
    return;
  }
  const text =
    result.status === 'no_account'
      ? t.resetNoAccount
      : result.status === 'limited'
        ? t.resetLimited
        : result.status === 'cooldown'
          ? t.resetCooldown.replace('{seconds}', String(result.seconds))
          : t.resetUnavailable;
  await send(deps, chatId, { text, replyMarkup: done });
}

export async function handleUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  if (update.callback_query !== undefined) {
    const query = update.callback_query;
    const chat = query.message?.chat;
    // Answer the press first, so the button stops spinning whatever happens next.
    await deps.client.answerCallbackQuery(query.id).catch(() => {});
    if (chat === undefined || query.from.is_bot === true) return;
    const owner = deps.ownerChatIds.has(chat.id);
    if (chat.type !== 'private' && !owner) return;
    if (!(await withinRate(deps, chat.id))) return;
    const locale = botLocale(query.from.language_code);
    const data = query.data ?? '';
    if (data.startsWith('m:')) {
      await act(deps, chat.id, locale, data.slice(2), owner);
    } else if (data.startsWith('lg:') && deps.playerMenu) {
      await matches(deps, chat.id, locale, textOf(locale).titleLeague, {
        filter: 'upcoming',
        competition: data.slice(3),
        limit: 10,
      });
    }
    return;
  }
  const message = update.message;
  if (message === undefined || message.from?.is_bot === true) return;
  const chatId = message.chat.id;
  const owner = deps.ownerChatIds.has(chatId);
  if (message.chat.type !== 'private' && !owner) return;
  const locale = botLocale(message.from?.language_code);
  if (message.contact !== undefined) {
    // A number is only ever shared for the PIN reset, and only in a private chat.
    if (message.chat.type !== 'private' || deps.resetCode === undefined) return;
    if (!(await withinRate(deps, chatId))) return;
    await resetWithContact(deps, message, locale);
    return;
  }
  const command = parseCommand(message.text);
  if (command === null && message.chat.type !== 'private') return;
  if (!(await withinRate(deps, chatId))) return;
  const action =
    command === 'start' && startPayload(message.text) === 'reset' ? 'reset' : (command ?? 'start');
  await act(deps, chatId, locale, action, owner);
}
