/**
 * The USSD menus (dial e.g. *123#) as a pure state machine.
 *
 * Aggregators call back with { sessionId, serviceCode, phoneNumber, text },
 * where `text` is the '*'-joined history of everything typed in the session
 * ('' on the first dial), and expect `CON <menu>` (keep the session open) or
 * `END <text>` (close it), at most USSD_MAX_LENGTH characters. The caller
 * stores the state reached after each callback and feeds the next input to
 * `ussdNext`, so an earlier choice is never re-read against data that has
 * changed since (the player confirms exactly what was shown).
 *
 * Menu: 1 Place bet (Game ID → pick from the options listed with their
 * current odds → stake → confirm with the possible win), 2 Balance, 3 My
 * bets, 4 Jackpot, 5 Help, 0 Exit. '00' goes back to the main menu from any
 * screen; invalid input re-prompts the same screen.
 *
 * Data comes in through the context (`games`, looked up by the caller when a
 * step answers `need_game`); balances, bets, jackpots and the placement are
 * the caller's (`info` / `place` steps), rendered with the end-text helpers.
 *
 * NOTE: the Amharic (`am`) wording is a working translation pending review
 * by a native speaker before launch.
 */
import { quoteBet } from './betslip';
import {
  betPlacedBody,
  formatMoney,
  refusalBody,
  type ChannelLocale,
  type ChannelRefusal,
  type PlacedBetSummary,
} from './channelreply';
import { formatGameId, parseGameId } from './codes';
import { type Santim } from './money';
import { formatOdds, isValidOddsMilli } from './odds';
import type { BetRules, MultiBonusConfig, TaxConfig } from './rules';
import { fitLength, USSD_MAX_LENGTH } from './smstext';
import {
  isOverlongWholeBirrStake,
  PICK_CODES,
  parseWholeBirrStake,
  type PickCode,
} from './textcommand';

/** Where the session is. Every value is JSON-safe except `stake` (see serializeUssdState). */
export type UssdState =
  | { screen: 'main' }
  | { screen: 'bet_game' }
  /** `picks[i]` is option number i + 1 as listed. */
  | { screen: 'bet_pick'; gameId: number; picks: PickCode[] }
  | { screen: 'bet_stake'; gameId: number; pick: PickCode }
  /** Exactly what the confirm screen showed: placing uses these odds and stake. */
  | {
      screen: 'bet_confirm';
      gameId: number;
      pick: PickCode;
      selectionId: string;
      oddsMilli: number;
      stake: Santim;
    }
  | { screen: 'ended' };

export type UssdScreen = UssdState['screen'];

export interface UssdGameOption {
  pick: PickCode;
  selectionId: string;
  oddsMilli: number;
  /** Bettable now (event, market and selection open). */
  available: boolean;
}

export interface UssdTeam {
  /** Display name in the player's language. */
  name: string;
  /** Short code ('ARS'), used when names do not fit. */
  short: string;
}

/** An event as the menus show it. */
export interface UssdGame {
  gameId: number;
  home: UssdTeam;
  away: UssdTeam;
  live: boolean;
  /** The picks whose market the event has, in PICK_CODES order. */
  options: UssdGameOption[];
}

export interface UssdContext {
  locale: ChannelLocale;
  demo: boolean;
  /** The code players dial, e.g. *123#. */
  serviceCode: string;
  rules: BetRules;
  multiBonus: MultiBonusConfig;
  tax: TaxConfig;
  /** Games looked up so far: null = no such game. A missing one is asked for with `need_game`. */
  games: ReadonlyMap<number, UssdGame | null>;
}

/** The bet to place: what the confirm screen showed. */
export interface UssdBetRequest {
  gameId: number;
  pick: PickCode;
  selectionId: string;
  oddsMilli: number;
  stake: Santim;
}

export type UssdInfo = 'balance' | 'bets' | 'jackpot';

