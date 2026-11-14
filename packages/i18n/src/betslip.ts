import type { Locale } from './locales';
import type { Messages } from './messages/en';

/*
 * The betslip drawer's text (`sportsbook.betslip.*`) is about 40% of the
 * `sportsbook` namespace, but only a player who opens the slip needs it. So the
 * root layout sends every page the betslip keys that other screens share (the
 * slip bar's total odds and the error texts reused by the jackpot and the API
 * error mapper), and the drawer loads the rest for the current locale in a
 * chunk of its own, next to the drawer's code (`loadBetslipMessages`).
 *
 * Safe for client components: the loader imports one locale's messages lazily.
 */

export type BetslipMessages = Messages['sportsbook']['betslip'];

/** `sportsbook.betslip` keys sent with every page; the drawer loads the others. */
export const SHARED_BETSLIP_KEYS = ['errors', 'insufficientFunds', 'totalOdds'] as const;

type SharedBetslipKey = (typeof SHARED_BETSLIP_KEYS)[number];
export type SharedBetslipMessages = Pick<BetslipMessages, SharedBetslipKey>;

/**
 * `sportsbook` sections that only server components render (the list controls
 * and the search page): they are never sent to the browser as messages.
 */
export const SERVER_ONLY_SPORTSBOOK = ['controls', 'search'] as const;

type ServerOnlySection = (typeof SERVER_ONLY_SPORTSBOOK)[number];

/**
 * The part of the `sportsbook` namespace every page sends to the browser:
 * without the drawer-only betslip text and without the server-only sections.
 */
export function withoutDrawerText(sportsbook: Messages['sportsbook']): Omit<
  Messages['sportsbook'],
  'betslip' | ServerOnlySection
> & {
  betslip: SharedBetslipMessages;
} {
  const betslip = {} as Record<SharedBetslipKey, unknown>;
  for (const key of SHARED_BETSLIP_KEYS) betslip[key] = sportsbook.betslip[key];
  const page: Partial<Messages['sportsbook']> = { ...sportsbook };
  for (const section of SERVER_ONLY_SPORTSBOOK) delete page[section];
  return { ...(page as Messages['sportsbook']), betslip: betslip as SharedBetslipMessages };
}

/** Every `sportsbook.betslip` message of one locale, from a lazily loaded chunk. */
export async function loadBetslipMessages(locale: Locale): Promise<BetslipMessages> {
  switch (locale) {
    case 'am':
      return (await import('./messages/am/sportsbook')).sportsbook.betslip;
    case 'om':
      return (await import('./messages/om')).om.sportsbook.betslip;
    case 'ti':
      return (await import('./messages/ti')).ti.sportsbook.betslip;
    case 'en':
      return (await import('./messages/en/sportsbook')).sportsbook.betslip;
  }
}
