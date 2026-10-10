import type { EventDetail, QuoteLeg } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import type { SlipLeg } from '@/lib/betslip/state';
import {
  bonusPercent,
  bookingCodeRequest,
  legsFromBooking,
  oddsChangesFromDetails,
  placeBetRequest,
  placementFingerprint,
  policyCoversChanges,
  QUICK_STAKES,
  quoteOddsChanges,
  quoteRequest,
  quoteUnavailable,
  slipErrorKey,
  slipErrorsFromDetails,
  stakeFromInput,
  stakeToInput,
  unavailableFromDetails,
} from './requests';

const leg = (id: string, oddsMilli: number, previousOddsMilli: number | null = null): SlipLeg => ({
  selectionId: id,
  eventId: `ev-${id}`,
  oddsMilli,
  previousOddsMilli,
  gameId: '1234',
  sport: 'football',
  home: { en: 'Home' },
  away: { en: 'Away' },
  marketName: { en: 'Match Result' },
  selectionName: { en: 'Home' },
  startTime: '2026-10-10T15:00:00.000Z',
  live: false,
});

const quoteLeg = (over: Partial<QuoteLeg>): QuoteLeg => ({
  selectionId: 's1',
  eventId: 'e1',
  gameId: '1234',
  eventName: 'Home vs Away',
  marketName: { en: 'Match Result' },
  selectionName: { en: 'Home' },
  oddsMilli: 1850,
  requestedOddsMilli: null,
  oddsChanged: false,
  available: true,
  reason: null,
  live: false,
  ...over,
});

describe('stake input', () => {
  it('parses birr text to a positive santim string without floats', () => {
    expect(stakeFromInput('10')).toBe('1000');
    expect(stakeFromInput(' 12.5 ')).toBe('1250');
    expect(stakeFromInput('1,250.75')).toBe('125075');
    expect(stakeFromInput('0.01')).toBe('1');
    expect(stakeFromInput('999999999999999.99')).toBe('99999999999999999');
    expect(stakeFromInput('0')).toBeNull();
    expect(stakeFromInput('')).toBeNull();
    expect(stakeFromInput('-5')).toBeNull();
    expect(stakeFromInput('1.234')).toBeNull();
    expect(stakeFromInput('abc')).toBeNull();
    expect(stakeFromInput('1e3')).toBeNull();
  });

  it('formats santim for the input and round-trips', () => {
    expect(stakeToInput('1000')).toBe('10');
    expect(stakeToInput('1250')).toBe('12.5');
    expect(stakeToInput('1205')).toBe('12.05');
    expect(stakeToInput('5')).toBe('0.05');
    expect(stakeToInput('x')).toBe('');
    for (const santim of ['1', '99', '100', '12345', '50000', '12345678901234567']) {
      expect(stakeFromInput(stakeToInput(santim))).toBe(santim);
    }
  });

  it('offers 10, 50, 100 and 500 ETB quick stakes', () => {
    expect(QUICK_STAKES.map(stakeToInput)).toEqual(['10', '50', '100', '500']);
  });
});

describe('slip → requests', () => {
  const legs = [leg('a', 1850), leg('b', 2100, 2000)];

  it('builds the quote request, or null with no legs or stake', () => {
    expect(quoteRequest(legs, '1000')).toEqual({
      legs: [
        { selectionId: 'a', oddsMilli: 1850 },
        { selectionId: 'b', oddsMilli: 2100 },
      ],
      stake: '1000',
    });
    expect(quoteRequest([], '1000')).toBeNull();
    expect(quoteRequest(legs, '0')).toBeNull();
    expect(quoteRequest(legs, '000')).toBeNull();
    expect(quoteRequest(legs, '')).toBeNull();
  });

  it('builds the bet and booking code requests', () => {
    expect(placeBetRequest(legs, '5000', 'higher')).toEqual({
      legs: [
        { selectionId: 'a', oddsMilli: 1850 },
        { selectionId: 'b', oddsMilli: 2100 },
      ],
      stake: '5000',
      oddsChangePolicy: 'higher',
    });
    expect(bookingCodeRequest(legs)).toEqual({
      legs: [{ selectionId: 'a' }, { selectionId: 'b' }],
    });
  });

  it('keeps one placement fingerprint per intent', () => {
    const a = placementFingerprint(placeBetRequest(legs, '5000', 'higher'));
    expect(placementFingerprint(placeBetRequest(legs, '5000', 'higher'))).toBe(a);
    expect(placementFingerprint(placeBetRequest(legs, '5001', 'higher'))).not.toBe(a);
    expect(placementFingerprint(placeBetRequest(legs, '5000', 'any'))).not.toBe(a);
    expect(
      placementFingerprint(placeBetRequest([leg('a', 1860), legs[1]!], '5000', 'higher')),
    ).not.toBe(a);
  });
});