export type UssdStep =
  /** Reply `CON text` and store `state`. */
  | { kind: 'menu'; state: UssdState; text: string }
  /** Reply `END text`; the session is over. */
  | { kind: 'end'; text: string }
  /** Look the game up, add it to `games` (null when unknown) and call again. */
  | { kind: 'need_game'; gameId: number }
  /** Reply `END` with this information (ussdEnd with balanceBody / betsBody / jackpotBody). */
  | { kind: 'info'; info: UssdInfo }
  /** Place this bet, then reply with ussdPlacedEnd / ussdRefusedEnd / ussdOddsChanged. */
  | { kind: 'place'; bet: UssdBetRequest };

type Text = { en: string; am: string };

const T = {
  title: (demo: boolean): Text => ({
    en: demo ? 'Vamos DEMO' : 'Vamos',
    am: demo ? 'Vamos DEMO' : 'Vamos',
  }),
  menu: {
    en: '1 Place bet\n2 Balance\n3 My bets\n4 Jackpot\n5 Help\n0 Exit',
    am: '1 ውርርድ\n2 ቀሪ ሂሳብ\n3 የእኔ ውርርዶች\n4 ጃክፖት\n5 እገዛ\n0 ውጣ',
  },
  invalidChoice: { en: 'Invalid choice.', am: 'የተሳሳተ ምርጫ።' },
  back: { en: '00 Main menu', am: '00 ዋና ማውጫ' },
  enterGameId: { en: 'Enter Game ID:', am: 'የጨዋታ መለያ ቁጥር ያስገቡ:' },
  invalidGameId: { en: 'Invalid Game ID.', am: 'የተሳሳተ የጨዋታ መለያ ቁጥር።' },
  gameNotFound: (id: number): Text => ({
    en: `Game ${formatGameId(id)} not found.`,
    am: `ጨዋታ ${formatGameId(id)} አልተገኘም።`,
  }),
  noBetsOpen: (id: number): Text => ({
    en: `Game ${formatGameId(id)}: no bets open now.`,
    am: `ጨዋታ ${formatGameId(id)}: አሁን ውርርድ የለም።`,
  }),
  optionUnavailable: { en: 'That option is not available now.', am: 'ይህ ምርጫ አሁን አይገኝም።' },
  enterStake: (min: string): Text => ({
    en: `Enter stake in ETB (min ${min}):`,
    am: `መጠን በብር ያስገቡ (ቢያንስ ${min}):`,
  }),
  invalidStake: { en: 'Invalid stake: whole birr only.', am: 'የተሳሳተ መጠን፤ ሙሉ ብር ብቻ።' },
  minStake: (amount: Santim): Text => ({
    en: `Minimum stake ${formatMoney(amount, 'en')}.`,
    am: `ዝቅተኛው መጠን ${formatMoney(amount, 'am')}።`,
  }),
  maxStake: (amount: Santim): Text => ({
    en: `Maximum stake ${formatMoney(amount, 'en')}.`,
    am: `ከፍተኛው መጠን ${formatMoney(amount, 'am')}።`,
  }),
  stake: { en: 'Stake', am: 'መጠን' },
  win: { en: 'Win', am: 'ሊያሸንፉ' },
  confirm: { en: '1 Confirm', am: '1 አረጋግጥ' },
  oddsChanged: (odds: number): Text => ({
    en: `Odds changed to ${formatOdds(odds)}.`,
    am: `ዕድሉ ወደ ${formatOdds(odds)} ተቀይሯል።`,
  }),
  goodbye: { en: 'Thank you for using Vamos.', am: 'ቫሞስን ስለተጠቀሙ እናመሰግናለን።' },
  ended: (code: string): Text => ({
    en: `Session ended. Dial ${code} again.`,
    am: `ክፍለ ጊዜው አብቅቷል። ${code} እንደገና ይደውሉ።`,
  }),
  expired: (code: string): Text => ({
    en: `Session expired. Dial ${code} again.`,
    am: `ክፍለ ጊዜው አልፏል። ${code} እንደገና ይደውሉ።`,
  }),
  tooMany: { en: 'Too many requests. Please try again later.', am: 'በጣም ብዙ ጥያቄዎች። ቆይተው ይሞክሩ።' },
  unavailable: {
    en: 'The service is not available. Please try again later.',
    am: 'አገልግሎቱ አሁን አይገኝም። ቆይተው ይሞክሩ።',
  },
  help: (code: string): Text => ({
    en: `Dial ${code}, choose 1, enter the Game ID, pick, stake and confirm. By SMS: GAMEID#PICK#STAKE, e.g. 1234#1#50.`,
    am: `${code} ይደውሉ፣ 1 ይምረጡ፣ የጨዋታ ቁጥር፣ ምርጫ፣ መጠን አስገብተው ያረጋግጡ። በSMS: GAMEID#PICK#STAKE፣ ለምሳሌ 1234#1#50።`,
  }),
};

