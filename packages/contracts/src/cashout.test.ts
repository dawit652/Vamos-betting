import { describe, expect, it } from 'vitest';
import { BetView, CashOutResponse } from './betting';
import {
  CashOutOffersQuery,
  CashOutOfferView,
  CashOutRequest,
  CashOutUnavailableDetails,
  MAX_CASH_OUT_OFFERS,
} from './cashout';

const UUID_A = '7f1d7c2e-6f43-4c41-9d0e-2a1f0f6f0a01';
const UUID_B = '7f1d7c2e-6f43-4c41-9d0e-2a1f0f6f0a02';

const offer = {
  betId: UUID_A,
  available: true,
  reason: null,
  gross: '25000',
  tax: '3000',
  net: '22000',
  potentialReturn: '40000',
  quotedAt: '2026-10-13T10:00:00.000Z',
};

describe('cash-out contracts', () => {
  it('a cash-out request carries the positive gross offer the player accepted', () => {
    expect(CashOutRequest.parse({ gross: '25000' })).toEqual({ gross: '25000' });
    for (const gross of ['0', '000', '-5', '12.5', '', 'abc', '1234567890123456']) {
      expect(CashOutRequest.safeParse({ gross }).success).toBe(false);
    }
    expect(CashOutRequest.safeParse({}).success).toBe(false);
    expect(CashOutRequest.safeParse({ gross: 25000 }).success).toBe(false);
  });

  it('offers parse with or without availability', () => {
    expect(CashOutOfferView.parse(offer)).toEqual(offer);
    const unavailable = {
      ...offer,
      available: false,
      reason: 'leg_suspended',
      gross: '0',
      tax: '0',
      net: '0',
    };
    expect(CashOutOfferView.parse(unavailable)).toEqual(unavailable);
    expect(CashOutOfferView.safeParse({ ...offer, reason: 'nope' }).success).toBe(false);
    expect(CashOutUnavailableDetails.parse({ reason: 'bet_not_open' })).toEqual({
      reason: 'bet_not_open',
    });
  });

  it('the offers query takes comma-separated or repeated ids, deduplicated, 1 to 50', () => {
    expect(CashOutOffersQuery.parse({ betIds: `${UUID_A},${UUID_B}` })).toEqual({
      betIds: [UUID_A, UUID_B],
    });
    expect(CashOutOffersQuery.parse({ betIds: [UUID_A, ` ${UUID_B} `, UUID_A] })).toEqual({
      betIds: [UUID_A, UUID_B],
    });
    expect(CashOutOffersQuery.parse({ betIds: `${UUID_A},,` })).toEqual({ betIds: [UUID_A] });
    expect(CashOutOffersQuery.safeParse({ betIds: '' }).success).toBe(false);
    expect(CashOutOffersQuery.safeParse({ betIds: ' , ' }).success).toBe(false);
    expect(CashOutOffersQuery.safeParse({}).success).toBe(false);
    const ids = Array.from({ length: MAX_CASH_OUT_OFFERS + 1 }, (_, i) => `bet-${i}`);
    expect(CashOutOffersQuery.safeParse({ betIds: ids.join(',') }).success).toBe(false);
    expect(CashOutOffersQuery.safeParse({ betIds: ids.slice(1).join(',') }).success).toBe(true);
    expect(CashOutOffersQuery.safeParse({ betIds: 'x'.repeat(65) }).success).toBe(false);
  });

  it('BetView carries the open offer and the cash-out paid', () => {
    const bet = {
      id: UUID_A,
      shortId: 'ABCD2345',
      betType: 'single',
      status: 'cashed_out',
      channel: 'web',
      oddsChangePolicy: 'none',
      stake: '10000',
      totalOddsMilli: '3000',
      potentialGross: '30000',
      bonusPercentBps: 0,
      potentialBonus: '0',
      potentialTax: '0',
      potentialNet: '30000',
      settledGross: '25000',
      settledTax: '3000',
      settledNet: '22000',
      rejectReason: null,
      placedAt: '2026-10-13T09:00:00.000Z',
      acceptAfter: null,
      acceptedAt: '2026-10-13T09:00:00.000Z',
      settledAt: '2026-10-13T10:00:00.000Z',
      cashOutOffer: null,
      cashedOut: {
        gross: '25000',
        tax: '3000',
        net: '22000',
        cashedOutAt: '2026-10-13T10:00:00.000Z',
      },
      legs: [],
    };
    expect(BetView.parse(bet)).toEqual(bet);
    expect(BetView.parse({ ...bet, status: 'open', cashOutOffer: offer, cashedOut: null })).toEqual(
      { ...bet, status: 'open', cashOutOffer: offer, cashedOut: null },
    );
    // Both fields are part of the contract (null when they do not apply).
    const { cashOutOffer: _offer, ...withoutOffer } = bet;
    expect(BetView.safeParse(withoutOffer).success).toBe(false);
    expect(CashOutResponse.parse({ bet, cashOut: bet.cashedOut }).cashOut.net).toBe('22000');
  });
});
