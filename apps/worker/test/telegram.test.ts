import { createHmac, randomUUID } from 'node:crypto';
import { telegramResetSigningInput, type EventSummary } from '@vamos/contracts';
import { OWNER_ALERT } from '@vamos/db';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processOwnerAlertJob } from '../src/tasks/owner-alert';
import { handleUpdate, BOT_RATE_LIMIT, type BotDeps } from '../src/telegram/bot';
import type { CatalogReader } from '../src/telegram/catalog';
import { flagOf } from '../src/telegram/catalog';
import {
  createTelegramClient,
  TelegramError,
  type InlineKeyboard,
  type ReplyMarkup,
  type TelegramClient,
  type TelegramUpdate,
} from '../src/telegram/client';
import {
  addisTime,
  botLocale,
  leaguesMessage,
  matchLine,
  matchListMessage,
  MAX_MATCHES_PER_MESSAGE,
  parseCommand,
  statusMessage,
} from '../src/telegram/format';
import { createResetCodeRequester } from '../src/telegram/reset';
import { telegramBotTask } from '../src/telegram/task';
import { createWorkerTestContext, SETUP_TIMEOUT, type WorkerTestContext } from './helpers';

const TOKEN = '123456789:AAH' + 'secretsecretsecretsecretsecret12';
const WEB = 'https://nahubet.example';

function event(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 'ev-1',
    gameId: '37921',
    sport: 'football',
    competition: {
      slug: 'premier-league',
      name: { en: 'Premier League' },
      category: { en: 'England' },
    },
    home: { id: 'h', name: { en: 'Arsenal', am: 'አርሰናል' }, shortName: 'ARS' },
    away: { id: 'a', name: { en: 'Chelsea' }, shortName: 'CHE' },
    startTime: '2026-11-16T12:30:00.000Z',
    status: 'scheduled',
    liveMinute: null,
    period: null,
    score: null,
    mainMarket: {
      id: 'm',
      type: '1x2',
      line: null,
      name: { en: 'Match Result' },
      status: 'open',
      selections: [
        { id: '1', code: '1', label: { en: '1' }, oddsMilli: 2070, open: true },
        { id: 'x', code: 'x', label: { en: 'X' }, oddsMilli: 3770, open: true },
        { id: '2', code: '2', label: { en: '2' }, oddsMilli: 3210, open: true },
      ],
    },
    marketCount: 18,
    optionCount: 64,
    ...overrides,
  };
}

