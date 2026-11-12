import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decideTeamVotes,
  type SourceAlias,
  type SourceFixture,
  type SpineFixture,
  type TeamVote,
} from './team-votes';

const T0 = Date.UTC(2026, 7, 15, 15, 0, 0);
const MIN = 60_000;

const sp = (key: string, home: string, away: string, offsetMin = 0): SpineFixture => ({
  key,
  kickoff: new Date(T0 + offsetMin * MIN),
  homeClubId: home,
  awayClubId: away,
});
const so = (key: string, home: string, away: string, offsetMin = 0): SourceFixture => ({
  key,
  kickoff: new Date(T0 + offsetMin * MIN),
  home,
  away,
});
const al = (
  spelling: string,
  clubId: string,
  state: SourceAlias['state'] = 'active',
): SourceAlias => ({
  spelling,
  clubId,
  state,
});

/** Six matches at one kickoff: clubs a1..a6 at home against b1..b6; spellings sa1.. and sb1... */
const round = (r: number, offsetMin = 0) => {
  const spine: SpineFixture[] = [];
  const source: SourceFixture[] = [];
  for (let i = 1; i <= 6; i += 1) {
    spine.push(sp(`f${r}-${i}`, `a${i}`, `b${i}`, offsetMin));
    source.push(so(`e${r}-${i}`, `sa${i}`, `sb${i}`, offsetMin));
  }
  return { spine, source };
};

describe('decideTeamVotes: pairing', () => {
  it('pairs the one new match of a six-match 15:00 round by elimination', () => {
    const { spine, source } = round(1);
    const aliases = [1, 2, 3, 4, 5].flatMap((i) => [al(`sa${i}`, `a${i}`), al(`sb${i}`, `b${i}`)]);
    const r = decideTeamVotes({ spine, source, aliases });
    expect(r.paired).toHaveLength(6);
    expect(r.votes.map((v) => [v.spelling, v.clubId]).sort()).toEqual([
      ['sa6', 'a6'],
      ['sb6', 'b6'],
    ]);
    expect(r.unlisted).toEqual([]);
  });

  it('does not pair two new clubs in one slot with no known side', () => {
    const spine = [sp('f1', 'a1', 'b1'), sp('f2', 'a2', 'b2')];
    const source = [so('e1', 'sa1', 'sb1'), so('e2', 'sa2', 'sb2')];
    const r = decideTeamVotes({ spine, source, aliases: [] });
    expect(r.votes).toEqual([]);
    expect(r.unlisted.map((u) => u.reason)).toEqual([
      'no_unique_elimination',
      'no_unique_elimination',
    ]);
  });

  it('pairs by the one known side and votes for the other side', () => {
    const spine = [sp('f1', 'a1', 'b1'), sp('f2', 'a2', 'b2')];
    const source = [so('e1', 'sa1', 'sb1', 2), so('e2', 'sa2', 'sb2', 30)];
    const r = decideTeamVotes({ spine, source, aliases: [al('sb1', 'b1')] });
    expect(r.votes.map((v) => [v.spelling, v.clubId, v.spineFixtureKey])).toEqual([
      ['sa1', 'a1', 'f1'],
    ]);
    expect(r.unlisted.map((u) => u.sourceEventKey)).toEqual(['e2']);
  });

  it('never pairs a flipped orientation', () => {
    const spine = [sp('f1', 'a1', 'b1')];
    const one = decideTeamVotes({
      spine,
      source: [so('e1', 'sx', 'sa1')],
      aliases: [al('sa1', 'a1')],
    });
    expect(one.votes).toEqual([]);
    expect(one.unlisted[0]?.reason).toBe('flipped_orientation');
    const both = decideTeamVotes({
      spine,
      source: [so('e1', 'sb1', 'sa1')],
      aliases: [al('sa1', 'a1'), al('sb1', 'b1')],
    });
    expect(both.votes).toEqual([]);
    expect(both.suspensions).toEqual([]);
    expect(both.unlisted[0]?.reason).toBe('flipped_orientation');
  });

  it('ignores fixtures outside the tolerance', () => {
    const r = decideTeamVotes({
      spine: [sp('f1', 'a1', 'b1')],
      source: [so('e1', 'sa1', 'sb1', 6)],
      aliases: [],
    });
    expect(r.votes).toEqual([]);
    expect(r.unlisted[0]?.reason).toBe('no_spine_fixture_in_window');
  });
});

