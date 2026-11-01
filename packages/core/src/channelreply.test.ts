import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  balanceBody,
  betPlacedBody,
  betsBody,
  channelLocale,
  commandErrorBody,
  formatAddisDate,
  formatAddisDateTime,
  formatMoney,
  formatTotalOdds,
  helpBody,
  jackpotBody,
  liveBetOutcomeBody,
  notAvailableBody,
  optOutBody,
  optOutBodyBilingual,
  quoteToken,
  refusalBody,
  replyPrefix,
  smsText,
  tooManyMessagesBody,
  type ChannelLocale,
  type ChannelRefusal,
  type JackpotSummary,
} from './channelreply';
import { MAX_SMS_SEGMENTS, smsSegments } from './smstext';
import type { TextCommandError } from './textcommand';

const LOCALES: ChannelLocale[] = ['en', 'am'];
const until = new Date('2026-11-01T21:30:00Z');

const REFUSALS: ChannelRefusal[] = [
  { code: 'game_not_found', gameId: 1234 },
  { code: 'pick_not_offered', gameId: 1234, pick: 'GG' },
  { code: 'pick_unavailable', gameId: 1234, pick: '1', reason: 'event_started' },
  { code: 'pick_unavailable', gameId: 1234, pick: 'X', reason: 'event_closed' },
  { code: 'pick_unavailable', gameId: 1234, pick: 'OV25', reason: 'suspended' },
  { code: 'pick_unavailable', gameId: 1234, pick: 'NG', reason: 'market_closed' },
  { code: 'odds_changed', oddsMilli: 1850 },
  { code: 'odds_changed', oddsMilli: null },
  { code: 'insufficient_funds', balance: 1_200n, stake: 5_000n },
  { code: 'self_excluded', until },
  { code: 'self_excluded', until: null },
  { code: 'cooling_off', until },
  { code: 'cooling_off', until: null },
  { code: 'account_disabled' },
  { code: 'stake_limit_exceeded', limit: 100_000n },
  { code: 'loss_limit_exceeded', period: 'day', limit: 100_000n },
  { code: 'loss_limit_exceeded', period: 'week', limit: 1_000_000n },
  { code: 'loss_limit_exceeded', period: 'month', limit: 10_000_000n },
  { code: 'stake_below_minimum', min: 500n },
  { code: 'stake_above_maximum', max: 10_000_000n },
  { code: 'liability_limit', max: 15_100n },
  { code: 'liability_limit', max: null },
  { code: 'too_many_legs', max: 40 },
  { code: 'odds_below_minimum', minOddsMilli: 1100 },
  { code: 'total_odds_above_maximum' },
  { code: 'duplicate_game', gameId: 1234 },
  { code: 'bet_failed' },
];

const COMMAND_ERRORS: TextCommandError[] = [
  { code: 'empty' },
  { code: 'too_long', max: 640 },
  { code: 'unknown_command' },
  { code: 'incomplete_bet' },
  { code: 'missing_stake' },
  { code: 'too_many_legs', legs: 41, max: 40 },
  { code: 'invalid_game_id', token: '99' },
  { code: 'invalid_pick', gameId: 1234, token: 'Z' },
  { code: 'invalid_stake', token: '50.5' },
  { code: 'stake_too_large', token: '1000000000' },
  { code: 'duplicate_game', gameId: 1234 },
];

/** The reply is sent whole (not cut with an ellipsis) in at most `parts` parts. */
function sentWhole(body: string, parts: number = MAX_SMS_SEGMENTS): void {
  const text = smsText(body, { demo: true });
  expect(text).toBe(`${replyPrefix(true)}${body}`);
  expect(smsSegments(text)).toBeLessThanOrEqual(parts);
}

