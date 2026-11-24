import { code128Bars } from '@vamos/core';

/** Pure helpers of the sell page and the printed ticket (the pages themselves are covered by e2e). */

export interface PickInput {
  gameId: number;
  pick: string;
}

export interface ParsedPicks {
  picks: PickInput[];
  /** Words that did not read as "Game ID pick", for a message next to the text box. */
  invalid: string[];
}

/**
 * The text box: lines such as `81492 1`, `69404 X`, `5512 OV25`. Words are paired up in reading
 * order (a Game ID, then its pick), so several pairs on one line work too. A pick is upper-cased.
 */
export function parsePickText(text: string): ParsedPicks {
  const picks: PickInput[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 2) {
      const id = words[i] ?? '';
      const pick = words[i + 1];
      const gameId = /^\d{1,15}$/.test(id) ? Number(id) : 0;
      if (gameId <= 0 || pick === undefined || !/^[A-Za-z0-9]{1,8}$/.test(pick)) {
        invalid.push(pick === undefined ? id : `${id} ${pick}`);
      } else {
        picks.push({ gameId, pick: pick.toUpperCase() });
      }
    }
  }
  return { picks, invalid };
}

/** Odds in milli as shown on a ticket: 1850 → "1.85" (the third decimal is dropped, never rounded up). */
export function formatOddsMilli(milli: number | string | null | undefined): string {
  if (milli === null || milli === undefined) return '–';
  let value: bigint;
  try {
    value = BigInt(milli);
  } catch {
    return '–';
  }
  const whole = value / 1000n;
  const cents = (value % 1000n) / 10n;
  return `${whole}.${String(cents).padStart(2, '0')}`;
}

/** The idempotency key of one ticket: made once and kept until the sale succeeded. */
export function newTicketKey(random: () => string = () => crypto.randomUUID()): string {
  return `ticket-${random()}`;
}

/**
 * The payout code of a ticket just sold travels from the sale to its print in this tab only, and
 * the ticket page takes it out at once: it is printed on the original, never kept, and a later
 * visit or reprint cannot show it (docs/plans/counter-codes-and-deposit-recovery.md, G3). It is
 * held in memory (the app's own navigation) and in sessionStorage (a full page load, when the
 * app's navigation is slow), and taking it clears both.
 */
const PAYOUT_CODE_KEY = (id: string) => `vamos:payout-code:${id}`;
const handedOver = new Map<string, string>();

export function handOverPayoutCode(id: string, code: string | null): void {
  if (code === null) return;
  handedOver.set(id, code);
  try {
    sessionStorage.setItem(PAYOUT_CODE_KEY(id), code);
  } catch {
    // Storage blocked: the code still reaches the ticket page through memory.
  }
}

export function takePayoutCode(id: string): string | null {
  const held = handedOver.get(id) ?? null;
  handedOver.delete(id);
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(PAYOUT_CODE_KEY(id));
    sessionStorage.removeItem(PAYOUT_CODE_KEY(id));
  } catch {
    // Storage blocked: only memory had it.
  }
  return held ?? stored;
}

/** The path of the ticket page; `print` records and prints the original when it opens. */
export function ticketPath(id: string, print = false): string {
  return print ? `/ticket/${id}?print=1` : `/ticket/${id}`;
}

/** What a check answers that decides a sale (ShopTicketCheckResponse, its shape only). */
export interface CheckedTicket {
  errors: readonly unknown[];
  legs: readonly { available: boolean; oddsChanged: boolean }[];
}

/** A checked ticket sells as it is: no error, every match available, no price changed. */
export function ticketSellable(check: CheckedTicket): boolean {
  return (
    check.legs.length > 0 &&
    check.errors.length === 0 &&
    check.legs.every((leg) => leg.available && !leg.oddsChanged)
  );
}

/** Why a pick could not be taken, in words for the counter. */
const REFUSALS: Readonly<Record<string, string>> = {
  game_not_found: 'No match with this Game ID.',
  pick_not_offered: 'This match does not offer that pick.',
  pick_unavailable: 'That pick is closed or suspended right now.',
  event_started: 'The match has started.',
};

export function refusalText(code: string): string {
  return REFUSALS[code] ?? code.replace(/_/g, ' ');
}

/** Why a match on the slip cannot be sold (a quote leg's reason). */
const LEG_REASONS: Readonly<Record<string, string>> = {
  event_started: 'Started or live: remove it',
  suspended: 'Suspended: remove it or wait',
  not_found: 'Not found: remove it',
  inactive: 'Switched off: remove it',
  event_closed: 'Closed: remove it',
  market_closed: 'Market closed: remove it',
};

export function legReasonText(reason: string | null): string {
  if (reason === null) return '';
  return LEG_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export interface BarcodeRect {
  x: number;
  width: number;
}

export interface BarcodeLayout {
  /** The whole drawing in px, quiet zones included. */
  width: number;
  rects: BarcodeRect[];
}

/** Modules of white either side: Code 128 asks for at least 10. */
export const BARCODE_QUIET_MODULES = 10;

/**
 * Where each bar of Code 128 goes: one rect per bar at `start × moduleWidth` after the quiet
 * zone. Widths stay whole pixels so the bars print crisp on a thermal head.
 */
export function barcodeLayout(text: string, moduleWidth = 2): BarcodeLayout {
  const bars = code128Bars(text);
  const quiet = BARCODE_QUIET_MODULES * moduleWidth;
  const last = bars[bars.length - 1];
  const modules = last === undefined ? 0 : last[0] + last[1];
  return {
    width: modules * moduleWidth + 2 * quiet,
    rects: bars.map(([start, width]) => ({
      x: quiet + start * moduleWidth,
      width: width * moduleWidth,
    })),
  };
}
