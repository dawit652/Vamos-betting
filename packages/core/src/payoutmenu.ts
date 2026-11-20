import type { Santim } from './money';
import { personNamesMatch } from './paymentmethods';
import { normalizeEthiopianMsisdn } from './phone';

/**
 * Walking an institution's USSD menu to send one payout (design:
 * docs/plans/payout-sender-design.md). A person sends a wallet transfer by
 * dialling the menu, typing the number and the amount, reading the
 * confirmation and typing the PIN. This module is that person's judgement as
 * a pure function: given the screens shown so far it says what to type next,
 * or that it must stop. A device (a modem with the payout SIM) does the
 * typing; nothing here does I/O, and the PIN is never passed in: the answer
 * `reply_pin` tells the driver to type it.
 *
 * It errs towards stopping. Every screen must match the script's template
 * for that step, and the money can only move after a screen has shown the
 * payout's own number and amount back to us (and its holder's name where the
 * script reads one). Any other screen ends the session:
 *
 * - `not_sent` when the last answer (the one after which money may move, the
 *   "commit": the first answer given once the PIN has been typed and the
 *   confirmation screen has been shown) was never given: nothing left the
 *   account, the payout can be tried again or paid by hand;
 * - `unknown` when it was given and the result is not one the script knows:
 *   a person must look before anything else happens to that payout. An
 *   unknown result is never retried by a machine.
 */

/** What is being sent. */
export interface PayoutMenuTransfer {
  /** The destination wallet, E.164 (`+2519…`). */
  number: string;
  amount: Santim;
  /** The holder's name as we know it (KYC); compared where the script's screens show a name. */
  name: string | null;
}

/** What to type at one step. */
export type PayoutMenuReply =
  /** Fixed keys: a menu choice such as `1`. */
  | { keys: string }
  /** The transfer's number or amount, in the script's format. */
  | { value: 'number' | 'amount' }
  /** The PIN, typed by the driver. */
  | { pin: true };

export interface PayoutMenuStep {
  /**
   * The screen that must be showing before the answer is typed, as a
   * template: literal text plus `{number}`, `{amount}`, `{name}` (compared
   * with the transfer), `{reference}` and `{any}` (anything, for parts that
   * change such as a balance or a date).
   */
  screen: string;
  reply: PayoutMenuReply;
}

export interface PayoutMenuScript {
  institution: string;
  version: number;
  /** The code that opens the menu, such as `*127#`. */
  dial: string;
  /** How the menu wants the number typed: `0911…` or `251911…`. */
  numberFormat: 'local' | 'international';
  /** `whole_birr`: `150` (an amount with santim is refused); `birr_and_santim`: `150.50`. */
  amountFormat: 'whole_birr' | 'birr_and_santim';
  /**
   * In order. The answer to the last step is the commit: after it money may
   * move, and the next screen is the result. A script with steps after the
   * commit is refused (validatePayoutMenuScript).
   */
  steps: readonly PayoutMenuStep[];
  /** The screen after the commit that means the money was sent; `{reference}` reads the transaction id. */
  success: string;
  /** Screens after the commit that mean it certainly was not sent (wrong PIN, balance too low…). */
  failures: readonly { screen: string; code: string }[];
}

export type PayoutMenuStopReason =
  | 'invalid_script'
  | 'invalid_transfer'
  | 'amount_not_whole_birr'
  | 'unexpected_screen'
  | 'number_differs'
  | 'amount_differs'
  | 'name_differs'
  | 'unexpected_result'
  | 'session_lost'
  | `failed_${string}`;

export type PayoutMenuAction =
  | { kind: 'dial'; code: string }
  | { kind: 'reply'; step: number; text: string; commit: boolean }
  | { kind: 'reply_pin'; step: number; commit: boolean }
  | { kind: 'finish'; outcome: 'sent'; reference: string | null }
  | { kind: 'finish'; outcome: 'not_sent'; reason: PayoutMenuStopReason }
  | { kind: 'finish'; outcome: 'unknown'; reason: PayoutMenuStopReason };