describe('telegram: what the bot says', () => {
  it('writes a match with its Addis Ababa time, prices and more options', () => {
    expect(addisTime('2026-11-16T12:30:00.000Z')).toBe('15:30');
    expect(matchLine(event(), 'en')).toBe(
      '15:30  Arsenal v Chelsea\n   1 2.07 · X 3.77 · 2 3.21 (+64 more options)',
    );
    // Amharic names where the feed has them, English otherwise.
    expect(matchLine(event(), 'am')).toContain('አርሰናል v Chelsea');
  });

  it('shows the live minute and score, and no prices for a suspended market', () => {
    const live = event({
      status: 'live',
      liveMinute: 67,
      score: { home: 1, away: 0 },
      mainMarket: { ...event().mainMarket!, status: 'suspended' },
      optionCount: 0,
    });
    expect(matchLine(live, 'en')).toBe("LIVE 67' 1-0  Arsenal v Chelsea");
  });

  it('lists at most 10 matches, each with a button to the website, DEMO and the 21+ line', () => {
    const many = Array.from({ length: 14 }, (_, i) => event({ id: `ev-${i}` }));
    const message = matchListMessage({
      title: 'Today',
      events: many,
      locale: 'en',
      webUrl: WEB,
      demo: true,
    });
    expect(message.text.startsWith('DEMO: play money only.\nToday')).toBe(true);
    expect(message.text.endsWith('21+ only. Bet responsibly.')).toBe(true);
    const buttons = (message.replyMarkup as InlineKeyboard).inline_keyboard.flat();
    expect(buttons).toHaveLength(MAX_MATCHES_PER_MESSAGE);
    expect(buttons[0]).toEqual({ text: 'Open: Arsenal v Chelsea', url: `${WEB}/event/ev-0` });
    const empty = matchListMessage({
      title: 'Live now',
      events: [],
      locale: 'en',
      webUrl: WEB,
      demo: false,
    });
    expect(empty.text).toContain('No matches to show right now.');
    expect(empty.replyMarkup).toBeUndefined();
  });

  it('builds league buttons, leaving out a slug too long for Telegram (64 bytes)', () => {
    const message = leaguesMessage(
      [
        {
          slug: 'premier-league',
          name: { en: 'Premier League' },
          flag: flagOf('GB'),
          eventCount: 9,
        },
        { slug: 'x'.repeat(70), name: { en: 'Too long' }, flag: flagOf(null), eventCount: 1 },
      ],
      'en',
    );
    expect((message.replyMarkup as InlineKeyboard).inline_keyboard.flat()).toEqual([
      { text: '🇬🇧 Premier League (9)', callback_data: 'lg:premier-league' },
    ]);
    expect(flagOf('ET')).toBe('🇪🇹');
    expect(flagOf('GB-ENG')).toBe(
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    );
    expect(flagOf(null)).toBe('🌍');
  });

  it('reads commands and the language, and writes the owner status', () => {
    expect(parseCommand('/today')).toBe('today');
    expect(parseCommand('/Live@NahubetBot now')).toBe('live');
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(botLocale('am-ET')).toBe('am');
    expect(botLocale('en')).toBe('en');
    expect(botLocale(undefined)).toBe('en');
    const now = new Date('2026-11-16T12:00:00Z');
    expect(
      statusMessage(
        {
          lastGatewaySmsAt: new Date('2026-11-16T11:57:00Z'),
          reviewQueue: 2,
          manualPayoutsOpen: 1,
        },
        now,
        'en',
      ),
    ).toBe(
      'Nahubet status\nLast SMS from the handset: 3 min\nSMS waiting for staff: 2\nManual payouts open: 1',
    );
  });
});

describe('telegram: the client', () => {
  it('calls the method on the token URL and returns the result', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createTelegramClient({
      token: TOKEN,
      baseUrl: 'https://tg.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: 5, type: 'private' } } }),
        );
      }) as unknown as typeof fetch,
    });
    expect((await client.sendMessage(5, 'hi')).message_id).toBe(7);
    expect(calls[0]!.url).toBe(`https://tg.test/bot${TOKEN}/sendMessage`);
    // Plain text: no parse_mode, so nothing in a team name can be read as markup.
    expect(calls[0]!.body).toMatchObject({ chat_id: 5, text: 'hi' });
    expect(calls[0]!.body).not.toHaveProperty('parse_mode');
  });

  it('never puts the token in an error', async () => {
    const failing = createTelegramClient({
      token: TOKEN,
      baseUrl: 'https://tg.test',
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED https://tg.test/bot${TOKEN}/getMe`);
      },
    });
    const error = (await failing.getMe().catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('<token>');
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);

    const refused = createTelegramClient({
      token: TOKEN,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 3 },
          }),
          { status: 429 },
        ),
    });
    const tooMany = await refused.getMe().catch((e: unknown) => e);
    expect(tooMany).toBeInstanceOf(TelegramError);
    expect(tooMany).toMatchObject({ code: 429, retryAfterSeconds: 3 });
  });
});

/** A Telegram client that records what the bot sends. */
function fakeClient() {
  const sent: { chatId: number; text: string; replyMarkup?: ReplyMarkup }[] = [];
  const answered: string[] = [];
  const client: TelegramClient = {
    getMe: async () => ({ id: 1, username: 'NahubetBot' }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, options) => {
      sent.push({
        chatId,
        text,
        ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
      });
      return { message_id: sent.length, chat: { id: chatId, type: 'private' } };
    },
    answerCallbackQuery: async (id) => {
      answered.push(id);
    },
  };
  return { client, sent, answered };
}

function memoryRedis() {
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  return {
    incr: async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async () => 1,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return 'OK' as const;
    },
    values,
  };
}

