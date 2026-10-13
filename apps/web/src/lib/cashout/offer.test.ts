import type { BetView, CashOutOfferView } from '@vamos/contracts';
import { lookup, MESSAGES } from '@vamos/i18n';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/lib/api/errors';
import {
  cashOutState,
  classifyCashOutError,
  compareAmounts,
  isWorse,
  mergeOffers,
  offerHasTax,
  openBetEventIds,
  openBetIds,
  sameOffer,
  UNAVAILABLE_REASON_KEY,
} from './offer';

function offer(over: Partial<CashOutOfferView> = {}): CashOutOfferView {
  return {
    betId: 'b1',
    available: true,
    reason: null,
    gross: '5000',
    tax: '0',
    net: '5000',
    potentialReturn: '20000',
    quotedAt: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

function bet(
  over: Partial<BetView> = {},
): Pick<BetView, 'id' | 'status' | 'cashOutOffer' | 'legs'> {
  return { id: 'b1', status: 'open', cashOutOffer: offer(), legs: [], ...over };
}

describe('cashOutState', () => {
  it('shows the offer of an open bet', () => {
    expect(cashOutState(bet())).toEqual({ kind: 'offer', offer: offer() });
  });
  it('shows nothing for bets that are not open or have no offer', () => {
    expect(cashOutState(bet({ status: 'pending_acceptance' })).kind).toBe('none');
    expect(cashOutState(bet({ status: 'cashed_out' })).kind).toBe('none');
    expect(cashOutState(bet({ cashOutOffer: null })).kind).toBe('none');
  });
  it('explains an unavailable offer, except when cash-out is off', () => {
    const unavailable = offer({ available: false, reason: 'leg_suspended', gross: '0', net: '0' });
    expect(cashOutState(bet({ cashOutOffer: unavailable }))).toEqual({
      kind: 'unavailable',
      reason: 'leg_suspended',
    });
    expect(
      cashOutState(bet({ cashOutOffer: offer({ available: false, reason: 'disabled' }) })).kind,
    ).toBe('none');
  });
});

describe('amounts', () => {
  it('compares santim strings by value', () => {
    expect(compareAmounts('99', '100')).toBe(-1);
    expect(compareAmounts('100', '99')).toBe(1);
    expect(compareAmounts('0100', '100')).toBe(0);
    expect(compareAmounts('9007199254740993', '9007199254740992')).toBe(1);
  });
  it('flags a lower net, or a lower gross at equal net, as worse', () => {
    expect(isWorse({ gross: '5000', net: '4900' }, { gross: '4900', net: '4950' })).toBe(true);
    expect(isWorse({ gross: '5100', net: '5000' }, { gross: '5000', net: '5000' })).toBe(false);
    expect(isWorse({ gross: '4900', net: '5000' }, { gross: '5000', net: '5000' })).toBe(true);
  });
  it('detects tax and equal offers', () => {
    expect(offerHasTax(offer())).toBe(false);
    expect(offerHasTax(offer({ tax: '120' }))).toBe(true);
    expect(sameOffer(offer(), offer({ quotedAt: 'later' }))).toBe(true);
    expect(sameOffer(offer(), offer({ net: '4999' }))).toBe(false);
  });
});

describe('classifyCashOutError', () => {
  it('reads a changed offer', () => {
    const fresh = offer({ gross: '4000', net: '4000' });
    const error = new ApiClientError(409, 'cashout_offer_changed', 'changed', {
      details: { offer: fresh },
    });
    expect(classifyCashOutError(error)).toEqual({ kind: 'changed', offer: fresh });
  });
  it('reads an unavailable reason and falls back for an unknown one', () => {
    const known = new ApiClientError(409, 'cashout_unavailable', 'x', {
      details: { reason: 'leg_lost' },
    });
    expect(classifyCashOutError(known)).toEqual({ kind: 'unavailable', reason: 'leg_lost' });
    const unknown = new ApiClientError(409, 'cashout_unavailable', 'x', {
      details: { reason: 'new_reason' },
    });
    expect(classifyCashOutError(unknown)).toEqual({ kind: 'unavailable', reason: 'bet_not_open' });
  });
  it('treats malformed or other errors as plain errors', () => {
    const bad = new ApiClientError(409, 'cashout_offer_changed', 'x', { details: { offer: 1 } });
    expect(classifyCashOutError(bad).kind).toBe('error');
    expect(classifyCashOutError(new ApiClientError(0, 'network_error', 'x')).kind).toBe('error');
    expect(classifyCashOutError(new Error('x')).kind).toBe('error');
  });
});

describe('lists', () => {
  const leg = (eventId: string, state: 'open' | 'won') =>
    ({ eventId, state }) as BetView['legs'][number];

  it('picks open bets and the events of their undecided legs', () => {
    const bets = [
      bet({ id: 'a', legs: [leg('e1', 'open'), leg('e2', 'won')] }),
      bet({ id: 'b', legs: [leg('e1', 'open'), leg('e3', 'open')] }),
      bet({ id: 'c', status: 'pending_acceptance', legs: [leg('e9', 'open')] }),
    ];
    expect(openBetIds(bets)).toEqual(['a', 'b']);
    expect(openBetEventIds(bets)).toEqual(['e1', 'e3']);
    expect(openBetEventIds(bets, 1)).toEqual(['e1']);
  });

  it('limits ids to the endpoint maximum', () => {
    const many = Array.from({ length: 80 }, (_, i) => bet({ id: `b${i}` }));
    expect(openBetIds(many)).toHaveLength(50);
  });

  it('merges fresh offers into open bets only, keeping the array when nothing changed', () => {
    const bets = [bet({ id: 'a' }), bet({ id: 'b', status: 'cashed_out', cashOutOffer: null })];
    const same = mergeOffers(bets, [
      offer({ betId: 'a', quotedAt: 'later' }),
      offer({ betId: 'b' }),
    ]);
    expect(same).toBe(bets);
    const fresh = offer({ betId: 'a', gross: '6000', net: '6000' });
    const merged = mergeOffers(bets, [fresh, offer({ betId: 'b' })]);
    expect(merged[0]!.cashOutOffer).toEqual(fresh);
    expect(merged[1]).toBe(bets[1]);
    expect(mergeOffers(bets, [])).toBe(bets);
  });
});

describe('messages', () => {
  it('has a text in English and Amharic for every unavailable reason', () => {
    for (const key of Object.values(UNAVAILABLE_REASON_KEY)) {
      expect(lookup(MESSAGES.en, key), key).toBeTypeOf('string');
      expect(lookup(MESSAGES.am, key), key).toBeTypeOf('string');
    }
  });
});
