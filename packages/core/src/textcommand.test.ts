import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { marketKey } from './markets';
import { DEFAULT_BET_RULES } from './rules';
import {
  formatTextCommand,
  MAX_TEXT_COMMAND_LENGTH,
  parsePick,
  parseTextCommand,
  parseWholeBirrStake,
  pickSelection,
  PICK_CODES,
  picksForSport,
  type TextCommand,
  type TextCommandResult,
} from './textcommand';

const ok = (command: TextCommand): TextCommandResult => ({ ok: true, command });

describe('parseTextCommand: bets', () => {
  it('reads a single as GAMEID#PICK#STAKE with the stake in santim', () => {
    expect(parseTextCommand('1234#1#50')).toEqual(
      ok({ kind: 'bet', legs: [{ gameId: 1234, pick: '1' }], stake: 5000n }),
    );
    expect(parseTextCommand('0123#x#5')).toEqual(
      ok({ kind: 'bet', legs: [{ gameId: 123, pick: 'X' }], stake: 500n }),
    );
  });

  it('reads a multi as GAMEID#PICK pairs followed by one stake', () => {
    expect(parseTextCommand('1234#1#5678#X#999999#ov25#100')).toEqual(
      ok({
        kind: 'bet',
        legs: [
          { gameId: 1234, pick: '1' },
          { gameId: 5678, pick: 'X' },
          { gameId: 999999, pick: 'OV25' },
        ],
        stake: 10_000n,
      }),
    );
  });

  it('is case-insensitive, tolerant of spaces and takes * (and full-width marks) for #', () => {
    const expected = ok({
      kind: 'bet',
      legs: [
        { gameId: 1234, pick: 'GG' },
        { gameId: 5678, pick: 'UN25' },
      ],
      stake: 2000n,
    });
    expect(parseTextCommand(' 1234 # gg # 5678 # Un25 # 20 ')).toEqual(expected);
    expect(parseTextCommand('1234*GG*5678*UN25*20')).toEqual(expected);
    expect(parseTextCommand('1234＃gg＊5678#un2.5*20')).toEqual(expected);
    expect(parseTextCommand('\n1234#GG##5678#UN25#20#\n')).toEqual(expected);
  });

  it('accepts every pick code and its spellings', () => {
    for (const pick of PICK_CODES) {
      const result = parseTextCommand(`500#${pick.toLowerCase()}#10`);
      expect(result).toEqual(ok({ kind: 'bet', legs: [{ gameId: 500, pick }], stake: 1000n }));
    }
    expect(parsePick('ov2.5')).toBe('OV25');
    expect(parsePick(' U N 2 5 ')).toBe('UN25');
    expect(parsePick('3')).toBeNull();
    expect(parsePick('draw')).toBeNull();
  });

  it('names what is wrong with a bet it cannot read', () => {
    expect(parseTextCommand('1234#1')).toEqual({ ok: false, error: { code: 'missing_stake' } });
    expect(parseTextCommand('1234#1#5678#X')).toEqual({
      ok: false,
      error: { code: 'missing_stake' },
    });
    expect(parseTextCommand('99#1#50')).toEqual({
      ok: false,
      error: { code: 'invalid_game_id', token: '99' },
    });
    expect(parseTextCommand('1000000#1#50')).toEqual({
      ok: false,
      error: { code: 'invalid_game_id', token: '1000000' },
    });
    expect(parseTextCommand('12 34#1#50')).toEqual({
      ok: false,
      error: { code: 'invalid_game_id', token: '12 34' },
    });
    expect(parseTextCommand('1234#3#50')).toEqual({
      ok: false,
      error: { code: 'invalid_pick', gameId: 1234, token: '3' },
    });
    expect(parseTextCommand('1234#1#5678#X#1234#2#50')).toEqual({
      ok: false,
      error: { code: 'duplicate_game', gameId: 1234 },
    });
    expect(parseTextCommand('0123#1#123#2#50')).toEqual({
      ok: false,
      error: { code: 'duplicate_game', gameId: 123 },
    });
    expect(parseTextCommand('#')).toEqual({ ok: false, error: { code: 'empty' } });
    expect(parseTextCommand('1234#')).toEqual({ ok: false, error: { code: 'incomplete_bet' } });
  });

  it('caps the legs at the bet rules', () => {
    const legs = (count: number) =>
      Array.from({ length: count }, (_, i) => `${1000 + i}#1`).join('#');
    const max = DEFAULT_BET_RULES.maxLegs;
    const atMax = parseTextCommand(`${legs(max)}#50`);
    expect(atMax.ok && atMax.command.kind === 'bet' && atMax.command.legs.length).toBe(max);
    expect(parseTextCommand(`${legs(max + 1)}#50`)).toEqual({
      ok: false,
      error: { code: 'too_many_legs', legs: max + 1, max },
    });
    expect(parseTextCommand(`${legs(3)}#50`, { maxLegs: 2 })).toEqual({
      ok: false,
      error: { code: 'too_many_legs', legs: 3, max: 2 },
    });
    // A 40-leg multi of six-digit Game IDs fits in the length limit.
    const longest = `${Array.from({ length: max }, (_, i) => `${100_000 + i}#OV25`).join('#')}#999999999`;
    expect(longest.length).toBeLessThanOrEqual(MAX_TEXT_COMMAND_LENGTH);
    expect(parseTextCommand(longest).ok).toBe(true);
  });

  it('refuses texts above the length limit without reading them', () => {
    expect(parseTextCommand('1'.repeat(MAX_TEXT_COMMAND_LENGTH + 1))).toEqual({
      ok: false,
      error: { code: 'too_long', max: MAX_TEXT_COMMAND_LENGTH },
    });
  });
});

