import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildAliasIndex,
  resolveCompetition,
  resolveTeam,
  suggestCompetitions,
  suggestTeams,
} from './alias';
import type { AliasIndexInput } from './alias';
import { normalizeName } from './name';

const input: AliasIndexInput = {
  teams: [
    {
      id: 't-mu',
      sportId: 'football',
      shortName: 'Man Utd',
      names: ['Manchester United', 'Manchester United FC'],
    },
    { id: 't-mc', sportId: 'football', shortName: 'Man City', names: ['Manchester City'] },
    { id: 't-ars', sportId: 'football', shortName: 'Arsenal', names: ['Arsenal FC'] },
    { id: 't-ars-w', sportId: 'football', shortName: 'Arsenal W', names: ['Arsenal Women'] },
    { id: 't-sp1', sportId: 'football', shortName: 'Spartak', names: ['Spartak Moscow'] },
    { id: 't-sp2', sportId: 'football', shortName: 'Spartak T', names: ['Spartak Trnava'] },
    { id: 't-bas', sportId: 'basketball', shortName: 'Arsenal', names: ['Arsenal Tula'] },
    {
      id: 't-ebc',
      sportId: 'football',
      shortName: 'Buna',
      names: ['Ethiopian Coffee', 'ኢትዮጵያ ቡና'],
    },
  ],
  teamAliases: [
    { aliasNorm: 'united', sourceId: null, teamId: 't-mu' },
    { aliasNorm: 'spartak', sourceId: null, teamId: 't-sp1' },
    { aliasNorm: 'spartak', sourceId: null, teamId: 't-sp2' },
    { aliasNorm: 'the gunners', sourceId: 'src-a', teamId: 't-ars' },
    { aliasNorm: 'the gunners', sourceId: 'src-b', teamId: 't-ars-w' },
    { aliasNorm: 'city', sourceId: null, teamId: 't-mc' },
    { aliasNorm: 'city', sourceId: 'src-a', teamId: 't-mu' },
    { aliasNorm: 'Man. Utd FC', sourceId: null, teamId: 't-mu' },
    { aliasNorm: 'ghost', sourceId: null, teamId: 't-missing' },
    { aliasNorm: '', sourceId: null, teamId: 't-mu' },
  ],
  competitions: [
    {
      id: 'c-epl',
      slug: 'premier-league',
      sportId: 'football',
      names: ['Premier League', 'English Premier League'],
    },
    {
      id: 'c-eth',
      slug: 'ethiopian-premier-league',
      sportId: 'football',
      names: ['Ethiopian Premier League'],
    },
    { id: 'c-d1', slug: 'dup-1', sportId: 'football', names: ['Cup'] },
    { id: 'c-d2', slug: 'dup-2', sportId: 'football', names: ['The Cup'] },
  ],
  competitionAliases: [{ aliasNorm: 'epl', sourceId: null, competitionId: 'c-epl' }],
};
const index = buildAliasIndex(input);
const team = (raw: string, sourceId = 'src-x', sportId = 'football') =>
  resolveTeam(index, { sportId, sourceId, raw });