const quiet = { warn: () => undefined, info: () => undefined } as unknown as Logger;
const OWNER = 4242;

function botDeps(overrides: Partial<BotDeps> = {}) {
  const fake = fakeClient();
  const queries: Parameters<CatalogReader['events']>[0][] = [];
  const catalog: CatalogReader = {
    events: async (query) => {
      queries.push(query);
      return [event()];
    },
    featuredLeagues: async () => [
      { slug: 'premier-league', name: { en: 'Premier League' }, flag: '🇬🇧', eventCount: 9 },
    ],
  };
  const deps: BotDeps = {
    client: fake.client,
    catalog,
    redis: memoryRedis(),
    logger: quiet,
    clock: () => new Date('2026-11-16T12:00:00Z'),
    webUrl: WEB,
    ownerChatIds: new Set([OWNER]),
    playerMenu: true,
    demo: false,
    status: async () => ({ lastGatewaySmsAt: null, reviewQueue: 0, manualPayoutsOpen: 0 }),
    ...overrides,
  };
  return { deps, ...fake, queries };
}

let updateId = 0;
const message = (
  chatId: number,
  text: string,
  type: 'private' | 'group' = 'private',
): TelegramUpdate => ({
  update_id: (updateId += 1),
  message: {
    message_id: updateId,
    chat: { id: chatId, type },
    from: { id: chatId, language_code: 'en' },
    text,
  },
});
const press = (chatId: number, data: string): TelegramUpdate => ({
  update_id: (updateId += 1),
  callback_query: {
    id: `cb${updateId}`,
    from: { id: chatId, language_code: 'en' },
    message: { message_id: 1, chat: { id: chatId, type: 'private' } },
    data,
  },
});

describe('telegram: the bot', () => {
  it('answers a player in a private chat with today’s matches and a menu for anything else', async () => {
    const { deps, sent, queries } = botDeps();
    await handleUpdate(deps, message(7, '/today'));
    expect(queries).toEqual([{ filter: 'today', limit: 10 }]);
    expect(sent[0]!.text).toContain('Today’s matches');
    expect(sent[0]!.text).toContain('Arsenal v Chelsea');
    await handleUpdate(deps, message(7, 'hello'));
    expect(sent[1]!.text).toContain('Welcome to Nahubet');
    expect(
      (sent[1]!.replyMarkup as InlineKeyboard).inline_keyboard
        .flat()
        .map((b) => 'callback_data' in b && b.callback_data),
    ).toEqual(['m:today', 'm:live', 'm:top', 'm:leagues']);
  });

  it('follows the buttons: live, the leagues, then one league’s matches', async () => {
    const { deps, sent, queries, answered } = botDeps();
    await handleUpdate(deps, press(7, 'm:live'));
    await handleUpdate(deps, press(7, 'm:leagues'));
    await handleUpdate(deps, press(7, 'lg:premier-league'));
    expect(answered).toHaveLength(3);
    expect(queries).toEqual([
      { filter: 'live', limit: 10 },
      { filter: 'upcoming', competition: 'premier-league', limit: 10 },
    ]);
    expect(sent[1]!.text).toBe('Choose a league:');
  });

  it('ignores group chats that are not owner chats, and other bots', async () => {
    const { deps, sent } = botDeps();
    await handleUpdate(deps, message(-100, '/today', 'group'));
    const fromBot = message(7, '/today');
    fromBot.message!.from!.is_bot = true;
    await handleUpdate(deps, fromBot);
    expect(sent).toHaveLength(0);
  });

  it('tells any chat its id, and gives /status to owner chats only', async () => {
    const { deps, sent } = botDeps();
    await handleUpdate(deps, message(7, '/id'));
    expect(sent[0]!.text).toBe('This chat’s id: 7');
    await handleUpdate(deps, message(7, '/status'));
    expect(sent[1]!.text).toContain('Welcome to Nahubet');
    await handleUpdate(deps, message(OWNER, '/status'));
    expect(sent[2]!.text).toContain('Nahubet status');
    expect(sent[2]!.text).toContain('Last SMS from the handset: never');
  });

  it('with the player menu off answers only /id and the owner’s commands', async () => {
    const { deps, sent, queries } = botDeps({ playerMenu: false });
    await handleUpdate(deps, message(7, '/today'));
    await handleUpdate(deps, press(7, 'lg:premier-league'));
    expect(queries).toHaveLength(0);
    expect(sent[0]!.text).toContain('This bot sends alerts only.');
    await handleUpdate(deps, message(7, '/id'));
    expect(sent.at(-1)!.text).toBe('This chat’s id: 7');
  });

  it('says so when the catalogue cannot be read', async () => {
    const { deps, sent } = botDeps({
      catalog: {
        events: async () => {
          throw new Error('down');
        },
        featuredLeagues: async () => {
          throw new Error('down');
        },
      },
    });
    await handleUpdate(deps, message(7, '/live'));
    await handleUpdate(deps, message(7, '/leagues'));
    expect(sent.map((s) => s.text)).toEqual([
      'Matches are not available right now. Try again in a minute.',
      'Matches are not available right now. Try again in a minute.',
    ]);
  });

  it(`answers at most ${BOT_RATE_LIMIT} messages a minute per chat`, async () => {
    const { deps, sent } = botDeps();
    for (let i = 0; i < BOT_RATE_LIMIT + 5; i += 1) await handleUpdate(deps, message(9, '/id'));
    expect(sent).toHaveLength(BOT_RATE_LIMIT);
  });
});

