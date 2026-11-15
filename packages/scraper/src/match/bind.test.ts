import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nameSimilarity } from '../normalize/alias';
import {
  BIND_NAME_SIMILARITY_MIN,
  DEFAULT_BIND_KICKOFF_TOLERANCE_MS,
  DEFAULT_BIND_MIN_PAIRS,
  DEFAULT_BIND_MIN_SHARE,
  DEFAULT_BIND_WINDOW_MS,
  bindCompetitions,
  type OddsApiCompetition,
  type SpineCompetition,
} from './bind';

const NOW = new Date(Date.UTC(2026, 7, 10, 12, 0, 0));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (offsetMin: number): Date => new Date(NOW.getTime() + offsetMin * MIN);

type Row = readonly [offsetMin: number, home: string, away: string];

const odds = (sportKey: string, rows: readonly Row[], idPrefix = 'o'): OddsApiCompetition => ({
  sportKey,
  fixtures: rows.map(([m, home, away], i) => ({
    id: `${idPrefix}${sportKey}-${i}`,
    kickoff: at(m),
    home,
    away,
  })),
});
const spine = (leagueId: string, rows: readonly Row[]): SpineCompetition => ({
  leagueId,
  fixtures: rows.map(([m, home, away], i) => ({
    id: `f${leagueId}-${i}`,
    kickoff: at(m),
    homeTeamId: `${home}#`,
    awayTeamId: `${away}#`,
    home,
    away,
  })),
});

const TEAMS = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley', 'Leeds', 'Luton'];
/** n fixtures, one per hour from a day out, teams rotating so no two fixtures are alike. */
const rows = (n: number, teams: readonly string[] = TEAMS, start = 24 * 60): Row[] =>
  Array.from({ length: n }, (_, i) => [
    start + i * 60,
    teams[i % teams.length]!,
    teams[(i + 1 + Math.floor(i / teams.length)) % teams.length]!,
  ]);

describe('defaults', () => {
  it('are 14 days, 5 minutes, 6 pairs, 80%', () => {
    expect(DEFAULT_BIND_WINDOW_MS).toBe(14 * DAY);
    expect(DEFAULT_BIND_KICKOFF_TOLERANCE_MS).toBe(5 * MIN);
    expect(DEFAULT_BIND_MIN_PAIRS).toBe(6);
    expect(DEFAULT_BIND_MIN_SHARE).toBe(0.8);
  });
});

