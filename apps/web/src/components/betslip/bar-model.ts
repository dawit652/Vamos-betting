import type { QuoteResponse } from '@vamos/contracts';
import { formatSantim, formatTotalOdds } from '@/lib/format';

/** Shown in place of a figure while the quote is loading or failed. */
export const BAR_PLACEHOLDER = '–';

export interface MiniBarInput {
  hydrated: boolean;
  count: number;
  isOpen: boolean;
  /** The server quote for the current slip; null while loading or after it failed. */
  quote: QuoteResponse | null;
}

export interface MiniBarView {
  count: number;
  totalOdds: string;
  netPay: string;
}

/** Whether the bar is on screen (and so whether it should be quoting). */
export function miniBarVisible(
  input: Pick<MiniBarInput, 'hydrated' | 'count' | 'isOpen'>,
): boolean {
  return input.hydrated && input.count > 0 && !input.isOpen;
}

/**
 * What the mini slip bar shows (pure). Figures come straight from the server
 * quote (tax and bonus included); nothing is recomputed here. Without a usable
 * quote the pick count stays and the figures are a neutral placeholder.
 */
export function miniBarView(input: MiniBarInput): MiniBarView | null {
  if (!miniBarVisible(input)) return null;
  const { quote } = input;
  if (quote === null) {
    return { count: input.count, totalOdds: BAR_PLACEHOLDER, netPay: BAR_PLACEHOLDER };
  }
  return {
    count: input.count,
    totalOdds: formatTotalOdds(quote.totalOddsMilli),
    netPay: quote.errors.length > 0 ? BAR_PLACEHOLDER : formatSantim(quote.netPayout),
  };
}