export const PAYOUT_MENU_MAX_STEPS = 12;
/** A USSD screen holds 182 characters; anything far longer is not one. */
export const PAYOUT_MENU_MAX_SCREEN_LENGTH = 1000;
const MAX_TEMPLATE_LENGTH = 600;

const PLACEHOLDER = /\{([a-z]+)\}/g;
type Placeholder = 'number' | 'amount' | 'name' | 'reference' | 'any';
const PLACEHOLDERS: readonly Placeholder[] = ['number', 'amount', 'name', 'reference', 'any'];

/**
 * The pattern of each placeholder. A number or an amount never starts or
 * ends inside a longer run of digits, so `{amount}` cannot match the `5`
 * of `1500`.
 */
const PLACEHOLDER_PATTERN: Readonly<Record<Placeholder, string>> = {
  number: String.raw`(?<![\d+])(\+?\d{9,13})(?!\d)`,
  amount: String.raw`(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d]|[.,]\d)`,
  name: String.raw`(.+?)`,
  reference: String.raw`([A-Za-z0-9]{6,32})`,
  any: String.raw`.*?`,
};

/** Whitespace of every kind (USSD screens are full of line breaks) becomes one space. */
export function normalizeMenuText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

interface CompiledTemplate {
  regex: RegExp;
  /** The captured placeholders, in the order of their groups. */
  groups: Exclude<Placeholder, 'any'>[];
  has: ReadonlySet<Placeholder>;
  /** Letters and digits of fixed text: a template of placeholders alone would match any screen. */
  fixed: number;
}

/** The least fixed text a template must hold. */
const MIN_FIXED_CHARACTERS = 4;

/** Null when the template names a placeholder that does not exist, or is empty or too long. */
function compileTemplate(template: unknown): CompiledTemplate | null {
  if (typeof template !== 'string') return null;
  const text = normalizeMenuText(template);
  if (text === '' || text.length > MAX_TEMPLATE_LENGTH) return null;
  const groups: Exclude<Placeholder, 'any'>[] = [];
  const has = new Set<Placeholder>();
  let pattern = '';
  let at = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as Placeholder;
    if (!PLACEHOLDERS.includes(name)) return null;
    pattern += escapeRegExp(text.slice(at, match.index));
    pattern += PLACEHOLDER_PATTERN[name];
    if (name !== 'any') groups.push(name);
    has.add(name);
    at = match.index + match[0].length;
  }
  pattern += escapeRegExp(text.slice(at));
  // A brace left over is a mistyped placeholder (`{amount`), not literal text.
  const literal = text.replace(PLACEHOLDER, '');
  if (/[{}]/.test(literal)) return null;
  const fixed = literal.replace(/[^\p{L}\p{N}]/gu, '').length;
  return { regex: new RegExp(`^${pattern}$`, 'iu'), groups, has, fixed };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An amount as a screen shows it (`1,500`, `1500.5`, `1500.50`) in santim, exactly; null if it is not one. */
export function parseMenuAmount(text: string): Santim | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const birr = BigInt((match[1] ?? '').replace(/,/g, ''));
  const santim = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return birr * 100n + santim;
}

export type PayoutMenuScreenMatch =
  | { ok: true; reference: string | null }
  | {
      ok: false;
      reason: 'unexpected_screen' | 'number_differs' | 'amount_differs' | 'name_differs';
    };

/**
 * Whether `screen` is the screen `template` describes, for this transfer.
 * Every `{number}` and `{amount}` the template reads must be the transfer's
 * own, to the digit and to the santim; every `{name}` must be the holder's
 * name (personNamesMatch), and a screen that shows a name when we know none
 * does not match.
 */
