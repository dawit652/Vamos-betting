import { smsSegments } from '@vamos/core';

/** Pure helpers of the demo-only SMS / USSD simulator (/dev/channels). */

/** The id alphabet the dev routes accept: 8–64 of A-Z a-z 0-9 _ -. */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isDevId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** A fresh message / session id. `random` returns [0, 1) (Math.random in the browser). */
export function newDevId(prefix: 'sms' | 'ussd', random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 12; i += 1) {
    suffix += alphabet[Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length))];
  }
  return `${prefix}-${suffix}`;
}

// ---------------------------------------------------------------------- SMS

/** Longest text the dev route takes (DevSmsSendRequest). */
export const SMS_MAX_CHARS = 640;

/** Parts the text needs: GSM-7 160/153, otherwise UCS-2 70/67 (0 for an empty text). */
export function smsParts(text: string): number {
  return smsSegments(text);
}

export interface ThreadEntry {
  /** 'out' is typed by the player, 'in' is a reply from the platform. */
  direction: 'out' | 'in';
  body: string;
  /** ISO time. */
  at: string;
}

export interface InboxMessage {
  body: string;
  createdAt: string;
}

/**
 * One conversation, oldest first: the texts sent in this page session plus the
 * replies in the dev SMS inbox. Replies from before the page opened (`since`)
 * and exact duplicates of what is already shown are left out.
 */
export function mergeThread(
  sent: readonly ThreadEntry[],
  inbox: readonly InboxMessage[],
  since: string,
): ThreadEntry[] {
  const replies: ThreadEntry[] = inbox
    .filter((m) => m.createdAt >= since)
    .map((m) => ({ direction: 'in', body: m.body, at: m.createdAt }));
  const all = [...sent.filter((e) => e.direction === 'out'), ...replies];
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.direction === 'out' ? -1 : 1));
  return all;
}

// --------------------------------------------------------------------- USSD

export interface UssdScreen {
  /** 'CON' keeps the session open (input expected); 'END' closes it. */
  kind: 'CON' | 'END';
  body: string;
}

/** Reads a `CON …` / `END …` answer; anything else is not a USSD answer. */
export function parseUssdResponse(response: string): UssdScreen | null {
  const match = /^(CON|END) ([\s\S]*)$/.exec(response);
  if (!match) return null;
  return { kind: match[1] === 'CON' ? 'CON' : 'END', body: match[2] ?? '' };
}

/** What a phone's keypad can send in a reply: digits and letters; `*` and `#` are not allowed. */
export function cleanUssdInput(raw: string): string {
  return raw.replace(/[*#\s]/g, '').slice(0, 64);
}

/** The aggregator's `text`: everything typed in the session, '*'-joined ('' when dialling). */
export function appendUssdInput(history: string, input: string): string {
  const clean = cleanUssdInput(input);
  if (clean === '') return history;
  return history === '' ? clean : `${history}*${clean}`;
}

/** Whether `dial` is the service code (`*123#`), as typed on a keypad. */
export function isServiceCodeDial(dial: string, serviceCode: string): boolean {
  return dial.replace(/\s/g, '') === serviceCode;
}

export const DEFAULT_USSD_SERVICE_CODE = '*123#';