describe('decideTeamVotes: decisions', () => {
  it('suspends an active alias that a paired fixture contradicts, with evidence', () => {
    const r = decideTeamVotes({
      spine: [sp('f1', 'a1', 'b1'), sp('f2', 'a2', 'b2', 180)],
      source: [so('e1', 'sa1', 'sb1')],
      aliases: [al('sa1', 'a1'), al('sb1', 'zz')],
    });
    expect(r.suspensions).toHaveLength(1);
    expect(r.suspensions[0]).toMatchObject({ spelling: 'sb1', clubId: 'zz' });
    expect(r.suspensions[0]?.evidence[0]?.sourceEventKey).toBe('e1');
  });

  it('drops the votes of a suspended spelling so they restart', () => {
    const previous: TeamVote[] = [
      {
        spelling: 'sb1',
        clubId: 'b1',
        spineFixtureKey: 'old',
        sourceEventKey: 'x',
        kickoff: new Date(T0),
      },
    ];
    const r = decideTeamVotes({
      spine: [sp('f1', 'a1', 'b1')],
      source: [so('e1', 'sa1', 'sb1')],
      aliases: [al('sa1', 'a1'), al('sb1', 'zz')],
      previousVotes: previous,
    });
    expect(r.votes).toEqual([]);
  });

  it('keeps one vote undecided and maps at two fixtures', () => {
    const f1 = [sp('f1', 'a1', 'b1')];
    const first = decideTeamVotes({
      spine: f1,
      source: [so('e1', 'sa1', 'sb1')],
      aliases: [],
    });
    expect(first.mappings).toEqual([]);
    expect(first.undecided.map((u) => u.reason)).toEqual(['one_vote', 'one_vote']);

    const second = decideTeamVotes({
      spine: [sp('f2', 'a1', 'b2', 7 * 24 * 60)],
      source: [so('e2', 'sa1', 'sb2', 7 * 24 * 60)],
      aliases: [],
      previousVotes: first.votes,
    });
    expect(second.mappings.map((m) => [m.spelling, m.clubId])).toEqual([['sa1', 'a1']]);
    expect(second.mappings[0]?.evidence.map((e) => e.spineFixtureKey).sort()).toEqual(['f1', 'f2']);
  });

  it('counts two votes from the same fixture once', () => {
    const input = {
      spine: [sp('f1', 'a1', 'b1')],
      source: [so('e1', 'sa1', 'sb1')],
      aliases: [],
    };
    const first = decideTeamVotes(input);
    const again = decideTeamVotes({
      ...input,
      source: [so('e1-copy', 'sa1', 'sb1', 1)],
      previousVotes: first.votes,
    });
    expect(again.mappings).toEqual([]);
    expect(again.votes).toHaveLength(2);
    expect(again.undecided.every((u) => u.reason === 'one_vote')).toBe(true);
  });

  it('maps neither of two spellings that claim one club', () => {
    const day = 7 * 24 * 60;
    const r = decideTeamVotes({
      spine: [sp('f1', 'a1', 'b1'), sp('f2', 'a1', 'b2', day)],
      source: [so('e1', 'sa1', 'sb1'), so('e2', 'sa1 alt', 'sb2', day)],
      aliases: [al('sb1', 'b1'), al('sb2', 'b2')],
    });
    expect(r.mappings).toEqual([]);
    expect(r.undecided.map((u) => [u.spelling, u.reason])).toEqual([
      ['sa1', 'one_vote'],
      ['sa1 alt', 'one_vote'],
    ]);
    // with two fixtures each the claim, not the vote count, is what blocks them
    const two = decideTeamVotes({
      spine: [],
      source: [],
      aliases: [],
      previousVotes: ['f1', 'f2'].flatMap((k) =>
        ['p', 'q'].map((s) => ({
          spelling: s,
          clubId: 'a1',
          spineFixtureKey: `${s}${k}`,
          sourceEventKey: k,
          kickoff: new Date(T0),
        })),
      ),
    });
    expect(two.mappings).toEqual([]);
    expect(two.undecided.map((u) => u.reason)).toEqual([
      'club_claimed_by_other_spelling',
      'club_claimed_by_other_spelling',
    ]);
  });

  it('does not map a spelling to a club an active alias already holds', () => {
    const votes: TeamVote[] = ['f1', 'f2'].map((k) => ({
      spelling: 'new',
      clubId: 'a1',
      spineFixtureKey: k,
      sourceEventKey: k,
      kickoff: new Date(T0),
    }));
    const r = decideTeamVotes({
      spine: [],
      source: [],
      aliases: [al('old', 'a1')],
      previousVotes: votes,
    });
    expect(r.undecided[0]?.reason).toBe('club_claimed_by_other_spelling');
  });

  it('keeps a spelling with votes for two clubs undecided', () => {
    const votes: TeamVote[] = [
      {
        spelling: 'x',
        clubId: 'a1',
        spineFixtureKey: 'f1',
        sourceEventKey: 'e1',
        kickoff: new Date(T0),
      },
      {
        spelling: 'x',
        clubId: 'a1',
        spineFixtureKey: 'f2',
        sourceEventKey: 'e2',
        kickoff: new Date(T0),
      },
      {
        spelling: 'x',
        clubId: 'a2',
        spineFixtureKey: 'f3',
        sourceEventKey: 'e3',
        kickoff: new Date(T0),
      },
    ];
    const r = decideTeamVotes({ spine: [], source: [], aliases: [], previousVotes: votes });
    expect(r.mappings).toEqual([]);
    expect(r.undecided[0]).toMatchObject({ reason: 'conflicting_votes', clubIds: ['a1', 'a2'] });
  });
});