export function matchPayoutMenuScreen(
  template: string,
  screen: unknown,
  transfer: PayoutMenuTransfer,
): PayoutMenuScreenMatch {
  const compiled = compileTemplate(template);
  if (compiled === null || typeof screen !== 'string') {
    return { ok: false, reason: 'unexpected_screen' };
  }
  if (screen.length > PAYOUT_MENU_MAX_SCREEN_LENGTH)
    return { ok: false, reason: 'unexpected_screen' };
  const found = compiled.regex.exec(normalizeMenuText(screen));
  if (found === null) return { ok: false, reason: 'unexpected_screen' };
  let reference: string | null = null;
  for (const [i, name] of compiled.groups.entries()) {
    const value = found[i + 1] ?? '';
    if (name === 'number') {
      if (normalizeEthiopianMsisdn(value) !== transfer.number) {
        return { ok: false, reason: 'number_differs' };
      }
    } else if (name === 'amount') {
      if (parseMenuAmount(value) !== transfer.amount)
        return { ok: false, reason: 'amount_differs' };
    } else if (name === 'name') {
      if (transfer.name === null || !personNamesMatch(value, transfer.name)) {
        return { ok: false, reason: 'name_differs' };
      }
    } else {
      reference = value;
    }
  }
  return { ok: true, reference };
}

const KEYS = /^[0-9*#]{1,20}$/;
const DIAL = /^\*[0-9*]{1,30}#$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Why a script may not be used; empty when it may. Beyond its shape, a
 * script must type the transfer's number and amount itself (never a fixed
 * beneficiary), type the PIN exactly once, and must be shown both the number
 * and the amount back on one screen after typing them and before the commit:
 * without that confirmation screen nothing proves the menu took the values
 * the way we meant them.
 */
export function validatePayoutMenuScript(script: PayoutMenuScript): string[] {
  const problems: string[] = [];
  const s = (
    typeof script === 'object' && script !== null ? script : {}
  ) as Partial<PayoutMenuScript>;
  if (typeof s.institution !== 'string' || s.institution.trim() === '') {
    problems.push('institution is missing');
  }
  if (!Number.isInteger(s.version) || (s.version ?? 0) < 1) problems.push('version must be >= 1');
  if (typeof s.dial !== 'string' || !DIAL.test(s.dial)) problems.push('dial must look like *127#');
  if (s.numberFormat !== 'local' && s.numberFormat !== 'international') {
    problems.push('numberFormat must be local or international');
  }
  if (s.amountFormat !== 'whole_birr' && s.amountFormat !== 'birr_and_santim') {
    problems.push('amountFormat must be whole_birr or birr_and_santim');
  }
  const steps = Array.isArray(s.steps) ? (s.steps as PayoutMenuStep[]) : [];
  if (steps.length < 1 || steps.length > PAYOUT_MENU_MAX_STEPS) {
    problems.push(`steps must hold 1 to ${PAYOUT_MENU_MAX_STEPS} steps`);
  }
  let numberAt = -1;
  let amountAt = -1;
  let pinAt = -1;
  let pins = 0;
  let numbers = 0;
  let amounts = 0;
  const compiled: (CompiledTemplate | null)[] = [];
  for (const [i, step] of steps.entries()) {
    const template = compileTemplate(step?.screen);
    compiled.push(template);
    if (template === null) problems.push(`step ${i + 1}: the screen template is not valid`);
    else {
      if (template.fixed < MIN_FIXED_CHARACTERS) {
        problems.push(`step ${i + 1}: the screen template needs some fixed text`);
      }
      if (template.has.has('reference')) {
        problems.push(`step ${i + 1}: {reference} belongs to the success screen only`);
      }
    }
    const reply = (step?.reply ?? {}) as Partial<Record<'keys' | 'value' | 'pin', unknown>>;
    if (typeof reply.keys === 'string') {
      if (!KEYS.test(reply.keys)) problems.push(`step ${i + 1}: keys must be 1 to 20 of 0-9 * #`);
    } else if (reply.value === 'number') {
      numbers += 1;
      numberAt = i;
    } else if (reply.value === 'amount') {
      amounts += 1;
      amountAt = i;
    } else if (reply.pin === true) {
      pins += 1;
      pinAt = i;
    } else {
      problems.push(`step ${i + 1}: the reply must be keys, the number, the amount or the PIN`);
    }
  }
  if (numbers !== 1) problems.push('the number must be typed in exactly one step');
  if (amounts !== 1) problems.push('the amount must be typed in exactly one step');
  if (pins !== 1) problems.push('the PIN must be typed in exactly one step');
  // The confirmation: the first screen, shown after both values were typed (step j shows what
  // the steps before j typed), that reads both back.
  const confirmAt = compiled.findIndex(
    (template, j) =>
      template !== null &&
      numberAt >= 0 &&
      amountAt >= 0 &&
      j > numberAt &&
      j > amountAt &&
      template.has.has('number') &&
      template.has.has('amount'),
  );
  if (confirmAt < 0) {
    problems.push(
      'no screen after the number and the amount were typed shows both {number} and {amount} back',
    );
  } else if (pins === 1 && Math.max(confirmAt, pinAt) !== steps.length - 1) {
    // Money can move from the first answer given once the PIN is typed and the confirmation was
    // shown. A step after it would make its result screen look like an ordinary screen, and a
    // transfer that went through would be reported as not sent.
    problems.push(
      `step ${Math.max(confirmAt, pinAt) + 1} sends the money (the PIN is typed and the confirmation shown), so it must be the last step`,
    );
  }
  const success = compileTemplate(s.success);
  if (success === null) problems.push('the success screen template is not valid');
  else if (success.fixed < MIN_FIXED_CHARACTERS) {
    problems.push('the success screen template needs some fixed text');
  }
  const failures: { screen?: unknown; code?: unknown }[] | null = Array.isArray(s.failures)
    ? (s.failures as { screen?: unknown; code?: unknown }[])
    : null;
  if (failures === null) problems.push('failures must be a list (it may be empty)');
  for (const [i, failure] of (failures ?? []).entries()) {
    const template = compileTemplate(failure?.screen);
    if (template === null) problems.push(`failure ${i + 1}: the screen template is not valid`);
    else if (template.fixed < MIN_FIXED_CHARACTERS) {
      problems.push(`failure ${i + 1}: the screen template needs some fixed text`);
    }
    const code = failure?.code;
    if (typeof code !== 'string' || !FAILURE_CODE.test(code)) {
      problems.push(`failure ${i + 1}: code must be lower-case letters, digits and _`);
    }
  }
  return problems;
}

