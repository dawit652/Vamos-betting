import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawDocument } from '../types';
import { createAdapter } from './index';
import type { SourceRow } from './registry';

/**
 * The football-data.org source (docs/scraper-plan/data/source-footballdata-en1.json): the
 * generic-json adapter with the file's own config, read against a document in the shape of the
 * v4 `GET /v4/competitions/PL/matches` response (__fixtures__/footballdata-en1-sample.json).
 */
const source = JSON.parse(
  readFileSync(
    new URL('../../../../docs/scraper-plan/data/source-footballdata-en1.json', import.meta.url),
    'utf8',
  ),
) as {
  id: string;
  adapter: SourceRow['adapter'];
  upstream: string;
  config: { requests: { url: string }[]; fields: { status: { map: Record<string, string> } } };
};

const body = readFileSync(
  new URL('./__fixtures__/footballdata-en1-sample.json', import.meta.url),
  'utf8',
);

function adapter() {
  const r = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.adapter;
}

const doc = (b: string): RawDocument => ({
  sourceId: source.id,
  url: source.config.requests[0]!.url,
  status: 200,
  contentType: 'application/json',
  body: b,
  fetchedAt: new Date('2026-11-05T19:00:00Z'),
  contentHash: 'x',
});

describe('football-data.org source file', () => {
  it('is a valid generic-json source that names the key variable, never a value', () => {
    expect(source.adapter).toBe('generic-json');
    expect(JSON.stringify(source.config)).toContain('"secret":"SCRAPER_SECRET_FOOTBALL_DATA"');
    expect(() => adapter()).not.toThrow();
  });

  it('maps every match status the v4 API documents (an unmapped one would drop the record)', () => {
    const documented = [
      'SCHEDULED',
      'TIMED',
      'IN_PLAY',
      'PAUSED',
      'EXTRA_TIME',
      'PENALTY_SHOOTOUT',
      'FINISHED',
      'SUSPENDED',
      'POSTPONED',
      'CANCELLED',
      'AWARDED',
    ];
    expect(Object.keys(source.config.fields.status.map).sort()).toEqual([...documented].sort());
  });
});

describe('football-data.org league source files', () => {
  const data = new URL('../../../../docs/scraper-plan/data/', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, data), 'utf8');
  // Competition names that a global alias maps to a catalogue competition.
  const competitionAliases = new Map(
    ['aliases-openfootball-en1.csv', 'aliases-openfootball-top-leagues.csv'].flatMap((file) =>
      read(file)
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split(','))
        .filter(([kind, , , , scope]) => kind === 'competition' && scope === '')
        .map(([, , alias, target]) => [alias!, target!] as const),
    ),
  );
  const leagues = [
    ['en1', 'PL', 'premier-league'],
    ['de1', 'BL1', 'bundesliga'],
    ['es1', 'PD', 'laliga'],
    ['it1', 'SA', 'serie-a'],
    ['fr1', 'FL1', 'ligue-1'],
  ] as const;

  it.each(leagues)('footballdata-%s reads competition %s and lands in %s', (key, code, slug) => {
    const file = JSON.parse(read(`source-footballdata-${key}.json`)) as typeof source & {
      config: { fields: { competition: { fixed: string } } };
    };
    expect(file.id).toBe(`footballdata-${key}`);
    expect(file.upstream).toBe('football-data.org');
    expect(file.config.requests).toEqual([
      { url: `https://api.football-data.org/v4/competitions/${code}/matches`, purpose: 'both' },
    ]);
    // Everything but the id, name, URL and competition is the Premier League file's config.
    const {
      requests: _r,
      fields: f,
      ...rest
    } = file.config as Record<string, unknown> & {
      fields: Record<string, unknown>;
    };
    const {
      requests: _s,
      fields: g,
      ...base
    } = source.config as Record<string, unknown> & {
      fields: Record<string, unknown>;
    };
    expect(rest).toEqual(base);
    expect({ ...f, competition: null }).toEqual({ ...g, competition: null });
    expect(competitionAliases.get(file.config.fields.competition.fixed)).toBe(slug);
    const r = createAdapter({
      id: file.id,
      adapter: file.adapter,
      upstream: file.upstream,
      config: file.config,
    });
    expect(r.ok).toBe(true);
  });
});