describe('N2 resolveTeam', () => {
  it('N2 resolves by catalogue name and short name, after normalisation', () => {
    expect(team('MANCHESTER UNITED')).toEqual({ status: 'resolved', id: 't-mu', via: 'name' });
    expect(team('Man City')).toEqual({ status: 'resolved', id: 't-mc', via: 'name' });
    expect(team('  man   CITY  FC ')).toEqual({ status: 'resolved', id: 't-mc', via: 'name' });
    expect(team('ኢትዮጵያ ቡና')).toEqual({ status: 'resolved', id: 't-ebc', via: 'name' });
  });

  it('N2 the same team listed twice under one normal form is not ambiguous', () => {
    expect(team('Manchester United FC')).toEqual({ status: 'resolved', id: 't-mu', via: 'name' });
  });

  it('N2 global alias beats catalogue name; aliases are normalised on load', () => {
    expect(team('United')).toEqual({ status: 'resolved', id: 't-mu', via: 'alias' });
    // 'Man. Utd FC' is stored un-normalised; it also equals the short name, the alias wins.
    expect(team('man utd')).toEqual({ status: 'resolved', id: 't-mu', via: 'alias' });
  });

  it('N2 source alias beats global alias and is limited to its source', () => {
    expect(team('city', 'src-a')).toEqual({ status: 'resolved', id: 't-mu', via: 'source_alias' });
    expect(team('city', 'src-b')).toEqual({ status: 'resolved', id: 't-mc', via: 'alias' });
    expect(team('the gunners', 'src-a')).toEqual({
      status: 'resolved',
      id: 't-ars',
      via: 'source_alias',
    });
    expect(team('the gunners', 'src-b')).toEqual({
      status: 'resolved',
      id: 't-ars-w',
      via: 'source_alias',
    });
    expect(team('the gunners', 'src-c')).toEqual({ status: 'unknown' });
  });

  it('N2 two teams under one name is ambiguous with sorted ids, never picked', () => {
    expect(team('spartak')).toEqual({ status: 'ambiguous', ids: ['t-sp1', 't-sp2'] });
  });

  it('N2 ambiguity at a level is not hidden by a weaker level', () => {
    const idx = buildAliasIndex({
      ...input,
      teamAliases: [
        { aliasNorm: 'arsenal', sourceId: 's', teamId: 't-ars' },
        { aliasNorm: 'arsenal', sourceId: 's', teamId: 't-ars-w' },
      ],
    });
    expect(resolveTeam(idx, { sportId: 'football', sourceId: 's', raw: 'Arsenal' })).toEqual({
      status: 'ambiguous',
      ids: ['t-ars', 't-ars-w'],
    });
  });

  it('N2 unknown for near misses: never fuzzy', () => {
    expect(team('Manchester Utd')).toEqual({ status: 'unknown' });
    expect(team('Manchester Unite')).toEqual({ status: 'unknown' });
    expect(team('Arsenal Ladies')).toEqual({ status: 'unknown' });
  });

  it('N2 a name that normalises to nothing is unknown', () => {
    expect(team('')).toEqual({ status: 'unknown' });
    expect(team(' - . ')).toEqual({ status: 'unknown' });
  });

  it('N2 sports are separate namespaces', () => {
    expect(team('Arsenal', 'x', 'football')).toEqual({
      status: 'resolved',
      id: 't-ars',
      via: 'name',
    });
    expect(team('Arsenal', 'x', 'basketball')).toEqual({
      status: 'resolved',
      id: 't-bas',
      via: 'name',
    });
    expect(team('Arsenal', 'x', 'tennis')).toEqual({ status: 'unknown' });
  });

  it('N2 aliases of teams missing from the catalogue are ignored', () => {
    expect(team('ghost')).toEqual({ status: 'unknown' });
  });

  it('N2 resolveCompetition follows the same precedence', () => {
    const c = (raw: string, sourceId = 's') =>
      resolveCompetition(index, { sportId: 'football', sourceId, raw });
    expect(c('EPL')).toEqual({ status: 'resolved', id: 'c-epl', via: 'alias' });
    expect(c('English Premier League')).toEqual({ status: 'resolved', id: 'c-epl', via: 'name' });
    expect(c('premier league')).toEqual({ status: 'resolved', id: 'c-epl', via: 'name' });
    expect(c('Premier')).toEqual({ status: 'unknown' });
    expect(c('')).toEqual({ status: 'unknown' });
    // Both competitions' names normalise differently, so no collision here:
    expect(c('Cup')).toEqual({ status: 'resolved', id: 'c-d1', via: 'name' });
  });

  it('N2 two competitions sharing a normal form are ambiguous', () => {
    const idx = buildAliasIndex({
      ...input,
      competitions: [
        { id: 'c1', slug: 'a', sportId: 'football', names: ['Super Cup'] },
        { id: 'c2', slug: 'b', sportId: 'football', names: ['SUPER CUP.'] },
      ],
      competitionAliases: [],
    });
    expect(
      resolveCompetition(idx, { sportId: 'football', sourceId: 's', raw: 'super cup' }),
    ).toEqual({
      status: 'ambiguous',
      ids: ['c1', 'c2'],
    });
  });

  it('N2 property: any catalogue name resolves to its team in any casing/spacing', () => {
    const names = input.teams
      .filter((t) => t.id !== 't-bas')
      .flatMap((t) => [...t.names, t.shortName].map((name) => ({ id: t.id, name })));
    fc.assert(
      fc.property(fc.constantFrom(...names), fc.boolean(), ({ id, name }, upper) => {
        const raw = ` ${upper ? name.toUpperCase() : name.toLowerCase()} `.replace(/ /g, '  ');
        const r = team(raw);
        expect(r.status).not.toBe('unknown');
        if (r.status === 'resolved') expect(r.id).toBe(id);
      }),
    );
  });

  it('N2 property: resolution never throws and a resolved id is a catalogue id', () => {
    const known = new Set(input.teams.map((t) => t.id));
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (raw) => {
        const r = team(raw);
        if (r.status === 'resolved') expect(known.has(r.id)).toBe(true);
        if (r.status === 'ambiguous') expect(r.ids.length).toBeGreaterThan(1);
      }),
    );
  });
});

