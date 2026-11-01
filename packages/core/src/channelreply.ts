/**
 * Reply texts of the SMS and USSD channels, in English and Amharic.
 *
 * Each builder returns the message body; `smsText` adds the "Vamos:" prefix
 * (with DEMO in play-money mode) and fits it in MAX_SMS_SEGMENTS parts, and
 * the USSD screens (ussd.ts) cap it at USSD_MAX_LENGTH. Bodies are written
 * to fit one GSM-7 message in English where they can; Amharic is UCS-2, so
 * those take two or three parts.
 *
 * NOTE: the Amharic (`am`) wording is a working translation pending review
 * by a native speaker before launch.
 */
import { BUSINESS_UTC_OFFSET_MS } from './businessday';
import { formatGameId } from './codes';
import { formatBirr, type Santim } from './money';
import { formatOdds } from './odds';
import { cleanSmsText, fitLength, fitSms, isGsm7, MAX_SMS_SEGMENTS } from './smstext';
import type { PickCode, TextCommandError } from './textcommand';

export type ChannelLocale = 'en' | 'am';

/**
 * The reply language of a player's locale: Amharic for `am` (and `ti`, also
 * written in Ge'ez script), English otherwise (`en`, `om`, unknown).
 */
export function channelLocale(locale: string | null | undefined): ChannelLocale {
  return locale === 'am' || locale === 'ti' ? 'am' : 'en';
}

export interface ReplyOptions {
  locale: ChannelLocale;
  /** Play-money mode: replies say DEMO. */
  demo: boolean;
}

type Text = { en: string; am: string };
const pickText = (text: Text, locale: ChannelLocale): string => text[locale];

/** "Vamos: " or "Vamos DEMO: ". */
export function replyPrefix(demo: boolean): string {
  return demo ? 'Vamos DEMO: ' : 'Vamos: ';
}

/** An SMS reply: prefix + body, fitted in MAX_SMS_SEGMENTS parts. */
export function smsText(body: string, options: Pick<ReplyOptions, 'demo'>): string {
  return fitSms(`${replyPrefix(options.demo)}${body}`, MAX_SMS_SEGMENTS);
}

/** "ETB 1,250.50" (en) or "1,250.50 ብር" (am). */
export function formatMoney(amount: Santim, locale: ChannelLocale): string {
  return locale === 'am' ? `${formatBirr(amount)} ብር` : formatBirr(amount, { currency: true });
}