describe('telegram: polling', () => {
  it('handles the updates, keeps the offset, and stops promptly', async () => {
    const { deps, sent } = botDeps();
    const redis = memoryRedis();
    let polls = 0;
    const offsets: (number | undefined)[] = [];
    deps.client.getUpdates = async ({ offset, signal }) => {
      polls += 1;
      offsets.push(offset);
      if (polls === 1) return [message(7, '/id'), message(8, '/id')];
      // Then wait like a long poll until stopped.
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return [];
    };
    const task = telegramBotTask(
      { ...deps, redis, logger: { ...quiet, error: () => undefined } },
      { offsetKey: 'test:offset', retryMs: 10 },
    );
    await task.start();
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await task.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent.map((s) => s.chatId)).toEqual([7, 8]);
    const lastId = updateId;
    expect(redis.values.get('test:offset')).toBe(String(lastId + 1));
    expect(offsets[1]).toBe(lastId + 1);
  });

  it('raises telegram_bot_unauthorized when Telegram refuses the token', async () => {
    const { deps } = botDeps();
    const alarms: string[] = [];
    deps.client.getUpdates = async () => {
      throw new TelegramError('getUpdates', 401, 'Unauthorized');
    };
    const logger = {
      ...quiet,
      error: (obj: { alarm?: string }) => {
        if (obj.alarm) alarms.push(obj.alarm);
      },
    } as unknown as Logger;
    const task = telegramBotTask(
      { ...deps, redis: memoryRedis(), logger },
      { offsetKey: 'test:o2' },
    );
    await task.start();
    await new Promise((r) => setTimeout(r, 50));
    await task.stop();
    expect(alarms).toEqual(['telegram_bot_unauthorized']);
  });
});

describe('telegram: owner alerts', () => {
  let t: WorkerTestContext;
  beforeAll(async () => {
    t = await createWorkerTestContext();
  }, SETUP_TIMEOUT);
  afterAll(async () => {
    await t?.close();
  }, SETUP_TIMEOUT);

  it('sends an owner alert to the Telegram chats too, even with no phone number', async () => {
    const { client, sent } = fakeClient();
    const key = `budget_exhausted|${randomUUID()}`;
    const result = await processOwnerAlertJob(
      {
        ...t.ctx,
        telegram: client,
        ownerAlerts: { phones: [], telegramChatIds: [111, -222], minIntervalMinutes: 30 },
      },
      {
        outboxId: '1',
        type: OWNER_ALERT,
        key,
        message: 'Odds reads are stopped.',
        raisedAt: t.clock.now.toISOString(),
      },
    );
    expect(result).toMatchObject({ sent: true, recipients: 2 });
    expect(sent.map((s) => [s.chatId, s.text])).toEqual([
      [111, 'Odds reads are stopped.'],
      [-222, 'Odds reads are stopped.'],
    ]);
  });
});