describe('stakes', () => {
  it('reads whole birr into santim without floating point', () => {
    expect(parseWholeBirrStake('50')).toBe(5000n);
    expect(parseWholeBirrStake('050')).toBe(5000n);
    expect(parseWholeBirrStake(' 7 ')).toBe(700n);
    expect(parseWholeBirrStake('50.0')).toBe(5000n);
    expect(parseWholeBirrStake('50.00')).toBe(5000n);
    expect(parseWholeBirrStake('999999999')).toBe(99_999_999_900n);
    // 0.1 + 0.2 style traps never apply: the digits are read as a bigint.
    expect(parseWholeBirrStake('9007199254')).toBeNull();
  });

  it('refuses fractions, signs, separators, exponents, spaces inside and zero', () => {
    for (const token of [
      '0',
      '00',
      '0.00',
      '50.5',
      '50.50',
      '50.000',
      '.5',
      '50.',
      '-5',
      '+5',
      '1e3',
      '5,000',
      '5 0',
      '5_0',
      '1000000000',
      '٥٠',
      '５０',
      '',
      'fifty',
      'Infinity',
      'NaN',
      '0x10',
    ]) {
      expect(parseWholeBirrStake(token)).toBeNull();
    }
    expect(parseTextCommand('1234#1#50.5')).toEqual({
      ok: false,
      error: { code: 'invalid_stake', token: '50.5' },
    });
    expect(parseTextCommand('1234#1#0')).toEqual({
      ok: false,
      error: { code: 'invalid_stake', token: '0' },
    });
  });

  it('tells a whole-birr stake that is too long apart from an unreadable one', () => {
    for (const token of ['1000000000', '0001000000000', '12345678901234567890', '1000000000.00']) {
      expect(parseWholeBirrStake(token)).toBeNull();
      expect(parseTextCommand(`1234#1#${token}`)).toEqual({
        ok: false,
        error: { code: 'stake_too_large', token },
      });
    }
    for (const token of ['1000000000.5', '1e10', '10,000,000,000']) {
      expect(parseTextCommand(`1234#1#${token}`)).toEqual({
        ok: false,
        error: { code: 'invalid_stake', token },
      });
    }
  });
});