// ---- properties ----

interface League {
  spine: SpineFixture[];
  source: SourceFixture[];
  aliases: SourceAlias[];
  truth: Map<string, string>;
}

const ROUND_MS = 7 * 24 * 60 * MIN;

const leagueArb = fc
  .record({
    pairs: fc.integer({ min: 2, max: 8 }),
    rounds: fc.integer({ min: 2, max: 8 }),
    seed: fc.array(fc.nat(1000), { minLength: 400, maxLength: 400 }),
    knownMask: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
    noise: fc.integer({ min: 0, max: 6 }),
    missing: fc.array(fc.boolean(), { minLength: 80, maxLength: 80 }),
  })
  .map(({ pairs, rounds, seed, knownMask, noise, missing }): League => {
    let n = 0;
    const next = (): number => seed[n++ % seed.length] as number;
    const clubs = Array.from({ length: pairs * 2 }, (_, i) => `club${i}`);
    const spelling = (c: string): string => `src ${c}`;
    const spine: SpineFixture[] = [];
    const source: SourceFixture[] = [];
    for (let r = 0; r < rounds; r += 1) {
      const order = [...clubs].sort(() => next() - 500);
      for (let i = 0; i < pairs; i += 1) {
        const home = order[2 * i] as string;
        const away = order[2 * i + 1] as string;
        const t = T0 + r * ROUND_MS + (next() % 3) * 2 * 60 * MIN;
        const key = `${r}-${i}`;
        spine.push({ key, kickoff: new Date(t), homeClubId: home, awayClubId: away });
        if (!missing[(r * 8 + i) % missing.length]) {
          const jitter = ((next() % 11) - 5) * MIN;
          source.push({
            key: `e${key}`,
            kickoff: new Date(t + jitter),
            home: spelling(home),
            away: spelling(away),
          });
        }
      }
    }
    for (let k = 0; k < noise; k += 1) {
      source.push({
        key: `noise${k}`,
        kickoff: new Date(T0 + (next() % rounds) * ROUND_MS + 3 * 24 * 60 * MIN),
        home: `stranger h${k}`,
        away: `stranger a${k}`,
      });
    }
    const aliases = clubs
      .filter((_, i) => knownMask[i % knownMask.length])
      .map((c) => al(spelling(c), c));
    return { spine, source, aliases, truth: new Map(clubs.map((c) => [spelling(c), c])) };
  });

function assertSound(league: League, result: ReturnType<typeof decideTeamVotes>): void {
  for (const m of result.mappings) expect(league.truth.get(m.spelling)).toBe(m.clubId);
}

describe('decideTeamVotes: properties', () => {
  it('truthful source: never maps a wrong club, never suspends a correct alias', () => {
    fc.assert(
      fc.property(leagueArb, (league) => {
        const full = decideTeamVotes(league);
        assertSound(league, full);
        expect(full.suspensions).toEqual([]);
        for (const v of full.votes) expect(league.truth.get(v.spelling)).toBe(v.clubId);

        // incremental: the first half, then the second half with the votes carried over
        const mid = T0 + 4 * ROUND_MS;
        const early = decideTeamVotes({
          ...league,
          spine: league.spine.filter((f) => f.kickoff.getTime() < mid),
          source: league.source.filter((f) => f.kickoff.getTime() < mid),
        });
        const late = decideTeamVotes({
          ...league,
          spine: league.spine.filter((f) => f.kickoff.getTime() >= mid),
          source: league.source.filter((f) => f.kickoff.getTime() >= mid),
          previousVotes: early.votes,
        });
        assertSound(league, early);
        assertSound(league, late);
        expect(late.suspensions).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('one lying source fixture: no wrong mapping (suspensions allowed)', () => {
    fc.assert(
      fc.property(
        leagueArb,
        fc.nat(1000),
        fc.boolean(),
        fc.nat(1000),
        (league, pick, homeSide, other) => {
          const real = league.source.filter((s) => !s.key.startsWith('noise'));
          const victim = real[pick % Math.max(real.length, 1)];
          if (victim === undefined) return;
          const spellings = [...league.truth.keys()];
          const replacement = spellings[other % spellings.length] as string;
          const lie = league.source.map((s) =>
            s === victim ? { ...s, [homeSide ? 'home' : 'away']: replacement } : s,
          );
          const result = decideTeamVotes({ ...league, source: lie });
          assertSound(league, result);
        },
      ),
      { numRuns: 400 },
    );
  });
});
