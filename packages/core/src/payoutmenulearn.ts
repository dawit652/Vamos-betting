import type { Santim } from './money';
import {
  nextPayoutMenuAction,
  normalizeMenuText,
  parseMenuAmount,
  validatePayoutMenuScript,
  type PayoutMenuReply,
  type PayoutMenuScript,
  type PayoutMenuStep,
} from './payoutmenu';
import { normalizeEthiopianMsisdn } from './phone';

/**
 * Making a menu script from one real session ("teach once", design:
 * docs/plans/payout-sender-design.md, section 6). The owner sends one small
 * transfer through the agent, typing what they would type on the phone; this
 * turns what the menu showed into the templates of a script: the number,
 * the amount and the holder's name become `{number}`, `{amount}`, `{name}`,
 * the transaction id on the result becomes `{reference}`, and every other
 * figure (a fee, a balance, a date) becomes `{any}`. Words stay fixed.
 *
 * Pure. The PIN is never part of a recording. The script is only returned
 * when it validates AND replays the recording exactly: the same answers in
 * the same order, ending in `sent`. It then still has to prove itself on
 * other numbers and amounts in rehearsal before it sends anything.
 */

export interface RecordedExchange {
  /** What the menu showed. */
  screen: string;
  /** What was typed in answer. The PIN itself is never recorded. */
  typed: PayoutMenuReply;
}

export interface MenuRecording {
  institution: string;
  /** The code that was dialled, such as `*127#`. */
  dial: string;
  /** How the number and the amount were typed. */
  numberFormat: 'local' | 'international';
  amountFormat: 'whole_birr' | 'birr_and_santim';
  /** Every screen that was answered, in order. */
  exchanges: readonly RecordedExchange[];
  /** The screen after the last answer, of a transfer that went through. */
  result: string;
  /** The transfer made while recording. */
  number: string;
  amount: Santim;
  /** The holder's name exactly as a screen showed it; null when the menu shows none. */
  shownName: string | null;
  version?: number;
}

export type DeriveMenuScriptResult =
  { ok: true; script: PayoutMenuScript; notes: string[] } | { ok: false; problems: string[] };

/** The least amount a recording may use: small amounts look like menu choices (`1. Confirm`). */
export const MIN_RECORDING_AMOUNT: Santim = 1_100n;

// Marks put in place of what was recognised, turned into placeholders at the end. Private-use
// characters: a screen cannot hold them (they are removed first).
const NAME = '\uE000';
const NUMBER = '\uE001';
const AMOUNT = '\uE002';
const REFERENCE = '\uE003';
const ANY = '\uE004';
const MARKS: Readonly<Record<string, string>> = {
  [NAME]: '{name}',
  [NUMBER]: '{number}',
  [AMOUNT]: '{amount}',
  [REFERENCE]: '{reference}',
  [ANY]: '{any}',
};

/** A run of letters and digits, with `. , : / + -` allowed inside it (`1,500.00`, `16/11/2026`). */
const RUN = /[\p{L}\p{N}+][\p{L}\p{N}.,:/+-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
const HAS_DIGIT = /\p{N}/u;
const REFERENCE_SHAPE = /^(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,32}$/;
/** After a one- or two-digit run: it numbers a menu choice (`1. Send`, `2) Buy`, `3: Yes`, `4 - No`). */
const CHOICE_AFTER = /^(?:[.):]\s*|\s*-\s*)\p{L}/u;

interface TemplateOptions {
  number: string;
  amount: Santim;
  shownName: string | null;
  /** The number / the amount had been typed before this screen was shown. */
  numberTyped: boolean;
  amountTyped: boolean;
  /** The result screen: its transaction id is read. */
  result: boolean;
}

interface Template {
  text: string;
  /** The recording's amount was also the number of a menu choice on this screen. */
  amountIsChoice: boolean;
  hasName: boolean;
  hasReference: boolean;
}

function templateOf(screen: string, options: TemplateOptions): Template {
  // Braces would read as placeholders, the marks are ours: neither may come from a screen.
  let text = normalizeMenuText(screen.replace(/[\uE000-\uF8FF]/g, '')).replace(/[{}]/g, ANY);

  let hasName = false;
  const name = options.shownName === null ? '' : normalizeMenuText(options.shownName);
  if (name !== '') {
    const lower = text.toLowerCase();
    const wanted = name.toLowerCase();
    let out = '';
    let from = 0;
    for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, from)) {
      out += text.slice(from, at) + NAME;
      from = at + wanted.length;
      hasName = true;
    }
    text = out + text.slice(from);
  }

  let amountIsChoice = false;
  let hasReference = false;
  text = text.replace(RUN, (run: string, offset: number, whole: string) => {
    if (!HAS_DIGIT.test(run)) return run;
    const after = whole.slice(offset + run.length);
    const choice = /^\d{1,2}$/.test(run) && CHOICE_AFTER.test(after);
    if (
      options.numberTyped &&
      /^\+?\d{9,13}$/.test(run) &&
      normalizeEthiopianMsisdn(run) === options.number
    ) {
      return NUMBER;
    }
    if (options.amountTyped && parseMenuAmount(run) === options.amount) {
      if (choice) amountIsChoice = true;
      return AMOUNT;
    }
    // An amount written against its currency: `ETB1500.00`, `1500.00ETB`.
    const glued = /^([A-Za-z]{1,4})(\d[\d.,]*)$|^(\d[\d.,]*?)([A-Za-z]{1,4})$/.exec(run);
    if (options.amountTyped && glued !== null) {
      const figure = glued[2] ?? glued[3] ?? '';
      if (parseMenuAmount(figure) === options.amount) {
        return glued[1] === undefined ? `${AMOUNT}${glued[4] ?? ''}` : `${glued[1]}${AMOUNT}`;
      }
    }
    if (options.result && !hasReference && REFERENCE_SHAPE.test(run)) {
      hasReference = true;
      return REFERENCE;
    }
    // The number of a menu choice is part of the menu's words; any other figure changes.
    return choice ? run : ANY;
  });

  // Several changing figures in a row are one changing part.
  text = text.replace(new RegExp(`${ANY}(?:\\s*${ANY})+`, 'g'), ANY);
  for (const [mark, placeholder] of Object.entries(MARKS))
    text = text.split(mark).join(placeholder);
  return { text, amountIsChoice, hasName, hasReference };
}

