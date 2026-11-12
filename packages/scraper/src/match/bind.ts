import { nameSimilarity } from '../normalize/alias';
import { STRONG_FIXTURE_SIMILARITY } from '../normalize/fixture-context';

/**
 * Bind (docs/plans/hulusport-parity-plan.md 4.3 step 2; the pure core of the league factory's
 * competition binding). No I/O.
 *
 * A Odds API competition (sport key) and an API-Football league are the SAME competition when,
 * over the window [now, now + 14 days]:
 *  - at least `minPairs` (6) of their fixtures pair up. A pair is kickoff within 5 minutes AND both
 *    team names alike in the same orientation. Pairing is unambiguous and one-to-one: each fixture
 *    takes only its single best partner, and only when that partner picks it back; a fixture with
 *    two equally good partners pairs with neither; and
 *  - at least `minShare` (80%) of ALL fixtures of the SMALLER side in the window pair up.
 * Bindings are one-to-one: a competition that passes with two candidates (or whose only candidate
 * is claimed by another) is bound to none (`ambiguous`). Competition names never decide anything;
 * they are carried into the evidence as a note only.
 *
 * "Alike" is the N3/N4 similarity (`nameSimilarity`: token Jaccard plus a 3-letter first-token
 * prefix bonus, both sides N1-normalised) at or above `STRONG_FIXTURE_SIMILARITY` (0.6), the bar rule
 * N4 already uses for a lone fixture-context candidate. Why 0.6: sibling clubs that share one token
 * score 0.33 (+0.10 when the first token shares a prefix: Manchester City / Manchester United,
 * Real Madrid / Real Betis, Sheffield United / Sheffield Wednesday = 0.43), so they never pass;
 * "Inter" / "Inter Milan" scores 0.6 and does. Spellings with no shared token ("Wolverhampton
 * Wanderers" / "Wolves" 0.10, "Paris Saint Germain" / "PSG" 0.0) and short forms ("Manchester
 * United" / "Man United" 0.43) do not pair; the 80% gate tolerates a few of those, and the kickoff
 * is the other half of the evidence (team votes, the next step, fix the spellings).
 */

export const DEFAULT_BIND_WINDOW_MS = 14 * 24 * 3_600_000;
export const DEFAULT_BIND_KICKOFF_TOLERANCE_MS = 5 * 60_000;
export const DEFAULT_BIND_MIN_PAIRS = 6;
export const DEFAULT_BIND_MIN_SHARE = 0.8;
/** Both names of a pair need at least this similarity (0..1). */
export const BIND_NAME_SIMILARITY_MIN = STRONG_FIXTURE_SIMILARITY;

export interface OddsApiBindFixture {
  id: string;
  kickoff: Date;
  home: string;
  away: string;
}

export interface SpineBindFixture {
  id: string;
  kickoff: Date;
  homeTeamId: string;
  awayTeamId: string;
  home: string;
  away: string;
}

export interface OddsApiCompetition {
  sportKey: string;
  /** Evidence note only. */
  name?: string;
  fixtures: readonly OddsApiBindFixture[];
}

export interface SpineCompetition {
  leagueId: string;
  /** Evidence note only. */
  name?: string;
  fixtures: readonly SpineBindFixture[];
}

export interface BindInput {
  oddsApi: readonly OddsApiCompetition[];
  spine: readonly SpineCompetition[];
  now: Date;
  windowMs?: number;
  kickoffToleranceMs?: number;
  minPairs?: number;
  minShare?: number;
  minNameSimilarity?: number;
}

export interface BindPair {
  oddsEventId: string;
  spineFixtureId: string;
  kickoff: Date;
  oddsHome: string;
  oddsAway: string;
  spineHome: string;
  spineAway: string;
}

export interface Binding {
  sportKey: string;
  leagueId: string;
  pairs: number;
  /** pairs / fixtures of the smaller side in the window (0..1). */
  share: number;
  oddsFixtures: number;
  spineFixtures: number;
  /** The first few pairs (by kickoff, then id). */
  examples: BindPair[];
  /** Competition names as the providers give them: a note, never a reason. */
  names: { oddsApi: string | null; spine: string | null };
}