describe('locale and formatting', () => {
  it('answers in Amharic for am and ti, in English otherwise', () => {
    expect(channelLocale('am')).toBe('am');
    expect(channelLocale('ti')).toBe('am');
    expect(channelLocale('en')).toBe('en');
    expect(channelLocale('om')).toBe('en');
    expect(channelLocale(null)).toBe('en');
    expect(channelLocale('xx')).toBe('en');
  });

  it('formats money from santim and combined odds from bigint milli', () => {
    expect(formatMoney(125_050n, 'en')).toBe('ETB 1,250.50');
    expect(formatMoney(125_050n, 'am')).toBe('1,250.50 ብር');
    expect(formatTotalOdds(3700n)).toBe('3.70');
    expect(formatTotalOdds(1855n)).toBe('1.855');
    expect(formatTotalOdds(123_456_789_000n)).toBe('123456789.00');
    expect(() => formatTotalOdds(-1n)).toThrow(RangeError);
  });

  it('shows Addis Ababa time (UTC+3)', () => {
    const instant = new Date('2026-10-19T21:05:00Z');
    expect(formatAddisDateTime(instant, 'en')).toBe('20 Oct 00:05');
    expect(formatAddisDateTime(instant, 'am')).toBe('20/10 00:05');
    expect(formatAddisDate(instant, 'en')).toBe('20 Oct 2026');
    expect(formatAddisDate(instant, 'am')).toBe('20/10/2026');
  });

  it('quotes what the sender typed safely and briefly', () => {
    expect(quoteToken('ab\u0000c"d')).toBe('ab cd');
    expect(quoteToken('1234567890123')).toBe('123456789...');
    expect(quoteToken('ሀ'.repeat(20))).toBe(`${'ሀ'.repeat(11)}…`);
    expect(quoteToken('')).toBe('?');
    expect(quoteToken('x'.repeat(40)).length).toBeLessThanOrEqual(12);
    expect(quoteToken('“hi”')).toBe('hi');
  });

  it('prefixes replies, with DEMO in play-money mode', () => {
    expect(smsText('Balance ETB 5.00.', { demo: true })).toBe('Vamos DEMO: Balance ETB 5.00.');
    expect(smsText('Balance ETB 5.00.', { demo: false })).toBe('Vamos: Balance ETB 5.00.');
  });
});

describe('bet placed', () => {
  const bet = {
    shortId: 'AB23CD45',
    legs: 1,
    totalOddsMilli: 2_000n,
    stake: 5_000n,
    potentialNetPayout: 8_000n,
    pendingAcceptance: false,
  };

  it('confirms the short ID, total odds, stake and possible win', () => {
    expect(betPlacedBody(bet, 'en')).toBe(
      'Bet AB23CD45 placed. Odds 2.00, stake ETB 50.00, possible win ETB 80.00.',
    );
    const multi = betPlacedBody({ ...bet, legs: 3, totalOddsMilli: 12_345n }, 'en');
    expect(multi).toBe(
      'Bet AB23CD45 placed. 3 games, odds 12.345, stake ETB 50.00, possible win ETB 80.00.',
    );
    const am = betPlacedBody(bet, 'am');
    for (const part of ['AB23CD45', '2.00', '50.00 ብር', '80.00 ብር']) expect(am).toContain(part);
  });

  it('says a live bet waits for acceptance', () => {
    expect(betPlacedBody({ ...bet, pendingAcceptance: true }, 'en')).toMatch(
      /^Live bet AB23CD45 received, awaiting acceptance\. Odds 2\.00/,
    );
    expect(betPlacedBody({ ...bet, pendingAcceptance: true }, 'am')).toContain('ማረጋገጫ');
  });

  it('fits one GSM-7 message in English and three parts in Amharic', () => {
    const big = { ...bet, legs: 40, totalOddsMilli: 999_999_999_999n, stake: 99_999_999_900n };
    sentWhole(betPlacedBody(big, 'en'), 1);
    sentWhole(betPlacedBody({ ...big, pendingAcceptance: true }, 'en'), 1);
    sentWhole(betPlacedBody(big, 'am'));
  });

  it('tells a live bettor whether the bet was accepted', () => {
    expect(liveBetOutcomeBody({ shortId: 'AB23CD45', accepted: true }, 'en')).toBe(
      'Live bet AB23CD45 accepted.',
    );
    expect(
      liveBetOutcomeBody(
        { shortId: 'AB23CD45', accepted: false, reason: 'odds_changed', refund: 5_000n },
        'en',
      ),
    ).toBe('Live bet AB23CD45 rejected: the odds changed. ETB 50.00 refunded.');
    for (const locale of LOCALES) {
      for (const reason of ['odds_changed', 'selection_unavailable', 'slip_invalid'] as const) {
        sentWhole(
          liveBetOutcomeBody(
            { shortId: 'AB23CD45', accepted: false, reason, refund: 5_000n },
            locale,
          ),
          locale === 'en' ? 1 : MAX_SMS_SEGMENTS,
        );
      }
    }
  });
});