describe('Telegram bot: Forgot PIN (X12)', () => {
  const contact = (chatId: number, phone: string, userId: number | undefined): TelegramUpdate => ({
    update_id: (updateId += 1),
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, language_code: 'en' },
      contact: { phone_number: phone, ...(userId === undefined ? {} : { user_id: userId }) },
    },
  });
  const asked: { phone: string; chatId: number }[] = [];
  const lines: string[] = [];
  const recording = {
    warn: (...args: unknown[]) => lines.push(JSON.stringify(args)),
    info: (...args: unknown[]) => lines.push(JSON.stringify(args)),
  } as unknown as Logger;
  const withReset = (result: Awaited<ReturnType<NonNullable<BotDeps['resetCode']>>>) =>
    botDeps({
      logger: recording,
      resetCode: async (input) => {
        asked.push(input);
        return result;
      },
    });

  it('asks for the number with the share button, from /reset, the menu and /start reset', async () => {
    const { deps, sent } = withReset({ status: 'sent', code: '123456' });
    await handleUpdate(deps, message(70, '/reset'));
    await handleUpdate(deps, press(70, 'm:reset'));
    await handleUpdate(deps, message(70, '/start reset'));
    expect(sent).toHaveLength(3);
    for (const reply of sent) {
      expect(reply.text).toContain('share your phone number');
      expect(reply.replyMarkup).toMatchObject({
        keyboard: [[{ text: 'Share my phone number', request_contact: true }]],
      });
    }
    // The menu offers it.
    await handleUpdate(deps, message(70, '/start'));
    expect(JSON.stringify(sent[3]!.replyMarkup)).toContain('m:reset');
  });

  it("sends the code for the sender's own number, with a button to the reset page", async () => {
    asked.length = 0;
    lines.length = 0;
    const { deps, sent } = withReset({ status: 'sent', code: '482913' });
    await handleUpdate(deps, contact(71, '251911234567', 71));
    expect(asked).toEqual([{ phone: '+251911234567', chatId: 71 }]);
    expect(sent[0]!.text).toContain('482913');
    expect(JSON.stringify(sent[0]!.replyMarkup)).toContain(`${WEB}/reset-password`);
    // Never in a log line: neither the code nor the number.
    expect(lines.join('\n')).not.toContain('482913');
    expect(lines.join('\n')).not.toContain('911234567');
  });

  it("refuses someone else's card, and tells only the number's owner there is no account", async () => {
    asked.length = 0;
    const { deps, sent } = withReset({ status: 'no_account' });
    await handleUpdate(deps, contact(72, '+251911234567', 999));
    await handleUpdate(deps, contact(72, '+251911234567', undefined));
    expect(asked).toEqual([]);
    expect(sent.map((s) => s.text)).toEqual([
      'Please share your own number with the button below.',
      'Please share your own number with the button below.',
    ]);
    await handleUpdate(deps, contact(72, '+251911234567', 72));
    expect(sent[2]!.text).toContain('No Nahubet account uses this number');
    // A foreign number cannot have an account: the API is not even asked.
    await handleUpdate(deps, contact(72, '+447700900123', 72));
    expect(asked).toHaveLength(1);
  });

  it('says when the number asked too often or the code cannot be had', async () => {
    const limited = withReset({ status: 'limited' });
    await handleUpdate(limited.deps, contact(73, '+251911234567', 73));
    expect(limited.sent[0]!.text).toContain('Try again in an hour');
    const failing = botDeps({
      logger: recording,
      resetCode: async () => {
        throw new Error('network down');
      },
    });
    await handleUpdate(failing.deps, contact(74, '+251911234567', 74));
    expect(failing.sent[0]!.text).toContain('cannot be sent right now');
  });

  it('tells a number that just got a code to use it, with the seconds to wait', async () => {
    const { deps, sent } = withReset({ status: 'cooldown', seconds: 42 });
    await handleUpdate(deps, contact(76, '+251911234567', 76));
    expect(sent[0]!.text).toContain('A code was sent a moment ago');
    expect(sent[0]!.text).toContain('42 seconds');
  });

  it('ignores a shared number while the reset is off, or in a group', async () => {
    const off = botDeps();
    await handleUpdate(off.deps, contact(75, '+251911234567', 75));
    expect(off.sent).toEqual([]);
    const { deps, sent } = withReset({ status: 'sent', code: '111111' });
    await handleUpdate(deps, {
      update_id: (updateId += 1),
      message: {
        message_id: updateId,
        chat: { id: OWNER, type: 'group' },
        from: { id: OWNER },
        contact: { phone_number: '+251911234567', user_id: OWNER },
      },
    });
    expect(sent).toEqual([]);
  });
});