describe('bindCompetitions', () => {
  it('binds a clean league with its evidence', () => {
    const r = rows(10);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [{ ...odds('soccer_epl', r), name: 'EPL' }],
      spine: [{ ...spine('39', r), name: 'Premier League' }],
    });
    expect(out.unbound).toEqual([]);
    expect(out.bindings).toHaveLength(1);
    const b = out.bindings[0]!;
    expect(b).toMatchObject({ sportKey: 'soccer_epl', leagueId: '39', pairs: 10, share: 1 });
    expect(b.examples).toHaveLength(3);
    expect(b.names).toEqual({ oddsApi: 'EPL', spine: 'Premier League' });
  });

  it('never decides on competition names', () => {
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [{ ...odds('soccer_epl', rows(10)), name: 'Premier League' }],
      spine: [
        {
          ...spine('39', rows(10, ['Ajax', 'Porto', 'Celtic', 'Basel', 'Genk', 'Lille'])),
          name: 'Premier League',
        },
      ],
    });
    expect(out.bindings).toEqual([]);
  });

  it('does not bind with too few fixtures in the window', () => {
    const r = rows(5);
    const out = bindCompetitions({ now: NOW, oddsApi: [odds('k', r)], spine: [spine('1', r)] });
    expect(out.bindings).toEqual([]);
    expect(out.unbound).toEqual([
      {
        side: 'odds_api',
        key: 'k',
        reason: 'too_few_pairs',
        best: { other: '1', pairs: 5, share: 1 },
      },
      {
        side: 'spine',
        key: '1',
        reason: 'too_few_pairs',
        best: { other: 'k', pairs: 5, share: 1 },
      },
    ]);
  });

  it('counts only fixtures in [now, now + 14 days]', () => {
    const inside = rows(5);
    const outside: Row[] = [
      [-60, 'Arsenal', 'Chelsea'],
      [14 * 24 * 60 + 60, 'Everton', 'Fulham'],
      [20 * 24 * 60, 'Burnley', 'Leeds'],
    ];
    const both = [...inside, ...outside];
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', both)],
      spine: [spine('1', both)],
    });
    expect(out.bindings).toEqual([]);
    expect(out.unbound[0]).toMatchObject({ reason: 'too_few_pairs', best: { pairs: 5 } });
    const empty = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', outside)],
      spine: [spine('1', inside)],
    });
    expect(empty.unbound.find((u) => u.side === 'odds_api')?.reason).toBe('no_fixtures_in_window');
  });

  it('needs 80% of the smaller side, not of the larger', () => {
    const r = rows(10);
    // Odds API has 10 more fixtures the spine lacks: the smaller side (10) is fully paired.
    const extra = rows(10, ['Ajax', 'Porto', 'Celtic', 'Basel', 'Genk', 'Lille'], 5 * 24 * 60);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', [...r, ...extra])],
      spine: [spine('1', r)],
    });
    expect(out.bindings[0]).toMatchObject({
      pairs: 10,
      share: 1,
      oddsFixtures: 20,
      spineFixtures: 10,
    });
  });

  it('does not bind when the share is below 80%', () => {
    const r = rows(10);
    const spineRows: Row[] = r.map((row, i) => (i < 3 ? [row[0], 'Ajax', 'Porto'] : row));
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', r)],
      spine: [spine('1', spineRows)],
    });
    expect(out.bindings).toEqual([]);
    expect(out.unbound[0]).toEqual({
      side: 'odds_api',
      key: 'k',
      reason: 'share_too_low',
      best: { other: '1', pairs: 7, share: 0.7 },
    });
  });

  it('binds at exactly 80%', () => {
    const r = rows(10);
    const spineRows: Row[] = r.map((row, i) => (i < 2 ? [row[0], 'Ajax', 'Porto'] : row));
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', r)],
      spine: [spine('1', spineRows)],
    });
    expect(out.bindings[0]).toMatchObject({ pairs: 8, share: 0.8 });
  });

  it('never binds leagues that only share kickoff times', () => {
    const a = rows(12, TEAMS);
    const b = rows(12, ['Ajax', 'Porto', 'Celtic', 'Basel', 'Genk', 'Lille', 'Nice', 'Metz']);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('a', a), odds('b', b)],
      spine: [spine('1', a), spine('2', b)],
    });
    expect(out.bindings.map((x) => [x.sportKey, x.leagueId])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    const cross = bindCompetitions({ now: NOW, oddsApi: [odds('a', a)], spine: [spine('2', b)] });
    expect(cross.bindings).toEqual([]);
    expect(cross.unbound.every((u) => u.best === undefined)).toBe(true);
  });

  it('gives no binding when two spine leagues both pass (a duplicate feed)', () => {
    const r = rows(10);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', r)],
      spine: [spine('39', r), spine('9039', r)],
    });
    expect(out.bindings).toEqual([]);
    expect(out.unbound.map((u) => [u.side, u.key, u.reason])).toEqual([
      ['odds_api', 'k', 'ambiguous'],
      ['spine', '39', 'ambiguous'],
      ['spine', '9039', 'ambiguous'],
    ]);
  });

  it('gives no binding when two Odds API competitions pass with one league', () => {
    const r = rows(10);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('a', r), odds('b', r)],
      spine: [spine('1', r)],
    });
    expect(out.bindings).toEqual([]);
    expect(out.unbound.every((u) => u.reason === 'ambiguous')).toBe(true);
  });

  it('does not pair a flipped home/away', () => {
    const r = rows(10);
    const flipped: Row[] = r.map(([m, h, a]) => [m, a, h]);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', r)],
      spine: [spine('1', flipped)],
    });
    expect(out.bindings).toEqual([]);
    expect(out.unbound[0]?.best).toBeUndefined();
  });

  it('pairs kickoffs within 5 minutes and not beyond', () => {
    const r = rows(10);
    const near: Row[] = r.map(([m, h, a]) => [m + 5, h, a]);
    const far: Row[] = r.map(([m, h, a]) => [m + 6, h, a]);
    expect(
      bindCompetitions({ now: NOW, oddsApi: [odds('k', r)], spine: [spine('1', near)] }).bindings,
    ).toHaveLength(1);
    expect(
      bindCompetitions({ now: NOW, oddsApi: [odds('k', r)], spine: [spine('1', far)] }).bindings,
    ).toEqual([]);
  });

  it('does not pair a fixture with two equally good partners', () => {
    // The same fixture twice on the spine side at the same time: neither copy is unambiguous.
    const r = rows(10);
    const dup: Row[] = [...r.slice(0, 5), r[5]!, r[5]!, ...r.slice(6)];
    const out = bindCompetitions({ now: NOW, oddsApi: [odds('k', r)], spine: [spine('1', dup)] });
    expect(out.bindings[0]).toMatchObject({ pairs: 9 });
    expect(
      out.bindings[0]!.examples.every(
        (p) => p.kickoff.getTime() !== r[5]![0] * MIN + NOW.getTime(),
      ),
    ).toBe(true);
  });
});

