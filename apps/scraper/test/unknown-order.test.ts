import { afterEach, describe, expect, it } from 'vitest';
import { planUnknownItems, unknownSubject, type UnknownName } from '../src/pipeline/run-source';
import {
  createHarness,
  jsonDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_B,
  type Harness,
} from './helpers';

/** Review finding 10: unknown-name items are opened in one fixed order, whatever the record order. */

const unknownName = (
  kind: 'team' | 'competition',
  raw: string,
  sport = 'football',
): UnknownName => ({
  kind,
  sport,
  raw,
  resolution: { status: 'unknown' },
  sourceId: 'src-b',
});

/** Deterministic pseudo-random numbers (no extra dependency): a small LCG. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const NAMES: UnknownName[] = [
  ...['Zulu FC', 'alpha United', 'Mike Town', 'Échec SC', 'zulu fc', 'Bravo 1', 'Bravo 10'].map(
    (raw) => unknownName('team', raw),
  ),
  ...['Zeta League', 'Alpha Cup', 'Mid Division'].map((raw) => unknownName('competition', raw)),
  unknownName('team', 'Zulu FC', 'basketball'),
];

describe('planUnknownItems', () => {
  it('opens one item per (kind, subject), sorted by (kind, subject key), whatever the input order', () => {
    const expected = planUnknownItems(NAMES).map((p) => `${p.kind}|${p.subjectKey}`);
    // "Zulu FC" and "zulu fc" are one subject; the same name in another sport is another.
    expect(expected).toHaveLength(NAMES.length - 1);
    const sorted = [...expected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(expected).toEqual(sorted);
    for (let seed = 1; seed <= 200; seed += 1) {
      const order = planUnknownItems(shuffled(NAMES, lcg(seed)));
      expect(order.map((p) => `${p.kind}|${p.subjectKey}`)).toEqual(expected);
      for (const item of order) {
        expect(item.subjectKey).toBe(unknownSubject(item.name.sport, item.name.raw));
      }
    }
  });

  it('is empty for no names', () => {
    expect(planUnknownItems([])).toEqual([]);
  });
});

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('a source run opens its unknown-name items in sorted order', () => {
  it(
    'N2: items for names listed in reverse order are inserted in subject order',
    async () => {
      h = await createHarness();
      // The records are stored by external id (1, 2, 3, 4), so the names arrive Zulu, Mike, Alpha, Bravo.
      const event = (id: number, home: string) => ({
        id,
        kick: '2026-11-02T15:00:00Z',
        h: home,
        a: 'Chelsea',
        st: 'NS' as const,
      });
      h.serve(
        URL_B,
        jsonDoc([
          event(1, 'Zulu FC'),
          event(2, 'Mike Town'),
          event(3, 'Alpha United'),
          event(4, 'Bravo SC'),
        ]),
      );
      await h.run('src-b');
      // A fresh table: the physical order of the rows is the order they were inserted in.
      const { rows } = await h.pool.query<{ subject_key: string }>(
        `SELECT subject_key FROM scrape_review_items WHERE kind = 'unknown_team' ORDER BY ctid`,
      );
      expect(rows.map((r) => r.subject_key)).toEqual([
        'football|alpha united',
        'football|bravo',
        'football|mike town',
        'football|zulu',
      ]);
    },
    TEST_TIMEOUT,
  );
});
