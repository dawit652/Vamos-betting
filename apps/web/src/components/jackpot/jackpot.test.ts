import { describe, expect, it } from 'vitest';
import { MESSAGES, lookup } from '@vamos/i18n';
import {
  closedMessageKey,
  ENTRY_STATUS_LABEL,
  emptyPicks,
  entryFingerprint,
  entryRequest,
  entryStatusTone,
  pickState,
  summarizePicks,
  takesEntries,
  templateTab,
  togglePick,
} from './jackpot';

const terms = { costPerCombination: '1000', maxCombinations: 100 };

describe('togglePick', () => {
  it('adds and removes outcomes in 1, X, 2 order without mutating', () => {
    const start = emptyPicks(3);
    const a = togglePick(start, 1, '2');
    const b = togglePick(a, 1, '1');
    expect(start).toEqual([[], [], []]);
    expect(a).toEqual([[], ['2'], []]);
    expect(b[1]).toEqual(['1', '2']);
    expect(togglePick(b, 1, '2')[1]).toEqual(['1']);
  });
});

describe('summarizePicks', () => {
  it('multiplies the pick counts and prices every combination', () => {
    let picks = emptyPicks(3);
    picks = togglePick(picks, 0, '1');
    picks = togglePick(picks, 0, 'X');
    picks = togglePick(picks, 1, '2');
    picks = togglePick(picks, 2, '1');
    picks = togglePick(picks, 2, 'X');
    picks = togglePick(picks, 2, '2');
    expect(summarizePicks(picks, terms)).toMatchObject({
      picked: 3,
      total: 3,
      complete: true,
      combinations: 6,
      cost: '6000',
      overMax: false,
      valid: true,
    });
  });

  it('is incomplete while a game has no pick', () => {
    const picks = togglePick(emptyPicks(2), 0, '1');
    const s = summarizePicks(picks, terms);
    expect(s).toMatchObject({
      picked: 1,
      complete: false,
      combinations: 0,
      cost: '0',
      valid: false,
    });
  });

  it('flags more combinations than the round allows', () => {
    let picks = emptyPicks(5);
    for (let g = 0; g < 5; g++)
      for (const o of ['1', 'X', '2'] as const) picks = togglePick(picks, g, o);
    const s = summarizePicks(picks, terms); // 3^5 = 243
    expect(s.combinations).toBe(243);
    expect(s.overMax).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.cost).toBe('243000');
  });

  it('keeps big costs exact (bigint)', () => {
    const s = summarizePicks([['1', 'X']], {
      costPerCombination: '9007199254740993',
      maxCombinations: 9,
    });
    expect(s.cost).toBe('18014398509481986');
  });
});

describe('entry request and key', () => {
  it('sends ordered picks per game', () => {
    expect(entryRequest([['2', '1'], ['X']])).toEqual({ picks: [['1', '2'], ['X']] });
  });
  it('fingerprints the round and picks', () => {
    expect(entryFingerprint('r1', [['1'], ['X', '2']])).toBe('r1:1|X2');
    expect(entryFingerprint('r1', [['1'], ['X']])).not.toBe(entryFingerprint('r1', [['1'], ['2']]));
    expect(entryFingerprint('r1', [['1']])).not.toBe(entryFingerprint('r2', [['1']]));
  });
});

describe('statuses and picks', () => {
  it('maps entry statuses to tones and existing message keys', () => {
    expect(entryStatusTone('won')).toBe('positive');
    expect(entryStatusTone('lost')).toBe('negative');
    expect(entryStatusTone('void')).toBe('muted');
    for (const key of Object.values(ENTRY_STATUS_LABEL)) {
      expect(lookup(MESSAGES.en, key)).toBeTruthy();
    }
  });
  it('judges a pick against the result', () => {
    expect(pickState('1', null)).toBe('open');
    expect(pickState('1', '1')).toBe('hit');
    expect(pickState('X', '1')).toBe('miss');
    expect(pickState('X', 'cancelled')).toBe('cancelled');
  });
  it('reads tabs, closing times and closed reasons', () => {
    expect(templateTab('weekly13')).toBe('weekly13');
    expect(templateTab('nope')).toBe('daily9');
    expect(templateTab(undefined)).toBe('daily9');
    const closesAt = '2026-10-17T12:00:00.000Z';
    expect(takesEntries({ status: 'open', closesAt }, Date.parse(closesAt) - 1)).toBe(true);
    expect(takesEntries({ status: 'open', closesAt }, Date.parse(closesAt))).toBe(false);
    expect(takesEntries({ status: 'closed', closesAt }, 0)).toBe(false);
    expect(closedMessageKey({ reason: 'game_started', status: 'open' })).toBe(
      'account.jackpot.errors.gameStarted',
    );
    expect(closedMessageKey(undefined)).toBe('account.jackpot.errors.closed');
  });
});