describe('name spellings of the two providers', () => {
  const score = (a: string, b: string): number => nameSimilarity(a, [b]).score / 1000;
  const pairs = (a: string, b: string): boolean => score(a, b) >= BIND_NAME_SIMILARITY_MIN;

  it('pairs spellings that share their words and not short forms', () => {
    expect(pairs('Arsenal FC', 'Arsenal')).toBe(true);
    expect(pairs('Inter', 'Inter Milan')).toBe(true);
    expect(pairs('Brighton and Hove Albion', 'Brighton & Hove Albion')).toBe(true);
    // Documented non-pairs: the kickoff gate and the 80% share absorb them, team votes fix them.
    expect(score('Manchester United', 'Man United')).toBeCloseTo(0.433, 3);
    expect(pairs('Manchester United', 'Man United')).toBe(false);
    expect(pairs('Wolverhampton Wanderers', 'Wolves')).toBe(false);
    expect(pairs('Paris Saint Germain', 'PSG')).toBe(false);
  });

  it('never pairs sibling clubs', () => {
    for (const [a, b] of [
      ['Manchester City', 'Manchester United'],
      ['Real Madrid', 'Real Betis'],
      ['Sheffield United', 'Sheffield Wednesday'],
      ['Leeds United', 'Manchester United'],
      ['Atletico Madrid', 'Real Madrid'],
      ['AC Milan', 'Inter Milan'],
    ] as const) {
      expect(pairs(a, b)).toBe(false);
    }
  });

  it('still binds a realistic league where a few names do not match', () => {
    // 20 clubs, two rounds in the window (20 fixtures, each club twice); two clubs are spelled
    // differently by the Odds API ("Man United", "Wolves"), which costs four fixtures: 16/20 = 80%.
    const base = [
      'Manchester United',
      'Arsenal',
      'Chelsea',
      'Liverpool',
      'Everton',
      'Fulham',
      'Brentford',
      'Burnley',
      'Luton',
      'Leeds',
      'Wolverhampton Wanderers',
      'Southampton',
      'Brighton',
      'Bournemouth',
      'Nottingham Forest',
      'Aston Villa',
      'Sheffield United',
      'Watford',
      'Norwich',
      'Ipswich',
    ];
    const alt: Record<string, string> = {
      'Manchester United': 'Man United',
      'Wolverhampton Wanderers': 'Wolves',
    };
    const fixtures: Row[] = Array.from({ length: 20 }, (_, i) => [
      24 * 60 + i * 90,
      base[i]!,
      base[(i + 1) % 20]!,
    ]);
    const oddsRows = fixtures.map(([m, h, a]): Row => [m, alt[h] ?? h, alt[a] ?? a]);
    const out = bindCompetitions({
      now: NOW,
      oddsApi: [odds('k', oddsRows)],
      spine: [spine('1', fixtures)],
    });
    const unmatched = fixtures.filter(([, h, a]) => h in alt || a in alt).length;
    expect(unmatched).toBeGreaterThan(0);
    expect(unmatched).toBe(4);
    expect(out.bindings).toHaveLength(1);
    expect(out.bindings[0]!.pairs).toBe(20 - unmatched);
    expect(out.bindings[0]!.share).toBeGreaterThanOrEqual(0.8);
  });
});