describe('football-data.org sample', () => {
  const out = adapter().parse(doc(body));
  const fixture = (ref: string) => out.fixtures.find((f) => f.externalRef === ref);
  const result = (ref: string) => out.results.find((r) => r.externalRef === ref);

  it('reads every record without issues', () => {
    expect(out.issues).toEqual([]);
    expect(out.stats).toEqual({ recordsSeen: 17, recordsAccepted: 17 });
  });

  it('keeps the real kickoffs of the 6-8 November 2026 round (UTC), not a default slot', () => {
    const kickoffs = Object.fromEntries(
      ['1001', '1002', '1003', '1005', '1006', '1010'].map((ref) => [
        ref,
        fixture(ref)?.kickoff.toISOString(),
      ]),
    );
    expect(kickoffs).toEqual({
      '1001': '2026-11-06T20:00:00.000Z', // Everton v Coventry, Friday
      '1002': '2026-11-07T12:30:00.000Z', // Leeds v Tottenham
      '1003': '2026-11-07T15:00:00.000Z', // Arsenal v Hull
      '1005': '2026-11-07T17:30:00.000Z', // Nottingham Forest v Manchester City
      '1006': '2026-11-08T14:00:00.000Z', // Brighton v Brentford, Sunday
      '1010': '2026-11-08T16:30:00.000Z', // Manchester United v Aston Villa
    });
    expect(fixture('1001')).toMatchObject({
      kind: 'fixture',
      status: 'scheduled',
      competition: 'English Premier League',
      home: 'Everton FC',
      away: 'Coventry City FC',
      round: '10',
    });
  });

  it('reads final scores with the half time, a goalless draw included, as regular time', () => {
    expect(result('901')).toMatchObject({
      status: 'finished',
      score: { home: 2, away: 2, htHome: 1, htAway: 0 },
      scoreBasis: 'regular_time',
    });
    expect(result('902')).toMatchObject({
      status: 'finished',
      score: { home: 0, away: 0, htHome: 0, htAway: 0 },
    });
  });

  it('never takes a live score for a result', () => {
    expect(result('1201')).toBeUndefined();
    expect(fixture('1201')?.status).toBe('scheduled');
  });

  it('turns a suspended or awarded match into a case for a person, never a settled score', () => {
    expect(result('1203')).toMatchObject({ status: 'abandoned', score: null });
    expect(result('1204')).toMatchObject({ status: 'abandoned', score: null });
    expect(out.results.filter((r) => r.status === 'finished').map((r) => r.externalRef)).toEqual([
      '901',
      '902',
    ]);
  });

  it('reports a postponement', () => {
    const postponed = [...out.fixtures, ...out.results].find((o) => o.externalRef === '1202');
    expect(postponed?.status).toBe('postponed');
  });
});

describe('football-data.org Champions League source (score basis per match)', () => {
  const cl = JSON.parse(
    readFileSync(
      new URL('../../../../docs/scraper-plan/data/source-footballdata-cl.json', import.meta.url),
      'utf8',
    ),
  ) as typeof source & { config: Record<string, unknown> & { fields: Record<string, unknown> } };

  const make = (config: unknown) =>
    createAdapter({ id: cl.id, adapter: cl.adapter, upstream: cl.upstream, config });

  const finished = (id: number, duration: string | null, home: number, away: number) => ({
    id,
    utcDate: '2026-10-21T19:00:00Z',
    status: 'FINISHED',
    matchday: 3,
    homeTeam: { name: 'FC Porto' },
    awayTeam: { name: 'Arsenal FC' },
    score: {
      ...(duration === null ? {} : { duration }),
      fullTime: { home, away },
      halfTime: { home: 0, away: 0 },
    },
  });

  it('is the Premier League config with the competition and the basis read per match', () => {
    const { requests, fields, scoreBasis, ...rest } = cl.config as Record<string, unknown> & {
      fields: Record<string, unknown>;
    };
    const {
      requests: _r,
      fields: baseFields,
      scoreBasis: _b,
      ...baseRest
    } = source.config as Record<string, unknown> & { fields: Record<string, unknown> };
    expect(requests).toEqual([
      { url: 'https://api.football-data.org/v4/competitions/CL/matches', purpose: 'both' },
    ]);
    expect(rest).toEqual(baseRest);
    const { competition, scoreBasis: perMatch, ...otherFields } = fields;
    const { competition: _c, ...baseOther } = baseFields;
    expect(otherFields).toEqual(baseOther);
    // The catalogue competition's own name: it resolves without an alias.
    expect(competition).toEqual({ fixed: 'UEFA Champions League' });
    expect(perMatch).toEqual({
      path: 'score.duration',
      map: {
        REGULAR: 'regular_time',
        EXTRA_TIME: 'includes_extra_time',
        PENALTY_SHOOTOUT: 'includes_extra_time',
      },
    });
    expect(scoreBasis).toBe('unknown');
  });

  it('marks an extra-time or penalty score so it never settles on its own', () => {
    const r = make(cl.config);
    if (!r.ok) throw new Error(r.errors.join());
    const out = r.adapter.parse(
      doc(
        JSON.stringify({
          matches: [
            finished(1, 'REGULAR', 2, 1),
            finished(2, 'EXTRA_TIME', 3, 2),
            finished(3, 'PENALTY_SHOOTOUT', 5, 4),
            finished(4, null, 1, 1),
            finished(5, 'GOLDEN_GOAL', 2, 1),
          ],
        }),
      ),
    );
    const basis = Object.fromEntries(out.results.map((x) => [x.externalRef, x.scoreBasis]));
    expect(basis).toEqual({
      '1': 'regular_time',
      '2': 'includes_extra_time',
      '3': 'includes_extra_time',
      '4': 'unknown', // no duration: the file's default, a person decides
      '5': 'unknown', // a value the map does not know
    });
    expect(out.issues).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'unknown_score_basis' }),
    ]);
    expect(out.stats).toEqual({ recordsSeen: 5, recordsAccepted: 5 });
  });

  it('refuses a per-match basis without a score, an empty map or a key mapped twice', () => {
    const fields = cl.config.fields;
    const { score: _s, ...noScore } = fields;
    const { scoreBasis: _d, ...noDefault } = cl.config;
    const bad = [
      { ...noDefault, fields: noScore },
      { ...cl.config, fields: { ...fields, scoreBasis: { path: 'score.duration', map: {} } } },
      {
        ...cl.config,
        fields: {
          ...fields,
          scoreBasis: {
            path: 'score.duration',
            map: { REGULAR: 'regular_time', ' regular ': 'includes_extra_time' },
          },
        },
      },
    ];
    for (const config of bad) expect(make(config).ok).toBe(false);
  });
});