describe('N3 suggestions', () => {
  const s = (raw: string, limit?: number) =>
    suggestTeams(index, { sportId: 'football', raw, ...(limit === undefined ? {} : { limit }) });

  it('N3 ranks by token overlap with a deterministic tie-break', () => {
    const out = s('Manchester Utd');
    expect(out.map((x) => x.id)).toEqual(['t-mc', 't-mu']);
    expect(out[0]?.matchedName).toBe('manchester city');
    expect(out.every((x) => x.score >= 250)).toBe(true);
  });

  it('N3 ties break by id ascending', () => {
    const idx = buildAliasIndex({
      teams: [
        { id: 'b', sportId: 'f', shortName: 'Bb', names: ['Dinamo Alpha'] },
        { id: 'a', sportId: 'f', shortName: 'Aa', names: ['Dinamo Beta'] },
      ],
      teamAliases: [],
      competitions: [],
      competitionAliases: [],
    });
    const out = suggestTeams(idx, { sportId: 'f', raw: 'Dinamo Gamma' });
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
    expect(out[0]?.score).toBe(out[1]?.score);
  });

  it('N3 never returns a team whose normalised name equals the query', () => {
    expect(s('Arsenal').map((x) => x.id)).not.toContain('t-ars');
    expect(s('Arsenal FC').map((x) => x.id)).not.toContain('t-ars');
    expect(s('Arsenal').map((x) => x.id)).toContain('t-ars-w');
  });

  it('N3 honours the limit (default 3), the minimum score and the sport', () => {
    expect(s('Manchester Spartak Arsenal United City Trnava Women', 20).length).toBeLessThanOrEqual(
      8,
    );
    expect(s('Manchester Spartak Arsenal United City Trnava Women').length).toBeLessThanOrEqual(3);
    expect(s('Manchester United FC Utd', 1).length).toBeLessThanOrEqual(1);
    expect(s('Zzyzx Qwerty')).toEqual([]);
    expect(s('Manchester', 0)).toEqual([]);
    expect(s('')).toEqual([]);
    expect(
      suggestTeams(index, { sportId: 'basketball', raw: 'Arsenal Kyiv' }).map((x) => x.id),
    ).toEqual(['t-bas']);
  });

  it('N3 suggestCompetitions', () => {
    const out = suggestCompetitions(index, { sportId: 'football', raw: 'Premier League Ethiopia' });
    expect(out.map((x) => x.id)).toEqual(['c-epl', 'c-eth']);
  });

  it('N3 property: sorted, bounded, never an exact name match, deterministic', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.integer({ min: 0, max: 6 }), (raw, limit) => {
        const out = s(raw, limit);
        expect(out).toEqual(s(raw, limit));
        expect(out.length).toBeLessThanOrEqual(limit);
        for (let i = 1; i < out.length; i += 1) {
          const prev = out[i - 1];
          const cur = out[i];
          if (!prev || !cur) throw new Error('unreachable');
          expect(prev.score > cur.score || (prev.score === cur.score && prev.id < cur.id)).toBe(
            true,
          );
        }
        const q = normalizeName(raw);
        for (const x of out) expect(x.matchedName).not.toBe(q);
      }),
    );
  });
});