/** The number as the menu wants it typed; null when it is not an Ethiopian mobile number in E.164. */
function typedNumber(script: PayoutMenuScript, transfer: PayoutMenuTransfer): string | null {
  if (typeof transfer.number !== 'string') return null;
  if (normalizeEthiopianMsisdn(transfer.number) !== transfer.number) return null;
  const subscriber = transfer.number.slice(-9);
  return script.numberFormat === 'local' ? `0${subscriber}` : `251${subscriber}`;
}

/** The amount as the menu wants it typed; null when it cannot be typed in this format. */
function typedAmount(script: PayoutMenuScript, transfer: PayoutMenuTransfer): string | null {
  if (typeof transfer.amount !== 'bigint' || transfer.amount <= 0n) return null;
  const birr = transfer.amount / 100n;
  const santim = transfer.amount % 100n;
  if (script.amountFormat === 'whole_birr') return santim === 0n ? birr.toString() : null;
  return `${birr}.${santim.toString().padStart(2, '0')}`;
}

/** validatePayoutMenuScript that never throws, whatever it is given. */
function scriptIsValid(script: PayoutMenuScript): boolean {
  try {
    return validatePayoutMenuScript(script).length === 0;
  } catch {
    return false;
  }
}

/**
 * What to do next, given every screen shown so far in this session (the
 * first is the answer to the dial code, each later one the answer to our
 * previous reply). Pure and total: the same input gives the same answer and
 * nothing is thrown. The caller types exactly what is returned, then calls
 * again with the next screen added; when the session breaks instead (a
 * timeout, the modem gone), it calls `payoutMenuOutcomeAfterBreak`.
 */
