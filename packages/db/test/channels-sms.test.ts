import {
  birr,
  formatMoney,
  formatTotalOdds,
  helpBody,
  MAX_SMS_SEGMENTS,
  notAvailableBody,
  optOutBody,
  optOutBodyBilingual,
  smsSegments,
  smsText,
  tooManyMessagesBody,
} from '@vamos/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BET_PLACED,
  getBalance,
  isSmsMarketingOptedOut,
  SMS_MAX_REPLY_SENDS,
  SMS_REPLY_RESEND_INTERVAL_MS,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import {
  auditLog,
  bets,
  inboundMessages,
  ledgerTransactions,
  markets,
  outboxEvents,
  rgExclusions,
  rgLimits,
  users,
} from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  goLive,
  HOUSE,
  reprice,
  type TestDb,
} from './betting-fixtures';
import {
  channelPlayer,
  gameIdOf,
  receiveSms,
  smsFrom,
  smsReplies,
  unknownPhone,
  unusedGameId,
} from './channel-fixtures';
import { cash, dropTestDatabase, pgCode } from './helpers';
import { createGames, openRound } from './jackpot-fixtures';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const reply = (body: string) => smsText(body, { demo: true });

async function inboundRow(id: string) {
  const [row] = await handle.db.select().from(inboundMessages).where(eq(inboundMessages.id, id));
  if (row === undefined) throw new Error(`no inbound message ${id}`);
  return row;
}

async function betsOf(userId: string) {
  return handle.db.select().from(bets).where(eq(bets.userId, userId)).orderBy(asc(bets.placedAt));
}

async function stakePostings(betId: string) {
  return handle.db
    .select({ id: ledgerTransactions.id })
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refId, betId), eq(ledgerTransactions.type, 'bet_stake')));
}

/** A prematch football event (1X2 2.00 / 3.20 / 3.50, O/U 2.5 1.90 / 1.85, no BTTS) and its Game ID. */
async function game(options: Parameters<typeof createEvent>[2] = {}) {
  const event = await createEvent(handle.db, ids, options);
  return { event, gameId: await gameIdOf(handle.db, event.eventId) };
}

