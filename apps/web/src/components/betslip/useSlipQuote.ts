'use client';

import type { QuoteResponse, UnavailableReason } from '@vamos/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bettingApi } from '@/lib/api/betting';
import type { SlipLeg } from '@/lib/betslip/state';
import { quoteRetryDelayMs, quoteSummaryKey, visibleQuote, type QuoteResult } from './quote-state';
import { quoteOddsChanges, quoteRequest } from './requests';

/** Typing a stake or tapping odds re-quotes once the player pauses. */
const QUOTE_DEBOUNCE_MS = 350;
/**
 * At most one quote a second: live prices can move the slip several times a
 * second, and the API allows 120 quotes a minute per address.
 */
const QUOTE_MIN_INTERVAL_MS = 1_000;

export interface SlipQuoteState {
  /**
   * The quote for the slip's current selections and stake. Null before it
   * arrives, after it failed, and as soon as a leg or the stake changes: an
   * older quote is never shown for a different slip.
   */
  quote: QuoteResponse | null;
  /** A quote is scheduled or in flight. */
  pending: boolean;
  /** The last quote for the current slip failed (429, network, 5xx); `retry()` asks again. */
  error: unknown;
  /** Legs the API says cannot be bet on now (from the current quote only). */
  unavailable: ReadonlyMap<string, UnavailableReason>;
  retry: () => void;
}

/**
 * Live quote of the slip: POST /betslip/quote, debounced, cancelled when the
 * slip changes again. Price changes it reports are pushed to the slip with
 * `onOddsChanges` (the slip then shows the move and asks to accept it). A 429
 * is retried by itself after the API's Retry-After.
 */
export function useSlipQuote(
  legs: readonly SlipLeg[],
  stake: string | null,
  onOddsChanges: (changes: { selectionId: string; oddsMilli: number }[]) => void,
): SlipQuoteState {
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastSent = useRef(0);
  const request = stake === null ? null : quoteRequest(legs, stake);
  const requestKey = request === null ? null : JSON.stringify(request);
  const summaryKey = quoteSummaryKey(legs, stake);

  useEffect(() => {
    if (requestKey === null || summaryKey === null) {
      setInFlight(null);
      return;
    }
    setInFlight(requestKey);
    const controller = new AbortController();
    const wait = Math.max(QUOTE_DEBOUNCE_MS, lastSent.current + QUOTE_MIN_INTERVAL_MS - Date.now());
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      lastSent.current = Date.now();
      bettingApi
        .quote(JSON.parse(requestKey) as Parameters<typeof bettingApi.quote>[0], controller.signal)
        .then((quote) => {
          if (controller.signal.aborted) return;
          setResult({ summaryKey, quote });
          setInFlight(null);
          const changes = quoteOddsChanges(quote);
          if (changes.length > 0) onOddsChanges(changes);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // Whatever was quoted before no longer stands for this slip.
          setResult({ summaryKey, error });
          setInFlight(null);
          const delay = quoteRetryDelayMs(error);
          if (delay !== null) retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
        });
    }, wait);
    return () => {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      controller.abort();
    };
  }, [requestKey, summaryKey, attempt, onOddsChanges]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const visible = visibleQuote(result, summaryKey);
  return {
    ...visible,
    // A failed quote is not "updating" any more until the player retries.
    pending: inFlight !== null && inFlight === requestKey,
    retry,
  };
}
