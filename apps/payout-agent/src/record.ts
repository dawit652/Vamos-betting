import type { MenuRecording, PayoutMenuReply, Santim } from '@vamos/core';
import { normalizeEthiopianMsisdn } from '@vamos/core';
import type { UssdScreen, UssdSession } from './ussd/session';

/**
 * Recording one real transfer so a script can be made from it (core's
 * `deriveMenuScript`; design: docs/plans/payout-sender-design.md, section
 * 6). A person answers each screen as they would on the phone. This file
 * types their answers, keeps what the menu showed, and never keeps the PIN:
 * it goes from the hidden prompt to the modem and is recorded as "the PIN
 * was typed here".
 *
 * A recording sends real money: the one transfer being recorded.
 */

/** What the person answered to one screen. */
export type RecordAnswer =
  /** A menu choice, typed as it is. */
  | { kind: 'keys'; text: string }
  /** "Now the number" / "now the amount": typed for them in the menu's format. */
  | { kind: 'number' }
  | { kind: 'amount' }
  /** The PIN, from a prompt that does not show it. */
  | { kind: 'pin'; pin: string }
  /** Give up: the session is cancelled and nothing is recorded. */
  | { kind: 'abort' };

export type RecordResult = { ok: true; recording: MenuRecording } | { ok: false; reason: string };

const KEYS = /^[0-9*#]{1,20}$/;
const PIN = /^\d{4,8}$/;
const MAX_EXCHANGES = 12;

export async function recordSession(input: {
  session: UssdSession;
  institution: string;
  dial: string;
  numberFormat: 'local' | 'international';
  amountFormat: 'whole_birr' | 'birr_and_santim';
  /** The transfer to make: E.164 and santim. */
  number: string;
  amount: Santim;
  /** The holder's name exactly as the menu shows it; null when it shows none. */
  shownName: string | null;
  /** Asks the person what to answer to this screen. */
  ask: (screen: UssdScreen, index: number) => Promise<RecordAnswer>;
}): Promise<RecordResult> {
  const { session, number, amount } = input;
  if (normalizeEthiopianMsisdn(number) !== number) {
    return { ok: false, reason: 'the number must be an Ethiopian mobile number in E.164' };
  }
  if (input.amountFormat === 'whole_birr' && amount % 100n !== 0n) {
    return {
      ok: false,
      reason: 'this menu takes whole birr: record with an amount without santim',
    };
  }
  const subscriber = number.slice(-9);
  const typedNumber = input.numberFormat === 'local' ? `0${subscriber}` : `251${subscriber}`;
  const typedAmount =
    input.amountFormat === 'whole_birr'
      ? (amount / 100n).toString()
      : `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;

  const exchanges: { screen: string; typed: PayoutMenuReply }[] = [];
  try {
    let screen = await session.dial(input.dial);
    // A screen that closes the session is the menu's last word: the result.
    while (screen.open) {
      if (exchanges.length >= MAX_EXCHANGES)
        return { ok: false, reason: 'the menu has too many steps' };
      const answer = await input.ask(screen, exchanges.length);
      if (answer.kind === 'abort') return { ok: false, reason: 'given up' };
      let typed: PayoutMenuReply;
      let next: UssdScreen;
      if (answer.kind === 'pin') {
        if (!PIN.test(answer.pin)) return { ok: false, reason: 'a PIN is 4 to 8 digits' };
        typed = { pin: true };
        next = await session.reply(answer.pin, { sensitive: true });
      } else if (answer.kind === 'keys') {
        if (!KEYS.test(answer.text))
          return { ok: false, reason: 'an answer is 1 to 20 of 0-9 * #' };
        typed = { keys: answer.text };
        next = await session.reply(answer.text);
      } else {
        typed = { value: answer.kind };
        next = await session.reply(answer.kind === 'number' ? typedNumber : typedAmount);
      }
      exchanges.push({ screen: screen.text, typed });
      screen = next;
    }
    return {
      ok: true,
      recording: {
        institution: input.institution,
        dial: input.dial,
        numberFormat: input.numberFormat,
        amountFormat: input.amountFormat,
        exchanges,
        result: screen.text,
        number,
        amount,
        shownName: input.shownName,
      },
    };
  } catch {
    // The message of a modem error is not passed on: it is ours to keep free of what was typed.
    return { ok: false, reason: 'the session broke; if the PIN had been typed, check the wallet' };
  } finally {
    await session.cancel();
  }
}