describe('parseTextCommand: keywords', () => {
  it('reads BAL, BETS, JP, HELP, STOP and START in any case and with spaces', () => {
    const cases: Array<[string, TextCommand['kind']]> = [
      ['BAL', 'balance'],
      [' bal ', 'balance'],
      ['Balance', 'balance'],
      ['BETS', 'bets'],
      ['my bets', 'bets'],
      ['jp', 'jackpot'],
      ['JACKPOT', 'jackpot'],
      ['help', 'help'],
      ['H E L P', 'help'],
      ['stop', 'stop'],
      ['Start', 'start'],
      ['#BAL#', 'balance'],
    ];
    for (const [text, kind] of cases) {
      expect(parseTextCommand(text)).toEqual(ok({ kind } as TextCommand));
    }
  });

  it('answers unknown words as unknown commands', () => {
    for (const text of ['hello', 'BAL 1234', '1234', 'STOPP', 'ውርርድ']) {
      expect(parseTextCommand(text)).toEqual({ ok: false, error: { code: 'unknown_command' } });
    }
    for (const text of ['', '   ', '\n']) {
      expect(parseTextCommand(text)).toEqual({ ok: false, error: { code: 'empty' } });
    }
  });
});

describe('picks on events', () => {
  it('maps picks to the main markets of each sport', () => {
    expect(pickSelection('football', '1')).toEqual({ marketKey: '1x2', code: '1' });
    expect(pickSelection('football', 'X')).toEqual({ marketKey: '1x2', code: 'X' });
    expect(pickSelection('football', 'OV25')).toEqual({
      marketKey: marketKey('ou', '2.5'),
      code: 'over',
    });
    expect(pickSelection('football', 'UN25')).toEqual({ marketKey: 'ou:2.5', code: 'under' });
    expect(pickSelection('football', 'GG')).toEqual({ marketKey: 'btts', code: 'yes' });
    expect(pickSelection('football', 'NG')).toEqual({ marketKey: 'btts', code: 'no' });
    expect(pickSelection('basketball', '2')).toEqual({ marketKey: 'ml', code: '2' });
    expect(pickSelection('tennis', '1')).toEqual({ marketKey: 'winner', code: '1' });
    expect(pickSelection('volleyball', '2')).toEqual({ marketKey: 'winner', code: '2' });
  });

  it('has no draw, totals or both-teams-to-score outside football', () => {
    for (const sport of ['basketball', 'tennis', 'volleyball']) {
      for (const pick of ['X', 'OV25', 'UN25', 'GG', 'NG'] as const) {
        expect(pickSelection(sport, pick)).toBeNull();
      }
      expect(picksForSport(sport)).toEqual(['1', '2']);
    }
    expect(picksForSport('football')).toEqual([...PICK_CODES]);
    expect(picksForSport('cricket')).toEqual([]);
  });
});

describe('formatTextCommand', () => {
  it('writes the canonical text', () => {
    expect(
      formatTextCommand({
        kind: 'bet',
        legs: [
          { gameId: 123, pick: '1' },
          { gameId: 5678, pick: 'OV25' },
        ],
        stake: 5000n,
      }),
    ).toBe('0123#1#5678#OV25#50');
    expect(formatTextCommand({ kind: 'balance' })).toBe('BAL');
    expect(formatTextCommand({ kind: 'jackpot' })).toBe('JP');
  });

  it('refuses bets that could not have been parsed', () => {
    const leg = { gameId: 1234, pick: '1' as const };
    expect(() => formatTextCommand({ kind: 'bet', legs: [], stake: 5000n })).toThrow(RangeError);
    expect(() => formatTextCommand({ kind: 'bet', legs: [leg], stake: 5050n })).toThrow(RangeError);
    expect(() => formatTextCommand({ kind: 'bet', legs: [leg], stake: 0n })).toThrow(RangeError);
    expect(() => formatTextCommand({ kind: 'bet', legs: [leg], stake: 100_000_000_000n })).toThrow(
      RangeError,
    );
    expect(() => formatTextCommand({ kind: 'bet', legs: [leg, leg], stake: 5000n })).toThrow(
      RangeError,
    );
    expect(() =>
      formatTextCommand({ kind: 'bet', legs: [{ gameId: 99, pick: '1' }], stake: 5000n }),
    ).toThrow(RangeError);
  });
});

// ------------------------------------------------------------ properties

