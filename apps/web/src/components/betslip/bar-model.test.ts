import type { QuoteResponse } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { BAR_PLACEHOLDER, miniBarView } from './bar-model';

const quote = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  betType: 'multi',
  legs: [],
  stake: '10000',
  totalOddsMilli: '3515',
  grossReturn: '35150',
  bonusPercentBps: 0,
  bonusAmount: '0',
  grossPayout: '35150',
  cappedByMaxPayout: false,
  taxAmount: '2500',
  netPayout: '32650',
  errors: [],
  ...over,
});

const base = { hydrated: true, count: 2, isOpen: false, quote: quote() };

describe('miniBarView', () => {
  it('is hidden before hydration, when empty and when the drawer is open', () => {
    expect(miniBarView({ ...base, hydrated: false })).toBeNull();
    expect(miniBarView({ ...base, count: 0 })).toBeNull();
    expect(miniBarView({ ...base, isOpen: true })).toBeNull();
  });

  it('formats odds and net pay from the quote strings', () => {
    expect(miniBarView(base)).toEqual({
      count: 2,
      totalOdds: '3.51',
      netPay: '326.50',
    });
  });

  it('keeps big totals exact', () => {
    const view = miniBarView({ ...base, quote: quote({ totalOddsMilli: '12345678901234567' }) });
    expect(view?.totalOdds).toBe('12,345,678,901,234.56');
  });

  it('shows placeholders while loading or failed', () => {
    expect(miniBarView({ ...base, quote: null })).toEqual({
      count: 2,
      totalOdds: BAR_PLACEHOLDER,
      netPay: BAR_PLACEHOLDER,
    });
  });

  it('hides net pay when the quote reports slip errors', () => {
    const errors = [{ code: 'selection_unavailable' }] as unknown as QuoteResponse['errors'];
    expect(miniBarView({ ...base, quote: quote({ errors }) })?.netPay).toBe(BAR_PLACEHOLDER);
  });
});
