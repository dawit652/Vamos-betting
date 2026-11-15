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
