import { randomUUID } from 'node:crypto';
import type { EventSummary } from '@vamos/contracts';
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
    expect(message.replyMarkup!.inline_keyboard.flat()).toEqual([
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
  const sent: { chatId: number; text: string; replyMarkup?: InlineKeyboard }[] = [];
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
      sent[1]!
        .replyMarkup!.inline_keyboard.flat()
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