describe('quote and error details', () => {
  it('reads price changes and unavailable legs from a quote', () => {
    const quote = {
      legs: [
        quoteLeg({
          selectionId: 'a',
          oddsMilli: 1900,
          requestedOddsMilli: 1850,
          oddsChanged: true,
        }),
        quoteLeg({ selectionId: 'b' }),
        quoteLeg({ selectionId: 'c', available: false, reason: 'suspended', oddsChanged: true }),
        quoteLeg({ selectionId: 'd', available: false, reason: null, oddsMilli: null }),
      ],
    };
    expect(quoteOddsChanges(quote)).toEqual([{ selectionId: 'a', oddsMilli: 1900 }]);
    expect([...quoteUnavailable(quote)]).toEqual([
      ['c', 'suspended'],
      ['d', 'not_found'],
    ]);
  });

  it('reads 409 and 422 details defensively', () => {
    expect(
      oddsChangesFromDetails({
        policy: 'none',
        changes: [
          { selectionId: 'a', requestedOddsMilli: 1850, currentOddsMilli: 1700, direction: 'down' },
          { selectionId: 'b', currentOddsMilli: 'x' },
          null,
        ],
      }),
    ).toEqual([{ selectionId: 'a', oddsMilli: 1700 }]);
    expect(oddsChangesFromDetails(undefined)).toEqual([]);
    expect([
      ...unavailableFromDetails({
        selections: [
          { selectionId: 'a', reason: 'event_started' },
          { selectionId: 'b', reason: 'bogus' },
          { reason: 'suspended' },
        ],
      }),
    ]).toEqual([
      ['a', 'event_started'],
      ['b', 'not_found'],
    ]);
    expect(
      slipErrorsFromDetails({ errors: [{ code: 'stake_below_minimum', message: 'x' }, 7] }),
    ).toEqual([{ code: 'stake_below_minimum' }]);
    expect(slipErrorsFromDetails('nope')).toEqual([]);
  });

  it('maps slip error codes to messages', () => {
    expect(slipErrorKey('stake_below_minimum')).toBe('sportsbook.betslip.errors.stakeBelowMinimum');
    expect(slipErrorKey('duplicate_event')).toBe('sportsbook.betslip.errors.duplicateEvent');
    expect(slipErrorKey('something_new')).toBe('sportsbook.betslip.errors.invalid');
  });

  it('shows the multi bonus percentage from basis points', () => {
    expect(bonusPercent(300)).toBe('3');
    expect(bonusPercent(1250)).toBe('12.5');
    expect(bonusPercent(1205)).toBe('12.05');
    expect(bonusPercent(20000)).toBe('200');
    expect(bonusPercent(0)).toBe('0');
  });
});

describe('odds-change policy', () => {
  it('needs confirmation unless the policy takes every change', () => {
    const up = [leg('a', 2000, 1800), leg('b', 1500)];
    const down = [leg('a', 1700, 1800)];
    expect(policyCoversChanges('none', [leg('a', 1800)])).toBe(true);
    expect(policyCoversChanges('none', up)).toBe(false);
    expect(policyCoversChanges('higher', up)).toBe(true);
    expect(policyCoversChanges('higher', down)).toBe(false);
    expect(policyCoversChanges('any', down)).toBe(true);
  });
});

describe('booking codes → slip', () => {
  const event: EventDetail = {
    id: 'e1',
    gameId: '1234',
    sport: 'football',
    competition: { slug: 'epl', name: { en: 'EPL' }, category: { en: 'England' } },
    home: { id: 'h', name: { en: 'Home FC', am: 'ሆም' }, shortName: 'HOM' },
    away: { id: 'a', name: { en: 'Away FC' }, shortName: 'AWA' },
    startTime: '2026-10-10T15:00:00.000Z',
    status: 'scheduled',
    liveMinute: null,
    period: null,
    score: null,
    htScore: null,
    mainMarket: null,
    marketCount: 1,
    markets: [
      {
        id: 'm1',
        type: '1x2',
        line: null,
        name: { en: 'Match Result' },
        status: 'open',
        selections: [
          { id: 's1', code: '1', label: { en: 'Home FC' }, oddsMilli: 1850, open: true },
          { id: 's2', code: 'X', label: { en: 'Draw' }, oddsMilli: 3300, open: true },
        ],
      },
    ],
  };

  it('fills the slip with available legs and counts the rest', () => {
    const booking = {
      legs: [
        quoteLeg({ selectionId: 's2', eventId: 'e1', oddsMilli: 3400 }),
        quoteLeg({ selectionId: 's9', eventId: 'e1' }),
        quoteLeg({ selectionId: 's1', eventId: 'e2' }),
        quoteLeg({ selectionId: 's1', eventId: 'e1', available: false, reason: 'suspended' }),
      ],
    };
    const { legs, skipped } = legsFromBooking(booking, new Map([['e1', event]]));
    expect(skipped).toBe(3);
    expect(legs).toEqual([
      {
        selectionId: 's2',
        eventId: 'e1',
        gameId: '1234',
        sport: 'football',
        home: { en: 'Home FC', am: 'ሆም' },
        away: { en: 'Away FC' },
        startTime: '2026-10-10T15:00:00.000Z',
        live: false,
        oddsMilli: 3400,
        marketName: { en: 'Match Result' },
        selectionName: { en: 'Draw' },
      },
    ]);
  });
});
