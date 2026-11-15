import type { ReviewItemView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import {
  batchSummary,
  buildBatchItems,
  chunkBatch,
  filterGroups,
  fixtureContext,
  groupUnknownNames,
  pickedTarget,
  spellingKey,
  strongSuggestion,
} from './feed-bulk';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

let n = 0;
function item(
  payload: Record<string, unknown>,
  over: Partial<ReviewItemView> = {},
): ReviewItemView {
  n += 1;
  return {
    id: `item-${n}`,
    kind: 'unknown_team',
    subjectKey: `s${n}`,
    status: 'open',
    severity: 'warning',
    title: 't',
    createdAt: `2026-11-10T10:00:${String(n).padStart(2, '0')}.000Z`,
    updatedAt: '2026-11-10T10:00:00.000Z',
    payload,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  };
}
const unknown = (raw: string, sourceId: string, extra: Record<string, unknown> = {}) =>
  item({ sport: 'football', raw, competition: 'Cup', sourceId, suggestions: [], ...extra });

describe('spellingKey', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(spellingKey('  Beşiktaş  J.K. ')).toBe('besiktas jk');
    expect(spellingKey('BESIKTAS j.k')).toBe('besiktas jk');
    expect(spellingKey('...')).toBe('');
  });
});

describe('groupUnknownNames', () => {
  it('makes one group per spelling and lists its sources and competitions', () => {
    const groups = groupUnknownNames([
      unknown('Besiktas JK', 'src-a'),
      unknown('besiktas j.k.', 'src-b', { competition: 'League' }),
      unknown('Besiktas JK', 'src-a'),
      unknown('Falkirk', 'src-a'),
    ]);
    expect(groups.map((g) => g.raw)).toEqual(['Besiktas JK', 'Falkirk']);
    expect(groups[0]!.entries).toHaveLength(3);
    expect(groups[0]!.sources).toEqual(['src-a', 'src-b']);
    expect(groups[0]!.competitions).toEqual(['Cup', 'League']);
  });

  it('keeps open unknown_team items with a usable name only', () => {
    const groups = groupUnknownNames([
      unknown('Open FC', 'src-a'),
      item({ raw: 'Closed FC', sourceId: 'x' }, { status: 'resolved' }),
      item({ raw: 'Other kind', sourceId: 'x' }, { kind: 'unknown_competition' }),
      item({ sourceId: 'x' }),
      item({ raw: '!!!', sourceId: 'x' }),
    ]);
    expect(groups.map((g) => g.raw)).toEqual(['Open FC']);
  });

  it('merges suggestions by team (best score) and sorts best first', () => {
    const [group] = groupUnknownNames([
      unknown('Gala', 'src-a', {
        suggestions: [
          { id: T1, name: 'Galatasaray', score: 0.5 },
          { id: T2, name: 'Galway', score: 0.4 },
        ],
      }),
      unknown('gala', 'src-b', {
        suggestions: [{ id: T1, name: 'Galatasaray', score: 0.7 }, 'bad', null],
      }),
    ]);
    expect(group!.suggestions).toEqual([
      { id: T1, name: 'Galatasaray', score: 0.7 },
      { id: T2, name: 'Galway', score: 0.4 },
    ]);
    expect(strongSuggestion(group!)).toEqual({ id: T1, name: 'Galatasaray', score: 0.7 });
  });
});

describe('strongSuggestion', () => {
  it('needs a score of at least 0.6', () => {
    expect(strongSuggestion({ suggestions: [] })).toBeNull();
    expect(strongSuggestion({ suggestions: [{ id: T1, name: 'A', score: 0.59 }] })).toBeNull();
    expect(strongSuggestion({ suggestions: [{ id: T1, name: 'A', score: 0.6 }] })?.id).toBe(T1);
  });
});

