import { describe, expect, it } from 'vitest';
import {
  JackpotClosedDetails,
  JackpotEntryInvalidDetails,
  JackpotEntryRequest,
  JackpotEntryView,
  JackpotListQuery,
  JackpotListResponse,
  JackpotRoundView,
  JackpotTemplateView,
  MyJackpotEntriesQuery,
  PromotionsResponse,
  type JackpotGameView,
  type JackpotRoundView as JackpotRoundViewType,
} from './jackpots';
import { UserMessage } from './user-stream';

const game = (position: number): JackpotGameView => ({
  position,
  eventId: `event-${position}`,
  gameId: '1234',
  sport: 'football',
  eventName: 'Arsenal vs Chelsea',
  homeTeam: { en: 'Arsenal' },
  awayTeam: { en: 'Chelsea', am: 'ቼልሲ' },
  competition: { en: 'Premier League' },
  startTime: '2026-10-17T15:00:00.000Z',
  status: 'scheduled',
  score: null,
  odds: { '1': 2000, X: 3200, '2': 3500 },
  result: null,
});

const openRound: JackpotRoundViewType = {
  id: 'round-1',
  templateCode: 'daily9',
  status: 'open',
  gameCount: 3,
  closesAt: '2026-10-17T15:00:00.000Z',
  costPerCombination: '1000',
  maxCombinations: 8,
  pool: '100000',
  cancelledRule: 'all_win',
  prizeTiers: [
    { correct: 3, kind: 'shared', amount: '100000' },
    { correct: 2, kind: 'fixed', amount: '2000' },
  ],
  games: [game(0), game(1), game(2)],
  settledAt: null,
  settlement: null,
};