/** Combined odds in milli (a bigint) the way formatOdds shows single odds: 3700n → "3.70". */
export function formatTotalOdds(totalOddsMilli: bigint): string {
  if (totalOddsMilli < 0n) throw new RangeError('odds cannot be negative');
  const whole = totalOddsMilli / 1000n;
  const fraction = Number(totalOddsMilli % 1000n);
  if (fraction % 10 === 0) return `${whole.toString()}.${String(fraction / 10).padStart(2, '0')}`;
  return `${whole.toString()}.${String(fraction).padStart(3, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Addis Ababa wall-clock parts of an instant (UTC+3 all year). */
function addisParts(instant: Date) {
  const local = new Date(instant.getTime() + BUSINESS_UTC_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    time: `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`,
  };
}

/** "19 Oct 18:00" (en) or "19/10 18:00" (am), Addis Ababa time. */
export function formatAddisDateTime(instant: Date, locale: ChannelLocale): string {
  const p = addisParts(instant);
  return locale === 'am'
    ? `${p.day}/${p.month + 1} ${p.time}`
    : `${p.day} ${MONTHS[p.month] ?? ''} ${p.time}`;
}

/** "19 Oct 2026" (en) or "19/10/2026" (am), Addis Ababa date. */
export function formatAddisDate(instant: Date, locale: ChannelLocale): string {
  const p = addisParts(instant);
  return locale === 'am'
    ? `${p.day}/${p.month + 1}/${p.year}`
    : `${p.day} ${MONTHS[p.month] ?? ''} ${p.year}`;
}

/** Longest quoted token, ellipsis included. */
const QUOTE_MAX = 12;

/**
 * What the sender typed, made safe to quote: control characters and quotes
 * removed, at most 12 characters. A GSM-7 token is cut with "..." (never
 * "…", which would turn the whole reply into UCS-2).
 */
export function quoteToken(token: string): string {
  const clean = cleanSmsText(typeof token === 'string' ? token : '').replace(/["“”]/g, '');
  if (clean.length === 0) return '?';
  if (clean.length <= QUOTE_MAX) return clean;
  const chars = Array.from(clean);
  const head = chars.slice(0, QUOTE_MAX - 3).join('');
  if (isGsm7(head)) return `${head.trimEnd()}...`;
  return fitLength(clean, QUOTE_MAX);
}

const SYNTAX: Text = {
  en: 'Bet: GAMEID#PICK#STAKE, e.g. 1234#1#50. Picks: 1 X 2 OV25 UN25 GG NG.',
  am: 'ውርርድ: GAMEID#PICK#STAKE፣ ለምሳሌ 1234#1#50። ምርጫዎች: 1 X 2 OV25 UN25 GG NG።',
};
const NO_BET: Text = { en: 'No bet placed.', am: 'ውርርድ አልተመዘገበም።' };

// --- Bets placed ------------------------------------------------------------

export interface PlacedBetSummary {
  shortId: string;
  legs: number;
  totalOddsMilli: bigint;
  stake: Santim;
  /** Net potential payout (after tax): the "possible win". */
  potentialNetPayout: Santim;
  /** A live bet waiting for the acceptance delay. */
  pendingAcceptance: boolean;
}

/** The confirmation of a placed bet: short ID, total odds, stake and possible win. */
export function betPlacedBody(bet: PlacedBetSummary, locale: ChannelLocale): string {
  const odds = formatTotalOdds(bet.totalOddsMilli);
  const stake = formatMoney(bet.stake, locale);
  const win = formatMoney(bet.potentialNetPayout, locale);
  if (locale === 'am') {
    const games = bet.legs > 1 ? `${bet.legs} ጨዋታዎች፣ ` : '';
    const head = bet.pendingAcceptance
      ? `የቀጥታ ውርርድ ${bet.shortId} ደርሷል፤ ማረጋገጫ በመጠበቅ ላይ።`
      : `ውርርድ ${bet.shortId} ተመዝግቧል።`;
    return `${head} ${games}ዕድል ${odds}፣ መጠን ${stake}፣ ሊያሸንፉ የሚችሉት ${win}።`;
  }
  const terms = `${bet.legs > 1 ? `${bet.legs} games, odds` : 'Odds'} ${odds}, stake ${stake}, possible win ${win}.`;
  if (bet.pendingAcceptance) {
    return `Live bet ${bet.shortId} received, awaiting acceptance. ${terms}`;
  }
  return `Bet ${bet.shortId} placed. ${terms}`;
}

/** Why a pending live bet was rejected after the acceptance delay (bets.reject_reason). */
export type LiveBetRejectReason = 'selection_unavailable' | 'odds_changed' | 'slip_invalid';

/**
 * The outcome of a live bet placed by SMS or USSD once the acceptance delay
 * has passed: accepted, or rejected with the stake refunded.
 */
export function liveBetOutcomeBody(
  outcome:
    | { shortId: string; accepted: true }
    | { shortId: string; accepted: false; reason: LiveBetRejectReason; refund: Santim },
  locale: ChannelLocale,
): string {
  if (outcome.accepted) {
    return locale === 'am'
      ? `የቀጥታ ውርርድ ${outcome.shortId} ተቀባይነት አግኝቷል።`
      : `Live bet ${outcome.shortId} accepted.`;
  }
  const refund = formatMoney(outcome.refund, locale);
  const why: Readonly<Record<LiveBetRejectReason, Text>> = {
    odds_changed: { en: 'the odds changed', am: 'ዕድሉ ስለተቀየረ' },
    selection_unavailable: { en: 'the market closed', am: 'ገበያው ስለተዘጋ' },
    slip_invalid: { en: 'it broke the bet rules', am: 'የውርርድ ደንብ ስላላሟላ' },
  };
  return locale === 'am'
    ? `የቀጥታ ውርርድ ${outcome.shortId} ${why[outcome.reason].am} ውድቅ ሆኗል። ${refund} ተመልሷል።`
    : `Live bet ${outcome.shortId} rejected: ${why[outcome.reason].en}. ${refund} refunded.`;
}

// --- Refusals ------------------------------------------------------------------

export type UnavailablePickReason =
  'event_started' | 'event_closed' | 'suspended' | 'market_closed';
export type LossLimitPeriod = 'day' | 'week' | 'month';

/** Why a channel bet was not placed (built from the resolution and placeBet's DomainErrors). */
export type ChannelRefusal =
  | { code: 'game_not_found'; gameId: number }
  | { code: 'pick_not_offered'; gameId: number; pick: PickCode }
  | { code: 'pick_unavailable'; gameId: number; pick: PickCode; reason: UnavailablePickReason }
  | { code: 'odds_changed'; oddsMilli: number | null }
  | { code: 'insufficient_funds'; balance: Santim; stake: Santim }
  | { code: 'self_excluded'; until: Date | null }
  | { code: 'cooling_off'; until: Date | null }
  | { code: 'account_disabled' }
  | { code: 'stake_limit_exceeded'; limit: Santim }
  | { code: 'loss_limit_exceeded'; period: LossLimitPeriod; limit: Santim }
  | { code: 'stake_below_minimum'; min: Santim }
  | { code: 'stake_above_maximum'; max: Santim }
  /** The house's liability cap (rule L1); `max` is the largest stake that fits, null when none does. */
  | { code: 'liability_limit'; max: Santim | null }
  | { code: 'too_many_legs'; max: number }
  | { code: 'odds_below_minimum'; minOddsMilli: number }
  | { code: 'total_odds_above_maximum' }
  | { code: 'duplicate_game'; gameId: number }
  | { code: 'bet_failed' };

export type ChannelRefusalCode = ChannelRefusal['code'];

const PERIOD: Readonly<Record<LossLimitPeriod, Text>> = {
  day: { en: '24-hour', am: 'የ24 ሰዓት' },
  week: { en: '7-day', am: 'የ7 ቀን' },
  month: { en: '30-day', am: 'የ30 ቀን' },
};

/** Why the bet was refused, ending with "No bet placed." where a bet was refused. */
export function refusalBody(refusal: ChannelRefusal, locale: ChannelLocale): string {
  const money = (amount: Santim) => formatMoney(amount, locale);
  const noBet = pickText(NO_BET, locale);
  const until = (date: Date | null): Text =>
    date === null
      ? { en: '', am: '' }
      : {
          en: ` until ${formatAddisDate(date, 'en')}`,
          am: ` እስከ ${formatAddisDate(date, 'am')}`,
        };
  let text: Text;
  switch (refusal.code) {
    case 'game_not_found':
      text = {
        en: `Game ${formatGameId(refusal.gameId)} not found. ${noBet}`,
        am: `ጨዋታ ${formatGameId(refusal.gameId)} አልተገኘም። ${noBet}`,
      };
      break;
    case 'pick_not_offered':
      text = {
        en: `Pick ${refusal.pick} is not offered on game ${formatGameId(refusal.gameId)}. ${noBet}`,
        am: `ምርጫ ${refusal.pick} በጨዋታ ${formatGameId(refusal.gameId)} ላይ የለም። ${noBet}`,
      };
      break;
    case 'pick_unavailable':
      text = unavailableText(refusal.gameId, refusal.pick, refusal.reason, noBet);
      break;
    case 'odds_changed':
      text =
        refusal.oddsMilli === null
          ? { en: `The odds have changed. ${noBet}`, am: `ዕድሉ ተቀይሯል። ${noBet}` }
          : {
              en: `The odds have changed to ${formatOdds(refusal.oddsMilli)}. ${noBet}`,
              am: `ዕድሉ ወደ ${formatOdds(refusal.oddsMilli)} ተቀይሯል። ${noBet}`,
            };
      break;
    case 'insufficient_funds':
      text = {
        en: `Your balance (${money(refusal.balance)}) is too low for a stake of ${money(refusal.stake)}. ${noBet}`,
        am: `ቀሪ ሂሳብዎ (${money(refusal.balance)}) ለ${money(refusal.stake)} መጠን በቂ አይደለም። ${noBet}`,
      };
      break;
    case 'self_excluded': {
      const u = until(refusal.until);
      text = {
        en: `You are self-excluded${u.en}. ${noBet}`,
        am: `ራስዎን ከውርርድ አግልለዋል${u.am}። ${noBet}`,
      };
      break;
    }
    case 'cooling_off': {
      const u = until(refusal.until);
      text = {
        en: `You are on a cool-off break${u.en}. ${noBet}`,
        am: `በእረፍት ጊዜ ላይ ነዎት${u.am}። ${noBet}`,
      };
      break;
    }
    case 'account_disabled':
      text = {
        en: 'This account cannot bet. Please contact support.',
        am: 'ይህ መለያ መወራረድ አይችልም። እባክዎ የደንበኞች አገልግሎትን ያግኙ።',
      };
      break;
    case 'stake_limit_exceeded':
      text = {
        en: `The stake is above your per-bet limit of ${money(refusal.limit)}. ${noBet}`,
        am: `መጠኑ ከውርርድ ገደብዎ ${money(refusal.limit)} በላይ ነው። ${noBet}`,
      };
      break;
    case 'loss_limit_exceeded':
      text = {
        en: `This bet could take you over your ${PERIOD[refusal.period].en} loss limit of ${money(refusal.limit)}. ${noBet}`,
        am: `ይህ ውርርድ ${PERIOD[refusal.period].am} የኪሳራ ገደብዎን ${money(refusal.limit)} ሊያልፍ ይችላል። ${noBet}`,
      };
      break;
    case 'stake_below_minimum':
      text = {
        en: `The minimum stake is ${money(refusal.min)}. ${noBet}`,
        am: `ዝቅተኛው መጠን ${money(refusal.min)} ነው። ${noBet}`,
      };
      break;
    case 'stake_above_maximum':
      text = {
        en: `The maximum stake is ${money(refusal.max)}. ${noBet}`,
        am: `ከፍተኛው መጠን ${money(refusal.max)} ነው። ${noBet}`,
      };
      break;
    case 'liability_limit':
      text =
        refusal.max === null
          ? {
              en: `This bet is too large for this game right now. ${noBet}`,
              am: `ይህ ውርርድ ለዚህ ጨዋታ በአሁኑ ጊዜ በጣም ትልቅ ነው። ${noBet}`,
            }
          : {
              en: `This bet is too large for this game right now. Try a stake up to ${money(refusal.max)}. ${noBet}`,
              am: `ይህ ውርርድ ለዚህ ጨዋታ በአሁኑ ጊዜ በጣም ትልቅ ነው። እስከ ${money(refusal.max)} ይሞክሩ። ${noBet}`,
            };
      break;
    case 'too_many_legs':
      text = {
        en: `A bet can have at most ${refusal.max} games. ${noBet}`,
        am: `አንድ ውርርድ ቢበዛ ${refusal.max} ጨዋታዎች ሊኖሩት ይችላል። ${noBet}`,
      };
      break;
    case 'odds_below_minimum':
      text = {
        en: `Every pick needs odds of at least ${formatOdds(refusal.minOddsMilli)}. ${noBet}`,
        am: `እያንዳንዱ ምርጫ ቢያንስ ${formatOdds(refusal.minOddsMilli)} ዕድል ሊኖረው ይገባል። ${noBet}`,
      };
      break;
    case 'total_odds_above_maximum':
      text = {
        en: `The total odds are above the maximum allowed. ${noBet}`,
        am: `ጠቅላላ ዕድሉ ከሚፈቀደው በላይ ነው። ${noBet}`,
      };
      break;
    case 'duplicate_game':
      text = {
        en: `Game ${formatGameId(refusal.gameId)} is on the bet twice; one pick per game. ${noBet}`,
        am: `ጨዋታ ${formatGameId(refusal.gameId)} ሁለት ጊዜ ገብቷል፤ በአንድ ጨዋታ አንድ ምርጫ ብቻ። ${noBet}`,
      };
      break;
    case 'bet_failed':
      text = {
        en: 'The bet could not be placed. Please try again later.',
        am: 'ውርርዱ አልተመዘገበም። እባክዎ ቆይተው እንደገና ይሞክሩ።',
      };
      break;
  }
  return pickText(text, locale);
}

function unavailableText(
  gameId: number,
  pick: PickCode,
  reason: UnavailablePickReason,
  noBet: string,
): Text {
  const id = formatGameId(gameId);
  switch (reason) {
    case 'event_started':
      return {
        en: `Game ${id} has started; betting before kick-off is closed. ${noBet}`,
        am: `ጨዋታ ${id} ተጀምሯል፤ የቅድመ-ጨዋታ ውርርድ ተዘግቷል። ${noBet}`,
      };
    case 'event_closed':
      return {
        en: `Game ${id} is closed for betting. ${noBet}`,
        am: `ጨዋታ ${id} ለውርርድ ተዘግቷል። ${noBet}`,
      };
    case 'suspended':
      return {
        en: `Betting on ${pick} for game ${id} is suspended right now. ${noBet}`,
        am: `በጨዋታ ${id} ላይ ${pick} ውርርድ ለጊዜው ታግዷል። ${noBet}`,
      };
    case 'market_closed':
      return {
        en: `Pick ${pick} on game ${id} is closed. ${noBet}`,
        am: `በጨዋታ ${id} ላይ ምርጫ ${pick} ተዘግቷል። ${noBet}`,
      };
  }
}

// --- Commands that could not be read --------------------------------------------

/** The reply to a text that is not a command: what was wrong and the syntax. */
export function commandErrorBody(
  error: TextCommandError,
  locale: ChannelLocale,
  rules: { maxStake?: Santim } = {},
): string {
  const syntax = pickText(SYNTAX, locale);
  let text: Text;
  switch (error.code) {
    case 'empty':
    case 'unknown_command':
    case 'incomplete_bet':
    case 'too_long':
      text = {
        en: `Unknown command. ${syntax} Also BAL, BETS, JP, HELP.`,
        am: `ያልታወቀ ትዕዛዝ። ${syntax} እንዲሁም BAL, BETS, JP, HELP።`,
      };
      break;
    case 'missing_stake':
      text = {
        en: `Add the stake at the end. ${syntax}`,
        am: `መጠኑን በመጨረሻ ያክሉ። ${syntax}`,
      };
      break;
    case 'too_many_legs':
      text = {
        en: `A bet can have at most ${error.max} games.`,
        am: `አንድ ውርርድ ቢበዛ ${error.max} ጨዋታዎች ሊኖሩት ይችላል።`,
      };
      break;
    case 'invalid_game_id':
      text = {
        en: `"${quoteToken(error.token)}" is not a Game ID. ${syntax}`,
        am: `"${quoteToken(error.token)}" የጨዋታ መለያ ቁጥር አይደለም። ${syntax}`,
      };
      break;
    case 'invalid_pick':
      text = {
        en: `"${quoteToken(error.token)}" is not a pick (game ${formatGameId(error.gameId)}). Picks: 1 X 2 OV25 UN25 GG NG.`,
        am: `"${quoteToken(error.token)}" ምርጫ አይደለም (ጨዋታ ${formatGameId(error.gameId)})። ምርጫዎች: 1 X 2 OV25 UN25 GG NG።`,
      };
      break;
    case 'invalid_stake':
      text = {
        en: `Stake "${quoteToken(error.token)}" is not valid: use whole birr, e.g. 1234#1#50.`,
        am: `መጠን "${quoteToken(error.token)}" ትክክል አይደለም፤ ሙሉ ብር ይጠቀሙ፣ ለምሳሌ 1234#1#50።`,
      };
      break;
    case 'stake_too_large':
      if (rules.maxStake !== undefined) {
        return refusalBody({ code: 'stake_above_maximum', max: rules.maxStake }, locale);
      }
      text = {
        en: `The stake is above the maximum. ${pickText(NO_BET, 'en')}`,
        am: `መጠኑ ከከፍተኛው በላይ ነው። ${pickText(NO_BET, 'am')}`,
      };
      break;
    case 'duplicate_game':
      text = {
        en: `Game ${formatGameId(error.gameId)} is on the bet twice; one pick per game.`,
        am: `ጨዋታ ${formatGameId(error.gameId)} ሁለት ጊዜ ገብቷል፤ በአንድ ጨዋታ አንድ ምርጫ ብቻ።`,
      };
      break;
  }
  return pickText(text, locale);
}