describe('refusals', () => {
  it('explains every refusal in both languages, whole, in one English message', () => {
    for (const refusal of REFUSALS) {
      const en = refusalBody(refusal, 'en');
      const am = refusalBody(refusal, 'am');
      expect(en.length).toBeGreaterThan(10);
      expect(am).not.toBe(en);
      sentWhole(en, 1);
      sentWhole(am);
    }
  });

  it('ends with "No bet placed." where a bet was refused', () => {
    for (const refusal of REFUSALS) {
      const en = refusalBody(refusal, 'en');
      if (refusal.code === 'account_disabled' || refusal.code === 'bet_failed') {
        expect(en).not.toContain('No bet placed');
      } else {
        expect(en.endsWith('No bet placed.')).toBe(true);
      }
    }
  });

  it('names the amounts and dates involved', () => {
    expect(refusalBody({ code: 'insufficient_funds', balance: 1_200n, stake: 5_000n }, 'en')).toBe(
      'Your balance (ETB 12.00) is too low for a stake of ETB 50.00. No bet placed.',
    );
    expect(refusalBody({ code: 'self_excluded', until }, 'en')).toBe(
      'You are self-excluded until 2 Nov 2026. No bet placed.',
    );
    expect(refusalBody({ code: 'self_excluded', until: null }, 'en')).toBe(
      'You are self-excluded. No bet placed.',
    );
    expect(
      refusalBody({ code: 'loss_limit_exceeded', period: 'week', limit: 1_000_000n }, 'en'),
    ).toBe('This bet could take you over your 7-day loss limit of ETB 10,000.00. No bet placed.');
    expect(refusalBody({ code: 'odds_changed', oddsMilli: 1850 }, 'en')).toBe(
      'The odds have changed to 1.85. No bet placed.',
    );
    // The house cap (rule L1): names the stake that fits, and never the cap itself.
    expect(refusalBody({ code: 'liability_limit', max: 15_100n }, 'en')).toBe(
      'This bet is too large for this game right now. Try a stake up to ETB 151.00. No bet placed.',
    );
    expect(refusalBody({ code: 'liability_limit', max: null }, 'en')).toBe(
      'This bet is too large for this game right now. No bet placed.',
    );
  });
});

describe('command errors', () => {
  it('answers every parse error with what was wrong and the syntax', () => {
    for (const error of COMMAND_ERRORS) {
      for (const locale of LOCALES) {
        const body = commandErrorBody(error, locale);
        sentWhole(body, locale === 'en' ? 1 : MAX_SMS_SEGMENTS);
      }
    }
    expect(commandErrorBody({ code: 'unknown_command' }, 'en')).toBe(
      'Unknown command. Bet: GAMEID#PICK#STAKE, e.g. 1234#1#50. Picks: 1 X 2 OV25 UN25 GG NG. Also BAL, BETS, JP, HELP.',
    );
    expect(commandErrorBody({ code: 'invalid_stake', token: '50.5' }, 'en')).toContain(
      'whole birr',
    );
  });

  it('names the maximum stake for a whole-birr stake that is too long', () => {
    const error: TextCommandError = { code: 'stake_too_large', token: '1000000000' };
    expect(commandErrorBody(error, 'en', { maxStake: 10_000_000n })).toBe(
      'The maximum stake is ETB 100,000.00. No bet placed.',
    );
    expect(commandErrorBody(error, 'en')).not.toContain('whole birr');
    expect(commandErrorBody(error, 'am', { maxStake: 10_000_000n })).toBe(
      refusalBody({ code: 'stake_above_maximum', max: 10_000_000n }, 'am'),
    );
  });

  it('shows Game IDs zero-padded, as printed on coupons and in USSD', () => {
    for (const locale of LOCALES) {
      for (const refusal of [
        { code: 'game_not_found', gameId: 123 },
        { code: 'pick_not_offered', gameId: 123, pick: 'GG' },
        { code: 'pick_unavailable', gameId: 123, pick: '1', reason: 'event_started' },
        { code: 'pick_unavailable', gameId: 123, pick: '1', reason: 'event_closed' },
        { code: 'pick_unavailable', gameId: 123, pick: '1', reason: 'suspended' },
        { code: 'pick_unavailable', gameId: 123, pick: '1', reason: 'market_closed' },
        { code: 'duplicate_game', gameId: 123 },
      ] satisfies ChannelRefusal[]) {
        const body = refusalBody(refusal, locale);
        expect(body).toContain('0123');
      }
      for (const error of [
        { code: 'invalid_pick', gameId: 123, token: 'Z' },
        { code: 'duplicate_game', gameId: 123 },
      ] satisfies TextCommandError[]) {
        expect(commandErrorBody(error, locale)).toContain('0123');
      }
    }
  });

  it('quotes a hostile token only shortened and cleaned', () => {
    const body = commandErrorBody(
      { code: 'invalid_game_id', token: `${'\u0007'.repeat(3)}"${'9'.repeat(500)}` },
      'en',
    );
    sentWhole(body, 1);
    expect(body).not.toContain('\u0007');
  });
});