const gameIdArb = fc.integer({ min: 100, max: 999_999 });
const pickArb = fc.constantFrom(...PICK_CODES);
const stakeArb = fc.bigInt({ min: 1n, max: 999_999_999n }).map((birr) => birr * 100n);
const betArb = fc
  .uniqueArray(fc.record({ gameId: gameIdArb, pick: pickArb }), {
    minLength: 1,
    maxLength: DEFAULT_BET_RULES.maxLegs,
    selector: (leg) => leg.gameId,
  })
  .chain((legs) => stakeArb.map((stake): TextCommand => ({ kind: 'bet', legs, stake })));
const keywordArb = fc.constantFrom<TextCommand>(
  { kind: 'balance' },
  { kind: 'bets' },
  { kind: 'jackpot' },
  { kind: 'help' },
  { kind: 'stop' },
  { kind: 'start' },
);
const commandArb = fc.oneof(betArb, keywordArb);

/** Re-spells a canonical command the way people type: case, spaces and separators. */
function respell(text: string, choices: { star: boolean[]; lower: boolean; pad: string }): string {
  let index = 0;
  const spelled = text.replace(/#/g, () => {
    const star = choices.star[index % Math.max(choices.star.length, 1)] ?? false;
    index += 1;
    return `${choices.pad}${star ? '*' : '#'}${choices.pad}`;
  });
  return choices.lower ? spelled.toLowerCase() : spelled;
}

describe('properties', () => {
  it('parse(format(command)) gives the command back', () => {
    fc.assert(
      fc.property(commandArb, (command) => {
        expect(parseTextCommand(formatTextCommand(command))).toEqual(ok(command));
      }),
    );
  });

  it('reads the same command whatever the case, spacing and separators', () => {
    fc.assert(
      fc.property(
        commandArb,
        fc.array(fc.boolean(), { maxLength: 8 }),
        fc.boolean(),
        fc.constantFrom('', ' ', '  '),
        (command, star, lower, pad) => {
          const text = respell(formatTextCommand(command), { star, lower, pad });
          expect(parseTextCommand(`${pad}${text}${pad}`)).toEqual(ok(command));
        },
      ),
    );
  });

  it('never throws, and every bet it reads is well formed with a whole-birr bigint stake', () => {
    const tokenArb = fc.oneof(
      fc.string(),
      fc.constantFrom('1234', '0123', '99', 'x', 'OV25', 'gg', '50', '50.00', '0', '-5', 'BAL'),
      fc.integer({ min: -10, max: 2_000_000 }).map(String),
    );
    const textArb = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 700 }),
      fc
        .array(tokenArb, { maxLength: 12 })
        .chain((tokens) =>
          fc.constantFrom('#', '*', ' # ', '＃').map((separator) => tokens.join(separator)),
        ),
    );
    fc.assert(
      fc.property(textArb, fc.integer({ min: 1, max: 40 }), (text, maxLegs) => {
        const result = parseTextCommand(text, { maxLegs });
        if (!result.ok) {
          expect(typeof result.error.code).toBe('string');
          return;
        }
        if (result.command.kind !== 'bet') return;
        const { legs, stake } = result.command;
        expect(typeof stake).toBe('bigint');
        expect(stake > 0n && stake % 100n === 0n).toBe(true);
        expect(legs.length).toBeGreaterThanOrEqual(1);
        expect(legs.length).toBeLessThanOrEqual(maxLegs);
        expect(new Set(legs.map((leg) => leg.gameId)).size).toBe(legs.length);
        for (const leg of legs) {
          expect(Number.isInteger(leg.gameId) && leg.gameId >= 100 && leg.gameId <= 999_999).toBe(
            true,
          );
          expect(PICK_CODES).toContain(leg.pick);
        }
      }),
    );
  });

  it('reads any whole-birr stake exactly (digits to bigint, never a float)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 999_999_999n }),
        fc.nat({ max: 2 }),
        fc.constantFrom('', '.0', '.00'),
        (birr, zeros, decimals) => {
          const token = `${'0'.repeat(zeros)}${birr.toString()}${decimals}`;
          expect(parseWholeBirrStake(token)).toBe(birr * 100n);
        },
      ),
    );
  });
});
