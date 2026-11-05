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
