import {
  FACTORY_MARKETS,
  type FactoryScoreGrids,
  fairBook,
  isFactoryOnlyMarketType,
  oddsFromProbability,
} from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { checkMarkets, checkReprice, type GateMarket } from './odds';

/**
 * Plan task 2.3: the odds gates (O2, O3) accept football markets of the market factory, each
 * checked against its own number of winners per score, with a subset of selections listed.
 */

function poisson(lambda: number, max = 10): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= max; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

function grid(home: number, away: number): number[][] {
  const h = poisson(home);
  const a = poisson(away);
  const cells = h.map((ph) => a.map((pa) => ph * pa));
  const total = cells.flat().reduce((x, y) => x + y, 0);
  return cells.map((row) => row.map((p) => p / total));
}

const GRIDS: FactoryScoreGrids = {
  ft: grid(1.45, 1.15),
  h1: grid(0.65, 0.52),
  h2: grid(0.8, 0.63),
};

/** A factory market priced at a 7% margin, long shots above 500.0 not listed. */
function priced(type: string, line: string | null = null): GateMarket {
  const market = FACTORY_MARKETS.find((m) => m.type === type && m.line === line);
  if (market === undefined) throw new Error(`no factory market ${type} ${String(line)}`);
  const book = fairBook(market, GRIDS);
  return {
    type,
    line,
    selections: market.selections.flatMap((code, i) => {
      const p = Math.max(book.probabilities[i] ?? 0, 1e-6);
      const oddsMilli = oddsFromProbability(p, 700);
      return oddsMilli > 500_000 ? [] : [{ code, oddsMilli }];
    }),
  };
}

describe('O2 on factory markets', () => {
  it('accepts every factory-only market priced at a normal margin', () => {
    const markets = FACTORY_MARKETS.filter((m) => isFactoryOnlyMarketType(m.type)).map((m) =>
      priced(m.type, m.line),
    );
    const check = checkMarkets(markets.filter((m) => m.selections.length > 0));
    expect(check).toEqual({ ok: true });
  });

  it('divides by the winners per score: a double-chance combination is not a bargain at twice the sum', () => {
    const combo = priced('ft_dc_btts');
    expect(checkMarkets([combo])).toEqual({ ok: true });
    // The same prices read as a one-winner book would look like a 200% overround.
    const sum = combo.selections.reduce((s, x) => s + 1000 / x.oddsMilli, 0);
    expect(sum).toBeGreaterThan(2);
  });

  it('rejects unknown factory markets and selections, duplicates and an empty listing', () => {
    const htft = priced('htft');
    const cases: Array<[GateMarket[], string]> = [
      [[{ type: 'htft', line: '2.5', selections: htft.selections }], 'bad_line'],
      [[{ type: 'no_such_market', line: null, selections: htft.selections }], 'unknown_market'],
      [
        [{ type: 'htft', line: null, selections: [{ code: '1/3', oddsMilli: 3000 }] }],
        'bad_selections',
      ],
      [[{ type: 'htft', line: null, selections: [] }], 'bad_selections'],
      [
        [
          {
            type: 'htft',
            line: null,
            selections: [htft.selections[0]!, htft.selections[0]!],
          },
        ],
        'bad_selections',
      ],
      [[htft, htft], 'duplicate_market'],
    ];
    for (const [markets, code] of cases) {
      const check = checkMarkets(markets);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.issues.map((i) => i.code)).toContain(code);
    }
  });

  it('rejects a factory book priced under the overround floor', () => {
    const htft = priced('htft');
    const generous = {
      ...htft,
      selections: htft.selections.map((s) => ({ ...s, oddsMilli: Math.floor(s.oddsMilli * 1.2) })),
    };
    const check = checkMarkets([generous]);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues[0]?.code).toBe('overround_low');
  });
});

describe('O3 on factory markets', () => {
  it('does not hold a re-price because a long shot of a factory market crossed the listing limit', () => {
    const before = priced('htcs_ft_result');
    // Pricing stops listing the longest price once it crosses 500.0.
    const longest = Math.max(...before.selections.map((s) => s.oddsMilli));
    const after = {
      ...before,
      selections: before.selections.filter((s) => s.oddsMilli !== longest),
    };
    expect(after.selections.length).toBe(before.selections.length - 1);
    expect(checkReprice([before], [after])).toEqual({ ok: true });
  });

  it('still holds today’s markets on a changed selection set', () => {
    const oneXTwo: GateMarket = {
      type: '1x2',
      line: null,
      selections: [
        { code: '1', oddsMilli: 2100 },
        { code: 'X', oddsMilli: 3300 },
        { code: '2', oddsMilli: 3600 },
      ],
    };
    const check = checkReprice(
      [oneXTwo],
      [{ ...oneXTwo, selections: oneXTwo.selections.slice(0, 2) }],
    );
    expect(check.ok).toBe(false);
  });

  it('does not hold a re-price because a factory market is no longer offered (it is suspended where stored)', () => {
    const oneXTwo: GateMarket = {
      type: '1x2',
      line: null,
      selections: [
        { code: '1', oddsMilli: 2100 },
        { code: 'X', oddsMilli: 3300 },
        { code: '2', oddsMilli: 3600 },
      ],
    };
    expect(checkReprice([oneXTwo, priced('htft')], [oneXTwo])).toEqual({ ok: true });
    // Removing one of today's markets still holds.
    const check = checkReprice([oneXTwo, priced('htft')], [priced('htft')]);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues.map((i) => i.code)).toContain('market_set_changed');
  });

  it('adds a factory market to an event without holding the others', () => {
    const oneXTwo: GateMarket = {
      type: '1x2',
      line: null,
      selections: [
        { code: '1', oddsMilli: 2100 },
        { code: 'X', oddsMilli: 3300 },
        { code: '2', oddsMilli: 3600 },
      ],
    };
    expect(checkReprice([oneXTwo], [oneXTwo, priced('htft')])).toEqual({ ok: true });
  });
});