describe('SMS bets', () => {
  it('places a single at the price at receipt and replies with the short ID, odds, stake and win', async () => {
    const { event, gameId } = await game();
    await reprice(handle.db, event.home, 2_100);
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const stakesBefore = await getBalance(handle.db, HOUSE.stakes);
    const now = new Date();

    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`), now);

    expect(result).toMatchObject({
      outcome: 'bet_placed',
      command: 'bet',
      replayed: false,
      replyQueued: true,
      conflict: false,
    });
    const bet = result.bet!;
    expect(bet).toMatchObject({
      userId: player.userId,
      channel: 'sms',
      oddsChangePolicy: 'none',
      status: 'open',
      stake: birr(50),
      totalOddsMilli: 2_100n,
      // Winnings of ETB 55 are under the tax exemption.
      potentialNetPayout: birr(105),
    });
    expect(bet.legs.map((leg) => [leg.selectionId, leg.oddsMilli])).toEqual([[event.home, 2_100]]);
    expect(result.reply).toBe(
      reply(`Bet ${bet.shortId} placed. Odds 2.10, stake ETB 50.00, possible win ETB 105.00.`),
    );
    expect(smsSegments(result.reply!)).toBe(1);

    // Money moved once, through the ledger.
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(950));
    expect(await getBalance(handle.db, HOUSE.stakes)).toBe(stakesBefore + birr(50));
    expect(await stakePostings(bet.id)).toHaveLength(1);

    // The message, its reply in the outbox and the bet.placed event.
    expect(await inboundRow(result.inboundMessageId)).toMatchObject({
      aggregator: 'mock',
      phone: player.phone,
      shortCode: '8123',
      userId: player.userId,
      text: `${gameId}#1#50`,
      command: 'bet',
      outcome: 'bet_placed',
      refusalCode: null,
      betId: bet.id,
      reply: result.reply,
      replyCount: 1,
      lastReplyAt: now,
      receivedAt: now,
    });
    expect(await smsReplies(handle.db, result.inboundMessageId)).toEqual([
      {
        inboundMessageId: result.inboundMessageId,
        to: player.phone,
        body: result.reply,
        template: 'channel_reply',
        userId: player.userId,
        send: 1,
      },
    ]);
    const [placed] = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, BET_PLACED), eq(outboxEvents.aggregateId, bet.id)));
    expect(placed?.payload).toMatchObject({ channel: 'sms', status: 'open', stake: '5000' });
  });

  it('places a multi typed in any case, with spaces and * as separators', async () => {
    const a = await game();
    const b = await game();
    const c = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });

    const text = ` ${a.gameId} * x # ${b.gameId}#ov25*0${c.gameId}#2# 100 `;
    const result = await receiveSms(handle.db, smsFrom(player.phone, text));

    expect(result.outcome).toBe('bet_placed');
    const bet = result.bet!;
    expect(bet).toMatchObject({ betType: 'multi', channel: 'sms', stake: birr(100) });
    expect(bet.legs.map((leg) => [leg.selectionId, leg.oddsMilli])).toEqual([
      [a.event.draw, 3_200],
      [b.event.over, 1_900],
      [c.event.away, 3_500],
    ]);
    // 3.20 × 1.90 × 3.50 = 21.28, and three legs of 1.30+ earn the 3% multi bonus.
    expect(bet.totalOddsMilli).toBe(21_280n);
    expect(bet.potentialBonus).toBeGreaterThan(0n);
    expect(result.reply).toBe(
      reply(
        `Bet ${bet.shortId} placed. 3 games, odds ${formatTotalOdds(bet.totalOddsMilli)}, stake ETB 100.00, possible win ${formatMoney(bet.potentialNetPayout, 'en')}.`,
      ),
    );
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(900));
  });

  it('caps the payout at the maximum, as on the web', async () => {
    const games = await Promise.all([game(), game(), game(), game()]);
    const player = await channelPlayer(handle.db, { funds: birr(100_000) });
    // 3.50^4 ≈ 150 × ETB 100,000 is far above the ETB 500,000 cap.
    const text = `${games.map((g) => `${g.gameId}#2`).join('#')}#100000`;
    const result = await receiveSms(handle.db, smsFrom(player.phone, text));
    expect(result.outcome).toBe('bet_placed');
    expect(result.bet?.potentialGrossPayout).toBe(settings.betRules.maxPayout);
  });

  it('answers in Amharic for an Amharic-speaking player, within three parts', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(100), locale: 'am' });
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#X#10`));
    expect(result.outcome).toBe('bet_placed');
    expect(result.reply).toContain('ተመዝግቧል');
    expect(result.reply).toContain('10.00 ብር');
    expect(smsSegments(result.reply!)).toBeLessThanOrEqual(MAX_SMS_SEGMENTS);
  });
});

