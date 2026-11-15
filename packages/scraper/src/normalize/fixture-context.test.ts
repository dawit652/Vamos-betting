import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nameSimilarity } from './alias';
import {
  combineFixtureContexts,
  fixtureContextSuggestions,
  FIXTURE_CONTEXT_WINDOW_MS,
  STRONG_FIXTURE_SIMILARITY,
  type CatalogueFixture,
  type FixtureContextQuery,
} from './fixture-context';

const HOUR = 3_600_000;
const KICKOFF = new Date('2026-11-14T15:00:00Z');
const LEAGUE = 'comp-1';

const NAMES: Record<string, string[]> = {
  twente: ['FC Twente', 'Twente'],
  zwolle: ['PEC Zwolle', 'Zwolle'],
  ajax: ['AFC Ajax', 'Ajax'],
  psv: ['PSV Eindhoven', 'PSV'],
  heracles: ['Heracles Almelo', 'Heracles'],
};

const fixture = (
  home: string,
  away: string,
  offsetMs = 0,
  competitionId = LEAGUE,
): CatalogueFixture => ({
  competitionId,
  kickoff: new Date(KICKOFF.getTime() + offsetMs),
  homeTeamId: home,
  awayTeamId: away,
  homeNames: NAMES[home] ?? [home],
  awayNames: NAMES[away] ?? [away],
});

const query = (over: Partial<FixtureContextQuery> = {}): FixtureContextQuery => ({
  raw: 'Twente Enschede',
  side: 'home',
  kickoff: KICKOFF,
  competitionId: LEAGUE,
  opponentId: 'ajax',
  ...over,
});

describe('nameSimilarity (N3 score of a name against a list)', () => {
  it('is 1000 for the same normalised name and 0 for no names', () => {
    expect(nameSimilarity('FC Twente', ['Twente']).score).toBe(1000);
    expect(nameSimilarity('Twente', [])).toEqual({ score: 0, matchedName: '' });
  });

  it('takes the best name', () => {
    // "twente enschede" vs "twente": 1 of 2 tokens shared (500) plus the prefix bonus (100).
    expect(nameSimilarity('Twente Enschede', ['Ajax', 'Twente'])).toEqual({
      score: 600,
      matchedName: 'twente',
    });
  });
});

