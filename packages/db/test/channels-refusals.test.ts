import { DEFAULT_BET_RULES } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import {
  channelRefusalOf,
  DomainError,
  smsBetKey,
  ussdBetKey,
  type ChannelBetLeg,
} from '../src/index';

const LEGS: ChannelBetLeg[] = [
  { gameId: 1234, pick: '1', selectionId: 'aaaaaaaa-0000-4000-8000-000000000001', oddsMilli: 2000 },
  {
    gameId: 5678,
    pick: 'OV25',
    selectionId: 'bbbbbbbb-0000-4000-8000-000000000002',
    oddsMilli: 1900,
  },
];

const refusal = (status: number, code: string, details?: unknown) =>
  channelRefusalOf(new DomainError(status, code, 'message', details), LEGS, DEFAULT_BET_RULES);

describe('placeBet errors as channel refusals', () => {
  it('names the leg of an unavailable selection and why', () => {
    const second = LEGS[1]!.selectionId.toUpperCase();
    expect(
      refusal(409, 'selection_unavailable', {
        selections: [{ selectionId: second, reason: 'suspended' }],
      }),
    ).toEqual({ code: 'pick_unavailable', gameId: 5678, pick: 'OV25', reason: 'suspended' });
    expect(
      refusal(409, 'selection_unavailable', {
        selections: [{ selectionId: LEGS[0]!.selectionId, reason: 'inactive' }],
      }),
    ).toEqual({ code: 'pick_unavailable', gameId: 1234, pick: '1', reason: 'event_closed' });
    expect(
      refusal(409, 'selection_unavailable', {
        selections: [{ selectionId: LEGS[0]!.selectionId, reason: 'not_found' }],
      }),
    ).toEqual({ code: 'pick_not_offered', gameId: 1234, pick: '1' });
  });

  it('maps odds, slip, funds, exclusion and limit errors', () => {
    expect(refusal(409, 'odds_changed', { changes: [{ currentOddsMilli: 1800 }] })).toEqual({
      code: 'odds_changed',
      oddsMilli: 1800,
    });
    expect(refusal(409, 'odds_changed')).toEqual({ code: 'odds_changed', oddsMilli: null });
    const slip = (code: string) => refusal(422, 'slip_invalid', { errors: [{ code }] });
    expect(slip('stake_below_minimum')).toEqual({
      code: 'stake_below_minimum',
      min: DEFAULT_BET_RULES.minStake,
    });
    expect(slip('stake_above_maximum')).toEqual({
      code: 'stake_above_maximum',
      max: DEFAULT_BET_RULES.maxStake,
    });
    expect(slip('too_many_legs')).toEqual({
      code: 'too_many_legs',
      max: DEFAULT_BET_RULES.maxLegs,
    });
    expect(slip('odds_below_minimum')).toEqual({
      code: 'odds_below_minimum',
      minOddsMilli: DEFAULT_BET_RULES.minLegOddsMilli,
    });
    expect(slip('total_odds_above_maximum')).toEqual({ code: 'total_odds_above_maximum' });
    expect(slip('duplicate_event')).toEqual({ code: 'duplicate_game', gameId: 1234 });
    expect(slip('invalid_odds')).toEqual({ code: 'bet_failed' });
    expect(refusal(422, 'insufficient_funds', { balance: '1200', stake: '5000' })).toEqual({
      code: 'insufficient_funds',
      balance: 1200n,
      stake: 5000n,
    });
    expect(refusal(422, 'insufficient_funds', {})).toEqual({ code: 'bet_failed' });
    expect(
      refusal(403, 'self_excluded', { kind: 'self_exclusion', endsAt: '2027-01-01T00:00:00.000Z' }),
    ).toEqual({ code: 'self_excluded', until: new Date('2027-01-01T00:00:00.000Z') });
    expect(refusal(403, 'self_excluded', { endsAt: null })).toEqual({
      code: 'self_excluded',
      until: null,
    });
    expect(refusal(403, 'cooling_off', { endsAt: 'garbage' })).toEqual({
      code: 'cooling_off',
      until: null,
    });
    expect(refusal(403, 'account_disabled')).toEqual({ code: 'account_disabled' });
    expect(refusal(422, 'stake_limit_exceeded', { limit: '3000' })).toEqual({
      code: 'stake_limit_exceeded',
      limit: 3000n,
    });
    expect(refusal(422, 'loss_limit_exceeded', { period: 'week', limit: '100000' })).toEqual({
      code: 'loss_limit_exceeded',
      period: 'week',
      limit: 100_000n,
    });
    expect(refusal(422, 'loss_limit_exceeded', { period: 'bet', limit: '1' })).toEqual({
      code: 'bet_failed',
    });
    expect(refusal(422, 'idempotency_key_reused')).toEqual({ code: 'bet_failed' });
    expect(refusal(404, 'not_found')).toEqual({ code: 'bet_failed' });
  });
});

describe('channel idempotency keys', () => {
  it('fit the 8–100 printable characters of a bet key and differ per message and step', () => {
    const sms = smsBetKey('mock', 'ATXid_1');
    expect(sms).toMatch(/^sms:[0-9a-f]{64}$/);
    expect(smsBetKey('mock', 'ATXid_2')).not.toBe(sms);
    expect(smsBetKey('other', 'ATXid_1')).not.toBe(sms);
    const ussd = ussdBetKey('mock', 'x'.repeat(128), 999_999);
    expect(ussd.length).toBeLessThanOrEqual(100);
    expect(ussdBetKey('mock', 's', 5)).not.toBe(ussdBetKey('mock', 's', 6));
    expect(() => ussdBetKey('mock', 's', 0)).toThrow(RangeError);
  });
});
