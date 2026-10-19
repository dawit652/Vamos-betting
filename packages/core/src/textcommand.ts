/**
 * Text commands for betting by SMS (Betika style), shared by the SMS channel
 * and, for picks and stakes, the USSD menus.
 *
 * - Bet: `GAMEID#PICK#STAKE` (single) or `GAMEID#PICK#GAMEID#PICK…#STAKE`
 *   (multi). GAMEID is the event's Game ID (100–999999, leading zeros
 *   allowed), PICK a code of the event's main markets (PICK_CODES) and STAKE
 *   whole birr ("50"; "50.00" is accepted too).
 * - Keywords: BAL (balance), BETS (last bets), JP (open jackpots), HELP,
 *   STOP / START (marketing SMS opt-out and back in).
 *
 * Case-insensitive; spaces around tokens are ignored; `*` (and the full-width
 * `＃` / `＊`) work as separators like `#`. Spaces inside a Game ID or stake
 * are refused rather than guessed ("5 0" is not 50). Stakes are parsed from
 * the digits into bigint santim; no floating point is involved.
 * parseTextCommand never throws: anything it cannot read is an error value.
 */
import { formatGameId, parseGameId } from './codes';
import { marketKey, type SportCode } from './markets';
import { type Santim, SANTIM_PER_BIRR } from './money';
import { DEFAULT_BET_RULES } from './rules';

/**
 * Picks on an event's main markets: 1 / X / 2 (football match result; 1 / 2
 * on two-way sports), OV25 / UN25 (football over/under 2.5 goals), GG / NG
 * (football both teams to score: yes / no).
 */
export const PICK_CODES = ['1', 'X', '2', 'OV25', 'UN25', 'GG', 'NG'] as const;
export type PickCode = (typeof PICK_CODES)[number];

/** Spellings accepted for each pick (compared upper-cased, without spaces). */
const PICK_ALIASES: Readonly<Record<string, PickCode>> = {
  '1': '1',
  X: 'X',
  '2': '2',
  OV25: 'OV25',
  'OV2.5': 'OV25',
  UN25: 'UN25',
  'UN2.5': 'UN25',
  GG: 'GG',
  NG: 'NG',
};

/** The market (by key) and selection code a pick stands for on an event of `sport`. */
export interface PickSelectionRef {
  marketKey: string;
  code: string;
}

const TWO_WAY_MARKET: Readonly<Partial<Record<SportCode, '1x2' | 'ml' | 'winner'>>> = {
  football: '1x2',
  basketball: 'ml',
  tennis: 'winner',
  volleyball: 'winner',
};

/**
 * The selection a pick names on an event of `sport`, or null when the sport
 * has no such market (X on a two-way sport; OV25, UN25, GG and NG outside
 * football).
 */
export function pickSelection(sport: string, pick: PickCode): PickSelectionRef | null {
  const football = sport === 'football';
  switch (pick) {
    case '1':
    case '2': {
      const type = TWO_WAY_MARKET[sport as SportCode];
      return type === undefined ? null : { marketKey: marketKey(type), code: pick };
    }
    case 'X':
      return football ? { marketKey: marketKey('1x2'), code: 'X' } : null;
    case 'OV25':
      return football ? { marketKey: marketKey('ou', '2.5'), code: 'over' } : null;
    case 'UN25':
      return football ? { marketKey: marketKey('ou', '2.5'), code: 'under' } : null;
    case 'GG':
      return football ? { marketKey: marketKey('btts'), code: 'yes' } : null;
    case 'NG':
      return football ? { marketKey: marketKey('btts'), code: 'no' } : null;
  }
}

/** The picks a sport can offer, in display order (whether each market exists is per event). */
export function picksForSport(sport: string): PickCode[] {
  return PICK_CODES.filter((pick) => pickSelection(sport, pick) !== null);
}

/** The pick a token spells, or null. */
export function parsePick(token: string): PickCode | null {
  if (typeof token !== 'string') return null;
  return PICK_ALIASES[token.replace(/\s+/g, '').toUpperCase()] ?? null;
}

/** Longest stake accepted, in digits (999,999,999 birr). */
const MAX_STAKE_DIGITS = 9;
const STAKE_PATTERN = new RegExp(`^(\\d{1,${MAX_STAKE_DIGITS}})(?:\\.0{1,2})?$`);

/**
 * A stake typed in whole birr ("50", "050", "50.00") as santim, or null for
 * anything else (decimals other than zeros, signs, separators, spaces inside,
 * zero, more than nine digits). Never goes through a float.
 */
export function parseWholeBirrStake(token: string): Santim | null {
  if (typeof token !== 'string') return null;
  const match = STAKE_PATTERN.exec(token.trim());
  const digits = match?.[1];
  if (digits === undefined) return null;
  const birr = BigInt(digits);
  return birr > 0n ? birr * SANTIM_PER_BIRR : null;
}

export interface TextBetLeg {
  gameId: number;
  pick: PickCode;
}

export type TextCommand =
  | { kind: 'bet'; legs: TextBetLeg[]; stake: Santim }
  | { kind: 'balance' }
  | { kind: 'bets' }
  | { kind: 'jackpot' }
  | { kind: 'help' }
  | { kind: 'stop' }
  | { kind: 'start' };

export type TextCommandKind = TextCommand['kind'];

/**
 * Why a text is not a command. `token` is the offending input, trimmed (show
 * it shortened: it is whatever the sender typed).
 */
