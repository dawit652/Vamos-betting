import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawDocument } from '../types';
import { createAdapter, parsePath, resolvePath } from './index';

const fx = (n: string) => readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), 'utf8');
const doc = (body: string, url = 'https://api.example.com/x'): RawDocument => ({
  sourceId: 's',
  url,
  status: 200,
  contentType: null,
  body,
  fetchedAt: new Date('2025-03-01T00:00:00Z'),
  contentHash: 'h',
});

const jsonCfg = {
  allowedHosts: ['api.example.com'],
  requests: [{ url: 'https://api.example.com/x', purpose: 'both' }],
  recordsPath: 'data.events[*]',
  fields: {
    home: 'h',
    away: 'a',
    competition: { path: 'league' },
    kickoff: { path: 'kick', format: 'iso' },
    externalRef: 'id',
    status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
    score: { homePath: 'hs', awayPath: 'as', htHomePath: 'hth', htAwayPath: 'hta' },
  },
  scoreBasis: 'regular_time',
};
function make(adapter: 'generic-json' | 'generic-html', config: unknown) {
  const r = createAdapter({ id: 's', adapter, upstream: 'u', config });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.adapter;
}

describe('path syntax', () => {
  it('parses and resolves', () => {
    const p = parsePath('a.b[1].c');
    expect(p.ok && resolvePath({ a: { b: [{}, { c: 7 }] } }, p.segments).values).toEqual([7]);
    const all = parsePath('x[*].y');
    expect(all.ok && resolvePath({ x: [{ y: 1 }, { y: 2 }, {}] }, all.segments).values).toEqual([
      1, 2,
    ]);
  });
  it.each(['a..b', 'a[', 'a[x]', '.a', 'a.', '__proto__.x', 'a]b'])('rejects %s', (p) => {
    expect(parsePath(p).ok).toBe(false);
  });
  it('never reads inherited properties', () => {
    const p = parsePath('toString');
    expect(p.ok && resolvePath({}, p.segments).values).toEqual([]);
  });
});

describe('generic-json golden', () => {
  const out = make('generic-json', jsonCfg).parse(doc(fx('generic-json-league.json')));
  it('maps results, fixtures and postponements', () => {
    expect(out.stats).toEqual({ recordsSeen: 6, recordsAccepted: 3 });
    expect(out.results[0]).toMatchObject({
      status: 'finished',
      externalRef: '101',
      home: 'Alpha FC',
      kickoff: new Date('2025-03-01T12:00:00Z'),
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      scoreBasis: 'regular_time',
    });
    expect(out.fixtures.map((f) => f.status)).toEqual(['scheduled', 'postponed']);
    expect(out.results.map((r) => r.status)).toEqual(['finished', 'postponed']);
  });
  it('drops: no offset, float score string, non-object', () => {
    expect(out.issues.map((i) => i.code).sort()).toEqual(['bad_record', 'bad_score', 'bad_time']);
  });
  it('local date+time uses the zone and rejects DST gaps', () => {
    const a = make('generic-json', {
      ...jsonCfg,
      recordsPath: '',
      fields: {
        home: 'h',
        away: 'a',
        competition: { fixed: 'L' },
        kickoff: { datePath: 'd', timePath: 't', timeZone: 'Europe/London' },
      },
      scoreBasis: undefined,
    });
    const rec = (d: string, t: string) => ({ h: 'A', a: 'B', d, t });
    const o = a.parse(
      doc(JSON.stringify([rec('2025-07-01', '15:00'), rec('2025-03-30', '01:30')])),
    );
    expect(o.fixtures[0]?.kickoff).toEqual(new Date('2025-07-01T14:00:00Z'));
    expect(o.issues[0]?.message).toContain('dst_gap');
  });
  it('epoch formats', () => {
    const cfg = (format: string) => ({
      ...jsonCfg,
      recordsPath: 'r[*]',
      fields: { home: 'h', away: 'a', competition: { fixed: 'L' }, kickoff: { path: 'k', format } },
      scoreBasis: undefined,
    });
    const t = Date.parse('2025-06-01T10:00:00Z');
    const body = (k: unknown) => doc(JSON.stringify({ r: [{ h: 'A', a: 'B', k }] }));
    expect(
      make('generic-json', cfg('epoch_ms')).parse(body(t)).fixtures[0]?.kickoff.getTime(),
    ).toBe(t);
    expect(
      make('generic-json', cfg('epoch_s'))
        .parse(body(t / 1000))
        .fixtures[0]?.kickoff.getTime(),
    ).toBe(t);
    expect(make('generic-json', cfg('epoch_s')).parse(body(-5)).issues[0]?.code).toBe('bad_time');
  });
  it('unknown status value is dropped; empty list is fine; missing path is fatal', () => {
    const a = make('generic-json', jsonCfg);
    const ev = { id: 1, league: 'L', kick: '2025-03-01T10:00:00Z', h: 'A', a: 'B', st: '??' };
    expect(a.parse(doc(JSON.stringify({ data: { events: [ev] } }))).issues[0]?.code).toBe(
      'unknown_status',
    );
    const empty = a.parse(doc('{"data":{"events":[]}}'));
    expect(empty.issues).toEqual([]);
    expect(a.parse(doc('{"data":{}}')).issues[0]?.fatal).toBe(true);
  });
  it('finished without score is not repaired', () => {
    const a = make('generic-json', jsonCfg);
    const ev = { id: 1, league: 'L', kick: '2025-03-01T10:00:00Z', h: 'A', a: 'B', st: 'FT' };
    const o = a.parse(doc(JSON.stringify({ data: { events: [ev] } })));
    expect(o.issues[0]?.code).toBe('missing_score');
    expect(o.results).toEqual([]);
  });
});

