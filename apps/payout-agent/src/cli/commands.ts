import {
  deriveMenuScript,
  MIN_RECORDING_AMOUNT,
  normalizeEthiopianMsisdn,
  parseBirr,
  santimToBirrString,
  type PayoutMenuScript,
  type Santim,
} from '@vamos/core';
import { recordSession, type RecordAnswer } from '../record';
import { runTransfer, type TranscriptEntry } from '../runner';
import { saveRecording, saveScript } from '../script-file';
import type { UssdSession } from '../ussd/session';

/**
 * The owner's commands, written against an `io` (the terminal, or a test)
 * and a USSD session (a real modem, or the simulated one): `record` makes a
 * script from one real transfer, `rehearse` walks the menu for a payout up to
 * the step that sends and hangs up there. Neither prints or stores the PIN.
 */

export interface CliIo {
  print(line: string): void;
  ask(question: string): Promise<string>;
  /** Input that is not shown on the screen: the PIN. */
  askHidden(question: string): Promise<string>;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseReceiver(input: string): Parsed<string> {
  const number = normalizeEthiopianMsisdn(input);
  return number === null
    ? { ok: false, problem: `"${input}" is not an Ethiopian mobile number (09…, 07…, +2519…)` }
    : { ok: true, value: number };
}

export function parseAmount(input: string): Parsed<Santim> {
  try {
    const amount = parseBirr(input);
    return amount > 0n
      ? { ok: true, value: amount }
      : { ok: false, problem: 'the amount must be more than 0' };
  } catch {
    return { ok: false, problem: `"${input}" is not an amount in birr (for example 15 or 15.50)` };
  }
}

const indent = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `  | ${line}`)
    .join('\n');

/** What the owner answers to one screen while recording. */
export function parseRecordAnswer(input: string): RecordAnswer | 'pin' | null {
  const text = input.trim();
  if (/^[nN]$/.test(text)) return { kind: 'number' };
  if (/^[aA]$/.test(text)) return { kind: 'amount' };
  if (/^[pP]$/.test(text)) return 'pin';
  if (/^[qQ]$/.test(text)) return { kind: 'abort' };
  if (/^[0-9*#]{1,20}$/.test(text)) return { kind: 'keys', text };
  return null;
}

export interface RecordOptions {
  institution: string;
  dial: string;
  numberFormat: 'local' | 'international';
  amountFormat: 'whole_birr' | 'birr_and_santim';
  to: string;
  amount: string;
  /** The receiver's name as the menu shows it; empty when it shows none. */
  name: string;
  scriptPath: string;
  recordingPath: string;
}

export async function recordCommand(
  io: CliIo,
  session: UssdSession,
  options: RecordOptions,
): Promise<number> {
  const to = parseReceiver(options.to);
  const amount = parseAmount(options.amount);
  if (!to.ok || !amount.ok) {
    io.print(
      `Not started: ${to.ok ? '' : to.problem}${!to.ok && !amount.ok ? '; ' : ''}${amount.ok ? '' : amount.problem}.`,
    );
    return 2;
  }
  if (amount.value < MIN_RECORDING_AMOUNT) {
    io.print(
      `Not started: record with at least ${santimToBirrString(MIN_RECORDING_AMOUNT)} birr (a smaller amount looks like a menu choice).`,
    );
    return 2;
  }
  io.print(
    `This SENDS ${santimToBirrString(amount.value)} birr for real to ${to.value}, from the wallet of the SIM in the modem.`,
  );
  io.print('Answer every screen as you would on the phone. N types the number, A the amount,');
  io.print('P the PIN (asked without showing it), Q gives up.');
  if ((await io.ask('Type SEND to start: ')).trim() !== 'SEND') {
    io.print('Not started.');
    return 1;
  }

  const result = await recordSession({
    session,
    institution: options.institution,
    dial: options.dial,
    numberFormat: options.numberFormat,
    amountFormat: options.amountFormat,
    number: to.value,
    amount: amount.value,
    shownName: options.name.trim() === '' ? null : options.name.trim(),
    ask: async (screen, index) => {
      io.print(`\nScreen ${index + 1}:\n${indent(screen.text)}`);
      for (;;) {
        const answer = parseRecordAnswer(await io.ask('Your answer: '));
        if (answer === 'pin')
          return { kind: 'pin', pin: (await io.askHidden('PIN (not shown): ')).trim() };
        if (answer !== null) return answer;
        io.print('Type the keys you would press (digits, * or #), or N, A, P or Q.');
      }
    },
  });
  if (!result.ok) {
    io.print(`\nNothing recorded: ${result.reason}.`);
    return 1;
  }
  io.print(`\nResult screen:\n${indent(result.recording.result)}`);
  await saveRecording(options.recordingPath, result.recording);

  const derived = deriveMenuScript(result.recording);
  if (!derived.ok) {
    io.print('\nNo script could be made from this recording:');
    for (const problem of derived.problems) io.print(`- ${problem}`);
    io.print(
      `The recording is kept in ${options.recordingPath} (private: it holds the receiver's number).`,
    );
    return 1;
  }
  await saveScript(options.scriptPath, derived.script);
  io.print(`\nScript saved to ${options.scriptPath}. Things it does not check yet:`);
  for (const note of derived.notes) io.print(`- ${note}`);
  return 0;
}

export interface RehearseOptions {
  to: string;
  amount: string;
  name: string;
}

/** Whether the script asks for the PIN before the step that sends (then a rehearsal must type it). */
export function pinBeforeCommit(script: PayoutMenuScript): boolean {
  const pinAt = script.steps.findIndex((step) => 'pin' in step.reply);
  return pinAt >= 0 && pinAt < script.steps.length - 1;
}

function transcriptLines(transcript: readonly TranscriptEntry[]): string[] {
  return transcript.map((entry) =>
    entry.kind === 'typed'
      ? `  > ${entry.text}${entry.commit ? '   (the step that sends)' : ''}`
      : indent(entry.text),
  );
}

export async function rehearseCommand(
  io: CliIo,
  session: UssdSession,
  script: PayoutMenuScript,
  options: RehearseOptions,
): Promise<number> {
  const to = parseReceiver(options.to);
  const amount = parseAmount(options.amount);
  if (!to.ok || !amount.ok) {
    io.print(
      `Not started: ${to.ok ? '' : to.problem}${!to.ok && !amount.ok ? '; ' : ''}${amount.ok ? '' : amount.problem}.`,
    );
    return 2;
  }
  // A menu that asks for the PIN before the step that sends needs it in a rehearsal too.
  let pin: string | null = null;
  if (pinBeforeCommit(script)) {
    io.print(
      'This menu asks for the PIN before the step that sends; nothing is sent in a rehearsal.',
    );
    pin = (await io.askHidden('PIN (not shown): ')).trim();
  }
  const result = await runTransfer({
    session,
    script,
    transfer: {
      number: to.value,
      amount: amount.value,
      name: options.name.trim() === '' ? null : options.name.trim(),
    },
    mode: 'rehearse',
    pin: { get: () => pin },
  });
  pin = null;
  for (const line of transcriptLines(result.transcript)) io.print(line);
  if (result.outcome === 'rehearsed') {
    io.print(
      '\nRehearsed: the menu matched the script up to the step that sends, which was not typed.',
    );
    return 0;
  }
  io.print(
    `\nThe rehearsal stopped: ${result.reason ?? result.outcome}.${result.outcome === 'unknown' ? ' Check the wallet: something may have been sent.' : ' Nothing was sent.'}`,
  );
  return 1;
}