// --- Information ------------------------------------------------------------

/** BAL: cash balance, plus the bonus balance when there is one. */
export function balanceBody(
  balances: { cash: Santim; bonus: Santim },
  locale: ChannelLocale,
): string {
  const cash = formatMoney(balances.cash, locale);
  const bonus = balances.bonus > 0n ? formatMoney(balances.bonus, locale) : null;
  if (locale === 'am') return `ቀሪ ሂሳብ ${cash}።${bonus === null ? '' : ` ቦነስ ${bonus}።`}`;
  return `Balance ${cash}.${bonus === null ? '' : ` Bonus ${bonus}.`}`;
}

export type ChannelBetStatus =
  'pending_acceptance' | 'open' | 'won' | 'lost' | 'void' | 'cashed_out' | 'rejected';

export interface BetLine {
  shortId: string;
  status: ChannelBetStatus;
  stake: Santim;
  potentialNetPayout: Santim;
  /** What a won or cashed-out bet paid (net). */
  settledNetPayout: Santim | null;
}

function betLineText(bet: BetLine, locale: ChannelLocale): string {
  const stake = formatBirr(bet.stake);
  const paid = formatBirr(bet.settledNetPayout ?? 0n);
  const win = formatBirr(bet.potentialNetPayout);
  const id = bet.shortId;
  const text: Readonly<Record<ChannelBetStatus, Text>> = {
    pending_acceptance: {
      en: `${id} awaiting acceptance, stake ${stake}`,
      am: `${id} ማረጋገጫ በመጠበቅ ላይ፣ መጠን ${stake}`,
    },
    open: {
      en: `${id} open, stake ${stake}, win ${win}`,
      am: `${id} ክፍት፣ መጠን ${stake}፣ ሊያሸንፉ ${win}`,
    },
    won: { en: `${id} won ${paid}`, am: `${id} አሸንፏል ${paid}` },
    lost: { en: `${id} lost, stake ${stake}`, am: `${id} ተሸንፏል፣ መጠን ${stake}` },
    void: { en: `${id} void, refunded ${stake}`, am: `${id} ተሰርዟል፣ ተመላሽ ${stake}` },
    cashed_out: { en: `${id} cashed out ${paid}`, am: `${id} ቀድሞ ተከፍሏል ${paid}` },
    rejected: { en: `${id} rejected, refunded ${stake}`, am: `${id} ውድቅ ሆኗል፣ ተመላሽ ${stake}` },
  };
  return pickText(text[bet.status], locale);
}