describe('information replies', () => {
  it('shows the balance, and the bonus balance only when there is one', () => {
    expect(balanceBody({ cash: 123_450n, bonus: 0n }, 'en')).toBe('Balance ETB 1,234.50.');
    expect(balanceBody({ cash: 0n, bonus: 2_000n }, 'en')).toBe(
      'Balance ETB 0.00. Bonus ETB 20.00.',
    );
    expect(balanceBody({ cash: 100n, bonus: 0n }, 'am')).toBe('ቀሪ ሂሳብ 1.00 ብር።');
  });

  it('lists the last bets with their status', () => {
    const lines = betsBody(
      [
        {
          shortId: 'AAAA2222',
          status: 'open',
          stake: 5_000n,
          potentialNetPayout: 9_000n,
          settledNetPayout: null,
        },
        {
          shortId: 'BBBB3333',
          status: 'won',
          stake: 1_000n,
          potentialNetPayout: 4_000n,
          settledNetPayout: 3_800n,
        },
        {
          shortId: 'CCCC4444',
          status: 'rejected',
          stake: 2_000n,
          potentialNetPayout: 4_000n,
          settledNetPayout: null,
        },
      ],
      'en',
    );
    expect(lines).toBe(
      'Last bets (ETB): AAAA2222 open, stake 50.00, win 90.00; BBBB3333 won 38.00; CCCC4444 rejected, refunded 20.00.',
    );
    sentWhole(lines, 1);
    expect(betsBody([], 'en')).toMatch(/^You have no bets yet\./);
  });

  it('fits three bets of any status in the reply', () => {
    const statuses = [
      'pending_acceptance',
      'open',
      'won',
      'lost',
      'void',
      'cashed_out',
      'rejected',
    ] as const;
    for (const locale of LOCALES) {
      for (const status of statuses) {
        const bet = {
          shortId: 'ZZZZ9999',
          status,
          stake: 99_999_999_900n,
          potentialNetPayout: 50_000_000_00n,
          settledNetPayout: 50_000_000_00n,
        };
        sentWhole(betsBody([bet, bet, bet], locale));
      }
    }
  });

  const round = (games: number, name = 'Arsenal'): JackpotSummary => ({
    templateCode: 'daily9',
    gameCount: games,
    costPerCombination: 1_000n,
    pool: 10_000_000n,
    closesAt: new Date('2026-10-19T15:00:00Z'),
    games: Array.from({ length: games }, (_, i) => ({
      gameId: 1000 + i,
      home: name,
      away: 'CHE',
    })),
  });

  it('summarises open jackpots with their games and cost per combination', () => {
    const one = jackpotBody([round(2, 'ARS')], 'en');
    expect(one).toBe(
      'Jackpot DAILY9: 2 games, ETB 10.00 per combination, prize ETB 100,000.00, closes 19 Oct 18:00. Games: 1000 ARS-CHE, 1001 ARS-CHE. Enter on the website.',
    );
    // Too long with team names: the Game IDs alone.
    const thirteen = jackpotBody([round(13, 'Wolverhampton Wanderers')], 'en');
    expect(thirteen).not.toContain('Wolverhampton');
    expect(thirteen).toContain('1012');
    sentWhole(thirteen);
    expect(jackpotBody([], 'en')).toBe(
      'No jackpot is open right now. Check the website for the next round.',
    );
    sentWhole(jackpotBody([round(9)], 'am'));
  });

  it('explains the commands in one message in English', () => {
    sentWhole(helpBody('en'), 1);
    sentWhole(helpBody('am'));
    expect(helpBody('en')).toContain('1234#1#5678#X#50');
  });

  it('confirms STOP and START', () => {
    expect(optOutBody(true, 'en')).toBe(
      'You will no longer get offers by SMS. Send START to get them again.',
    );
    expect(optOutBody(false, 'en')).toBe('You will get Vamos offers by SMS. Send STOP to opt out.');
    for (const optedOut of [true, false]) {
      sentWhole(optOutBody(optedOut, 'en'), 1);
      sentWhole(optOutBody(optedOut, 'am'));
      sentWhole(optOutBodyBilingual(optedOut));
    }
  });

  it('tells a flooding number to wait, in both languages', () => {
    expect(tooManyMessagesBody()).toContain('Too many messages');
    sentWhole(tooManyMessagesBody());
  });

  it('has one bilingual answer for every number that cannot bet', () => {
    const body = notAvailableBody();
    expect(body).toContain('not available for this number');
    expect(body).toContain('ቁጥር');
    sentWhole(body);
  });
});

describe('properties', () => {
  it('smsText always fits the allowed parts', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 1000 }), fc.boolean(), (body, demo) => {
        expect(smsSegments(smsText(body, { demo }))).toBeLessThanOrEqual(MAX_SMS_SEGMENTS);
      }),
    );
  });

  it('formatTotalOdds shows the exact milli value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1000n, max: 10n ** 15n }), (milli) => {
        const [whole = '', fraction = ''] = formatTotalOdds(milli).split('.');
        expect(BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))).toBe(milli);
      }),
    );
  });
});