describe('createResetCodeRequester', () => {
  const SECRET = 'test-session-secret-0123456789abcdef0123456789';
  const clock = () => new Date('2026-11-17T08:00:00Z');

  it('signs the request the way the API checks it, and reads the code', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const ask = createResetCodeRequester({
      baseUrl: 'http://api:4000/',
      secret: SECRET,
      clock,
      fetch: async (url, init) => {
        seen = {
          url: url as string,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        };
        return new Response(
          JSON.stringify({ status: 'sent', code: '048213', expiresAt: '2026-11-17T08:05:00Z' }),
          { status: 200 },
        );
      },
    });
    expect(await ask({ phone: '+251911234567', chatId: 9 })).toEqual({
      status: 'sent',
      code: '048213',
    });
    expect(seen!.url).toBe('http://api:4000/internal/telegram/password-reset');
    const body = JSON.parse(seen!.body) as { phone: string; chatId: number; timestamp: number };
    expect(body).toEqual({ phone: '+251911234567', chatId: 9, timestamp: 1_794_902_400 });
    const expected = createHmac('sha256', SECRET)
      .update(telegramResetSigningInput(body))
      .digest('hex');
    expect(seen!.headers['x-vamos-signature']).toBe(expected);
  });

  it('turns 429 into limited and anything unexpected into unavailable', async () => {
    const answer = (status: number, body: unknown) =>
      createResetCodeRequester({
        baseUrl: 'http://api:4000',
        secret: SECRET,
        clock,
        fetch: async () => new Response(JSON.stringify(body), { status }),
      })({ phone: '+251911234567', chatId: 9 });
    expect(await answer(429, { error: {} })).toEqual({ status: 'limited' });
    expect(
      await answer(429, { error: { code: 'otp_cooldown', details: { retryAfterSeconds: 42 } } }),
    ).toEqual({ status: 'cooldown', seconds: 42 });
    expect(await answer(429, { error: { code: 'otp_limit' } })).toEqual({ status: 'limited' });
    expect(await answer(401, { error: {} })).toEqual({ status: 'unavailable' });
    expect(await answer(200, { status: 'sent', code: 'abc' })).toEqual({ status: 'unavailable' });
    expect(await answer(200, { status: 'no_account' })).toEqual({ status: 'no_account' });
  });
});

describe('Telegram bot: share with friends', () => {
  it('offers Telegram’s share page for the bot’s link in the menu and on /share', async () => {
    const { deps, sent } = botDeps({ botUsername: 'NahubetBot' });
    await handleUpdate(deps, message(80, '/start'));
    const menu = JSON.stringify(sent[0]!.replyMarkup);
    expect(menu).toContain('https://t.me/share/url?url=https%3A%2F%2Ft.me%2FNahubetBot');
    await handleUpdate(deps, message(80, '/share'));
    expect(sent[1]!.text).toContain('https://t.me/NahubetBot');
    expect(sent[1]!.replyMarkup).toMatchObject({
      inline_keyboard: [[{ text: 'Share with friends' }]],
    });
  });

  it('answers /share with the menu while the bot does not know its name', async () => {
    const { deps, sent } = botDeps();
    await handleUpdate(deps, message(81, '/share'));
    expect(sent[0]!.text).toContain('Welcome to Nahubet');
    expect(JSON.stringify(sent[0]!.replyMarkup)).not.toContain('t.me/share');
  });
});