describe('SMS bets that are refused', () => {
  async function expectNoBet(userId: string, funds: bigint) {
    expect(await betsOf(userId)).toEqual([]);
    expect(await getBalance(handle.db, cash(userId))).toBe(funds);
  }

  it('refuses an unknown Game ID, a pick the game does not offer and a suspended market', async () => {
    const { event, gameId } = await game();
    const unknown = await unusedGameId(handle.db);
    const player = await channelPlayer(handle.db, { funds: birr(500) });

    const notFound = await receiveSms(handle.db, smsFrom(player.phone, `${unknown}#1#50`));
    expect(notFound).toMatchObject({ outcome: 'bet_refused', command: 'bet', bet: null });
    expect(notFound.reply).toBe(reply(`Game ${unknown} not found. No bet placed.`));
    expect((await inboundRow(notFound.inboundMessageId)).refusalCode).toBe('game_not_found');

    // The fixture has no both-teams-to-score market.
    const notOffered = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#GG#50`));
    expect(notOffered.reply).toBe(
      reply(`Pick GG is not offered on game ${gameId}. No bet placed.`),
    );

    await handle.db
      .update(markets)
      .set({ status: 'suspended', suspendedBy: 'trader' })
      .where(eq(markets.id, event.marketIds['1x2']));
    const suspended = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`));
    expect(suspended.reply).toBe(
      reply(`Betting on 1 for game ${gameId} is suspended right now. No bet placed.`),
    );
    expect((await inboundRow(suspended.inboundMessageId)).refusalCode).toBe('pick_unavailable');
    // Another market of the same game is still open.
    expect((await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#UN25#5`))).outcome).toBe(
      'bet_placed',
    );
    expect(await betsOf(player.userId)).toHaveLength(1);
  });

  it('names the first leg, in text order, that cannot be bet on', async () => {
    const good = await game();
    const unknown = await unusedGameId(handle.db);
    const player = await channelPlayer(handle.db, { funds: birr(500) });
    const result = await receiveSms(
      handle.db,
      smsFrom(player.phone, `${good.gameId}#1#${unknown}#X#${good.gameId}#2#50`),
    );
    // A Game ID twice is a parse error before anything is looked up.
    expect(result.outcome).toBe('invalid_command');
    const second = await receiveSms(
      handle.db,
      smsFrom(player.phone, `${good.gameId}#1#${unknown}#X#50`),
    );
    expect(second.reply).toBe(reply(`Game ${unknown} not found. No bet placed.`));
    await expectNoBet(player.userId, birr(500));
  });

  it('refuses a game whose prematch betting closed at kick-off', async () => {
    const { gameId } = await game({ startTime: new Date(Date.now() - 60_000) });
    const player = await channelPlayer(handle.db, { funds: birr(500) });
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`));
    expect(result.reply).toBe(
      reply(`Game ${gameId} has started; betting before kick-off is closed. No bet placed.`),
    );
    await expectNoBet(player.userId, birr(500));
  });

  it('refuses a stake above the balance and records the refusal (nothing else written)', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(20) });
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`));
    expect(result).toMatchObject({ outcome: 'bet_refused', bet: null, betId: null });
    expect(result.reply).toBe(
      reply('Your balance (ETB 20.00) is too low for a stake of ETB 50.00. No bet placed.'),
    );
    expect(await inboundRow(result.inboundMessageId)).toMatchObject({
      outcome: 'bet_refused',
      refusalCode: 'insufficient_funds',
      betId: null,
      replyCount: 1,
    });
    expect(await smsReplies(handle.db, result.inboundMessageId)).toHaveLength(1);
    await expectNoBet(player.userId, birr(20));
    const stakeRows = await handle.db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.type, 'bet_stake'),
          eq(ledgerTransactions.actorId, player.userId),
        ),
      );
    expect(stakeRows).toEqual([]);
  });

  it('refuses a self-excluded or cooling-off player', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(500) });
    const until = new Date('2027-03-01T09:00:00Z');
    await handle.db.insert(rgExclusions).values({
      userId: player.userId,
      kind: 'self_exclusion',
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: until,
    });
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`));
    expect(result.reply).toBe(reply('You are self-excluded until 1 Mar 2027. No bet placed.'));
    expect((await inboundRow(result.inboundMessageId)).refusalCode).toBe('self_excluded');
    await expectNoBet(player.userId, birr(500));

    const resting = await channelPlayer(handle.db, { funds: birr(500) });
    await handle.db.insert(rgExclusions).values({
      userId: resting.userId,
      kind: 'cool_off',
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: until,
    });
    const coolOff = await receiveSms(handle.db, smsFrom(resting.phone, `${gameId}#1#50`));
    expect(coolOff.reply).toBe(
      reply('You are on a cool-off break until 1 Mar 2027. No bet placed.'),
    );
  });

  it('applies the bet rules on stakes: minimum and maximum', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(200_000) });
    const low = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#4`));
    expect(low.reply).toBe(reply('The minimum stake is ETB 5.00. No bet placed.'));
    const high = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#100001`));
    expect(high.reply).toBe(reply('The maximum stake is ETB 100,000.00. No bet placed.'));
    await expectNoBet(player.userId, birr(200_000));
  });

  it('reads stakes in whole birr only, never as a float', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    for (const [stake, expected] of [
      ['050', birr(50)],
      ['20.00', birr(20)],
      ['7.0', birr(7)],
    ] as const) {
      const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#2#${stake}`));
      expect(result.outcome).toBe('bet_placed');
      expect(result.bet?.stake).toBe(expected);
    }
    for (const stake of ['50.5', '0', '5,000', '-5', '1e3', '5 0', '0.99']) {
      const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#2#${stake}`));
      expect(result).toMatchObject({ outcome: 'invalid_command', command: null, bet: null });
      expect(result.reply).toContain('is not valid: use whole birr');
      expect((await inboundRow(result.inboundMessageId)).refusalCode).toBe('invalid_stake');
    }
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(1_000 - 50 - 20 - 7));
  });

  it('applies the per-bet stake limit the player set', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    await handle.db.insert(rgLimits).values({
      userId: player.userId,
      kind: 'stake',
      period: 'bet',
      amount: birr(30),
      effectiveFrom: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 60_000),
    });
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`));
    expect(result.reply).toBe(
      reply('The stake is above your per-bet limit of ETB 30.00. No bet placed.'),
    );
    await expectNoBet(player.userId, birr(1_000));
  });
});

describe('who may bet by SMS', () => {
  it('gives every number that is not an active, verified player the same reply and never bets', async () => {
    const { gameId } = await game();
    const unverified = await channelPlayer(handle.db, {
      funds: birr(500),
      status: 'pending_verification',
      verified: false,
    });
    const suspended = await channelPlayer(handle.db, { funds: birr(500), status: 'suspended' });
    const closed = await channelPlayer(handle.db, { funds: birr(500), status: 'closed' });
    const verifiedButPending = await channelPlayer(handle.db, {
      funds: birr(500),
      verified: false,
    });
    const senders = [
      unknownPhone(),
      unverified.phone,
      suspended.phone,
      closed.phone,
      verifiedButPending.phone,
    ];
    for (const phone of senders) {
      for (const text of [`${gameId}#1#50`, 'BAL', 'BETS', 'hello']) {
        const result = await receiveSms(handle.db, smsFrom(phone, text));
        expect(result).toMatchObject({ outcome: 'not_available', bet: null, betId: null });
        expect(result.reply).toBe(reply(notAvailableBody()));
        expect((await inboundRow(result.inboundMessageId)).userId).toBeNull();
      }
    }
    for (const player of [unverified, suspended, closed, verifiedButPending]) {
      expect(await betsOf(player.userId)).toEqual([]);
      expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(500));
    }
  });

  it('accepts the number in any common format', async () => {
    const player = await channelPlayer(handle.db, { funds: birr(10) });
    const local = `0${player.phone.slice(4)}`;
    const result = await receiveSms(handle.db, smsFrom(local, 'BAL'));
    expect(result.reply).toBe(reply('Balance ETB 10.00.'));
    expect((await inboundRow(result.inboundMessageId)).phone).toBe(player.phone);
  });

  it('sends no reply to a sender that is not an Ethiopian mobile number', async () => {
    const result = await receiveSms(handle.db, smsFrom('+14155550100', 'BAL'));
    expect(result).toMatchObject({ outcome: 'not_available', reply: null, replyQueued: false });
    expect(await smsReplies(handle.db, result.inboundMessageId)).toEqual([]);
    expect((await inboundRow(result.inboundMessageId)).replyCount).toBe(0);
  });
});

