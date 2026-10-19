import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quoteBet } from './betslip';
import { formatMoney, type ChannelLocale } from './channelreply';
import { DEFAULT_BET_RULES, DEFAULT_MULTI_BONUS, DEFAULT_TAX } from './rules';
import { USSD_MAX_LENGTH } from './smstext';
import { PICK_CODES, type PickCode } from './textcommand';
import {
  parseUssdState,
  serializeUssdState,
  ussdEnd,
  ussdExpiredEnd,
  ussdInputs,
  ussdLatestInput,
  ussdNext,
  ussdNotAvailableEnd,
  ussdOddsChanged,
  ussdPickLabel,
  ussdPlacedEnd,
  ussdRateLimitedEnd,
  ussdRefusedEnd,
  ussdResponse,
  ussdStart,
  ussdUnavailableEnd,
  type UssdContext,
  type UssdGame,
  type UssdState,
  type UssdStep,
} from './ussd';

const sel = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const FOOTBALL: UssdGame = {
  gameId: 1234,
  home: { name: 'Arsenal', short: 'ARS' },
  away: { name: 'Chelsea', short: 'CHE' },
  live: false,
  options: [
    { pick: '1', selectionId: sel(1), oddsMilli: 2000, available: true },
    { pick: 'X', selectionId: sel(2), oddsMilli: 3200, available: true },
    { pick: '2', selectionId: sel(3), oddsMilli: 3500, available: true },
    { pick: 'OV25', selectionId: sel(4), oddsMilli: 1900, available: true },
    { pick: 'UN25', selectionId: sel(5), oddsMilli: 1850, available: true },
    { pick: 'GG', selectionId: sel(6), oddsMilli: 1700, available: true },
    { pick: 'NG', selectionId: sel(7), oddsMilli: 2050, available: true },
  ],
};

const BASKETBALL: UssdGame = {
  gameId: 500,
  home: { name: 'Lakers', short: 'LAL' },
  away: { name: 'Celtics', short: 'BOS' },
  live: true,
  options: [
    { pick: '1', selectionId: sel(11), oddsMilli: 1650, available: true },
    { pick: '2', selectionId: sel(12), oddsMilli: 2250, available: true },
  ],
};

/** Every option suspended, or priced below the minimum leg odds. */
const CLOSED: UssdGame = {
  gameId: 777,
  home: { name: 'Fasil Kenema', short: 'FAS' },
  away: { name: 'Saint George', short: 'STG' },
  live: true,
  options: [
    { pick: '1', selectionId: sel(21), oddsMilli: 1005, available: true },
    { pick: 'X', selectionId: sel(22), oddsMilli: 6000, available: false },
    { pick: '2', selectionId: sel(23), oddsMilli: 9000, available: false },
  ],
};

const LONG_NAMES: UssdGame = {
  gameId: 999999,
  home: { name: 'Wolverhampton Wanderers Football Club', short: 'WOL' },
  away: { name: 'Brighton and Hove Albion Football Club', short: 'BHA' },
  live: true,
  options: FOOTBALL.options.map((option, i) => ({ ...option, selectionId: sel(31 + i) })),
};

const GAMES = [FOOTBALL, BASKETBALL, CLOSED, LONG_NAMES];

function context(
  overrides: Partial<UssdContext> = {},
  games: ReadonlyArray<UssdGame> = GAMES,
): UssdContext {
  const map = new Map<number, UssdGame | null>(games.map((game) => [game.gameId, game]));
  map.set(4040, null);
  return {
    locale: 'en',
    demo: true,
    serviceCode: '*123#',
    rules: DEFAULT_BET_RULES,
    multiBonus: DEFAULT_MULTI_BONUS,
    tax: DEFAULT_TAX,
    games: map,
    ...overrides,
  };
}

const CTX = context();

function menu(step: UssdStep): { state: UssdState; text: string } {
  if (step.kind !== 'menu') throw new Error(`expected a menu, got ${JSON.stringify(step)}`);
  return step;
}

function end(step: UssdStep): string {
  if (step.kind !== 'end') throw new Error(`expected an end, got ${JSON.stringify(step)}`);
  return step.text;
}

