import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawDocument } from '../types';
import { createAdapter, safeParse } from './index';

const URL_ =
  'https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json';
const body = readFileSync(
  new URL('./__fixtures__/openfootball-en1-sample.json', import.meta.url),
  'utf8',
);

function adapter(extra: Record<string, unknown> = {}) {
  const r = createAdapter({
    id: 'of-en1',
    adapter: 'openfootball',
    upstream: 'openfootball',
    config: {
      requests: [{ url: URL_, competition: 'Premier League' }],
      timeZone: 'Europe/London',
      ...extra,
    },
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.adapter;
}
const doc = (b: string, url = URL_): RawDocument => ({
  sourceId: 'of-en1',
  url,
  status: 200,
  contentType: 'application/json',
  body: b,
  fetchedAt: new Date('2025-03-01T00:00:00Z'),
  contentHash: 'x',
});
const matches = (list: unknown[]) => JSON.stringify({ name: 'x', matches: list });

describe('openfootball golden', () => {
  const out = adapter().parse(doc(body));

  it('counts records', () => {
    expect(out.stats).toEqual({ recordsSeen: 16, recordsAccepted: 14 });
    expect(out.results).toHaveLength(11);
    expect(out.fixtures).toHaveLength(3);
  });

  it('converts local time to UTC (BST) and reads the score', () => {
    expect(out.results[0]).toMatchObject({
      kind: 'result',
      sourceId: 'of-en1',
      competition: 'Premier League',
      home: 'Manchester United FC',
      away: 'Fulham FC',
      status: 'finished',
      kickoff: new Date('2024-08-16T19:00:00Z'),
      score: { home: 1, away: 0, htHome: 0, htAway: 0 },
      scoreBasis: 'regular_time',
      externalRef: null,
    });
  });

  it('unplayed matches are scheduled fixtures', () => {
    expect(out.fixtures.map((f) => f.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(out.fixtures[0]).toMatchObject({
      kind: 'fixture',
      round: expect.stringContaining('Matchday'),
    });
  });

  it('DST gap kickoff is dropped with bad_time', () => {
    const issue = out.issues.find((i) => i.code === 'bad_time');
    expect(issue?.message).toContain('dst_gap');
    expect(issue?.context?.home).toBe('Chelsea FC');
  });

  it('et/p without ft gives basis unknown', () => {
    const r = out.results.find((x) => x.away === 'Leeds United FC');
    expect(r?.scoreBasis).toBe('unknown');
    expect(r?.score).toMatchObject({ home: 2, away: 1 });
  });

  it('3-element score is dropped with bad_score', () => {
    expect(out.issues.find((i) => i.code === 'bad_score')?.context?.home).toBe('Aston Villa FC');
    expect(out.results.some((x) => x.home === 'Aston Villa FC')).toBe(false);
  });
});

describe('openfootball record rules', () => {
  const one = (m: Record<string, unknown>) =>
    adapter().parse(
      doc(
        matches([{ round: 'R', date: '2025-01-10', time: '15:00', team1: 'A', team2: 'B', ...m }]),
      ),
    );

  it('winter time is UTC', () => {
    expect(one({}).fixtures[0]?.kickoff).toEqual(new Date('2025-01-10T15:00:00Z'));
  });
  it('DST overlap is dropped', () => {
    const o = one({ date: '2024-10-27', time: '01:30' });
    expect(o.stats).toEqual({ recordsSeen: 1, recordsAccepted: 0 });
    expect(o.issues[0]?.code).toBe('bad_time');
  });
  it.each([
    ['no date', { date: undefined }, 'bad_date'],
    ['bad date', { date: '10/01/2025' }, 'bad_date'],
    ['no time', { time: undefined }, 'missing_time'],
    ['bad time', { time: '3pm' }, 'bad_time'],
    ['negative', { score: { ft: [-1, 0] } }, 'bad_score'],
    ['string score', { score: { ft: ['1', '0'] } }, 'bad_score'],
    ['float', { score: { ft: [1.5, 0] } }, 'bad_score'],
    ['bad ht', { score: { ft: [1, 0], ht: [2, 0] } }, 'invalid_record'],
    ['only ht', { score: { ht: [0, 0] } }, 'bad_score'],
    ['same team', { team2: 'a' }, 'invalid_record'],
    ['no team', { team1: '' }, 'bad_name'],
  ])('%s -> %s', (_n, m, code) => {
    const o = one(m);
    expect(o.stats.recordsAccepted).toBe(0);
    expect(o.issues.map((i) => i.code)).toEqual([code]);
  });
  it('missing time is only a warning', () => {
    expect(one({ time: undefined }).issues[0]?.severity).toBe('warning');
  });
  it('strips control and bidi characters; keeps RTL names', () => {
    const o = one({ team1: 'Al\u0000 Ahly‮', team2: 'الهلال' });
    expect(o.fixtures[0]).toMatchObject({ home: 'Al Ahly', away: 'الهلال' });
  });
});

describe('openfootball fatal', () => {
  it.each([
    ['empty', ''],
    ['not json', '<html>'],
    ['array', '[]'],
    ['no matches', '{"matches":{}}'],
  ])('%s', (_n, b) => {
    const o = safeParse(adapter(), doc(b));
    expect(o.issues[0]?.fatal).toBe(true);
    expect(o.stats.recordsAccepted).toBe(0);
  });
  it('unknown request URL with several requests', () => {
    const a = createAdapter({
      id: 's',
      adapter: 'openfootball',
      upstream: 'u',
      config: {
        requests: [
          { url: URL_, competition: 'A' },
          { url: URL_ + '2', competition: 'B' },
        ],
        timeZone: 'Europe/London',
      },
    });
    if (!a.ok) throw new Error();
    expect(
      a.adapter.parse(doc('{"matches":[]}', 'https://raw.githubusercontent.com/x')).issues[0]?.code,
    ).toBe('unknown_request');
  });
  it('plan returns the configured requests', () => {
    expect(adapter().plan(new Date())).toEqual([{ url: URL_, purpose: 'both' }]);
  });
});