const PICK_LABEL: Readonly<Record<Exclude<PickCode, '1' | '2'>, Text>> = {
  X: { en: 'Draw', am: 'አቻ' },
  OV25: { en: 'Over 2.5', am: 'ከ2.5 በላይ' },
  UN25: { en: 'Under 2.5', am: 'ከ2.5 በታች' },
  GG: { en: 'Both score', am: 'ሁለቱም ያገባሉ' },
  NG: { en: 'Not both', am: 'ሁለቱም አያገቡም' },
};

/** Longest text after the CON / END prefix. */
const MAX_TEXT = USSD_MAX_LENGTH - 4;
/** Longest input read (anything longer is invalid). */
const MAX_INPUT_LENGTH = 20;

/** How team names are written: in full, cut to n characters, or as short codes. */
type NameMode = 'full' | number | 'short';
const NAME_MODES: readonly NameMode[] = ['full', 14, 10, 7, 'short'];

function teamName(team: UssdTeam, mode: NameMode): string {
  if (mode === 'full') return team.name;
  if (mode === 'short') return team.short;
  return fitLength(team.name, mode);
}

/** The first rendering (by name mode) that fits; the last one is hard-capped. */
function fitting(render: (mode: NameMode) => string): string {
  let text = '';
  for (const mode of NAME_MODES) {
    text = render(mode);
    if (text.length <= MAX_TEXT) return text;
  }
  return fitLength(text, MAX_TEXT);
}

const t = (text: Text, ctx: Pick<UssdContext, 'locale'>) => text[ctx.locale];
const lines = (...parts: Array<string | null>) =>
  parts.filter((part): part is string => part !== null && part.length > 0).join('\n');

/** The label of a pick on a game ("Arsenal", "Draw", "Over 2.5"…). */
export function ussdPickLabel(
  game: UssdGame,
  pick: PickCode,
  locale: ChannelLocale,
  mode: NameMode = 'full',
): string {
  if (pick === '1') return teamName(game.home, mode);
  if (pick === '2') return teamName(game.away, mode);
  return PICK_LABEL[pick][locale];
}

/** True when an option can be put on a bet now (bettable and within the minimum leg odds). */
function listable(option: UssdGameOption, rules: BetRules): boolean {
  return option.available && option.oddsMilli >= rules.minLegOddsMilli;
}

function gameHeader(game: UssdGame, mode: NameMode): string {
  const live = game.live ? ' LIVE' : '';
  return `${formatGameId(game.gameId)}${live} ${teamName(game.home, mode)} v ${teamName(game.away, mode)}`;
}

function menuStep(state: UssdState, text: string): UssdStep {
  return { kind: 'menu', state, text: fitLength(text, MAX_TEXT) };
}

function endStep(text: string): UssdStep {
  return { kind: 'end', text: fitLength(text, MAX_TEXT) };
}

function mainMenu(ctx: UssdContext, notice: Text | null = null): UssdStep {
  return menuStep(
    { screen: 'main' },
    lines(notice === null ? null : t(notice, ctx), t(T.title(ctx.demo), ctx), t(T.menu, ctx)),
  );
}

function gamePrompt(ctx: UssdContext, notice: Text | null = null): UssdStep {
  return menuStep(
    { screen: 'bet_game' },
    lines(notice === null ? null : t(notice, ctx), t(T.enterGameId, ctx), t(T.back, ctx)),
  );
}

