'use client';

import type { QuoteResponse, UnavailableReason } from '@vamos/contracts';
import { useEffect, useRef, useState } from 'react';
import { bettingApi } from '@/lib/api/betting';
import type { SlipLeg } from '@/lib/betslip/state';
import { quoteOddsChanges, quoteRequest, quoteUnavailable } from './requests';

/** Typing a stake or tapping odds re-quotes once the player pauses. */
const QUOTE_DEBOUNCE_MS = 350;
/**
 * At most one quote a second: live prices can move the slip several times a
 * second, and the API allows 120 quotes a minute per address.
 */
const QUOTE_MIN_INTERVAL_MS = 1_000;

export interface SlipQuoteState {
  /** The latest quote for the current slip (null before the first one or with no stake). */
  quote: QuoteResponse | null;
  /** A quote is scheduled or in flight. */
  pending: boolean;
  /** The last quote request failed (the summary keeps the previous quote). */
  error: unknown;
  /** Legs the API says cannot be bet on now. */
  unavailable: ReadonlyMap<string, UnavailableReason>;
}

/**
 * Live quote of the slip: POST /betslip/quote, debounced, cancelled when the
 * slip changes again. Price changes it reports are pushed to the slip with
 * `onOddsChanges` (the slip then shows the move and asks to accept it).
 */
export function useSlipQuote(
  legs: readonly SlipLeg[],
  stake: string | null,
  onOddsChanges: (changes: { selectionId: string; oddsMilli: number }[]) => void,
): SlipQuoteState {
  const [state, setState] = useState<SlipQuoteState>({
    quote: null,
    pending: false,
    error: null,
    unavailable: new Map(),
  });
  const lastSent = useRef(0);
  const request = stake === null ? null : quoteRequest(legs, stake);
  const requestKey = request === null ? null : JSON.stringify(request);

  useEffect(() => {
    if (requestKey === null) {
      setState((s) => ({ ...s, quote: null, pending: false, error: null }));
      return;
    }
    setState((s) => ({ ...s, pending: true }));
    const controller = new AbortController();
    const wait = Math.max(QUOTE_DEBOUNCE_MS, lastSent.current + QUOTE_MIN_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      lastSent.current = Date.now();
      bettingApi
        .quote(JSON.parse(requestKey) as Parameters<typeof bettingApi.quote>[0], controller.signal)
        .then((quote) => {
          if (controller.signal.aborted) return;
          setState({ quote, pending: false, error: null, unavailable: quoteUnavailable(quote) });
          const changes = quoteOddsChanges(quote);
          if (changes.length > 0) onOddsChanges(changes);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState((s) => ({ ...s, pending: false, error }));
        });
    }, wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, onOddsChanges]);

  return state;
}