/** What a reply types for the recording's own transfer, as the judgement would give it. */
function typedText(recording: MenuRecording, reply: PayoutMenuReply): string | null {
  if ('keys' in reply) return reply.keys;
  if ('pin' in reply) return null;
  if (reply.value === 'number') {
    const subscriber = recording.number.slice(-9);
    return recording.numberFormat === 'local' ? `0${subscriber}` : `251${subscriber}`;
  }
  const birr = recording.amount / 100n;
  const santim = recording.amount % 100n;
  return recording.amountFormat === 'whole_birr'
    ? birr.toString()
    : `${birr}.${santim.toString().padStart(2, '0')}`;
}

export function deriveMenuScript(recording: MenuRecording): DeriveMenuScriptResult {
  const problems: string[] = [];
  const exchanges = Array.isArray(recording?.exchanges)
    ? (recording.exchanges as RecordedExchange[])
    : [];
  if (exchanges.length === 0) problems.push('the recording holds no answered screen');
  if (
    typeof recording?.number !== 'string' ||
    normalizeEthiopianMsisdn(recording.number) !== recording.number
  ) {
    problems.push('the number must be an Ethiopian mobile number in E.164 (+2519…)');
  }
  if (typeof recording?.amount !== 'bigint' || recording.amount < MIN_RECORDING_AMOUNT) {
    problems.push(
      `record with an amount of at least ${MIN_RECORDING_AMOUNT / 100n} birr: a smaller one looks like a menu choice`,
    );
  }
  if (typeof recording?.result !== 'string' || recording.result.trim() === '') {
    problems.push('the result screen is missing');
  }
  if (problems.length > 0) return { ok: false, problems };

  const typedAt = (value: 'number' | 'amount') =>
    exchanges.findIndex((e) => 'value' in e.typed && e.typed.value === value);
  const numberAt = typedAt('number');
  const amountAt = typedAt('amount');
  const base = {
    number: recording.number,
    amount: recording.amount,
    shownName: recording.shownName,
  };
  const notes: string[] = [];
  let namedSomewhere = false;

  const steps: PayoutMenuStep[] = exchanges.map((exchange, i) => {
    const template = templateOf(exchange.screen, {
      ...base,
      // Screen i shows what the answers before it typed.
      numberTyped: numberAt >= 0 && i > numberAt,
      amountTyped: amountAt >= 0 && i > amountAt,
      result: false,
    });
    if (template.amountIsChoice) {
      problems.push(
        `screen ${i + 1}: the amount is also the number of a menu choice there; record with another amount`,
      );
    }
    namedSomewhere ||= template.hasName;
    return { screen: template.text, reply: exchange.typed };
  });
  const success = templateOf(recording.result, {
    ...base,
    numberTyped: numberAt >= 0,
    amountTyped: amountAt >= 0,
    result: true,
  });
  if (success.amountIsChoice) {
    problems.push('the result screen: the amount is also the number of a menu choice there');
  }

  const script: PayoutMenuScript = {
    institution: recording.institution,
    version: recording.version ?? 1,
    dial: recording.dial,
    numberFormat: recording.numberFormat,
    amountFormat: recording.amountFormat,
    steps,
    success: success.text,
    failures: [],
  };
  problems.push(...validatePayoutMenuScript(script));
  if (problems.length > 0) return { ok: false, problems };

  // The script must replay its own recording: the same answers in the same order, then "sent".
  const transfer = {
    number: recording.number,
    amount: recording.amount,
    name: recording.shownName,
  };
  const screens = [...exchanges.map((e) => e.screen), recording.result];
  for (let shown = 0; shown <= screens.length; shown += 1) {
    const action = nextPayoutMenuAction(script, transfer, screens.slice(0, shown));
    const expected = shown === 0 ? null : exchanges[shown - 1];
    let same: boolean;
    if (shown === 0) same = action.kind === 'dial' && action.code === recording.dial;
    else if (shown === screens.length) same = action.kind === 'finish' && action.outcome === 'sent';
    else if (expected === undefined || expected === null) same = false;
    else if ('pin' in expected.typed) same = action.kind === 'reply_pin';
    else same = action.kind === 'reply' && action.text === typedText(recording, expected.typed);
    if (!same) {
      let instead = 'answer differently';
      if (action.kind === 'finish') {
        instead = action.outcome === 'sent' ? 'report sent too early' : `stop: ${action.reason}`;
      }
      problems.push(
        shown === screens.length
          ? 'the script does not read the recorded result as sent'
          : `the script does not repeat the recording at step ${shown} (it would ${instead})`,
      );
      break;
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  if (recording.shownName !== null && !namedSomewhere) {
    notes.push('the name given was on no screen: the script does not check the holder name');
  }
  if (recording.shownName === null) {
    notes.push(
      'no name was given: if the menu shows the holder name, the script does not check it',
    );
  }
  if (!success.hasReference) notes.push('the result screen shows no transaction id to read');
  notes.push(
    'no failure screens are known: a transfer the menu refuses after the commit is reported as unknown',
    'rehearse with other numbers and amounts before sending: only that shows which parts of a screen change',
  );
  return { ok: true, script, notes };
}