/** Runs inputs from the main menu, answering need_game from the context. */
function run(inputs: string[], ctx: UssdContext = CTX): UssdStep {
  let step = ussdStart(ctx);
  for (const input of inputs) {
    const state = menu(step).state;
    step = ussdNext(state, input, ctx);
  }
  return step;
}

function win(oddsMilli: number, stake: bigint): bigint {
  return quoteBet({
    stake,
    legs: [{ selectionId: 'x', eventId: 'e', oddsMilli }],
    rules: DEFAULT_BET_RULES,
    multiBonus: DEFAULT_MULTI_BONUS,
    tax: DEFAULT_TAX,
  }).netPayout;
}

describe('main menu', () => {
  it('opens on the main menu', () => {
    const step = menu(ussdStart(CTX));
    expect(step.state).toEqual({ screen: 'main' });
    expect(step.text).toBe(
      'Vamos DEMO\n1 Place bet\n2 Balance\n3 My bets\n4 Jackpot\n5 Help\n0 Exit',
    );
    expect(menu(ussdStart(context({ demo: false }))).text.startsWith('Vamos\n')).toBe(true);
    expect(menu(ussdStart(context({ locale: 'am' }))).text).toContain('1 ውርርድ');
  });

  it('routes every choice', () => {
    expect(menu(run(['1'])).state).toEqual({ screen: 'bet_game' });
    expect(run(['2'])).toEqual({ kind: 'info', info: 'balance' });
    expect(run(['3'])).toEqual({ kind: 'info', info: 'bets' });
    expect(run(['4'])).toEqual({ kind: 'info', info: 'jackpot' });
    expect(end(run(['5']))).toContain('GAMEID#PICK#STAKE');
    expect(end(run(['0']))).toBe('Thank you for using Vamos.');
  });

  it('re-prompts on anything else', () => {
    for (const input of ['', '6', '9', '01', 'x', ' 1 1', '1'.repeat(30), '*', '#']) {
      const step = menu(run([input]));
      expect(step.state).toEqual({ screen: 'main' });
      expect(step.text.startsWith('Invalid choice.\nVamos DEMO\n1 Place bet')).toBe(true);
    }
    // Spaces around a choice are ignored.
    expect(menu(run([' 1 '])).state).toEqual({ screen: 'bet_game' });
  });
});