describe('fixtureContextSuggestions (rule N4)', () => {
  it('a unique fixture against the opponent with a similar name is strong', () => {
    const result = fixtureContextSuggestions(query(), [
      fixture('twente', 'ajax', 2 * HOUR),
      fixture('psv', 'zwolle'),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.strong).toMatchObject({ teamId: 'twente', score: 0.6, matchedName: 'twente' });
  });

  it('a unique fixture with a dissimilar name is a candidate, not strong', () => {
    const result = fixtureContextSuggestions(query({ raw: 'Tukkers' }), [
      fixture('twente', 'ajax'),
    ]);
    expect(result.candidates.map((c) => c.teamId)).toEqual(['twente']);
    expect(result.strong).toBeNull();
  });

  it('two candidate teams (a conflict in the catalogue) are never strong', () => {
    const result = fixtureContextSuggestions(query(), [
      fixture('twente', 'ajax'),
      fixture('heracles', 'ajax', 3 * HOUR),
    ]);
    expect(result.candidates.map((c) => c.teamId)).toEqual(['twente', 'heracles']);
    expect(result.strong).toBeNull();
  });

  it('the same team from two fixtures (event and observation) is one candidate', () => {
    const result = fixtureContextSuggestions(query(), [
      fixture('twente', 'ajax'),
      fixture('twente', 'ajax', HOUR),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.strong?.kickoff).toEqual(KICKOFF);
  });

  it('respects the side, the competition and the ±24 h window', () => {
    const fixtures = [
      fixture('ajax', 'twente'), // the opponent on the wrong side
      fixture('twente', 'ajax', 0, 'comp-2'), // another competition
      fixture('twente', 'ajax', FIXTURE_CONTEXT_WINDOW_MS + 1), // a day and a bit later
      fixture('twente', 'ajax', -FIXTURE_CONTEXT_WINDOW_MS - 1),
    ];
    expect(fixtureContextSuggestions(query(), fixtures).candidates).toEqual([]);
    // Exactly 24 h is still in.
    expect(
      fixtureContextSuggestions(query(), [fixture('twente', 'ajax', -FIXTURE_CONTEXT_WINDOW_MS)])
        .strong?.teamId,
    ).toBe('twente');
    // The away side reads the home team as the opponent.
    expect(
      fixtureContextSuggestions(query({ side: 'away', opponentId: 'twente', raw: 'Ajax A' }), [
        fixture('twente', 'ajax'),
      ]).candidates.map((c) => c.teamId),
    ).toEqual(['ajax']);
  });

  it('combining sightings: agreement stays strong, disagreement is not strong', () => {
    const a = fixtureContextSuggestions(query(), [fixture('twente', 'ajax')]);
    const b = fixtureContextSuggestions(query({ opponentId: 'psv' }), [fixture('twente', 'psv')]);
    const c = fixtureContextSuggestions(query({ opponentId: 'psv' }), [fixture('heracles', 'psv')]);
    expect(combineFixtureContexts([a, b]).strong?.teamId).toBe('twente');
    expect(combineFixtureContexts([a, c]).strong).toBeNull();
    expect(combineFixtureContexts([]).strong).toBeNull();
  });

  // --- properties -----------------------------------------------------------------

  const TEAMS = ['twente', 'zwolle', 'ajax', 'psv', 'heracles', 'x1', 'x2'];
  const team = fc.constantFrom(...TEAMS);
  const arbFixture = fc
    .record({
      home: team,
      away: team,
      offset: fc.integer({ min: -3 * 24, max: 3 * 24 }).map((h) => h * HOUR),
      competition: fc.constantFrom(LEAGUE, 'comp-2'),
    })
    .filter((f) => f.home !== f.away)
    .map((f) => fixture(f.home, f.away, f.offset, f.competition));
  const arbQuery = fc.record({
    raw: fc.constantFrom('Twente Enschede', 'Twente', 'Zwolle', 'Tukkers', 'PSV', 'Heracles'),
    side: fc.constantFrom('home' as const, 'away' as const),
    opponentId: team,
  });

  it('property: strong only with exactly one candidate scoring at least 0.6', () => {
    fc.assert(
      fc.property(arbQuery, fc.array(arbFixture, { maxLength: 8 }), (q, fixtures) => {
        const result = fixtureContextSuggestions(query(q), fixtures);
        if (result.candidates.length !== 1) expect(result.strong).toBeNull();
        if (result.strong !== null) {
          expect(result.candidates).toEqual([result.strong]);
          expect(result.strong.score).toBeGreaterThanOrEqual(STRONG_FIXTURE_SIMILARITY);
        }
      }),
    );
  });

  it('property: never suggests the opponent; candidates are distinct, in the window and against the opponent', () => {
    fc.assert(
      fc.property(arbQuery, fc.array(arbFixture, { maxLength: 8 }), (q, fixtures) => {
        const result = fixtureContextSuggestions(query(q), fixtures);
        const ids = result.candidates.map((c) => c.teamId);
        expect(ids).not.toContain(q.opponentId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of result.candidates) {
          expect(c.score).toBeGreaterThanOrEqual(0);
          expect(c.score).toBeLessThanOrEqual(1);
          expect(Math.abs(c.kickoff.getTime() - KICKOFF.getTime())).toBeLessThanOrEqual(
            FIXTURE_CONTEXT_WINDOW_MS,
          );
          const witness = fixtures.some(
            (f) =>
              f.competitionId === LEAGUE &&
              (q.side === 'home'
                ? f.homeTeamId === c.teamId && f.awayTeamId === q.opponentId
                : f.awayTeamId === c.teamId && f.homeTeamId === q.opponentId),
          );
          expect(witness).toBe(true);
        }
      }),
    );
  });

  it('property: the result does not depend on the order of the fixtures', () => {
    fc.assert(
      fc.property(
        arbQuery,
        fc.array(arbFixture, { maxLength: 8 }),
        fc.integer(),
        (q, fixtures, seed) => {
          const shuffled = [...fixtures].sort(
            (a, b) =>
              ((a.kickoff.getTime() ^ seed) % 7) - ((b.kickoff.getTime() ^ seed) % 7) ||
              a.homeTeamId.localeCompare(b.homeTeamId),
          );
          const one = fixtureContextSuggestions(query(q), fixtures);
          const two = fixtureContextSuggestions(query(q), [...shuffled].reverse());
          expect(two.candidates.map((c) => [c.teamId, c.score])).toEqual(
            one.candidates.map((c) => [c.teamId, c.score]),
          );
          expect(two.strong?.teamId).toEqual(one.strong?.teamId);
        },
      ),
    );
  });

  it('property: combining is never strong with zero or several teams across the sightings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbQuery, fc.array(arbFixture, { maxLength: 5 })), { maxLength: 4 }),
        (sightings) => {
          const results = sightings.map(([q, f]) => fixtureContextSuggestions(query(q), f));
          const combined = combineFixtureContexts(results);
          const teams = new Set(results.flatMap((r) => r.candidates.map((c) => c.teamId)));
          if (teams.size !== 1) expect(combined.strong).toBeNull();
          if (combined.strong !== null) {
            expect(teams).toEqual(new Set([combined.strong.teamId]));
          }
        },
      ),
    );
  });
});