describe('redelivered messages', () => {
  it('never places twice and re-sends the same reply at most three times, not on a quick retry', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const input = smsFrom(player.phone, `${gameId}#1#50`);
    const t0 = new Date();
    const first = await receiveSms(handle.db, input, t0);
    expect(first.outcome).toBe('bet_placed');

    const quick = await receiveSms(handle.db, input, new Date(t0.getTime() + 5_000));
    expect(quick).toMatchObject({
      inboundMessageId: first.inboundMessageId,
      outcome: 'bet_placed',
      reply: first.reply,
      replayed: true,
      replyQueued: false,
      betId: first.betId,
      bet: null,
    });

    const at = (ms: number) => new Date(t0.getTime() + ms);
    const later = await receiveSms(handle.db, input, at(SMS_REPLY_RESEND_INTERVAL_MS));
    expect(later).toMatchObject({ replayed: true, replyQueued: true, reply: first.reply });
    const third = await receiveSms(handle.db, input, at(2 * SMS_REPLY_RESEND_INTERVAL_MS));
    expect(third.replyQueued).toBe(true);
    const fourth = await receiveSms(handle.db, input, at(10 * SMS_REPLY_RESEND_INTERVAL_MS));
    expect(fourth.replyQueued).toBe(false);

    const sent = await smsReplies(handle.db, first.inboundMessageId);
    expect(sent.map((payload) => payload.send)).toEqual([1, 2, 3]);
    expect(sent.every((payload) => payload.body === first.reply)).toBe(true);
    expect(SMS_MAX_REPLY_SENDS).toBe(3);
    expect((await inboundRow(first.inboundMessageId)).replyCount).toBe(3);

    expect(await betsOf(player.userId)).toHaveLength(1);
    expect(await stakePostings(first.betId!)).toHaveLength(1);
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(950));
  });

  it('places once when the same message arrives several times at once', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const input = smsFrom(player.phone, `${gameId}#X#25`);
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => receiveSms(handle.db, input, now)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.betId)).size).toBe(1);
    expect(new Set(results.map((result) => result.reply)).size).toBe(1);
    expect(await betsOf(player.userId)).toHaveLength(1);
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(975));
  });

  it('ignores a message id reused with another text or sender', async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const input = smsFrom(player.phone, 'BAL');
    const first = await receiveSms(handle.db, input);
    const otherText = await receiveSms(handle.db, { ...input, text: `${gameId}#1#500` });
    expect(otherText).toMatchObject({
      replayed: true,
      conflict: true,
      reply: null,
      replyQueued: false,
    });
    const other = await channelPlayer(handle.db, { funds: birr(1_000) });
    const otherSender = await receiveSms(handle.db, { ...input, from: other.phone });
    expect(otherSender.conflict).toBe(true);
    expect(await betsOf(player.userId)).toEqual([]);
    expect(await smsReplies(handle.db, first.inboundMessageId)).toHaveLength(1);
  });
});

