import { randomUUID } from 'node:crypto';
import {
  cashOutOffer,
  computeWinningsTax,
  DEFAULT_BET_RULES,
  DEFAULT_MULTI_BONUS,
  type CashOutConfig,
  type TaxConfig,
} from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isSelectionBettable,
  legStateOf,
  priceCashOut,
  type BetStatus,
  type CashOutPricingInput,
  type SelectionSnapshot,
} from '../src/index';

/**
 * priceCashOut is pure: these properties hold for any bet and catalogue
 * state, without a database.
 */

const NOW = new Date('2026-10-13T12:00:00.000Z');

function snapshot(overrides: Partial<SelectionSnapshot>): SelectionSnapshot {
  return {
    selectionId: randomUUID(),
    code: '1',
    oddsMilli: 2000,
    selectionStatus: 'open',
    result: null,
    marketId: randomUUID(),
    marketType: '1x2',
    marketLine: null,
    marketKey: '1x2',
    marketStatus: 'open',
    eventId: randomUUID(),
    gameId: 1234,
    sportId: 'football',
    competitionId: randomUUID(),
    competitionName: { en: 'League' },
    homeTeam: { en: 'Home' },
    awayTeam: { en: 'Away' },
    startTime: new Date(NOW.getTime() + 3600_000),
    eventStatus: 'scheduled',
    bettingOpen: true,
    scoreHome: null,
    scoreAway: null,
    sportActive: true,
    competitionActive: true,
    ...overrides,
  };
}

const oddsArb = fc.integer({ min: 1001, max: 50_000 });

/** A selection in any catalogue state, consistent the way resulting keeps it. */
const anySelectionArb: fc.Arbitrary<SelectionSnapshot> = fc
  .record({
    oddsMilli: fc.oneof(oddsArb, fc.constantFrom(1000, 0, 1_000_001)),
    marketStatus: fc.constantFrom(
      'open' as const,
      'suspended' as const,
      'closed' as const,
      'settled' as const,
      'void' as const,
    ),
    selectionOpen: fc.boolean(),
    result: fc.constantFrom('won' as const, 'lost' as const, 'void' as const),
    eventStatus: fc.constantFrom(
      'scheduled' as const,
      'live' as const,
      'finished' as const,
      'cancelled' as const,
    ),
    bettingOpen: fc.boolean(),
    started: fc.boolean(),
    sportActive: fc.boolean(),
    competitionActive: fc.boolean(),
  })
  .map((r) => {
    const final = r.marketStatus === 'settled' || r.marketStatus === 'void';
    return snapshot({
      oddsMilli: r.oddsMilli,
      marketStatus: r.marketStatus,
      // A resulted market's selections are settled with a result; others have none.
      selectionStatus: final ? 'settled' : r.selectionOpen ? 'open' : 'suspended',
      result: final ? (r.marketStatus === 'void' ? 'void' : r.result) : null,
      eventStatus: r.eventStatus,
      bettingOpen: r.bettingOpen,
      startTime: new Date(NOW.getTime() + (r.started ? -60_000 : 3600_000)),
      sportActive: r.sportActive,
      competitionActive: r.competitionActive,
    });
  });

/** A selection that can be bet on now (prematch or live), at valid odds. */
const bettableSelectionArb: fc.Arbitrary<SelectionSnapshot> = fc
  .record({ oddsMilli: oddsArb, live: fc.boolean() })
  .map((r) =>
    snapshot({
      oddsMilli: r.oddsMilli,
      eventStatus: r.live ? 'live' : 'scheduled',
      startTime: new Date(NOW.getTime() + (r.live ? -1800_000 : 3600_000)),
    }),
  );

/** Mostly bettable selections, so that offers are made often enough to be checked. */
const selectionArb = fc.oneof(
  { weight: 3, arbitrary: bettableSelectionArb },
  { weight: 1, arbitrary: anySelectionArb },
);

const taxArb: fc.Arbitrary<TaxConfig> = fc.record({
  rateBps: fc.integer({ min: 0, max: 10_000 }),
  base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
  exemptBelow: fc.bigInt({ min: 0n, max: 50_000n }),
});

const configArb: fc.Arbitrary<CashOutConfig> = fc.record({
  enabled: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, fc.constant(false)),
  marginBps: fc.integer({ min: 0, max: 10_000 }),
  minOffer: fc.bigInt({ min: 0n, max: 1_000n }),
});

const statusArb: fc.Arbitrary<BetStatus> = fc.oneof(
  { weight: 6, arbitrary: fc.constant('open' as const) },
  fc.constantFrom<BetStatus>('pending_acceptance', 'won', 'lost', 'void', 'cashed_out', 'rejected'),
);