/** The pick screen with the options bettable now (or the Game ID prompt when there are none). */
function pickScreen(game: UssdGame, ctx: UssdContext, notice: Text | null = null): UssdStep {
  const options = game.options.filter((option) => listable(option, ctx.rules));
  if (options.length === 0) return gamePrompt(ctx, T.noBetsOpen(game.gameId));
  const state: UssdState = {
    screen: 'bet_pick',
    gameId: game.gameId,
    picks: options.map((option) => option.pick),
  };
  const text = fitting((mode) =>
    lines(
      notice === null ? null : t(notice, ctx),
      gameHeader(game, mode),
      ...options.map(
        (option, i) =>
          `${i + 1} ${ussdPickLabel(game, option.pick, ctx.locale, mode)} ${formatOdds(option.oddsMilli)}`,
      ),
      t(T.back, ctx),
    ),
  );
  return { kind: 'menu', state, text };
}

function stakePrompt(
  game: UssdGame,
  option: UssdGameOption,
  ctx: UssdContext,
  notice: Text | null = null,
): UssdStep {
  const min = formatMoney(ctx.rules.minStake, 'en').replace(/^ETB /, '');
  const text = fitting((mode) =>
    lines(
      notice === null ? null : t(notice, ctx),
      `${ussdPickLabel(game, option.pick, ctx.locale, mode)} @${formatOdds(option.oddsMilli)}`,
      t(T.enterStake(min), ctx),
      t(T.back, ctx),
    ),
  );
  return {
    kind: 'menu',
    state: { screen: 'bet_stake', gameId: game.gameId, pick: option.pick },
    text,
  };
}

/** The net possible win of a single at these odds (quoteBet under the context's terms). */
function quoteSingle(ctx: UssdContext, request: Omit<UssdBetRequest, 'pick'>) {
  return quoteBet({
    stake: request.stake,
    legs: [
      {
        selectionId: request.selectionId,
        eventId: `game:${request.gameId}`,
        oddsMilli: request.oddsMilli,
      },
    ],
    rules: ctx.rules,
    multiBonus: ctx.multiBonus,
    tax: ctx.tax,
  });
}

function confirmScreen(
  game: UssdGame,
  bet: UssdBetRequest,
  ctx: UssdContext,
  notice: Text | null = null,
): UssdStep {
  const quote = quoteSingle(ctx, bet);
  const text = fitting((mode) =>
    lines(
      notice === null ? null : t(notice, ctx),
      gameHeader(game, mode),
      `${ussdPickLabel(game, bet.pick, ctx.locale, mode)} @${formatOdds(bet.oddsMilli)}`,
      `${t(T.stake, ctx)} ${formatMoney(bet.stake, ctx.locale)}`,
      `${t(T.win, ctx)} ${formatMoney(quote.netPayout, ctx.locale)}`,
      t(T.confirm, ctx),
      t(T.back, ctx),
    ),
  );
  return { kind: 'menu', state: { screen: 'bet_confirm', ...bet }, text };
}

/** The first screen of a session (the main menu). */
export function ussdStart(ctx: UssdContext): UssdStep {
  return mainMenu(ctx);
}

/** The game a step needs: its data, `need_game`, or the "not found" prompt. */
function withGame(gameId: number, ctx: UssdContext, then: (game: UssdGame) => UssdStep): UssdStep {
  const game = ctx.games.get(gameId);
  if (game === undefined) return { kind: 'need_game', gameId };
  if (game === null) return gamePrompt(ctx, T.gameNotFound(gameId));
  return then(game);
}

/**
 * The step after `rawInput` (one input, as typed) on the screen `state`.
 * Never throws for any input; texts always fit USSD_MAX_LENGTH with their
 * prefix.
 */