describe('N2b resolveTeam falls back to the name without its legal form', () => {
  const relaxed = buildAliasIndex({
    teams: [
      { id: 't-bjk', sportId: 'football', shortName: 'Beşiktaş', names: ['Beşiktaş JK'] },
      { id: 't-fal', sportId: 'football', shortName: 'Falkirk', names: ['Falkirk FC'] },
      { id: 't-kon', sportId: 'football', shortName: 'Konyaspor', names: ['Konyaspor'] },
      { id: 't-oli1', sportId: 'football', shortName: 'Olimpia', names: ['Olimpia'] },
      { id: 't-oli2', sportId: 'football', shortName: 'Olimpia SK', names: ['Olimpia SK'] },
      { id: 't-bas', sportId: 'basketball', shortName: 'Roma', names: ['Roma'] },
    ],
    teamAliases: [],
    competitions: [{ id: 'c-sl', slug: 'super-lig', sportId: 'football', names: ['Super Lig'] }],
    competitionAliases: [],
  });
  const resolve = (raw: string, sportId = 'football') =>
    resolveTeam(relaxed, { sportId, sourceId: 'src-x', raw });

  it('resolves a name that differs only in its legal form or a sponsor prefix', () => {
    expect(resolve('Besiktas JK')).toEqual({ status: 'resolved', id: 't-bjk', via: 'name' });
    expect(resolve('Beşiktaş A.Ş.')).toEqual({
      status: 'resolved',
      id: 't-bjk',
      via: 'name_relaxed',
    });
    expect(resolve('Falkirk F.C.')).toEqual({
      status: 'resolved',
      id: 't-fal',
      via: 'name_relaxed',
    });
    expect(resolve('Torku Konyaspor')).toEqual({
      status: 'resolved',
      id: 't-kon',
      via: 'name_relaxed',
    });
  });

  it('exact names still win, and a relaxed name shared by two teams stays unknown', () => {
    expect(resolve('Olimpia SK')).toEqual({ status: 'resolved', id: 't-oli2', via: 'name' });
    expect(resolve('Olimpia')).toEqual({ status: 'resolved', id: 't-oli1', via: 'name' });
    expect(resolve('Olimpia FK')).toEqual({ status: 'unknown' });
  });

  it('keeps sports apart and never relaxes competitions', () => {
    expect(resolve('AS Roma')).toEqual({ status: 'unknown' });
    expect(resolve('AS Roma', 'basketball')).toEqual({
      status: 'resolved',
      id: 't-bas',
      via: 'name_relaxed',
    });
    expect(
      resolveCompetition(relaxed, { sportId: 'football', sourceId: 'src-x', raw: 'Super Lig AS' }),
    ).toEqual({ status: 'unknown' });
  });
});