describe('placing a bet', () => {
  it('asks for the Game ID and lists the picks with their current odds', () => {
    expect(menu(run(['1'])).text).toBe('Enter Game ID:\n00 Main menu');
    const pick = menu(run(['1', '1234']));
    expect(pick.state).toEqual({ screen: 'bet_pick', gameId: 1234, picks: [...PICK_CODES] });
    expect(pick.text).toBe(
      [
        '1234 Arsenal v Chelsea',
        '1 Arsenal 2.00',
        '2 Draw 3.20',
        '3 Chelsea 3.50',
        '4 Over 2.5 1.90',
        '5 Under 2.5 1.85',
        '6 Both score 1.70',
        '7 Not both 2.05',
        '00 Main menu',
      ].join('\n'),
    );
    const live = menu(run(['1', '0500']));
    expect(live.state).toEqual({ screen: 'bet_pick', gameId: 500, picks: ['1', '2'] });
    expect(live.text.split('\n')[0]).toBe('0500 LIVE Lakers v Celtics');
  });

  it('asks the caller to look up a game it does not have yet', () => {
    expect(run(['1', '4321'])).toEqual({ kind: 'need_game', gameId: 4321 });
  });

  it('re-prompts for an invalid, unknown or closed game', () => {
    for (const input of ['', 'abc', '99', '1000000', '12 34', '1234#', '1'.repeat(25)]) {
      const step = menu(run(['1', input]));
      expect(step.state).toEqual({ screen: 'bet_game' });
      expect(step.text).toBe('Invalid Game ID.\nEnter Game ID:\n00 Main menu');
    }
    expect(menu(run(['1', '4040'])).text).toBe(
      'Game 4040 not found.\nEnter Game ID:\n00 Main menu',
    );
    const closed = menu(run(['1', '777']));
    expect(closed.state).toEqual({ screen: 'bet_game' });
    expect(closed.text).toBe('Game 0777: no bets open now.\nEnter Game ID:\n00 Main menu');
  });

  it('takes a pick, a stake and shows the possible win before confirming', () => {
    const stake = menu(run(['1', '1234', '2']));
    expect(stake.state).toEqual({ screen: 'bet_stake', gameId: 1234, pick: 'X' });
    expect(stake.text).toBe('Draw @3.20\nEnter stake in ETB (min 5.00):\n00 Main menu');

    const confirm = menu(run(['1', '1234', '2', '50']));
    expect(confirm.state).toEqual({
      screen: 'bet_confirm',
      gameId: 1234,
      pick: 'X',
      selectionId: sel(2),
      oddsMilli: 3200,
      stake: 5000n,
    });
    expect(confirm.text).toBe(
      [
        '1234 Arsenal v Chelsea',
        'Draw @3.20',
        'Stake ETB 50.00',
        `Win ${formatMoney(win(3200, 5000n), 'en')}`,
        '1 Confirm',
        '00 Main menu',
      ].join('\n'),
    );
  });

  it('places exactly what the confirm screen showed', () => {
    expect(run(['1', '1234', '4', '120', '1'])).toEqual({
      kind: 'place',
      bet: { gameId: 1234, pick: 'OV25', selectionId: sel(4), oddsMilli: 1900, stake: 12_000n },
    });
    // Even when the context's prices moved since: the caller places at the shown odds.
    const state = menu(run(['1', '1234', '4', '120'])).state;
    const moved = context({}, [
      {
        ...FOOTBALL,
        options: FOOTBALL.options.map((o) => (o.pick === 'OV25' ? { ...o, oddsMilli: 1500 } : o)),
      },
    ]);
    expect(ussdNext(state, '1', moved)).toEqual({
      kind: 'place',
      bet: { gameId: 1234, pick: 'OV25', selectionId: sel(4), oddsMilli: 1900, stake: 12_000n },
    });
  });

  it('re-prompts for an invalid pick', () => {
    for (const input of ['0', '8', '9', '-1', 'x', '1.0', '', '001']) {
      const step = menu(run(['1', '1234', input]));
      expect(step.state).toEqual({ screen: 'bet_pick', gameId: 1234, picks: [...PICK_CODES] });
      expect(step.text.startsWith('Invalid choice.\n1234 Arsenal v Chelsea\n1 Arsenal 2.00')).toBe(
        true,
      );
    }
    // A two-way game has two options only.
    expect(menu(run(['1', '500', '3'])).text.startsWith('Invalid choice.')).toBe(true);
  });

  it('re-lists the picks when the chosen one closed meanwhile', () => {
    const state = menu(run(['1', '1234'])).state;
    const changed = context({}, [
      {
        ...FOOTBALL,
        options: FOOTBALL.options.map((o) => (o.pick === 'X' ? { ...o, available: false } : o)),
      },
    ]);
    const step = menu(ussdNext(state, '2', changed));
    expect(step.state).toEqual({
      screen: 'bet_pick',
      gameId: 1234,
      picks: ['1', '2', 'OV25', 'UN25', 'GG', 'NG'],
    });
    expect(step.text.startsWith('That option is not available now.\n1234 Arsenal v Chelsea')).toBe(
      true,
    );
    // Same from the stake screen.
    const stakeState = menu(run(['1', '1234', '2'])).state;
    expect(menu(ussdNext(stakeState, '50', changed)).state.screen).toBe('bet_pick');
  });

  it('re-prompts for an invalid, too small or too big stake', () => {
    for (const input of ['', '0', '5.5', '-5', 'abc', '1e3', '5 0', '9'.repeat(25)]) {
      const step = menu(run(['1', '1234', '1', input]));
      expect(step.state).toEqual({ screen: 'bet_stake', gameId: 1234, pick: '1' });
      expect(step.text.startsWith('Invalid stake: whole birr only.\nArsenal @2.00')).toBe(true);
    }
    const low = menu(run(['1', '1234', '1', '4']));
    expect(low.text.startsWith('Minimum stake ETB 5.00.\n')).toBe(true);
    const high = menu(run(['1', '1234', '1', '100001']));
    expect(high.text.startsWith('Maximum stake ETB 100,000.00.\n')).toBe(true);
    expect(menu(run(['1', '1234', '1', '5'])).state.screen).toBe('bet_confirm');
    expect(menu(run(['1', '1234', '1', '100000'])).state.screen).toBe('bet_confirm');
  });

  it('asks again on the confirm screen for anything but 1', () => {
    for (const input of ['', '2', '0', 'yes', '11']) {
      const step = menu(run(['1', '1234', '1', '50', input]));
      expect(step.state.screen).toBe('bet_confirm');
      expect(step.text.startsWith('Invalid choice.\n1234 Arsenal v Chelsea')).toBe(true);
    }
  });

  it('goes back to the main menu with 00 from every screen', () => {
    for (const path of [[], ['1'], ['1', '1234'], ['1', '1234', '1'], ['1', '1234', '1', '50']]) {
      const step = menu(run([...path, '00']));
      expect(step.state).toEqual({ screen: 'main' });
      expect(step.text.startsWith('Vamos DEMO\n1 Place bet')).toBe(true);
    }
  });

  it('shows the confirm screen again at new odds after a price change', () => {
    const bet = {
      gameId: 1234,
      pick: '1' as const,
      selectionId: sel(1),
      oddsMilli: 2000,
      stake: 5000n,
    };
    const moved: UssdGame = {
      ...FOOTBALL,
      options: FOOTBALL.options.map((o) => (o.pick === '1' ? { ...o, oddsMilli: 1800 } : o)),
    };
    const step = menu(ussdOddsChanged(bet, moved, CTX));
    expect(step.state).toEqual({ screen: 'bet_confirm', ...bet, oddsMilli: 1800 });
    expect(
      step.text.startsWith('Odds changed to 1.80.\n1234 Arsenal v Chelsea\nArsenal @1.80'),
    ).toBe(true);
    const suspended: UssdGame = {
      ...FOOTBALL,
      options: FOOTBALL.options.map((o) => (o.pick === '1' ? { ...o, available: false } : o)),
    };
    expect(menu(ussdOddsChanged(bet, suspended, CTX)).state.screen).toBe('bet_pick');
    const allClosed: UssdGame = {
      ...FOOTBALL,
      options: FOOTBALL.options.map((o) => ({ ...o, available: false })),
    };
    expect(menu(ussdOddsChanged(bet, allClosed, CTX)).state).toEqual({ screen: 'bet_game' });
  });

  it('uses short team names when the full ones do not fit', () => {
    const step = menu(run(['1', '999999']));
    expect(step.text.length).toBeLessThanOrEqual(USSD_MAX_LENGTH - 4);
    expect(step.text).toContain('2 Draw 3.20');
    const label = ussdPickLabel(LONG_NAMES, '1', 'en', 'short');
    expect(label).toBe('WOL');
    expect(ussdPickLabel(FOOTBALL, 'X', 'am')).toBe('አቻ');
  });

  it('ends a session that is over', () => {
    expect(end(ussdNext({ screen: 'ended' }, '1', CTX))).toBe('Session ended. Dial *123# again.');
    expect(end(ussdNext({ screen: 'ended' }, '00', CTX))).toBe('Session ended. Dial *123# again.');
  });
});