describe('bindCompetitions properties', () => {
  /** [true name (as API-Football spells it), the Odds API spelling]. Leagues have disjoint clubs. */
  const LEAGUES: readonly (readonly (readonly [string, string])[])[] = [
    [
      ['Manchester United', 'Man United'],
      ['Manchester City', 'Man City'],
      ['Wolverhampton Wanderers', 'Wolves'],
      ['Tottenham Hotspur', 'Tottenham'],
      ['Newcastle United', 'Newcastle Utd'],
      ['Brighton & Hove Albion', 'Brighton and Hove Albion'],
      ['Arsenal', 'Arsenal FC'],
      ['Chelsea', 'Chelsea'],
      ['Everton', 'Everton'],
      ['Fulham', 'Fulham FC'],
    ],
    [
      ['Real Madrid', 'Real Madrid CF'],
      ['Real Betis', 'Betis'],
      ['Atletico Madrid', 'Atletico de Madrid'],
      ['Athletic Club', 'Athletic Bilbao'],
      ['Barcelona', 'FC Barcelona'],
      ['Sevilla', 'Sevilla FC'],
      ['Valencia', 'Valencia CF'],
      ['Villarreal', 'Villarreal'],
      ['Osasuna', 'CA Osasuna'],
      ['Getafe', 'Getafe CF'],
    ],
    [
      ['AC Milan', 'Milan'],
      ['Inter', 'Inter Milan'],
      ['Juventus', 'Juventus FC'],
      ['Napoli', 'SSC Napoli'],
      ['AS Roma', 'Roma'],
      ['Lazio', 'SS Lazio'],
      ['Atalanta', 'Atalanta BC'],
      ['Fiorentina', 'ACF Fiorentina'],
      ['Torino', 'Torino FC'],
      ['Bologna', 'Bologna FC'],
    ],
    [
      ['Paris Saint Germain', 'PSG'],
      ['Marseille', 'Olympique Marseille'],
      ['Lyon', 'Olympique Lyon'],
      ['Monaco', 'AS Monaco'],
      ['Lille', 'Lille OSC'],
      ['Nice', 'OGC Nice'],
      ['Lens', 'RC Lens'],
      ['Rennes', 'Stade Rennais'],
      ['Nantes', 'FC Nantes'],
      ['Reims', 'Stade de Reims'],
    ],
  ];
  const SLOTS = [14 * 60, 15 * 60, 17 * 60 + 30]; // minutes of day, shared by every league

  interface Plan {
    /** per league: present on the Odds API side, on the spine side, noise per fixture side */
    leagues: {
      onOdds: boolean;
      onSpine: boolean;
      rounds: { slot: number; day: number; order: number[]; noisy: boolean[] }[];
    }[];
    jitter: number;
  }
  const roundArb = fc.record({
    slot: fc.integer({ min: 0, max: SLOTS.length - 1 }),
    day: fc.integer({ min: 0, max: 12 }),
    order: fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { minLength: 10, maxLength: 10 }),
    noisy: fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }),
  });
  const planArb = (noise: boolean): fc.Arbitrary<Plan> =>
    fc.record({
      leagues: fc.array(
        fc.record({
          onOdds: fc.boolean(),
          onSpine: fc.boolean(),
          rounds: fc.array(
            noise ? roundArb : roundArb.map((r) => ({ ...r, noisy: r.noisy.map(() => false) })),
            { minLength: 1, maxLength: 5 },
          ),
        }),
        { minLength: LEAGUES.length, maxLength: LEAGUES.length },
      ),
      jitter: fc.integer({ min: 0, max: 5 }),
    });

  function build(plan: Plan): { oddsApi: OddsApiCompetition[]; spine: SpineCompetition[] } {
    const oddsApi: OddsApiCompetition[] = [];
    const spineOut: SpineCompetition[] = [];
    plan.leagues.forEach((lg, li) => {
      const teams = LEAGUES[li]!;
      const oRows: Row[] = [];
      const sRows: Row[] = [];
      lg.rounds.forEach((rd) => {
        const m = rd.day * 24 * 60 + SLOTS[rd.slot]!;
        for (let k = 0; k < 5; k += 1) {
          const h = teams[rd.order[2 * k]!]!;
          const a = teams[rd.order[2 * k + 1]!]!;
          const noisy = rd.noisy[2 * k]!;
          sRows.push([m, h[0], a[0]]);
          oRows.push([m + plan.jitter, noisy ? h[1] : h[0], noisy ? a[1] : a[0]]);
        }
      });
      if (lg.onOdds) oddsApi.push(odds(`soccer_${li}`, oRows));
      if (lg.onSpine) spineOut.push(spine(String(100 + li), sRows));
    });
    return { oddsApi, spine: spineOut };
  }

  const window = (m: number): boolean => m >= 0 && m <= 14 * 24 * 60;

  it('never produces a wrong binding, whatever the noise and decoys', () => {
    fc.assert(
      fc.property(planArb(true), (plan) => {
        const input = build(plan);
        const out = bindCompetitions({ now: NOW, ...input });
        for (const b of out.bindings) {
          expect(Number(b.leagueId) - 100).toBe(Number(b.sportKey.replace('soccer_', '')));
        }
        // One-to-one.
        expect(new Set(out.bindings.map((b) => b.sportKey)).size).toBe(out.bindings.length);
        expect(new Set(out.bindings.map((b) => b.leagueId)).size).toBe(out.bindings.length);
        // Every competition is either bound or explained, exactly once.
        expect(out.bindings.length * 2 + out.unbound.length).toBe(
          input.oddsApi.length + input.spine.length,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('always binds a noise-free league of at least 10 fixtures in the window', () => {
    fc.assert(
      fc.property(planArb(false), (plan) => {
        const input = build(plan);
        const out = bindCompetitions({ now: NOW, ...input });
        plan.leagues.forEach((lg, li) => {
          if (!lg.onOdds || !lg.onSpine) return;
          const n = lg.rounds.filter((r) => window(r.day * 24 * 60 + SLOTS[r.slot]!)).length * 5;
          // Repeated identical fixtures across rounds at one kickoff would be ambiguous: skip them.
          const keys = lg.rounds.map((r) => `${r.day}/${r.slot}`);
          if (n < 10 || new Set(keys).size !== keys.length) return;
          expect(
            out.bindings.some(
              (b) => b.sportKey === `soccer_${li}` && b.leagueId === String(100 + li),
            ),
          ).toBe(true);
        });
      }),
      { numRuns: 300 },
    );
  });
});