describe('JackpotEntryRequest', () => {
  it('accepts one to three different picks per game', () => {
    const picks = [['1'], ['X', '1'], ['1', 'X', '2']];
    expect(JackpotEntryRequest.parse({ picks })).toEqual({ picks });
  });

  it('rejects empty games, repeated or unknown picks and too many games', () => {
    const bad = [
      [[]],
      [['1', '1']],
      [['1', 'X', '2', '1']],
      [['3']],
      [[1]],
      [],
      Array.from({ length: 31 }, () => ['1']),
      'not picks',
    ];
    for (const picks of bad) {
      expect(JackpotEntryRequest.safeParse({ picks }).success, JSON.stringify(picks)).toBe(false);
    }
  });

  it('rejects an oversized list with one issue, without checking each game', () => {
    const result = JackpotEntryRequest.safeParse({
      picks: Array.from({ length: 5_000 }, () => ['1', '1']),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', path: ['picks'] });
  });
});

describe('round and entry views', () => {
  it('parse an open round and a settled one', () => {
    expect(JackpotRoundView.parse(openRound)).toEqual(openRound);
    const settled: JackpotRoundViewType = {
      ...openRound,
      status: 'settled',
      games: openRound.games.map((g, i) => ({
        ...g,
        status: i === 0 ? 'cancelled' : 'finished',
        score: i === 0 ? null : { home: 2, away: 1 },
        odds: null,
        result: i === 0 ? 'cancelled' : '1',
      })),
      settledAt: '2026-10-17T17:00:00.000Z',
      settlement: {
        void: false,
        voidReason: null,
        cancelledGames: 1,
        winners: 2,
        payouts: [
          {
            correct: 3,
            kind: 'shared',
            winningCombinations: '2',
            prizePerCombination: '50000',
            total: '100000',
          },
          {
            correct: 2,
            kind: 'fixed',
            winningCombinations: '3',
            prizePerCombination: '2000',
            total: '6000',
          },
        ],
      },
    };
    expect(JackpotRoundView.parse(settled)).toEqual(settled);
    expect(JackpotRoundView.safeParse({ ...openRound, pool: 1000 }).success).toBe(false);
    expect(JackpotRoundView.safeParse({ ...openRound, templateCode: 'mega' }).success).toBe(false);
  });

  it('parse the list response and the entry view', () => {
    const list = { open: [openRound], recent: [], nextCursor: null };
    expect(JackpotListResponse.parse(list)).toEqual(list);
    const entry = {
      id: 'entry-1',
      roundId: openRound.id,
      templateCode: 'daily9',
      status: 'won',
      roundStatus: 'settled',
      closesAt: openRound.closesAt,
      picks: [['1', 'X'], ['2'], ['1']],
      combinations: 2,
      cost: '2000',
      correct: ['0', '0', '1', '1'],
      bestCorrect: 3,
      prizeGross: '52000',
      prizeTax: '10000',
      prizeNet: '42000',
      refund: null,
      placedAt: '2026-10-17T12:00:00.000Z',
      settledAt: '2026-10-17T17:00:00.000Z',
      games: openRound.games.map((g, i) => ({
        ...g,
        result: '1',
        picks: i === 0 ? ['1', 'X'] : i === 1 ? ['2'] : ['1'],
        hit: i !== 1,
      })),
    };
    expect(JackpotEntryView.parse(entry)).toEqual(entry);
    expect(JackpotEntryView.safeParse({ ...entry, status: 'cashed_out' }).success).toBe(false);
  });

  it('page queries default their limit and check the template and status', () => {
    expect(JackpotListQuery.parse({})).toEqual({ limit: 20 });
    expect(JackpotListQuery.parse({ template: 'weekly13', limit: '5' })).toEqual({
      template: 'weekly13',
      limit: 5,
    });
    expect(JackpotListQuery.safeParse({ template: 'monthly' }).success).toBe(false);
    expect(MyJackpotEntriesQuery.parse({ status: 'settled' })).toEqual({
      status: 'settled',
      limit: 20,
    });
    expect(MyJackpotEntriesQuery.safeParse({ status: 'won' }).success).toBe(false);
  });
});

describe('errors, promotions and templates', () => {
  it('describe the jackpot error details', () => {
    expect(JackpotClosedDetails.parse({ reason: 'game_started', status: 'open' })).toEqual({
      reason: 'game_started',
      status: 'open',
    });
    const invalid = {
      errors: ['Too many combinations: 27 (the maximum is 8).'],
      gameCount: 3,
      combinations: 27,
      maxCombinations: 8,
    };
    expect(JackpotEntryInvalidDetails.parse(invalid)).toEqual(invalid);
  });

  it('parse the promotions page and a template edit', () => {
    const promotions = {
      multiBonus: {
        enabled: true,
        minLegOddsMilli: 1300,
        maxBonus: '5000000',
        tiers: [
          { minLegs: 3, percentBps: 300 },
          { minLegs: 4, percentBps: 500 },
        ],
      },
      jackpots: [openRound],
    };
    expect(PromotionsResponse.parse(promotions)).toEqual(promotions);
    const template = {
      code: 'weekly13',
      enabled: true,
      gameCount: 13,
      costPerCombination: '1000',
      maxCombinations: 4096,
      cancelledRule: 'all_win',
      prizeTiers: [{ correct: 13, kind: 'shared', amount: '100000000' }],
    };
    expect(JackpotTemplateView.parse(template)).toEqual(template);
    expect(JackpotTemplateView.safeParse({ ...template, prizeTiers: [] }).success).toBe(false);
  });

  it('jackpot.settled is a player push with its amounts as santim strings', () => {
    const message = {
      type: 'jackpot.settled',
      data: {
        entryId: 'e',
        roundId: 'r',
        templateCode: 'weekly13',
        status: 'void',
        gross: '0',
        tax: '0',
        net: '0',
        refund: '2000',
        bestCorrect: null,
      },
    };
    expect(UserMessage.parse(message)).toEqual(message);
    expect(
      UserMessage.safeParse({ ...message, data: { ...message.data, status: 'open' } }).success,
    ).toBe(false);
    expect(
      UserMessage.safeParse({ ...message, data: { ...message.data, refund: 20 } }).success,
    ).toBe(false);
  });
});