describe('end screens', () => {
  it('render placed bets, refusals and service messages within the limit', () => {
    const placed = ussdPlacedEnd(
      {
        shortId: 'AB23CD45',
        legs: 1,
        totalOddsMilli: 2000n,
        stake: 5000n,
        potentialNetPayout: 10_000n,
        pendingAcceptance: false,
      },
      CTX,
    );
    expect(end(placed)).toBe(
      'Bet AB23CD45 placed. Odds 2.00, stake ETB 50.00, possible win ETB 100.00.',
    );
    expect(
      end(ussdRefusedEnd({ code: 'insufficient_funds', balance: 0n, stake: 5000n }, CTX)),
    ).toBe('Your balance (ETB 0.00) is too low for a stake of ETB 50.00. No bet placed.');
    expect(end(ussdExpiredEnd(CTX))).toBe('Session expired. Dial *123# again.');
    expect(end(ussdRateLimitedEnd(CTX))).toBe('Too many requests. Please try again later.');
    expect(end(ussdUnavailableEnd(CTX))).toContain('not available');
    expect(end(ussdNotAvailableEnd())).toContain('Register and verify');
    const long = end(ussdEnd('x'.repeat(500)));
    expect(long.length).toBe(USSD_MAX_LENGTH - 4);
    expect(ussdResponse({ kind: 'end', text: long })).toHaveLength(USSD_MAX_LENGTH);
    expect(ussdResponse({ kind: 'menu', state: { screen: 'main' }, text: 'Hi' })).toBe('CON Hi');
    expect(ussdResponse({ kind: 'end', text: 'Bye' })).toBe('END Bye');
  });
});