export function nextPayoutMenuAction(
  script: PayoutMenuScript,
  transfer: PayoutMenuTransfer,
  screens: readonly unknown[],
): PayoutMenuAction {
  const shown: readonly unknown[] = Array.isArray(screens) ? (screens as unknown[]) : [];
  const stop = (reason: PayoutMenuStopReason, commitSent: boolean): PayoutMenuAction => ({
    kind: 'finish',
    outcome: commitSent ? 'unknown' : 'not_sent',
    reason,
  });
  const valid = scriptIsValid(script);
  // With an invalid script no reply was ever returned, so nothing was committed
  // unless the caller did not follow: then a result screen is already there.
  if (!valid) return stop('invalid_script', shown.length > 0);
  const steps = script.steps;
  const commitSent = shown.length > steps.length;

  const t = (
    typeof transfer === 'object' && transfer !== null ? transfer : {}
  ) as PayoutMenuTransfer;
  const number = typedNumber(script, t);
  const amount = typedAmount(script, t);
  if (number === null || typeof t.amount !== 'bigint' || t.amount <= 0n) {
    return stop('invalid_transfer', commitSent);
  }
  if (amount === null) return stop('amount_not_whole_birr', commitSent);
  const safe: PayoutMenuTransfer = {
    number: t.number,
    amount: t.amount,
    name: typeof t.name === 'string' && t.name.trim() !== '' ? t.name : null,
  };

  if (shown.length === 0) return { kind: 'dial', code: script.dial };
  if (shown.length > steps.length + 1) return stop('unexpected_result', true);

  // Every screen so far must be its step's screen: one that is not ends the session.
  const upTo = Math.min(shown.length, steps.length);
  for (let i = 0; i < upTo; i += 1) {
    const step = steps[i];
    if (step === undefined) return stop('invalid_script', commitSent);
    const match = matchPayoutMenuScreen(step.screen, shown[i], safe);
    if (!match.ok) return stop(match.reason, commitSent);
  }

  if (!commitSent) {
    const index = shown.length - 1;
    const step = steps[index];
    if (step === undefined) return stop('invalid_script', false);
    const commit = index === steps.length - 1;
    const reply = step.reply;
    if ('pin' in reply) return { kind: 'reply_pin', step: index, commit };
    if ('keys' in reply) return { kind: 'reply', step: index, text: reply.keys, commit };
    return {
      kind: 'reply',
      step: index,
      text: reply.value === 'number' ? number : amount,
      commit,
    };
  }

  // The commit was typed: this screen is the result.
  const result: unknown = shown[steps.length];
  const success = matchPayoutMenuScreen(script.success, result, safe);
  if (success.ok) return { kind: 'finish', outcome: 'sent', reference: success.reference };
  for (const failure of script.failures) {
    if (matchPayoutMenuScreen(failure.screen, result, safe).ok) {
      return { kind: 'finish', outcome: 'not_sent', reason: `failed_${failure.code}` };
    }
  }
  // Not a result we know, or a success screen naming another number or amount: a person looks.
  return { kind: 'finish', outcome: 'unknown', reason: 'unexpected_result' };
}

/**
 * The outcome when the session broke (no screen came, the modem went away).
 * `repliesStarted` counts the replies the driver began to type, counted
 * BEFORE each write: a commit whose write failed half-way may have reached
 * the network, so it counts as typed.
 */
export function payoutMenuOutcomeAfterBreak(
  script: PayoutMenuScript,
  repliesStarted: number,
): { outcome: 'not_sent' | 'unknown'; reason: 'session_lost' } {
  const steps = Array.isArray(script?.steps) ? script.steps.length : 0;
  const committed =
    !Number.isInteger(repliesStarted) ||
    repliesStarted < 0 ||
    steps === 0 ||
    repliesStarted >= steps;
  return { outcome: committed ? 'unknown' : 'not_sent', reason: 'session_lost' };
}