/** BETS: the player's latest bets (newest first) with their status; amounts in birr. */
export function betsBody(bets: readonly BetLine[], locale: ChannelLocale): string {
  if (bets.length === 0) {
    return locale === 'am'
      ? `እስካሁን ውርርድ የለዎትም። ${pickText(SYNTAX, locale)}`
      : `You have no bets yet. ${pickText(SYNTAX, locale)}`;
  }
  const lines = bets.map((bet) => betLineText(bet, locale));
  return locale === 'am'
    ? `የቅርብ ውርርዶች (ብር): ${lines.join('፤ ')}።`
    : `Last bets (ETB): ${lines.join('; ')}.`;
}

export interface JackpotSummary {
  templateCode: string;
  gameCount: number;
  costPerCombination: Santim;
  /** The advertised top prize. */
  pool: Santim;
  closesAt: Date;
  /** Game IDs (and short team names) in round order. */
  games: ReadonlyArray<{ gameId: number; home: string; away: string }>;
}

function jackpotText(round: JackpotSummary, locale: ChannelLocale, withTeams: boolean): string {
  const code = round.templateCode.toUpperCase();
  const cost = formatMoney(round.costPerCombination, locale);
  const pool = formatMoney(round.pool, locale);
  const closes = formatAddisDateTime(round.closesAt, locale);
  const games = round.games
    .map((game) =>
      withTeams
        ? `${formatGameId(game.gameId)} ${game.home}-${game.away}`
        : formatGameId(game.gameId),
    )
    .join(', ');
  return locale === 'am'
    ? `ጃክፖት ${code}: ${round.gameCount} ጨዋታዎች፣ ${cost} በአንድ ጥምረት፣ ሽልማት ${pool}፣ የሚዘጋው ${closes}። ጨዋታዎች: ${games}።`
    : `Jackpot ${code}: ${round.gameCount} games, ${cost} per combination, prize ${pool}, closes ${closes}. Games: ${games}.`;
}

