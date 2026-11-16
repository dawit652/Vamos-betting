/**
 * A minimal Telegram Bot API client (https://core.telegram.org/bots/api), over fetch: the few
 * methods the bot uses and nothing else. The token is part of every request URL, so it never
 * appears in an error, a log line or a thrown message (scrubbed).
 */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  language_code?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/** A call the Bot API refused (`ok: false`), or an HTTP error without a body. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    /** The API's error_code (or the HTTP status). */
    readonly code: number,
    description: string,
    /** Seconds to wait after a 429, when the API says so. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`telegram ${method}: ${code} ${description}`);
    this.name = 'TelegramError';
  }
}

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  /** Long polling: waits up to `timeoutSeconds` for updates after `offset`. */
  getUpdates(input: {
    offset?: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: InlineKeyboard },
  ): Promise<TelegramMessage>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface TelegramClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Default https://api.telegram.org (tests pass their own). */
  baseUrl?: string;
  /** Time limit of a call other than the long poll (default 10 s). */
  timeoutMs?: number;
}

interface ApiAnswer<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  const { token } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const scrub = (text: string) => (token.length > 0 ? text.split(token).join('<token>') : text);

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    limitMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(limitMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const reason = scrub(error instanceof Error ? error.message : String(error));
      // The original error is not attached: it can carry the request URL, which holds the token.
      // eslint-disable-next-line preserve-caught-error -- the caught error may contain the bot token
      throw new Error(`telegram ${method} failed: ${reason}`);
    }
    let answer: ApiAnswer<T> | null;
    try {
      answer = (await response.json()) as ApiAnswer<T>;
    } catch {
      answer = null;
    }
    if (answer === null || !answer.ok || answer.result === undefined) {
      throw new TelegramError(
        method,
        answer?.error_code ?? response.status,
        scrub(answer?.description ?? response.statusText ?? 'error'),
        answer?.parameters?.retry_after,
      );
    }
    return answer.result;
  }

  return {
    getMe: () => call<TelegramUser>('getMe', {}, timeoutMs),
    getUpdates: ({ offset, timeoutSeconds, signal }) =>
      call<TelegramUpdate[]>(
        'getUpdates',
        {
          ...(offset === undefined ? {} : { offset }),
          timeout: timeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        },
        // The long poll itself plus a margin for the network.
        timeoutSeconds * 1000 + 10_000,
        signal,
      ),
    sendMessage: (chatId, text, opts) =>
      call<TelegramMessage>(
        'sendMessage',
        {
          chat_id: chatId,
          // Plain text on purpose (no parse_mode): team names come from the feed and can hold any
          // character, so nothing can be read as markup.
          text,
          link_preview_options: { is_disabled: true },
          ...(opts?.replyMarkup === undefined ? {} : { reply_markup: opts.replyMarkup }),
        },
        timeoutMs,
      ),
    answerCallbackQuery: async (callbackQueryId, text) => {
      await call<boolean>(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, ...(text === undefined ? {} : { text }) },
        timeoutMs,
      );
    },
  };
}