export function ussdNext(state: UssdState, rawInput: string, ctx: UssdContext): UssdStep {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  const readable = input.length <= MAX_INPUT_LENGTH;
  if (state.screen === 'ended') return ussdSessionEndedEnd(ctx);
  if (input === '00') return mainMenu(ctx);

  switch (state.screen) {
    case 'main':
      switch (input) {
        case '1':
          return gamePrompt(ctx);
        case '2':
          return { kind: 'info', info: 'balance' };
        case '3':
          return { kind: 'info', info: 'bets' };
        case '4':
          return { kind: 'info', info: 'jackpot' };
        case '5':
          return endStep(t(T.help(ctx.serviceCode), ctx));
        case '0':
          return endStep(t(T.goodbye, ctx));
        default:
          return mainMenu(ctx, T.invalidChoice);
      }

    case 'bet_game': {
      const gameId = readable ? parseGameId(input) : null;
      if (gameId === null) return gamePrompt(ctx, T.invalidGameId);
      return withGame(gameId, ctx, (game) => pickScreen(game, ctx));
    }

    case 'bet_pick':
      return withGame(state.gameId, ctx, (game) => {
        const index = readable && /^\d{1,2}$/.test(input) ? Number(input) - 1 : -1;
        const pick = state.picks[index];
        if (pick === undefined) return pickScreen(game, ctx, T.invalidChoice);
        const option = game.options.find((candidate) => candidate.pick === pick);
        if (option === undefined || !listable(option, ctx.rules)) {
          return pickScreen(game, ctx, T.optionUnavailable);
        }
        return stakePrompt(game, option, ctx);
      });

    case 'bet_stake':
      return withGame(state.gameId, ctx, (game) => {
        const option = game.options.find((candidate) => candidate.pick === state.pick);
        if (option === undefined || !listable(option, ctx.rules)) {
          return pickScreen(game, ctx, T.optionUnavailable);
        }
        const stake = readable ? parseWholeBirrStake(input) : null;
        if (stake === null) {
          const tooLarge = readable && isOverlongWholeBirrStake(input);
          const notice = tooLarge ? T.maxStake(ctx.rules.maxStake) : T.invalidStake;
          return stakePrompt(game, option, ctx, notice);
        }
        const bet: UssdBetRequest = {
          gameId: game.gameId,
          pick: option.pick,
          selectionId: option.selectionId,
          oddsMilli: option.oddsMilli,
          stake,
        };
        const errors = quoteSingle(ctx, bet).errors;
        if (errors.some((error) => error.code === 'stake_below_minimum')) {
          return stakePrompt(game, option, ctx, T.minStake(ctx.rules.minStake));
        }
        if (errors.some((error) => error.code === 'stake_above_maximum')) {
          return stakePrompt(game, option, ctx, T.maxStake(ctx.rules.maxStake));
        }
        if (errors.length > 0) return pickScreen(game, ctx, T.optionUnavailable);
        return confirmScreen(game, bet, ctx);
      });

    case 'bet_confirm': {
      const { screen: _screen, ...bet } = state;
      if (input === '1') return { kind: 'place', bet };
      return withGame(state.gameId, ctx, (game) => confirmScreen(game, bet, ctx, T.invalidChoice));
    }
  }
}

/** The response body the aggregator expects: `CON …` / `END …` (at most USSD_MAX_LENGTH). */
export function ussdResponse(step: Extract<UssdStep, { kind: 'menu' | 'end' }>): string {
  const prefix = step.kind === 'menu' ? 'CON ' : 'END ';
  return `${prefix}${fitLength(step.text, MAX_TEXT)}`;
}

/** An `end` step with any body (information, refusals…), fitted. */
export function ussdEnd(body: string): UssdStep {
  return endStep(body);
}

/** END: the bet was placed (short ID, odds, stake, possible win). */
export function ussdPlacedEnd(bet: PlacedBetSummary, ctx: Pick<UssdContext, 'locale'>): UssdStep {
  return endStep(betPlacedBody(bet, ctx.locale));
}

/** END: the bet was refused. */
export function ussdRefusedEnd(
  refusal: ChannelRefusal,
  ctx: Pick<UssdContext, 'locale'>,
): UssdStep {
  return endStep(refusalBody(refusal, ctx.locale));
}

/**
 * The odds moved between the confirm screen and the confirmation: the confirm
 * screen again at the new odds (confirming then places at those).
 */
export function ussdOddsChanged(bet: UssdBetRequest, game: UssdGame, ctx: UssdContext): UssdStep {
  const option = game.options.find((candidate) => candidate.pick === bet.pick);
  if (
    option === undefined ||
    !listable(option, ctx.rules) ||
    option.selectionId !== bet.selectionId
  ) {
    return pickScreen(game, ctx, T.optionUnavailable);
  }
  return confirmScreen(
    game,
    { ...bet, oddsMilli: option.oddsMilli },
    ctx,
    T.oddsChanged(option.oddsMilli),
  );
}