describe('L1 and L2: what other sources teach (docs/plans/name-learning.md)', () => {
  const learnedInput: AliasIndexInput = {
    teams: [
      { id: 't-hof', sportId: 'football', shortName: 'Hoffenheim', names: ['TSG Hoffenheim'] },
      { id: 't-dyn-d', sportId: 'football', shortName: 'Dresden', names: ['Dynamo Dresden'] },
      { id: 't-dyn-k', sportId: 'football', shortName: 'Kyiv', names: ['Dynamo Kyiv'] },
      { id: 't-new', sportId: 'football', shortName: 'Newly Added', names: ['Newly Added FC'] },
    ],
    teamAliases: [
      { aliasNorm: '1899 hoffenheim', sourceId: 'src-a', teamId: 't-hof' },
      { aliasNorm: 'dynamo', sourceId: 'src-a', teamId: 't-dyn-d' },
      { aliasNorm: 'dynamo', sourceId: 'src-b', teamId: 't-dyn-k' },
      { aliasNorm: 'newbie', sourceId: 'src-a', teamId: 't-new' },
    ],
    competitions: [
      {
        id: 'c-bl',
        slug: 'bundesliga',
        sportId: 'football',
        names: ['Bundesliga'],
        countryCategoryId: 'cat-de',
      },
      {
        id: 'c-pokal',
        slug: 'dfb-pokal',
        sportId: 'football',
        names: ['DFB-Pokal'],
        countryCategoryId: 'cat-de',
      },
      {
        id: 'c-upl',
        slug: 'ukraine-premier-league',
        sportId: 'football',
        names: ['Ukrainian Premier League'],
        countryCategoryId: 'cat-ua',
      },
      {
        id: 'c-uel',
        slug: 'uefa-europa-league',
        sportId: 'football',
        names: ['Europa League'],
        countryCategoryId: null,
      },
      {
        id: 'c-epl',
        slug: 'premier-league',
        sportId: 'football',
        names: ['Premier League'],
        countryCategoryId: 'cat-en',
      },
    ],
    competitionAliases: [
      { aliasNorm: 'england premier league 39', sourceId: 'af-bydate', competitionId: 'c-epl' },
      { aliasNorm: 'ligue 1', sourceId: 'src-a', competitionId: 'c-bl' },
    ],
    teamCompetitions: [
      { teamId: 't-hof', competitionId: 'c-bl' },
      { teamId: 't-dyn-d', competitionId: 'c-pokal' },
      { teamId: 't-dyn-k', competitionId: 'c-upl' },
      { teamId: 't-dyn-k', competitionId: 'c-uel' },
    ],
    sourceUpstreams: [
      { sourceId: 'af-bydate', upstream: 'api-sports' },
      { sourceId: 'af-odds-en1', upstream: 'api-sports' },
      { sourceId: 'src-c', upstream: 'other' },
    ],
  };
  const idx = buildAliasIndex(learnedInput);
  const team = (raw: string, competitionId: string | null) =>
    resolveTeam(idx, { sportId: 'football', sourceId: 'src-c', raw, competitionId });
  const comp = (raw: string, sourceId: string) =>
    resolveCompetition(idx, { sportId: 'football', sourceId, raw });
  const learned = (id: string) => ({ status: 'resolved', id, via: 'learned' });
  const unknown = { status: 'unknown' };

  it('L1 a team mapped for one source resolves from another, in its competition or a cup of its country', () => {
    expect(team('1899 Hoffenheim', 'c-bl')).toEqual(learned('t-hof'));
    expect(team('1899 Hoffenheim', 'c-pokal')).toEqual(learned('t-hof'));
  });

  it('L1 never in another country, in an international competition it has not played, or without a competition', () => {
    expect(team('1899 Hoffenheim', 'c-upl')).toEqual(unknown);
    expect(team('1899 Hoffenheim', 'c-uel')).toEqual(unknown);
    expect(team('1899 Hoffenheim', null)).toEqual(unknown);
    expect(
      resolveTeam(idx, { sportId: 'football', sourceId: 'src-c', raw: '1899 Hoffenheim' }),
    ).toEqual(unknown);
  });

  it('L1 one spelling mapped to two teams: only the one that fits the competition, else unknown', () => {
    expect(team('Dynamo', 'c-pokal')).toEqual(learned('t-dyn-d'));
    expect(team('Dynamo', 'c-uel')).toEqual(learned('t-dyn-k'));
    expect(team('Dynamo', 'c-epl')).toEqual(unknown);
  });

  it('L1 a team with no event yet is not learned: a person maps it once more', () => {
    expect(team('Newbie', 'c-bl')).toEqual(unknown);
  });

  it('L1 never overrides a stronger level', () => {
    expect(team('TSG Hoffenheim', 'c-upl')).toEqual({
      status: 'resolved',
      id: 't-hof',
      via: 'name',
    });
  });

  it('L1 a league name that carries its provider id resolves from every source', () => {
    expect(comp('England - Premier League [39]', 'af-odds-en1')).toEqual(learned('c-epl'));
    expect(comp('England - Premier League [39]', 'src-c')).toEqual(learned('c-epl'));
  });

  it('L2 a renamed league resolves by its provider id, only from a source of the same upstream', () => {
    expect(comp('England - Premier League 2026/27 [39]', 'af-odds-en1')).toEqual({
      status: 'resolved',
      id: 'c-epl',
      via: 'provider_id',
    });
    expect(comp('England - Premier League 2026/27 [39]', 'src-c')).toEqual(unknown);
    expect(comp('World - World Cup [1]', 'af-odds-en1')).toEqual(unknown);
  });

  it('L1 a plain league name is never learned: several countries use it', () => {
    expect(comp('Ligue 1', 'src-c')).toEqual(unknown);
  });

  it('L1 property: a learned team always fits the competition it was learned for', () => {
    const competitions = ['c-bl', 'c-pokal', 'c-upl', 'c-uel', 'c-epl'];
    fc.assert(
      fc.property(
        fc.constantFrom('1899 Hoffenheim', 'Dynamo', 'Newbie', 'Someone'),
        fc.constantFrom(...competitions),
        (raw, competitionId) => {
          const out = team(raw, competitionId);
          if (out.status !== 'resolved') return;
          const plays = (learnedInput.teamCompetitions ?? [])
            .filter((row) => row.teamId === out.id)
            .map((row) => row.competitionId);
          const country = (c: string) =>
            learnedInput.competitions.find((x) => x.id === c)?.countryCategoryId ?? null;
          const fitsIt =
            plays.includes(competitionId) ||
            (country(competitionId) !== null &&
              plays.some((c) => country(c) === country(competitionId)));
          expect(fitsIt).toBe(true);
        },
      ),
    );
  });
});
