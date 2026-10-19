import { birr, formatMoney, quoteBet, USSD_MAX_LENGTH } from '@vamos/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBalance,
  pruneUssdSessions,
  USSD_MAX_CALLBACKS,
  USSD_SESSION_RETENTION_MS,
  USSD_SESSION_TTL_MS,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { bets, inboundMessages, rgExclusions, users, ussdSessions } from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  goLive,
  reprice,
  type TestDb,
} from './betting-fixtures';
import {
  channelPlayer,
  dialUssd,
  gameIdOf,
  receiveSms,
  smsFrom,
  unknownPhone,
  unusedGameId,
  ussdSessionId,
} from './channel-fixtures';
import { cash, dropTestDatabase } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function game(options: Parameters<typeof createEvent>[2] = {}) {
  const event = await createEvent(handle.db, ids, options);
  return { event, gameId: await gameIdOf(handle.db, event.eventId) };
}

async function betsOf(userId: string) {
  return handle.db.select().from(bets).where(eq(bets.userId, userId)).orderBy(asc(bets.placedAt));
}

async function sessionRow(sessionId: string) {
  const [row] = await handle.db
    .select()
    .from(ussdSessions)
    .where(eq(ussdSessions.sessionId, sessionId));
  return row;
}

/** Runs a session's callbacks (texts are the '*'-joined history), returning every response. */
async function session(phone: string, inputs: string[], now: Date = new Date()) {
  const sessionId = ussdSessionId();
  const responses: string[] = [];
  let text = '';
  const first = await dialUssd(handle.db, { sessionId, phone, text }, now);
  responses.push(first.response);
  for (const input of inputs) {
    text = text === '' ? input : `${text}*${input}`;
    const result = await dialUssd(handle.db, { sessionId, phone, text }, now);
    responses.push(result.response);
  }
  return { sessionId, text, responses, last: responses.at(-1) ?? '' };
}

const netWin = (oddsMilli: number, stake: bigint) =>
  quoteBet({
    stake,
    legs: [{ selectionId: 's', eventId: 'e', oddsMilli }],
    rules: settings.betRules,
    multiBonus: settings.multiBonus,
    tax: settings.tax,
  }).netPayout;