export type TextCommandError =
  | { code: 'empty' }
  | { code: 'too_long'; max: number }
  | { code: 'unknown_command' }
  | { code: 'incomplete_bet' }
  | { code: 'missing_stake' }
  | { code: 'too_many_legs'; legs: number; max: number }
  | { code: 'invalid_game_id'; token: string }
  | { code: 'invalid_pick'; gameId: number; token: string }
  | { code: 'invalid_stake'; token: string }
  | { code: 'duplicate_game'; gameId: number };

export type TextCommandResult =
  { ok: true; command: TextCommand } | { ok: false; error: TextCommandError };

/** Longest text read as a command (a 40-leg multi of 6-digit Game IDs fits easily). */
export const MAX_TEXT_COMMAND_LENGTH = 640;

const SEPARATOR = /[#*＃＊]/;
const KEYWORDS: Readonly<Record<string, Exclude<TextCommandKind, 'bet'>>> = {
  BAL: 'balance',
  BALANCE: 'balance',
  BETS: 'bets',
  MYBETS: 'bets',
  JP: 'jackpot',
  JACKPOT: 'jackpot',
  HELP: 'help',
  STOP: 'stop',
  START: 'start',
};
const CANONICAL_KEYWORD: Readonly<Record<Exclude<TextCommandKind, 'bet'>, string>> = {
  balance: 'BAL',
  bets: 'BETS',
  jackpot: 'JP',
  help: 'HELP',
  stop: 'STOP',
  start: 'START',
};

const failure = (error: TextCommandError): TextCommandResult => ({ ok: false, error });

/** The keyword command a token spells (spaces and case ignored), or null. */
function keywordOf(token: string): Exclude<TextCommandKind, 'bet'> | null {
  return KEYWORDS[token.replace(/\s+/g, '').toUpperCase()] ?? null;
}

/**
 * Reads an SMS as a command. `maxLegs` (default the bet rules' 40) caps the
 * legs of a multi; the caller passes the current bet rules. Which picks an
 * event actually offers, and whether it can be bet on, is checked later.
 */
export function parseTextCommand(
  text: string,
  options: { maxLegs?: number } = {},
): TextCommandResult {
  if (typeof text !== 'string') return failure({ code: 'empty' });
  if (text.length > MAX_TEXT_COMMAND_LENGTH) {
    return failure({ code: 'too_long', max: MAX_TEXT_COMMAND_LENGTH });
  }
  const maxLegs = options.maxLegs ?? DEFAULT_BET_RULES.maxLegs;
  const hasSeparator = SEPARATOR.test(text);
  const tokens = text
    .split(SEPARATOR)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return failure({ code: 'empty' });

  if (tokens.length === 1) {
    const kind = keywordOf(tokens[0] ?? '');
    if (kind !== null) return { ok: true, command: { kind } };
    return failure({ code: hasSeparator ? 'incomplete_bet' : 'unknown_command' });
  }
  if (tokens.length % 2 === 0) return failure({ code: 'missing_stake' });

  const legCount = (tokens.length - 1) / 2;
  if (legCount > maxLegs) return failure({ code: 'too_many_legs', legs: legCount, max: maxLegs });

  const legs: TextBetLeg[] = [];
  for (let i = 0; i < legCount; i += 1) {
    const gameToken = tokens[2 * i] ?? '';
    const pickToken = tokens[2 * i + 1] ?? '';
    const gameId = parseGameId(gameToken);
    if (gameId === null) return failure({ code: 'invalid_game_id', token: gameToken });
    const pick = parsePick(pickToken);
    if (pick === null) return failure({ code: 'invalid_pick', gameId, token: pickToken });
    legs.push({ gameId, pick });
  }
  const stakeToken = tokens[tokens.length - 1] ?? '';
  const stake = parseWholeBirrStake(stakeToken);
  if (stake === null) return failure({ code: 'invalid_stake', token: stakeToken });

  const seen = new Set<number>();
  for (const leg of legs) {
    if (seen.has(leg.gameId)) return failure({ code: 'duplicate_game', gameId: leg.gameId });
    seen.add(leg.gameId);
  }
  return { ok: true, command: { kind: 'bet', legs, stake } };
}

/**
 * The canonical text of a command (`0123#1#5678#X#50`, `BAL`): parsing it
 * (with a `maxLegs` of at least its legs) gives the command back. Throws
 * RangeError for a bet that could not have been parsed: no legs, a Game ID
 * out of range or used twice, an unknown pick, or a stake that is not a whole
 * number of birr between 1 and 999,999,999.
 */
export function formatTextCommand(command: TextCommand): string {
  if (command.kind !== 'bet') return CANONICAL_KEYWORD[command.kind];
  if (command.legs.length === 0) throw new RangeError('a bet needs at least one leg');
  const birr = command.stake / SANTIM_PER_BIRR;
  if (
    command.stake <= 0n ||
    command.stake % SANTIM_PER_BIRR !== 0n ||
    birr.toString().length > MAX_STAKE_DIGITS
  ) {
    throw new RangeError('a text bet stake must be a whole number of birr from 1 to 999,999,999');
  }
  const seen = new Set<number>();
  const legs = command.legs.map((leg) => {
    if (seen.has(leg.gameId)) throw new RangeError(`game ${leg.gameId} is on the bet twice`);
    seen.add(leg.gameId);
    if (!(PICK_CODES as readonly string[]).includes(leg.pick)) {
      throw new RangeError(`unknown pick ${String(leg.pick)}`);
    }
    return `${formatGameId(leg.gameId)}#${leg.pick}`;
  });
  return `${legs.join('#')}#${birr.toString()}`;
}