describe('live games', () => {
  it('a bet on a game in play waits for acceptance like a web bet', async () => {
    const { event, gameId } = await game();
    await goLive(handle.db, event.eventId);
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const now = new Date();
    const result = await receiveSms(handle.db, smsFrom(player.phone, `${gameId}#1#50`), now);
    expect(result.outcome).toBe('bet_placed');
    expect(result.bet).toMatchObject({
      status: 'pending_acceptance',
      channel: 'sms',
      acceptAfter: new Date(now.getTime() + settings.liveBetDelayMs),
      acceptedAt: null,
    });
    expect(result.bet?.legs[0]?.isLive).toBe(true);
    expect(result.reply).toBe(
      reply(
        `Live bet ${result.bet!.shortId} received, awaiting acceptance. Odds 2.00, stake ETB 50.00, possible win ETB 100.00.`,
      ),
    );
    const [placed] = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, BET_PLACED), eq(outboxEvents.aggregateId, result.betId!)));
    expect(placed?.payload).toMatchObject({ status: 'pending_acceptance', channel: 'sms' });
    // The stake is held while the bet waits.
    expect(await getBalance(handle.db, cash(player.userId))).toBe(birr(950));
  });
});

describe('information and opt-out commands', () => {
  it("answers BAL, BETS (last three), JP and HELP in the player's language", async () => {
    const { gameId } = await game();
    const player = await channelPlayer(handle.db, { funds: birr(1_000) });
    const balance = await receiveSms(handle.db, smsFrom(player.phone, 'bal'));
    expect(balance).toMatchObject({ outcome: 'info', command: 'balance' });
    expect(balance.reply).toBe(reply('Balance ETB 1,000.00.'));

    const none = await receiveSms(handle.db, smsFrom(player.phone, 'BETS'));
    expect(none.reply).toContain('You have no bets yet.');

    const base = Date.now();
    const shortIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const placed = await receiveSms(
        handle.db,
        smsFrom(player.phone, `${gameId}#1#${10 + i}`),
        new Date(base + i * 1_000),
      );
      shortIds.push(placed.bet!.shortId);
    }
    const recent = await receiveSms(
      handle.db,
      smsFrom(player.phone, 'my bets'),
      new Date(base + 10_000),
    );
    expect(recent.reply).toBe(
      reply(
        `Last bets (ETB): ${shortIds[3]} open, stake 13.00, win 26.00; ${shortIds[2]} open, stake 12.00, win 24.00; ${shortIds[1]} open, stake 11.00, win 22.00.`,
      ),
    );

    const help = await receiveSms(handle.db, smsFrom(player.phone, 'HELP'));
    expect(help.reply).toBe(reply(helpBody('en')));

    const amharic = await channelPlayer(handle.db, { funds: birr(5), locale: 'am' });
    const am = await receiveSms(handle.db, smsFrom(amharic.phone, 'BAL'));
    expect(am.reply).toBe(reply('ቀሪ ሂሳብ 5.00 ብር።'));
  });

  it('summarises the open jackpot rounds', async () => {
    const player = await channelPlayer(handle.db);
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + 2 * 3_600_000));
    const round = await openRound(handle.db, games);
    const result = await receiveSms(handle.db, smsFrom(player.phone, 'JP'));
    expect(result).toMatchObject({ outcome: 'info', command: 'jackpot' });
    expect(result.reply).toContain('Jackpot DAILY9: 3 games, ETB 10.00 per combination');
    for (const g of round.games) expect(result.reply).toContain(String(g.gameId));
    expect(result.reply).toContain('Enter on the website.');
  });

  it('records STOP and START on the account, for any account, with one reply for non-players', async () => {
    const player = await channelPlayer(handle.db);
    const stop = await receiveSms(handle.db, smsFrom(player.phone, 'STOP'));
    expect(stop).toMatchObject({ outcome: 'opt_out', command: 'stop' });
    expect(stop.reply).toBe(reply(optOutBody(true, 'en')));
    expect(await isSmsMarketingOptedOut(handle.db, player.userId)).toBe(true);
    // Again: nothing changes.
    await receiveSms(handle.db, smsFrom(player.phone, 'stop'));
    const start = await receiveSms(handle.db, smsFrom(player.phone, 'Start'));
    expect(start).toMatchObject({ outcome: 'opt_in', command: 'start' });
    expect(start.reply).toBe(reply(optOutBody(false, 'en')));
    expect(await isSmsMarketingOptedOut(handle.db, player.userId)).toBe(false);
    const audits = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorId, player.userId))
      .orderBy(asc(auditLog.id));
    expect(audits.map((row) => row.action)).toEqual([
      'sms.marketing_opt_out',
      'sms.marketing_opt_in',
    ]);

    // An account that cannot bet still opts out; the reply is the one non-players get.
    const unverified = await channelPlayer(handle.db, {
      status: 'pending_verification',
      verified: false,
    });
    const pending = await receiveSms(handle.db, smsFrom(unverified.phone, 'STOP'));
    expect(pending).toMatchObject({ outcome: 'opt_out', reply: reply(optOutBodyBilingual(true)) });
    expect(await isSmsMarketingOptedOut(handle.db, unverified.userId)).toBe(true);
    const unknown = await receiveSms(handle.db, smsFrom(unknownPhone(), 'STOP'));
    expect(unknown).toMatchObject({ outcome: 'opt_out', reply: reply(optOutBodyBilingual(true)) });
    const [row] = await handle.db
      .select({ at: users.smsMarketingOptOutAt })
      .from(users)
      .where(eq(users.id, player.userId));
    expect(row?.at).toBeNull();
  });

  it('answers a text that is not a command with the syntax', async () => {
    const player = await channelPlayer(handle.db);
    const result = await receiveSms(handle.db, smsFrom(player.phone, 'hello there'));
    expect(result).toMatchObject({ outcome: 'invalid_command', command: null });
    expect(result.reply).toBe(
      reply(
        'Unknown command. Bet: GAMEID#PICK#STAKE, e.g. 1234#1#50. Picks: 1 X 2 OV25 UN25 GG NG. Also BAL, BETS, JP, HELP.',
      ),
    );
    expect((await inboundRow(result.inboundMessageId)).refusalCode).toBe('unknown_command');
  });
});