describe('USSD betting', () => {
  it('places a bet through the menus at the odds the confirm screen showed', async () => {
    const { event, gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const run = await session(player.phone, ['1', String(gameId), '1', '50']);
    expect(run.responses[0]).toBe(
      'CON Vamos DEMO\n1 Place bet\n2 Balance\n3 My bets\n4 Jackpot\n5 Help\n0 Exit',
    );
    expect(run.responses[1]).toBe('CON Enter Game ID:\n00 Main menu');
    expect(run.responses[2]).toContain('1 Arsenal 2.00\n2 Draw 3.20\n3 Chelsea 3.50');
    expect(run.responses[2]).toContain('4 Over 2.5 1.90\n5 Under 2.5 1.85');
    expect(run.responses[3]).toBe(
      'CON Arsenal @2.00\nEnter stake in ETB (min 5.00):\n00 Main menu',
    );
    expect(run.last).toContain('Stake ETB 50.00');
    expect(run.last).toContain(`Win ${formatMoney(netWin(2_000, birr(50)), 'en')}`);
    for (const response of run.responses) {
      expect(response.length).toBeLessThanOrEqual(USSD_MAX_LENGTH);
    }

    const confirmText = `${run.text}*1`;
    const placed = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: confirmText,
    });
    expect(placed.ended).toBe(true);
    const bet = placed.bet!;
    expect(bet).toMatchObject({
      channel: 'ussd',
      oddsChangePolicy: 'none',
      status: 'open',
      stake: birr(50),
      totalOddsMilli: 2_000n,
    });
    expect(bet.legs.map((leg) => leg.selectionId)).toEqual([event.home]);
    expect(placed.response).toBe(
      `END Bet ${bet.shortId} placed. Odds 2.00, stake ETB 50.00, possible win ETB 100.00.`,
    );
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(950));
    expect(await sessionRow(run.sessionId)).toMatchObject({
      userId: player.userId,
      betId: bet.id,
      lastText: confirmText,
      lastResponse: placed.response,
      state: { screen: 'ended' },
    });

    // The aggregator retries the confirmation: same response, no second bet.
    const retry = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: confirmText,
    });
    expect(retry).toMatchObject({ response: placed.response, replayed: true, bet: null });
    expect(await betsOf(player.userId)).toHaveLength(1);
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(950));

    // Anything after the END is refused.
    const after = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${confirmText}*1`,
    });
    expect(after.response).toBe('END Session ended. Dial *123# again.');
    expect(await betsOf(player.userId)).toHaveLength(1);
  });

  it('shows the confirm screen again when the price moved, then places at the new odds', async () => {
    const { event, gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const run = await session(player.phone, ['1', String(gameId), '2', '100']);
    expect(run.last).toContain('Draw @3.20');
    await reprice(handle.db, event.draw, 2_900);

    const moved = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${run.text}*1`,
    });
    expect(moved.ended).toBe(false);
    expect(moved.bet).toBeNull();
    expect(moved.response.startsWith('CON Odds changed to 2.90.\n')).toBe(true);
    expect(moved.response).toContain('Draw @2.90');
    expect(await betsOf(player.userId)).toEqual([]);

    const confirmed = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${run.text}*1*1`,
    });
    expect(confirmed.bet).toMatchObject({ totalOddsMilli: 2_900n, stake: birr(100) });
    expect(confirmed.bet?.legs[0]?.selectionId).toBe(event.draw);
  });

  it('a bet on a game in play waits for acceptance like a web bet', async () => {
    const { event, gameId } = await game();
    await goLive(handle.db, event.eventId);
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const now = new Date();
    const run = await session(player.phone, ['1', String(gameId), '3', '20', '1'], now);
    const [bet] = await betsOf(player.userId);
    expect(bet).toMatchObject({
      status: 'pending_acceptance',
      channel: 'ussd',
      acceptAfter: new Date(now.getTime() + settings.liveBetDelayMs),
    });
    expect(run.last).toBe(
      `END Live bet ${bet!.shortId} received, awaiting acceptance. Odds 3.50, stake ETB 20.00, possible win ETB 70.00.`,
    );
    expect(run.responses[2]).toContain(' LIVE ');
  });

  it('ends with the refusal when the bet cannot be placed', async () => {
    const { gameId } = await game();
    const poor = await channelPlayer(handle.db, { funds: birr(10) });
    const broke = await session(poor.phone, ['1', String(gameId), '1', '50', '1']);
    expect(broke.last).toBe(
      'END Your balance (ETB 10.00) is too low for a stake of ETB 50.00. No bet placed.',
    );
    expect(await betsOf(poor.userId)).toEqual([]);
    expect(await getBalance(handle.db, cash(poor.userId))).toBe(birr(10));

    const excluded = await channelPlayer(handle.db, { funds: birr(500) });
    // Excluded after the session started: checked again at placement.
    const run = await session(excluded.phone, ['1', String(gameId), '1', '50']);
    await handle.db.insert(rgExclusions).values({
      userId: excluded.userId,
      kind: 'self_exclusion',
      startsAt: new Date(Date.now() - 1_000),
      endsAt: null,
    });
    const refused = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: excluded.phone,
      text: `${run.text}*1`,
    });
    expect(refused.response).toBe('END You are self-excluded. No bet placed.');
    expect(await betsOf(excluded.userId)).toEqual([]);
  });

  it('re-prompts for an invalid or unknown Game ID and a stake outside the rules', async () => {
    const { gameId } = await game();
    const unknown = await unusedGameId(handle.db);
    const player = await channelPlayer(handle.db, { funds: birr(100) });
    const run = await session(player.phone, [
      '1',
      'abc',
      String(unknown),
      String(gameId),
      '9',
      '1',
      '4',
      '5.5',
    ]);
    expect(run.responses[2]).toBe('CON Invalid Game ID.\nEnter Game ID:\n00 Main menu');
    expect(run.responses[3]).toBe(
      `CON Game ${String(unknown).padStart(4, '0')} not found.\nEnter Game ID:\n00 Main menu`,
    );
    expect(run.responses[5]?.startsWith('CON Invalid choice.\n')).toBe(true);
    expect(run.responses[7]?.startsWith('CON Minimum stake ETB 5.00.\n')).toBe(true);
    expect(run.responses[8]?.startsWith('CON Invalid stake: whole birr only.\n')).toBe(true);
    // 00 goes back to the main menu.
    const back = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${run.text}*00`,
    });
    expect(back.response.startsWith('CON Vamos DEMO\n1 Place bet')).toBe(true);
    expect(await betsOf(player.userId)).toEqual([]);
  });

  it('answers balance, my bets, jackpot and help, ending the session', async () => {
    const player = await channelPlayer(handle.db, { funds: birr(1_234) });
    expect((await session(player.phone, ['2'])).last).toBe('END Balance ETB 1,234.00.');
    expect((await session(player.phone, ['3'])).last).toContain('END You have no bets yet.');
    expect((await session(player.phone, ['4'])).last.startsWith('END ')).toBe(true);
    expect((await session(player.phone, ['5'])).last).toContain('GAMEID#PICK#STAKE');
    expect((await session(player.phone, ['0'])).last).toBe('END Thank you for using Vamos.');
    const amharic = await channelPlayer(handle.db, { funds: birr(5), locale: 'am' });
    const am = await session(amharic.phone, ['2']);
    expect(am.responses[0]).toContain('1 ውርርድ');
    expect(am.last).toBe('END ቀሪ ሂሳብ 5.00 ብር።');
  });
});

