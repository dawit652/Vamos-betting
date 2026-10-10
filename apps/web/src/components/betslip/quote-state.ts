import type { QuoteResponse, UnavailableReason } from '@vamos/contracts';
import { isApiClientError } from '@/lib/api/errors';
import type { SlipLeg } from '@/lib/betslip/state';
import { quoteUnavailable } from './requests';

/**
 * Which quote the drawer may show (pure, unit tested). A quote belongs to the
 * selections and stake it was asked for: once the player adds or removes a leg
 * or changes the stake, an older quote's totals, payout, errors and
 * unavailable legs no longer apply and are hidden. A price moving (live or
 * from a quote) keeps the quote on screen while the next one is fetched: the
 * figures are a close estimate and the API checks the prices when placing.
 */

/** The selections and stake a quote is for (not the odds). Null when there is nothing to quote. */
export function quoteSummaryKey(legs: readonly SlipLeg[], stake: string | null): string | null {
  if (stake === null || legs.length === 0) return null;
  return JSON.stringify([legs.map((leg) => leg.selectionId), stake]);
}

/** The outcome of the last quote request. */
export type QuoteResult =
  | { summaryKey: string; quote: QuoteResponse; error?: undefined }
  | { summaryKey: string; quote?: undefined; error: unknown };

export interface VisibleQuote {
  /** The quote for the slip as it is now; null before it arrives or when it failed. */
  quote: QuoteResponse | null;
  unavailable: ReadonlyMap<string, UnavailableReason>;
  /** The last quote for this slip failed (nothing is shown for it). */
  error: unknown;
}

const NONE: ReadonlyMap<string, UnavailableReason> = new Map();

export function visibleQuote(result: QuoteResult | null, summaryKey: string | null): VisibleQuote {
  if (result === null || summaryKey === null || result.summaryKey !== summaryKey) {
    return { quote: null, unavailable: NONE, error: null };
  }
  if (result.quote === undefined) return { quote: null, unavailable: NONE, error: result.error };
  return { quote: result.quote, unavailable: quoteUnavailable(result.quote), error: null };
}

/** How long to wait before quoting again after a 429 (the API's retryAfterSeconds, capped); null otherwise. */
export function quoteRetryDelayMs(error: unknown): number | null {
  if (!isApiClientError(error) || error.status !== 429) return null;
  const details = error.details as { retryAfterSeconds?: unknown } | null | undefined;
  const seconds = details?.retryAfterSeconds;
  const wait = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
  return Math.min(wait, 60) * 1000;
}