describe('generic-html golden', () => {
  const ref = (selector: string) => ({ selector });
  const htmlCfg = {
    allowedHosts: ['www.example.com'],
    requests: [{ url: 'https://www.example.com/league', purpose: 'both' }],
    itemSelector: 'table.fixtures tr.match',
    fields: {
      home: ref('.home'),
      away: ref('.away'),
      competition: ref('.comp'),
      kickoff: { selector: 'time', attr: 'datetime', format: 'iso' },
      externalRef: { attr: 'data-id' },
      status: { selector: '.status', map: { FT: 'finished', Scheduled: 'scheduled' } },
      score: ref('.score'),
      halfTime: { selector: '.ht', regex: '\\((\\d+)-(\\d+)\\)' },
    },
    scoreBasis: 'regular_time',
  };
  const out = make('generic-html', htmlCfg).parse(
    doc(fx('generic-html-league.html'), 'https://www.example.com/league'),
  );
  it('parses rows, ignores scripts, drops incomplete rows', () => {
    expect(out.stats).toEqual({ recordsSeen: 3, recordsAccepted: 2 });
    expect(out.results[0]).toMatchObject({
      externalRef: 'm1',
      home: 'Alpha FC',
      competition: 'Demo League',
      kickoff: new Date('2025-03-01T12:00:00Z'),
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
    });
    // the "15:00" in a scheduled row's score cell is not a score: status says scheduled
    expect(out.fixtures).toHaveLength(1);
    expect(out.fixtures[0]?.home).toBe('Gamma');
    expect(out.issues[0]?.code).toBe('bad_name');
    expect(JSON.stringify(out)).not.toContain('Injected');
  });
  it('date text + time text with zone formats and DST', () => {
    const cfg = {
      ...htmlCfg,
      itemSelector: 'tr.d',
      fields: {
        home: ref('.home'),
        away: ref('.away'),
        competition: { fixed: 'L' },
        kickoff: {
          date: { selector: '.date', format: 'DD/MM/YYYY' },
          time: ref('.time'),
          timeZone: 'Europe/London',
        },
      },
      scoreBasis: undefined,
    };
    const o = make('generic-html', cfg).parse(
      doc(fx('generic-html-league.html'), 'https://www.example.com/league'),
    );
    expect(o.fixtures).toHaveLength(1);
    expect(o.fixtures[0]?.kickoff).toEqual(new Date('2025-03-15T16:00:00Z'));
    expect(o.issues[0]?.message).toContain('dst_gap');
  });
  it('no matching items is fatal', () => {
    const o = make('generic-html', htmlCfg).parse(doc('<html><body>blocked</body></html>'));
    expect(o.issues[0]?.fatal).toBe(true);
  });
});