describe('USSD sessions', () => {
  it('gives every number that is not an active, verified player the same END', async () => {
    const unverified = await channelPlayer(handle.db, {
      status: 'pending_verification',
      verified: false,
    });
    const suspended = await channelPlayer(handle.db, { status: 'suspended' });
    const responses = new Set<string>();
    for (const phone of [unknownPhone(), unverified.phone, suspended.phone]) {
      const result = await dialUssd(handle.db, { sessionId: ussdSessionId(), phone, text: '' });
      expect(result.ended).toBe(true);
      responses.add(result.response);
    }
    expect(responses.size).toBe(1);
    expect([...responses][0]).toContain('Register and verify it on the Vamos website.');
  });

  it('never acts on a session it did not start, nor after it expired', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const foreign = await dialUssd(handle.db, {
      sessionId: ussdSessionId(),
      phone: player.phone,
      text: `1*${gameId}*1*50*1`,
    });
    expect(foreign.response).toBe('END Session expired. Dial *123# again.');

    const t0 = new Date();
    const run = await session(player.phone, ['1', String(gameId), '1', '50'], t0);
    const late = await dialUssd(
      handle.db,
      { sessionId: run.sessionId, phone: player.phone, text: `${run.text}*1` },
      new Date(t0.getTime() + USSD_SESSION_TTL_MS + 1),
    );
    expect(late.response).toBe('END Session expired. Dial *123# again.');
    expect(await betsOf(player.userId)).toEqual([]);
    expect((await sessionRow(run.sessionId))?.endedAt).not.toBeNull();
  });

  it('ends a session whose text does not extend the last one, and refuses another number', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const run = await session(player.phone, ['1', String(gameId)]);
    const other = await channelPlayer(handle.db, { funds: birr(1_000) });
    const hijack = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: other.phone,
      text: `${run.text}*1`,
    });
    expect(hijack.ended).toBe(true);
    // The session itself was not touched.
    expect((await sessionRow(run.sessionId))?.lastText).toBe(run.text);

    const jumbled = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: '2*1',
    });
    expect(jumbled.response).toBe('END The service is not available. Please try again later.');
    expect(await betsOf(player.userId)).toEqual([]);
    expect(await betsOf(other.userId)).toEqual([]);
  });

  it('answers a late duplicate of an earlier callback without touching the live session', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const run = await session(player.phone, ['1', String(gameId)]);
    expect(run.last.startsWith('CON ')).toBe(true);
    const dial = (text: string) =>
      dialUssd(handle.db, { sessionId: run.sessionId, phone: player.phone, text });
    // The aggregator retries earlier callbacks after the later one was handled.
    for (const stale of ['1', '']) {
      expect(await dial(stale)).toEqual({
        response: run.last,
        ended: false,
        replayed: true,
        bet: null,
      });
    }
    expect(await sessionRow(run.sessionId)).toMatchObject({
      lastText: run.text,
      lastResponse: run.last,
      endedAt: null,
    });
    // The player's real next inputs carry on, and the bet is placed once.
    expect((await dial(`${run.text}*1`)).response.startsWith('CON ')).toBe(true);
    expect((await dial(`${run.text}*1*50`)).response.startsWith('CON ')).toBe(true);
    const confirmed = await dial(`${run.text}*1*50*1`);
    expect(confirmed.response).toMatch(/^END Bet .* placed/);
    // A stale callback after the bet keeps the receipt for a redelivered confirm.
    expect((await dial(`${run.text}*1`)).response).toBe(confirmed.response);
    expect(await dial(`${run.text}*1*50*1`)).toMatchObject({
      response: confirmed.response,
      replayed: true,
    });
    expect(await betsOf(player.userId)).toHaveLength(1);
  });

  it(`ends a session after ${USSD_MAX_CALLBACKS} callbacks`, async () => {
    const player = await channelPlayer(handle.db);
    const inputs = Array.from({ length: USSD_MAX_CALLBACKS - 1 }, () => '00');
    const run = await session(player.phone, inputs);
    expect(run.last.startsWith('CON ')).toBe(true);
    const over = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${run.text}*00`,
    });
    expect(over.response).toBe('END Session expired. Dial *123# again.');
    expect((await sessionRow(run.sessionId))?.endedAt).not.toBeNull();
  });

  it('shares the per-number budget with SMS', async () => {
    const player = await channelPlayer(handle.db);
    const limits = [{ max: 2, windowMs: 60_000 }];
    const now = new Date();
    for (let i = 0; i < 2; i += 1) {
      await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), now);
    }
    const limited = await dialUssd(
      handle.db,
      { sessionId: ussdSessionId(), phone: player.phone, text: '' },
      now,
      { rateLimits: limits },
    );
    expect(limited.response).toBe('END Too many requests. Please try again later.');
  });

  it('limits new sessions per number', async () => {
    const player = await channelPlayer(handle.db);
    const limits = [{ max: 2, windowMs: 60_000 }];
    const now = new Date();
    for (let i = 0; i < 2; i += 1) {
      const ok = await dialUssd(
        handle.db,
        { sessionId: ussdSessionId(), phone: player.phone, text: '' },
        now,
        { rateLimits: limits },
      );
      expect(ok.response.startsWith('CON ')).toBe(true);
    }
    const limited = await dialUssd(
      handle.db,
      { sessionId: ussdSessionId(), phone: player.phone, text: '' },
      now,
      { rateLimits: limits },
    );
    expect(limited.response).toBe('END Too many requests. Please try again later.');
  });

  it('checks the player again on every callback', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const run = await session(player.phone, ['1', String(gameId), '1', '50']);
    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, player.userId));
    const result = await dialUssd(handle.db, {
      sessionId: run.sessionId,
      phone: player.phone,
      text: `${run.text}*1`,
    });
    expect(result.response).toContain('Register and verify it on the Vamos website.');
    expect(await betsOf(player.userId)).toEqual([]);
  });
});

describe('USSD session retention', () => {
  it('prunes expired sessions without a bet in bounded batches, keeping bets and inbound texts', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const t0 = new Date('2021-03-01T09:00:00.000Z');
    const plain = [
      await session(player.phone, [], t0),
      await session(player.phone, ['2'], t0),
      await session(unknownPhone(), [], t0),
    ];
    const withBet = await session(player.phone, ['1', String(gameId), '1', '50', '1'], t0);
    expect(withBet.last).toMatch(/^END Bet .* placed/);
    const sms = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), t0);
    const ids = [...plain, withBet].map((run) => run.sessionId);
    const left = async () =>
      (
        await handle.db
          .select({ sessionId: ussdSessions.sessionId })
          .from(ussdSessions)
          .where(inArray(ussdSessions.sessionId, ids))
      ).map((row) => row.sessionId);

    const expired = t0.getTime() + USSD_SESSION_TTL_MS;
    // Not yet past the retention window: nothing goes.
    expect(
      await pruneUssdSessions(handle.db, { now: new Date(expired + USSD_SESSION_RETENTION_MS) }),
    ).toBe(0);
    const later = new Date(expired + USSD_SESSION_RETENTION_MS + 1);
    expect(await pruneUssdSessions(handle.db, { now: later, batchSize: 2 })).toBe(2);
    expect(await left()).toHaveLength(2);
    expect(await pruneUssdSessions(handle.db, { now: later, batchSize: 2 })).toBe(1);
    expect(await left()).toEqual([withBet.sessionId]);
    expect(await pruneUssdSessions(handle.db, { now: later })).toBe(0);
    // Inbound texts are evidence and stay.
    const [text] = await handle.db
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .where(and(eq(inboundMessages.id, sms.inboundMessageId)));
    expect(text).toBeDefined();
  });
});
