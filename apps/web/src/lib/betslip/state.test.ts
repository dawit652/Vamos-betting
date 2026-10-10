import { DEFAULT_BET_RULES } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import {
  addLeg,
  DEFAULT_STAKE,
  EMPTY_SLIP,
  hasOddsChanges,
  MAX_SLIP_LEGS,
  parseStoredSlip,
  serializeSlip,
  slipReducer,
  toggleLeg,
  type NewSlipLeg,
  type SlipState,
} from './state';

function leg(eventId: string, selectionId = `${eventId}-1`, oddsMilli = 1850): NewSlipLeg {
  return {
    selectionId,
    eventId,
    oddsMilli,
    gameId: '1234',
    sport: 'football',
    home: { en: 'Home' },
    away: { en: 'Away', am: 'እንግዳ' },
    marketName: { en: '1X2' },
    selectionName: { en: '1' },
    startTime: '2026-10-10T15:00:00.000Z',
    live: false,
  };
}

function slipWith(count: number): SlipState {
  let state = EMPTY_SLIP;
  for (let i = 0; i < count; i++) state = addLeg(state, leg(`e${i}`)).state;
  return state;
}

describe('betslip toggle', () => {
  it('adds, then removes on a second tap', () => {
    const added = toggleLeg(EMPTY_SLIP, leg('e1'));
    expect(added.outcome).toBe('added');
    expect(added.state.legs).toHaveLength(1);
    expect(added.state.legs[0]?.previousOddsMilli).toBeNull();
    const removed = toggleLeg(added.state, leg('e1'));
    expect(removed.outcome).toBe('removed');
    expect(removed.state.legs).toHaveLength(0);
  });

  it('keeps one selection per event, replacing in place', () => {
    let state = addLeg(EMPTY_SLIP, leg('e1', 'e1-home')).state;
    state = addLeg(state, leg('e2')).state;
    const replaced = toggleLeg(state, leg('e1', 'e1-away', 3100));
    expect(replaced.outcome).toBe('replaced');
    expect(replaced.state.legs.map((l) => l.selectionId)).toEqual(['e1-away', 'e2-1']);
    expect(replaced.state.legs[0]?.oddsMilli).toBe(3100);
  });

  it('refuses a 41st event but still allows replacing a pick at the limit', () => {
    const full = slipWith(MAX_SLIP_LEGS);
    expect(MAX_SLIP_LEGS).toBe(DEFAULT_BET_RULES.maxLegs);
    const refused = toggleLeg(full, leg('another'));
    expect(refused.outcome).toBe('limit');
    expect(refused.state).toBe(full);
    const replaced = toggleLeg(full, leg('e0', 'e0-2'));
    expect(replaced.outcome).toBe('replaced');
    expect(replaced.state.legs).toHaveLength(MAX_SLIP_LEGS);
  });

  it('never holds two legs of one event or more than 40 legs, whatever the taps', () => {
    let state = EMPTY_SLIP;
    for (let i = 0; i < 500; i++) {
      const eventId = `e${(i * 7) % 53}`;
      state = slipReducer(state, { type: 'toggle', leg: leg(eventId, `${eventId}-${i % 3}`) });
      const events = state.legs.map((l) => l.eventId);
      expect(new Set(events).size).toBe(events.length);
      expect(state.legs.length).toBeLessThanOrEqual(MAX_SLIP_LEGS);
    }
  });
});