/**
 * JP: the open jackpot rounds (games and cost per combination). Entries are
 * made on the website; team names are dropped when they would not fit.
 */
export function jackpotBody(
  rounds: readonly JackpotSummary[],
  locale: ChannelLocale,
  maxSegments: number = MAX_SMS_SEGMENTS,
): string {
  if (rounds.length === 0) {
    return locale === 'am'
      ? 'አሁን ክፍት ጃክፖት የለም። ለቀጣዩ ዙር ድረ-ገጹን ይመልከቱ።'
      : 'No jackpot is open right now. Check the website for the next round.';
  }
  const tail = locale === 'am' ? ' በድረ-ገጹ ላይ ይሳተፉ።' : ' Enter on the website.';
  const withTeams = rounds.map((round) => jackpotText(round, locale, true)).join(' ') + tail;
  if (smsFits(withTeams, maxSegments)) return withTeams;
  return rounds.map((round) => jackpotText(round, locale, false)).join(' ') + tail;
}

/** Whether `body` with the longest prefix fits in `maxSegments` parts. */
function smsFits(body: string, maxSegments: number): boolean {
  const text = `${replyPrefix(true)}${body}`;
  return fitSms(text, maxSegments) === text;
}

/** HELP: the commands (one GSM-7 message in English, prefix included). */
export function helpBody(locale: ChannelLocale): string {
  return locale === 'am'
    ? 'ውርርድ: GAMEID#PICK#STAKE፣ ለምሳሌ 1234#1#50። ብዙ ጨዋታ: 1234#1#5678#X#50። ምርጫዎች: 1 X 2 OV25 UN25 GG NG። BAL ቀሪ ሂሳብ፣ BETS ውርርዶች፣ JP ጃክፖት፣ STOP ማስታወቂያ አቁም።'
    : 'Bet: GAMEID#PICK#STAKE e.g. 1234#1#50. Multi: 1234#1#5678#X#50. Picks: 1 X 2 OV25 UN25 GG NG. BAL balance, BETS bets, JP jackpot, STOP no offers.';
}