describe('callback text', () => {
  it('splits the history and finds the latest input', () => {
    expect(ussdInputs('')).toEqual([]);
    expect(ussdInputs('1*1234*2')).toEqual(['1', '1234', '2']);
    expect(ussdLatestInput(null, '')).toBe('');
    expect(ussdLatestInput('', '1')).toBe('1');
    expect(ussdLatestInput('1', '1*1234')).toBe('1234');
    expect(ussdLatestInput('1*1234', '1*1234*')).toBe('');
    expect(ussdLatestInput('1*1234', '1*1234*00')).toBe('00');
    expect(ussdLatestInput('1*1234', '1*999*2')).toBeNull();
    expect(ussdLatestInput('1*1234', '1*1234')).toBeNull();
    expect(ussdLatestInput('1', '12')).toBeNull();
  });
});

describe('stored state', () => {
  const states: UssdState[] = [
    { screen: 'main' },
    { screen: 'bet_game' },
    { screen: 'bet_pick', gameId: 1234, picks: ['1', 'X', '2'] },
    { screen: 'bet_stake', gameId: 123, pick: 'GG' },
    {
      screen: 'bet_confirm',
      gameId: 999999,
      pick: 'NG',
      selectionId: sel(9),
      oddsMilli: 1_000_000,
      stake: 99_999_999_900n,
    },
    { screen: 'ended' },
  ];

  it('round-trips through JSON', () => {
    for (const state of states) {
      const json: unknown = JSON.parse(JSON.stringify(serializeUssdState(state)));
      expect(parseUssdState(json)).toEqual(state);
    }
  });

  it('refuses anything malformed', () => {
    const bad: unknown[] = [
      null,
      'main',
      42,
      {},
      { screen: 'nope' },
      { screen: 'bet_pick', gameId: 1234, picks: [] },
      { screen: 'bet_pick', gameId: 1234, picks: ['Z'] },
      { screen: 'bet_pick', gameId: 99, picks: ['1'] },
      { screen: 'bet_pick', gameId: 1234, picks: [...PICK_CODES, '1'] },
      { screen: 'bet_stake', gameId: '1234', pick: '1' },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: 'x',
        oddsMilli: 2000,
        stake: '5000',
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 1000,
        stake: '5000',
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 2000.5,
        stake: '5000',
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 1_000_001,
        stake: '5000',
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 2000,
        stake: 5000,
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 2000,
        stake: '0',
      },
      {
        screen: 'bet_confirm',
        gameId: 1234,
        pick: '1',
        selectionId: sel(1),
        oddsMilli: 2000,
        stake: '-5',
      },
    ];
    for (const json of bad) expect(parseUssdState(json)).toBeNull();
  });
});

// ------------------------------------------------------------ exhaustive / properties

const INPUTS = [
  '',
  '0',
  '00',
  '000',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '50',
  '100001',
  '123',
  '500',
  '777',
  '1234',
  '4040',
  '4321',
  '999999',
  'x',
  '5.5',
  ' 1 ',
  '*',
  '1'.repeat(30),
];

function allStates(): UssdState[] {
  const states: UssdState[] = [{ screen: 'main' }, { screen: 'bet_game' }, { screen: 'ended' }];
  for (const game of GAMES) {
    const picks = game.options.map((option) => option.pick);
    states.push({ screen: 'bet_pick', gameId: game.gameId, picks });
    for (const option of game.options) {
      states.push({ screen: 'bet_stake', gameId: game.gameId, pick: option.pick });
      states.push({
        screen: 'bet_confirm',
        gameId: game.gameId,
        pick: option.pick,
        selectionId: option.selectionId,
        oddsMilli: Math.max(option.oddsMilli, 1001),
        stake: 5000n,
      });
    }
  }
  // States naming games the context does not have (yet).
  states.push({ screen: 'bet_pick', gameId: 4321, picks: ['1'] });
  states.push({ screen: 'bet_stake', gameId: 4040, pick: '1' });
  return states;
}