describe('fixtureContext', () => {
  it('reads the opponent and kickoff of a fixture in the payload', () => {
    expect(
      fixtureContext({ fixture: { opponent: 'Fasil Kenema', kickoff: '2026-11-14T16:00:00Z' } }),
    ).toBe('vs Fasil Kenema, 2026-11-14 16:00 UTC');
    expect(fixtureContext({ fixture: { opponent: 'Fasil Kenema' } })).toBe('vs Fasil Kenema');
    expect(fixtureContext({ fixture: { kickoff: 'not a date' } })).toBeNull();
    expect(fixtureContext({})).toBeNull();
    expect(fixtureContext({ fixture: 'x' })).toBeNull();
  });
});

describe('filterGroups', () => {
  it('matches the spelling, a source or a competition', () => {
    const groups = groupUnknownNames([unknown('Besiktas', 'src-a'), unknown('Falkirk', 'src-b')]);
    expect(filterGroups(groups, 'BESIK').map((g) => g.raw)).toEqual(['Besiktas']);
    expect(filterGroups(groups, 'src-b').map((g) => g.raw)).toEqual(['Falkirk']);
    expect(filterGroups(groups, 'cup')).toHaveLength(2);
    expect(filterGroups(groups, '  ')).toHaveLength(2);
    expect(filterGroups(groups, 'zzz')).toEqual([]);
  });
});

describe('pickedTarget', () => {
  it('prefers a typed valid id and never falls back when the typed one is invalid', () => {
    expect(pickedTarget('', T1)).toBe(T1);
    expect(pickedTarget(` ${T2} `, T1)).toBe(T2);
    expect(pickedTarget('nope', T1)).toBe('');
    expect(pickedTarget('', '')).toBe('');
    expect(pickedTarget('', 'bad')).toBe('');
  });
});

describe('buildBatchItems', () => {
  const groups = groupUnknownNames([
    unknown('Besiktas', 'src-a'),
    unknown('besiktas', 'src-b'),
    unknown('Falkirk', 'src-a'),
    unknown('Twente', 'src-a'),
  ]);
  const key = (raw: string) => groups.find((g) => g.raw === raw)!.key;

  it('maps every item of each selected spelling to its chosen team, with the scope', () => {
    const plan = buildBatchItems(
      groups,
      new Set([key('Besiktas'), key('Falkirk')]),
      { [key('Besiktas')]: T1, [key('Falkirk')]: T2 },
      'source',
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toEqual([
      { itemId: groups[0]!.entries[0]!.itemId, targetId: T1, scope: 'source' },
      { itemId: groups[0]!.entries[1]!.itemId, targetId: T1, scope: 'source' },
      { itemId: groups[1]!.entries[0]!.itemId, targetId: T2, scope: 'source' },
    ]);
    expect(
      buildBatchItems(groups, new Set([key('Falkirk')]), { [key('Falkirk')]: T2 }, 'all').items[0]!
        .scope,
    ).toBe('all');
  });

  it('skips a selected row with no valid team and ignores unselected rows', () => {
    const plan = buildBatchItems(
      groups,
      new Set([key('Twente')]),
      { [key('Twente')]: '' },
      'source',
    );
    expect(plan).toEqual({ items: [], skipped: ['Twente'] });
    expect(buildBatchItems(groups, new Set(), { [key('Twente')]: T1 }, 'source').items).toEqual([]);
  });
});

describe('chunkBatch and batchSummary', () => {
  it('splits at 50 by default', () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    expect(chunkBatch(items).map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunkBatch([], 50)).toEqual([]);
    expect(chunkBatch([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('summarises mapped and failed items', () => {
    expect(batchSummary([{ itemId: 'a', ok: true }])).toBe('1 mapped.');
    expect(
      batchSummary([
        { itemId: 'a', ok: true },
        { itemId: 'b', ok: false, error: { code: 'review_closed', message: 'already resolved' } },
        { itemId: 'c', ok: false, error: { code: 'review_closed', message: 'already resolved' } },
      ]),
    ).toBe('1 mapped, 2 failed: already resolved');
  });
});