/** STOP / START: the marketing opt-out confirmation, in the player's language. */
export function optOutBody(optedOut: boolean, locale: ChannelLocale): string {
  if (optedOut) {
    return locale === 'am'
      ? 'የማስታወቂያ መልዕክቶች አይላኩልዎትም። እንደገና ለመቀበል START ይላኩ።'
      : 'You will no longer get offers by SMS. Send START to get them again.';
  }
  return locale === 'am'
    ? 'የቫሞስ ቅናሾችን በSMS ይቀበላሉ። ለማቆም STOP ይላኩ።'
    : 'You will get Vamos offers by SMS. Send STOP to opt out.';
}

/** STOP / START for a number that is not an active, verified player: both languages. */
export function optOutBodyBilingual(optedOut: boolean): string {
  return `${optOutBody(optedOut, 'en')} ${optOutBody(optedOut, 'am')}`;
}

/**
 * The reply to a number sending too many texts, in both languages (sent at
 * most once per rate-limit window; the texts themselves are not read).
 */
export function tooManyMessagesBody(): string {
  return (
    'Too many messages. Please wait a few minutes and try again. ' +
    'በጣም ብዙ መልዕክቶች። እባክዎ ጥቂት ደቂቃዎች ቆይተው ይሞክሩ።'
  );
}

/**
 * The one reply for every number that is not an active, verified player
 * (unknown, unverified, suspended or closed alike), in both languages, so it
 * never tells whether the number is registered.
 */
export function notAvailableBody(): string {
  return (
    'SMS betting is not available for this number. Register and verify it on the Vamos website. ' +
    'ለዚህ ቁጥር የSMS ውርርድ የለም። ቁጥሩን በቫሞስ ድረ-ገጽ ያስመዝግቡ።'
  );
}