function checkStep(step: UssdStep, ctx: UssdContext): void {
  switch (step.kind) {
    case 'menu': {
      expect(step.text.length).toBeGreaterThan(0);
      expect(ussdResponse(step).length).toBeLessThanOrEqual(USSD_MAX_LENGTH);
      // Every state a menu stores can be stored and read back.
      const json: unknown = JSON.parse(JSON.stringify(serializeUssdState(step.state)));
      expect(parseUssdState(json)).toEqual(step.state);
      if (step.state.screen === 'bet_pick') {
        const game = ctx.games.get(step.state.gameId);
        expect(game).toBeTruthy();
        for (const pick of step.state.picks) {
          const option = game?.options.find((o) => o.pick === pick);
          expect(option?.available).toBe(true);
          expect(option!.oddsMilli).toBeGreaterThanOrEqual(ctx.rules.minLegOddsMilli);
        }
      }
      break;
    }
    case 'end':
      expect(ussdResponse(step).length).toBeLessThanOrEqual(USSD_MAX_LENGTH);
      break;
    case 'need_game':
      expect(ctx.games.has(step.gameId)).toBe(false);
      break;
    case 'info':
      expect(['balance', 'bets', 'jackpot']).toContain(step.info);
      break;
    case 'place':
      expect(step.bet.stake > 0n).toBe(true);
      break;
  }
}

describe('exhaustive and property checks', () => {
  it('answers every input on every screen within the length limit, in both languages', () => {
    for (const locale of ['en', 'am'] as ChannelLocale[]) {
      for (const demo of [true, false]) {
        const ctx = context({ locale, demo });
        for (const state of allStates()) {
          for (const input of INPUTS) {
            checkStep(ussdNext(state, input, ctx), ctx);
          }
        }
      }
    }
  });

  it('only ever places from the confirm screen with input 1', () => {
    for (const state of allStates()) {
      for (const input of INPUTS) {
        const step = ussdNext(state, input, CTX);
        if (step.kind === 'place') {
          expect(state.screen).toBe('bet_confirm');
          expect(input.trim()).toBe('1');
          if (state.screen === 'bet_confirm') {
            const { screen: _screen, ...shown } = state;
            expect(step.bet).toEqual(shown);
          }
        }
      }
    }
  });

  const pickArb = fc.constantFrom<PickCode>(...PICK_CODES);
  const stateArb: fc.Arbitrary<UssdState> = fc.oneof(
    fc.constant<UssdState>({ screen: 'main' }),
    fc.constant<UssdState>({ screen: 'bet_game' }),
    fc.constant<UssdState>({ screen: 'ended' }),
    fc.record({
      screen: fc.constant('bet_pick' as const),
      gameId: fc.constantFrom(1234, 500, 777, 999999, 4040, 4321),
      picks: fc.uniqueArray(pickArb, { minLength: 1, maxLength: 7 }),
    }),
    fc.record({
      screen: fc.constant('bet_stake' as const),
      gameId: fc.constantFrom(1234, 500, 777, 999999, 4040),
      pick: pickArb,
    }),
    fc.record({
      screen: fc.constant('bet_confirm' as const),
      gameId: fc.constantFrom(1234, 500, 999999),
      pick: pickArb,
      selectionId: fc.constant(sel(1)),
      oddsMilli: fc.integer({ min: 1001, max: 1_000_000 }),
      stake: fc.bigInt({ min: 500n, max: 10_000_000n }),
    }),
  );

  it('never throws for arbitrary input and keeps responses within 182 characters', () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.oneof(fc.string({ unit: 'binary', maxLength: 60 }), fc.constantFrom(...INPUTS)),
        fc.constantFrom<ChannelLocale>('en', 'am'),
        (state, input, locale) => {
          const ctx = context({ locale });
          checkStep(ussdNext(state, input, ctx), ctx);
        },
      ),
    );
  });
});
