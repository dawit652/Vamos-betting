import { type Santim, applyBps, maxSantim, minSantim } from './money';
import type { TaxConfig } from './rules';

/**
 * Winnings tax withheld from a winning bet's payout. The tax is rounded down
 * and never exceeds the winnings, so a winning bet always pays back at least
 * its stake — even when the configured base is the whole gross payout.
 */

export interface WinningsTax {
  /** Amount the rate was applied to (net winnings or gross payout, per config). */
  base: Santim;
  /** Tax withheld, in santim. */
  amount: Santim;
}

const MAX_RATE_BPS = 10_000;

export function computeWinningsTax(args: {
  stake: Santim;
  grossPayout: Santim;
  config: TaxConfig;
}): WinningsTax {
  const { stake, grossPayout, config } = args;
  const { rateBps } = config;
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > MAX_RATE_BPS) {
    throw new RangeError(`tax rateBps must be an integer between 0 and 10000 (got ${rateBps})`);
  }

  const winnings = maxSantim(0n, grossPayout - stake);
  const base = taxableBase(config, winnings, grossPayout);
  if (winnings === 0n || base < config.exemptBelow) return { base, amount: 0n };

  return { base, amount: minSantim(applyBps(base, rateBps), winnings) };
}

function taxableBase(config: TaxConfig, winnings: Santim, grossPayout: Santim): Santim {
  switch (config.base) {
    case 'net_winnings':
      return winnings;
    case 'gross_payout':
      return grossPayout;
    default: {
      const unknown: never = config.base;
      throw new RangeError(`unknown tax base: ${String(unknown)}`);
    }
  }
}
