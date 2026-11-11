import type { OpenBatchResult, OpenCheckResult, ReviewItemView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkChunks,
  isOpenCandidate,
  openSummary,
  pruneSelection,
  selectableIds,
  toleranceText,
  worstDeviation,
} from './feed-open';

function item(id: string, over: Partial<ReviewItemView> = {}): ReviewItemView {
  return {
    id,
    kind: 'odds_approval',
    subjectKey: `ref-${id}`,
    status: 'open',
    ...over,
  } as ReviewItemView;
}

function check(id: string, within: boolean, reason: string | null = null): OpenCheckResult {
  return { itemId: id, withinTolerance: within, reason, selections: [] };
}

describe('feed-open helpers', () => {
  it('only open, non-reprice odds_approval items are candidates', () => {
    expect(isOpenCandidate(item('a'))).toBe(true);
    expect(isOpenCandidate(item('b', { subjectKey: 'ref|reprice' }))).toBe(false);
    expect(isOpenCandidate(item('c', { status: 'resolved' }))).toBe(false);
    expect(isOpenCandidate(item('d', { kind: 'unknown_team' }))).toBe(false);
  });

  it('chunks the ids to ask about into batches of 50', () => {
    const items = Array.from({ length: 120 }, (_, i) => item(`i${i}`));
    items.push(item('r', { subjectKey: 'x|reprice' }));
    const chunks = checkChunks(items);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks.flat()).not.toContain('r');
  });

  it('lets only within-tolerance items be selected', () => {
    const items = [item('a'), item('b'), item('c'), item('d', { subjectKey: 'z|reprice' })];
    const checks = new Map([
      ['a', check('a', true)],
      ['b', check('b', false, 'out_of_tolerance')],
      ['d', check('d', true)],
    ]);
    expect(selectableIds(items, checks)).toEqual(['a']);
    expect([...pruneSelection(new Set(['a', 'b', 'x']), ['a'])]).toEqual(['a']);
  });

  it('words the status', () => {
    expect(toleranceText(undefined, 300)).toBe('checking');
    expect(toleranceText(check('a', true), 300)).toBe('within 3%');
    expect(toleranceText(check('a', false, 'no_consensus'), 300)).toBe(
      'no fresh bookmaker consensus',
    );
    expect(toleranceText(check('a', false, 'odd'), 300)).toBe('odd');
  });

  it('shows the widest deviation', () => {
    expect(worstDeviation(undefined)).toBeNull();
    const sel = (deviation: number) => ({
      selection: '1',
      oddsMilli: 2000,
      consensusProbability: 0.5,
      deviation,
      within: true,
    });
    expect(worstDeviation({ ...check('a', true), selections: [sel(0.01), sel(-0.02)] })).toBe(
      '-2.0%',
    );
    expect(worstDeviation({ ...check('a', true), selections: [sel(0.012)] })).toBe('+1.2%');
  });

  it('summarises a batch', () => {
    const ok: OpenBatchResult = { itemId: 'a', ok: true };
    const bad: OpenBatchResult = { itemId: 'b', ok: false, error: { code: 'x', message: 'nope' } };
    expect(openSummary([ok, ok])).toBe('2 opened.');
    expect(openSummary([ok, bad])).toBe('1 opened, 1 failed: nope');
  });
});