/** END: the session is over (a callback after it ended). */
export function ussdSessionEndedEnd(ctx: Pick<UssdContext, 'locale' | 'serviceCode'>): UssdStep {
  return endStep(t(T.ended(ctx.serviceCode), ctx));
}

/** END: the session timed out (the aggregator's timeout passed, or it is too old). */
export function ussdExpiredEnd(ctx: Pick<UssdContext, 'locale' | 'serviceCode'>): UssdStep {
  return endStep(t(T.expired(ctx.serviceCode), ctx));
}

/** END: too many requests from this number. */
export function ussdRateLimitedEnd(ctx: Pick<UssdContext, 'locale'>): UssdStep {
  return endStep(t(T.tooMany, ctx));
}

/** END: the service cannot answer now. */
export function ussdUnavailableEnd(ctx: Pick<UssdContext, 'locale'>): UssdStep {
  return endStep(t(T.unavailable, ctx));
}

/**
 * END for every number that is not an active, verified player (unknown,
 * unverified, suspended or closed alike), in both languages.
 */
export function ussdNotAvailableEnd(): UssdStep {
  return endStep(
    'Not available for this number. Register and verify it on the Vamos website.\nለዚህ ቁጥር አገልግሎቱ የለም። በቫሞስ ድረ-ገጽ ይመዝገቡ።',
  );
}

/**
 * The inputs of a callback's `text` ('' → none, '1*1234*2' → ['1', '1234', '2']).
 * Stateless use only: an input that itself contains '*' cannot be told apart;
 * the stored-state flow takes the new input with ussdLatestInput instead.
 */
export function ussdInputs(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.split('*');
}

/**
 * The input a callback adds to the session: `text` minus the previous
 * callback's text and the '*' joining them. null when `text` does not extend
 * `previousText` (a malformed or out-of-order callback). The first callback
 * of a session has previousText null and normally an empty text.
 */
export function ussdLatestInput(previousText: string | null, text: string): string | null {
  if (typeof text !== 'string') return null;
  if (previousText === null) return text;
  if (previousText.length === 0) return text;
  if (!text.startsWith(`${previousText}*`)) return null;
  return text.slice(previousText.length + 1);
}

// --- Stored state ------------------------------------------------------------

const PICK_SET: ReadonlySet<string> = new Set(PICK_CODES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON form of a state (the stake as a santim string). */
export function serializeUssdState(state: UssdState): Record<string, unknown> {
  if (state.screen === 'bet_confirm') return { ...state, stake: state.stake.toString() };
  return { ...state };
}

function isGameId(value: unknown): value is number {
  return typeof value === 'number' && parseGameId(String(value)) === value;
}

function isPick(value: unknown): value is PickCode {
  return typeof value === 'string' && PICK_SET.has(value);
}

/** Reads a stored state; null for anything malformed (the caller ends the session). */
export function parseUssdState(json: unknown): UssdState | null {
  if (typeof json !== 'object' || json === null) return null;
  const value = json as Record<string, unknown>;
  switch (value.screen) {
    case 'main':
    case 'bet_game':
    case 'ended':
      return { screen: value.screen };
    case 'bet_pick': {
      const picks = value.picks;
      if (!isGameId(value.gameId) || !Array.isArray(picks) || picks.length === 0) return null;
      if (picks.length > PICK_CODES.length || !picks.every(isPick)) return null;
      return { screen: 'bet_pick', gameId: value.gameId, picks: [...picks] };
    }
    case 'bet_stake':
      if (!isGameId(value.gameId) || !isPick(value.pick)) return null;
      return { screen: 'bet_stake', gameId: value.gameId, pick: value.pick };
    case 'bet_confirm': {
      const { gameId, pick, selectionId, oddsMilli, stake } = value;
      if (!isGameId(gameId) || !isPick(pick)) return null;
      if (typeof selectionId !== 'string' || !UUID_RE.test(selectionId)) return null;
      if (typeof oddsMilli !== 'number' || !isValidOddsMilli(oddsMilli)) return null;
      if (typeof stake !== 'string' || !/^[1-9]\d{0,17}$/.test(stake)) return null;
      return { screen: 'bet_confirm', gameId, pick, selectionId, oddsMilli, stake: BigInt(stake) };
    }
    default:
      return null;
  }
}
