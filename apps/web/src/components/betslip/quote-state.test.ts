import type { QuoteResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/api/errors';
import type { SlipLeg } from '@/lib/betslip/state';
import { quoteRetryDelayMs, quoteSummaryKey, visibleQuote, type QuoteResult } from './quote-state';

const leg = (id: string, oddsMilli = 1850): SlipLeg => ({
  selectionId: id,
  eventId: `ev-${id}`,
  oddsMilli,
  previousOddsMilli: null,
  gameId: '1234',
  sport: 'football',
  home: { en: 'Home' },
  away: { en: 'Away' },
  marketName: { en: 'Match Result' },
  selectionName: { en: 'Home' },
  startTime: '2026-10-10T15:00:00.000Z',
  live: false,
});

const quote = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  betType: 'multi',
  legs: [],
  stake: '1000',
  totalOddsMilli: '3422',
  grossReturn: '3422',
  bonusPercentBps: 0,
  bonusAmount: '0',
  grossPayout: '3422',
  cappedByMaxPayout: false,
  taxAmount: '0',
  netPayout: '3422',
  errors: [],
  ...over,
});

describe('which quote the drawer shows', () => {
  it('keys a quote on the selections and stake, not on the odds', () => {
    expect(quoteSummaryKey([leg('a'), leg('b')], '1000')).toBe(
      quoteSummaryKey([leg('a', 1900), leg('b', 1700)], '1000'),
    );
    expect(quoteSummaryKey([leg('a'), leg('b')], '1000')).not.toBe(
      quoteSummaryKey([leg('a'), leg('b'), leg('c')], '1000'),
    );
    expect(quoteSummaryKey([leg('a')], '1000')).not.toBe(quoteSummaryKey([leg('a')], '50000'));
    expect(quoteSummaryKey([], '1000')).toBeNull();
    expect(quoteSummaryKey([leg('a')], null)).toBeNull();
  });

  it('shows the quote, its errors and unavailable legs for the slip it was made for', () => {
    const key = quoteSummaryKey([leg('a'), leg('b')], '1000')!;
    const q = quote({
      errors: [{ code: 'stake_below_minimum', message: 'min' }],
      legs: [
        {
          selectionId: 'b',
          eventId: null,
          gameId: null,
          eventName: null,
          marketName: null,
          selectionName: null,
          oddsMilli: null,
          requestedOddsMilli: null,
          oddsChanged: false,
          available: false,
          reason: 'suspended',
          live: false,
        },
      ],
    });
    const shown = visibleQuote({ summaryKey: key, quote: q }, key);
    expect(shown.quote).toBe(q);
    expect([...shown.unavailable]).toEqual([['b', 'suspended']]);
    expect(shown.error).toBeNull();
  });

  it('hides the old totals, errors and unavailable legs once a leg or the stake changes', () => {
    const before = quoteSummaryKey([leg('a'), leg('b'), leg('c')], '1000')!;
    const result: QuoteResult = {
      summaryKey: before,
      quote: quote({ errors: [{ code: 'stake_below_minimum', message: 'min' }] }),
    };
    const afterNewLeg = quoteSummaryKey([leg('a'), leg('b'), leg('c'), leg('d')], '1000');
    expect(visibleQuote(result, afterNewLeg)).toEqual({
      quote: null,
      unavailable: new Map(),
      error: null,
    });
    const afterStake = quoteSummaryKey([leg('a'), leg('b'), leg('c')], '50000');
    expect(visibleQuote(result, afterStake).quote).toBeNull();
  });

  it('a failed quote after a slip change keeps nothing of the previous quote', () => {
    const key = quoteSummaryKey([leg('a'), leg('b'), leg('c'), leg('d')], '1000')!;
    const error = new ApiClientError(429, 'rate_limited', 'slow down', {
      details: { retryAfterSeconds: 12 },
    });
    const shown = visibleQuote({ summaryKey: key, error }, key);
    expect(shown.quote).toBeNull();
    expect(shown.unavailable.size).toBe(0);
    expect(shown.error).toBe(error);
  });

  it('waits for Retry-After after a 429, capped, and does not auto-retry other failures', () => {
    const limited = (details: unknown) =>
      new ApiClientError(429, 'rate_limited', 'slow down', { details });
    expect(quoteRetryDelayMs(limited({ retryAfterSeconds: 12 }))).toBe(12_000);
    expect(quoteRetryDelayMs(limited({ retryAfterSeconds: 600 }))).toBe(60_000);
    expect(quoteRetryDelayMs(limited(undefined))).toBe(5_000);
    expect(quoteRetryDelayMs(new ApiClientError(0, 'network_error', 'offline'))).toBeNull();
    expect(quoteRetryDelayMs(new ApiClientError(503, 'http_503', 'down'))).toBeNull();
  });
});