describe('betslip reducer', () => {
  it('removes, clears (keeping stake and policy), sets stake and policy', () => {
    let state = slipWith(3);
    state = slipReducer(state, { type: 'setStake', stake: '5000' });
    state = slipReducer(state, { type: 'setPolicy', policy: 'any' });
    state = slipReducer(state, { type: 'remove', selectionId: 'e1-1' });
    expect(state.legs.map((l) => l.eventId)).toEqual(['e0', 'e2']);
    state = slipReducer(state, { type: 'clear' });
    expect(state).toEqual({ legs: [], stake: '5000', oddsChangePolicy: 'any' });
  });

  it('ignores a stake that is not a santim integer and an unknown policy', () => {
    const state = slipWith(1);
    expect(slipReducer(state, { type: 'setStake', stake: '10.5' })).toBe(state);
    expect(slipReducer(state, { type: 'setStake', stake: '-100' })).toBe(state);
    expect(slipReducer(state, { type: 'setPolicy', policy: 'maybe' as never })).toBe(state);
  });

  it('tracks live odds changes until accepted', () => {
    let state = slipWith(2);
    expect(hasOddsChanges(state)).toBe(false);
    state = slipReducer(state, {
      type: 'updateOdds',
      changes: [
        { selectionId: 'e0-1', oddsMilli: 2000 },
        { selectionId: 'missing', oddsMilli: 2000 },
      ],
    });
    state = slipReducer(state, {
      type: 'updateOdds',
      changes: [{ selectionId: 'e0-1', oddsMilli: 2100 }],
    });
    expect(state.legs[0]).toMatchObject({ oddsMilli: 2100, previousOddsMilli: 1850 });
    expect(hasOddsChanges(state)).toBe(true);
    state = slipReducer(state, { type: 'acceptOdds' });
    expect(state.legs[0]).toMatchObject({ oddsMilli: 2100, previousOddsMilli: null });
    expect(hasOddsChanges(state)).toBe(false);
  });

  it('ignores unchanged or invalid odds updates', () => {
    const state = slipWith(1);
    expect(
      slipReducer(state, {
        type: 'updateOdds',
        changes: [{ selectionId: 'e0-1', oddsMilli: 1850 }],
      }),
    ).toBe(state);
    expect(
      slipReducer(state, {
        type: 'updateOdds',
        changes: [{ selectionId: 'e0-1', oddsMilli: 1000 }],
      }),
    ).toBe(state);
  });

  it('replaces the legs (booking code) with the same rules', () => {
    const legs = [leg('a'), leg('a', 'a-2'), ...Array.from({ length: 45 }, (_, i) => leg(`b${i}`))];
    const state = slipReducer(slipWith(3), { type: 'replaceLegs', legs });
    expect(state.legs).toHaveLength(MAX_SLIP_LEGS);
    expect(state.legs[0]?.selectionId).toBe('a-2');
  });
});

describe('betslip storage', () => {
  it('round-trips a slip, including pending odds changes', () => {
    let state = slipWith(2);
    state = slipReducer(state, { type: 'setStake', stake: '25000' });
    state = slipReducer(state, {
      type: 'updateOdds',
      changes: [{ selectionId: 'e1-1', oddsMilli: 1700 }],
    });
    expect(parseStoredSlip(serializeSlip(state))).toEqual(state);
  });

  it('rejects garbage and drops invalid legs', () => {
    expect(parseStoredSlip(null)).toBeNull();
    expect(parseStoredSlip('not json')).toBeNull();
    expect(parseStoredSlip('42')).toBeNull();
    const restored = parseStoredSlip(
      JSON.stringify({
        legs: [leg('ok'), { ...leg('bad'), oddsMilli: 'x' }, { ...leg('bad2'), home: null }, 7],
        stake: '1.5',
        oddsChangePolicy: 'whatever',
      }),
    );
    expect(restored?.legs.map((l) => l.eventId)).toEqual(['ok']);
    expect(restored?.stake).toBe(DEFAULT_STAKE);
    expect(restored?.oddsChangePolicy).toBe(EMPTY_SLIP.oddsChangePolicy);
  });

  it('enforces the slip rules on stored data', () => {
    const legs = [leg('x'), leg('x', 'x-2'), ...Array.from({ length: 50 }, (_, i) => leg(`y${i}`))];
    const restored = parseStoredSlip(JSON.stringify({ legs, stake: '1000' }));
    expect(restored?.legs).toHaveLength(MAX_SLIP_LEGS);
    expect(restored?.legs.filter((l) => l.eventId === 'x')).toHaveLength(1);
  });
});