const betArb: fc.Arbitrary<CashOutPricingInput> = fc
  .record({
    status: statusArb,
    stake: fc.bigInt({ min: 1n, max: 10_000_000n }),
    maxPayout: fc.bigInt({ min: 1n, max: 50_000_000n }),
    tax: taxArb,
    legs: fc.array(fc.tuple(oddsArb, selectionArb), { minLength: 1, maxLength: 6 }),
  })
  .map((r) => ({
    id: randomUUID(),
    userId: randomUUID(),
    status: r.status,
    stake: r.stake,
    terms: {
      betRules: { ...DEFAULT_BET_RULES, maxPayout: r.maxPayout },
      multiBonus: DEFAULT_MULTI_BONUS,
      tax: r.tax,
    },
    legs: r.legs.map(([placed, selection]) => ({
      id: randomUUID(),
      selectionId: selection.selectionId,
      oddsMilli: placed,
      selection,
    })),
  }));

function bettable(selection: SelectionSnapshot): boolean {
  return (
    selection.sportActive &&
    selection.competitionActive &&
    isSelectionBettable(
      {
        status: selection.eventStatus,
        bettingOpen: selection.bettingOpen,
        startTime: selection.startTime,
      },
      selection.marketStatus,
      selection.selectionStatus,
      NOW,
    )
  );
}

describe('priceCashOut – properties', () => {
  it('gross = tax + net, the tax is the settlement tax of the bet terms, and nothing is offered for free', () => {
    let offers = 0;
    fc.assert(
      fc.property(betArb, configArb, (bet, config) => {
        const quote = priceCashOut(bet, config, NOW);
        expect(quote.gross).toBe(quote.tax + quote.net);
        expect(quote.tax >= 0n && quote.net >= 0n).toBe(true);
        expect(quote.available).toBe(quote.reason === null);
        if (!quote.available) {
          expect([quote.gross, quote.tax, quote.net]).toEqual([0n, 0n, 0n]);
          return;
        }
        offers += 1;
        expect(bet.status).toBe('open');
        expect(quote.gross > 0n && quote.gross >= config.minOffer).toBe(true);
        expect(quote.gross <= quote.potentialReturn).toBe(true);
        expect(quote.potentialReturn <= bet.terms.betRules.maxPayout).toBe(true);
        const winnings = quote.gross > bet.stake ? quote.gross - bet.stake : 0n;
        expect(quote.tax <= winnings).toBe(true);
        expect(quote.tax).toBe(
          computeWinningsTax({ stake: bet.stake, grossPayout: quote.gross, config: bet.terms.tax })
            .amount,
        );
      }),
      { numRuns: 1_000 },
    );
    // The generators make offers often enough for the checks above to mean something.
    expect(offers).toBeGreaterThan(100);
  });

  it('prices each leg as its selection decides it now, and only bettable open legs at live odds', () => {
    fc.assert(
      fc.property(betArb, configArb, (bet, config) => {
        const quote = priceCashOut(bet, config, NOW);
        expect(quote.legs).toHaveLength(bet.legs.length);
        quote.legs.forEach((priced, i) => {
          const leg = bet.legs[i]!;
          const state = legStateOf(leg.selection.marketStatus, leg.selection.result);
          expect(priced).toEqual({
            legId: leg.id,
            selectionId: leg.selectionId,
            state,
            placedOddsMilli: leg.oddsMilli,
            currentOddsMilli:
              state === 'open' && bettable(leg.selection) ? leg.selection.oddsMilli : null,
          });
        });
      }),
      { numRuns: 500 },
    );
  });

  it('only an open bet can cash out; otherwise the gross is core cashOutOffer with the bet’s own cap', () => {
    fc.assert(
      fc.property(betArb, configArb, (bet, config) => {
        const quote = priceCashOut(bet, config, NOW);
        const core = cashOutOffer({
          stake: bet.stake,
          legs: quote.legs.map((leg) => ({
            placedOddsMilli: leg.placedOddsMilli,
            state: leg.state,
            currentOddsMilli: leg.currentOddsMilli,
          })),
          config,
          maxPayout: bet.terms.betRules.maxPayout,
        });
        expect(quote.potentialReturn).toBe(core.potentialReturn);
        if (bet.status !== 'open') {
          expect(quote.reason).toBe('bet_not_open');
        } else if (!core.available) {
          expect(quote.reason).toBe(core.reason);
        } else if (core.amount === 0n) {
          expect(quote.reason).toBe('below_minimum');
        } else {
          expect(quote).toMatchObject({ available: true, gross: core.amount });
        }
        // A leg that lost (seen by its selection) means no offer, whatever the bet row says.
        if (bet.status === 'open' && config.enabled && quote.legs.some((l) => l.state === 'lost')) {
          expect(quote.reason).toBe('leg_lost');
        }
      }),
      { numRuns: 500 },
    );
  });
});