export type UnboundReason =
  'no_fixtures_in_window' | 'too_few_pairs' | 'share_too_low' | 'ambiguous';

export interface Unbound {
  side: 'odds_api' | 'spine';
  key: string;
  reason: UnboundReason;
  /** The best other competition (most pairs) when any fixture paired. */
  best?: { other: string; pairs: number; share: number };
}

export interface BindResult {
  bindings: Binding[];
  unbound: Unbound[];
}

const MAX_EXAMPLES = 3;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Overlap {
  oddsKey: string;
  spineKey: string;
  pairs: BindPair[];
  share: number;
  passes: boolean;
}

export function bindCompetitions(input: BindInput): BindResult {
  const windowMs = input.windowMs ?? DEFAULT_BIND_WINDOW_MS;
  const tol = input.kickoffToleranceMs ?? DEFAULT_BIND_KICKOFF_TOLERANCE_MS;
  const minPairs = input.minPairs ?? DEFAULT_BIND_MIN_PAIRS;
  const minShare = input.minShare ?? DEFAULT_BIND_MIN_SHARE;
  const minSim = input.minNameSimilarity ?? BIND_NAME_SIMILARITY_MIN;
  const from = input.now.getTime();
  const to = from + windowMs;
  const inWindow = (d: Date): boolean => {
    const t = d.getTime();
    return t >= from && t <= to;
  };

  const simCache = new Map<string, number>();
  const similar = (a: string, b: string): number => {
    const key = `${a}\u0000${b}`;
    let s = simCache.get(key);
    if (s === undefined) {
      s = nameSimilarity(a, [b]).score / 1000;
      simCache.set(key, s);
    }
    return s;
  };

  const odds = [...input.oddsApi]
    .sort((a, b) => byText(a.sportKey, b.sportKey))
    .map((c) => ({ c, fx: c.fixtures.filter((f) => inWindow(f.kickoff)) }));
  const spine = [...input.spine]
    .sort((a, b) => byText(a.leagueId, b.leagueId))
    .map((c) => ({ c, fx: c.fixtures.filter((f) => inWindow(f.kickoff)) }));

  /** The pairs between two competitions' window fixtures (mutual unique best partner). */
  const pairUp = (o: readonly OddsApiBindFixture[], s: readonly SpineBindFixture[]): BindPair[] => {
    const bestOf = <A extends { kickoff: Date }, B extends { kickoff: Date }>(
      list: readonly A[],
      others: readonly B[],
      score: (a: A, b: B) => number,
      idOf: (x: A | B) => string,
    ): Map<string, string | null> => {
      const out = new Map<string, string | null>();
      for (const a of list) {
        let top = -1;
        let topId: string | null = null;
        for (const b of others) {
          if (Math.abs(a.kickoff.getTime() - b.kickoff.getTime()) > tol) continue;
          const sc = score(a, b);
          if (sc < 0) continue;
          if (sc > top) {
            top = sc;
            topId = idOf(b);
          } else if (sc === top) topId = null; // tie for best: no partner
        }
        if (top >= 0) out.set(idOf(a), topId);
      }
      return out;
    };
    // A candidate needs BOTH names alike; its score is the sum of the two similarities.
    const pairScore = (a: OddsApiBindFixture, b: SpineBindFixture): number => {
      const h = similar(a.home, b.home);
      const w = similar(a.away, b.away);
      return h >= minSim && w >= minSim ? h + w : -1;
    };
    const idOf = (x: { id: string }): string => x.id;
    const oBest = bestOf(o, s, pairScore, idOf);
    const sBest = bestOf(s, o, (b, a) => pairScore(a, b), idOf);
    const oById = new Map(o.map((f) => [f.id, f]));
    const out: BindPair[] = [];
    for (const f of s) {
      const partner = sBest.get(f.id);
      if (partner === undefined || partner === null) continue;
      if (oBest.get(partner) !== f.id) continue;
      const a = oById.get(partner);
      if (a === undefined) continue;
      out.push({
        oddsEventId: a.id,
        spineFixtureId: f.id,
        kickoff: a.kickoff,
        oddsHome: a.home,
        oddsAway: a.away,
        spineHome: f.home,
        spineAway: f.away,
      });
    }
    return out.sort(
      (x, y) =>
        x.kickoff.getTime() - y.kickoff.getTime() ||
        byText(x.oddsEventId, y.oddsEventId) ||
        byText(x.spineFixtureId, y.spineFixtureId),
    );
  };

  const overlaps: Overlap[] = [];
  for (const o of odds) {
    for (const s of spine) {
      const smaller = Math.min(o.fx.length, s.fx.length);
      if (smaller === 0) continue;
      const pairs = pairUp(o.fx, s.fx);
      if (pairs.length === 0) continue;
      const share = pairs.length / smaller;
      overlaps.push({
        oddsKey: o.c.sportKey,
        spineKey: s.c.leagueId,
        pairs,
        share,
        passes: pairs.length >= minPairs && share >= minShare,
      });
    }
  }

  const passing = overlaps.filter((x) => x.passes);
  const passesOf = (side: 'odds' | 'spine', key: string): Overlap[] =>
    passing.filter((x) => (side === 'odds' ? x.oddsKey : x.spineKey) === key);

  const bindings: Binding[] = [];
  const unbound: Unbound[] = [];
  const bound = { odds: new Set<string>(), spine: new Set<string>() };
  const oddsBy = new Map(odds.map((o) => [o.c.sportKey, o]));
  const spineBy = new Map(spine.map((s) => [s.c.leagueId, s]));

  for (const x of passing) {
    if (passesOf('odds', x.oddsKey).length !== 1 || passesOf('spine', x.spineKey).length !== 1) {
      continue;
    }
    const o = oddsBy.get(x.oddsKey);
    const s = spineBy.get(x.spineKey);
    if (o === undefined || s === undefined) continue;
    bound.odds.add(x.oddsKey);
    bound.spine.add(x.spineKey);
    bindings.push({
      sportKey: x.oddsKey,
      leagueId: x.spineKey,
      pairs: x.pairs.length,
      share: x.share,
      oddsFixtures: o.fx.length,
      spineFixtures: s.fx.length,
      examples: x.pairs.slice(0, MAX_EXAMPLES),
      names: { oddsApi: o.c.name ?? null, spine: s.c.name ?? null },
    });
  }
  bindings.sort((a, b) => byText(a.sportKey, b.sportKey) || byText(a.leagueId, b.leagueId));

  const explain = (
    side: 'odds_api' | 'spine',
    key: string,
    fxCount: number,
    mine: readonly Overlap[],
    ambiguous: boolean,
  ): Unbound => {
    if (fxCount === 0) return { side, key, reason: 'no_fixtures_in_window' };
    const otherOf = (x: Overlap): string => (side === 'odds_api' ? x.spineKey : x.oddsKey);
    const best = [...mine].sort(
      (a, b) =>
        b.pairs.length - a.pairs.length || b.share - a.share || byText(otherOf(a), otherOf(b)),
    )[0];
    const info =
      best === undefined
        ? {}
        : { best: { other: otherOf(best), pairs: best.pairs.length, share: best.share } };
    if (ambiguous) return { side, key, reason: 'ambiguous', ...info };
    if (best === undefined || best.pairs.length < minPairs) {
      return { side, key, reason: 'too_few_pairs', ...info };
    }
    return { side, key, reason: 'share_too_low', ...info };
  };

  for (const o of odds) {
    if (bound.odds.has(o.c.sportKey)) continue;
    const mine = overlaps.filter((x) => x.oddsKey === o.c.sportKey);
    unbound.push(
      explain(
        'odds_api',
        o.c.sportKey,
        o.fx.length,
        mine,
        mine.some((x) => x.passes),
      ),
    );
  }
  for (const s of spine) {
    if (bound.spine.has(s.c.leagueId)) continue;
    const mine = overlaps.filter((x) => x.spineKey === s.c.leagueId);
    unbound.push(
      explain(
        'spine',
        s.c.leagueId,
        s.fx.length,
        mine,
        mine.some((x) => x.passes),
      ),
    );
  }
  return { bindings, unbound };
}