describe('rate limits and stored evidence', () => {
  it('limits texts per number and says so once per window', async () => {
    const player = await channelPlayer(handle.db, { funds: birr(10) });
    const limits = [{ max: 3, windowMs: 60_000 }];
    const t0 = new Date();
    const at = (ms: number) => new Date(t0.getTime() + ms);
    for (let i = 0; i < 3; i += 1) {
      const ok = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), at(i), {
        rateLimits: limits,
      });
      expect(ok.outcome).toBe('info');
    }
    const limited = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), at(10), {
      rateLimits: limits,
    });
    expect(limited).toMatchObject({ outcome: 'rate_limited', command: null });
    expect(limited.reply).toBe(reply(tooManyMessagesBody()));
    const silent = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), at(20), {
      rateLimits: limits,
    });
    expect(silent).toMatchObject({ outcome: 'rate_limited', reply: null, replyQueued: false });
    expect(await smsReplies(handle.db, silent.inboundMessageId)).toEqual([]);
    // Once the window has passed, texts are read again.
    const again = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'), at(60_021), {
      rateLimits: limits,
    });
    expect(again.outcome).toBe('info');
  });

  it('keeps inbound messages as evidence: no delete, and only the reply count may change', async () => {
    const player = await channelPlayer(handle.db);
    const result = await receiveSms(handle.db, smsFrom(player.phone, 'BAL'));
    const id = result.inboundMessageId;
    const refused = async (op: Promise<unknown>) => {
      const error = await op.then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgCode(error)).toBe('23001');
    };
    await refused(handle.db.delete(inboundMessages).where(eq(inboundMessages.id, id)));
    await refused(
      handle.db.update(inboundMessages).set({ text: 'BETS' }).where(eq(inboundMessages.id, id)),
    );
    await refused(
      handle.db.update(inboundMessages).set({ replyCount: 0 }).where(eq(inboundMessages.id, id)),
    );
    await refused(handle.db.execute(sql`TRUNCATE inbound_messages`));
    await handle.db
      .update(inboundMessages)
      .set({ replyCount: 2, lastReplyAt: new Date() })
      .where(eq(inboundMessages.id, id));
    expect((await inboundRow(id)).replyCount).toBe(2);
  });

  it('stores texts PostgreSQL cannot hold as given (NUL, lone surrogates) and reads them the same', async () => {
    const player = await channelPlayer(handle.db, { funds: birr(10) });
    const input = smsFrom(player.phone, 'BAL\u0000\ud800');
    const first = await receiveSms(handle.db, input);
    expect(first.outcome).toBe('invalid_command');
    expect((await inboundRow(first.inboundMessageId)).text).toBe('BAL��');
    const again = await receiveSms(handle.db, input);
    expect(again).toMatchObject({ replayed: true, conflict: false });
  });
});
