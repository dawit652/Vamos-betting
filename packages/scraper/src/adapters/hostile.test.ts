import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RawDocument, SourceAdapter } from '../types';
import { MAX_ISSUES, MAX_RECORDS, createAdapter, regexProblem, safeParse } from './index';

const doc = (body: string, contentType: string | null = null): RawDocument => ({
  sourceId: 's',
  url: 'https://a.example.com/x',
  status: 200,
  contentType,
  body,
  fetchedAt: new Date('2025-03-01T00:00:00Z'),
  contentHash: 'h',
});
const row = (adapter: 'openfootball' | 'generic-json' | 'generic-html', config: unknown) =>
  createAdapter({ id: 's', adapter, upstream: 'u', config });

const of = {
  allowedHosts: ['a.example.com'],
  requests: [{ url: 'https://a.example.com/x', competition: 'L' }],
  timeZone: 'Europe/London',
};
const json = {
  allowedHosts: ['a.example.com'],
  requests: [{ url: 'https://a.example.com/x' }],
  recordsPath: 'm[*]',
  fields: {
    home: 'h',
    away: 'a',
    competition: { fixed: 'L' },
    kickoff: { path: 'k', format: 'iso' },
  },
};
const html = {
  allowedHosts: ['a.example.com'],
  requests: [{ url: 'https://a.example.com/x' }],
  itemSelector: 'li',
  fields: {
    home: { selector: '.h' },
    away: { selector: '.a' },
    competition: { fixed: 'L' },
    kickoff: { selector: 'time', attr: 'datetime', format: 'iso' },
  },
};
function adapters(): SourceAdapter[] {
  return [row('openfootball', of), row('generic-json', json), row('generic-html', html)].map(
    (r) => {
      if (!r.ok) throw new Error(r.errors.join());
      return r.adapter;
    },
  );
}

describe('config validation (S3)', () => {
  const cases = [
    ['openfootball', of],
    ['generic-json', json],
    ['generic-html', html],
  ] as const;
  it.each(cases)('%s accepts a valid config', (name, cfg) => {
    expect(row(name, cfg).ok).toBe(true);
  });
  it.each(cases.filter(([n]) => n !== 'openfootball'))('%s requires allowedHosts', (name, cfg) => {
    const { allowedHosts: _a, ...rest } = cfg as Record<string, unknown>;
    const r = row(name, rest);
    expect(r.ok).toBe(false);
  });
  it.each(cases)('%s rejects an empty allowedHosts', (name, cfg) => {
    expect(row(name, { ...cfg, allowedHosts: [] }).ok).toBe(false);
  });
  it.each(cases)('%s rejects http URLs', (name, cfg) => {
    const c = { ...cfg, requests: [{ ...cfg.requests[0], url: 'http://a.example.com/x' }] };
    const r = row(name, c);
    expect(!r.ok && r.errors.join()).toContain('https');
  });
  it.each(cases)('%s rejects a host outside allowedHosts', (name, cfg) => {
    const c = { ...cfg, requests: [{ ...cfg.requests[0], url: 'https://evil.example.org/x' }] };
    const r = row(name, c);
    expect(!r.ok && r.errors.join()).toContain('not in allowedHosts');
  });
  it('rejects credentials in URLs, wildcards, unknown keys, bad zones', () => {
    expect(
      row('generic-json', { ...json, requests: [{ url: 'https://u:p@a.example.com/x' }] }).ok,
    ).toBe(false);
    expect(row('generic-json', { ...json, allowedHosts: ['*.example.com'] }).ok).toBe(false);
    expect(row('generic-json', { ...json, allowedHost: ['a.example.com'] }).ok).toBe(false);
    expect(row('openfootball', { ...of, timeZone: '+03:00' }).ok).toBe(false);
    expect(row('openfootball', { ...of, timeZone: 'Mars/Base' }).ok).toBe(false);
  });
  it('openfootball allowedHosts defaults to raw.githubusercontent.com', () => {
    const r = row('openfootball', {
      requests: [{ url: 'https://raw.githubusercontent.com/a/b.json', competition: 'L' }],
      timeZone: 'Europe/London',
    });
    expect(r.ok && r.adapter.allowedHosts).toEqual(['raw.githubusercontent.com']);
    expect(
      row('openfootball', {
        requests: [{ url: 'https://a.example.com/b.json', competition: 'L' }],
        timeZone: 'Europe/London',
      }).ok,
    ).toBe(false);
  });
  it('requires scoreBasis when a score is configured', () => {
    const score = { homePath: 'x', awayPath: 'y' };
    expect(row('generic-json', { ...json, fields: { ...json.fields, score } }).ok).toBe(false);
    const status = { path: 's', map: { FT: 'finished' } };
    expect(
      row('generic-json', {
        ...json,
        fields: { ...json.fields, score, status },
        scoreBasis: 'unknown',
      }).ok,
    ).toBe(true);
    const hs = { ...html.fields, score: { selector: '.s' } };
    expect(row('generic-html', { ...html, fields: hs }).ok).toBe(false);
  });
  it('rejects bad paths, selectors and unknown adapters without throwing', () => {
    expect(row('generic-json', { ...json, recordsPath: 'a..b' }).ok).toBe(false);
    expect(row('generic-json', { ...json, fields: { ...json.fields, home: 'x[*]' } }).ok).toBe(
      false,
    );
    expect(row('generic-html', { ...html, itemSelector: 'li[' }).ok).toBe(false);
    expect(row('nope' as never, {}).ok).toBe(false);
    expect(row('generic-json', null).ok).toBe(false);
  });
  it('rejects slow, nested, long and invalid regexes', () => {
    expect(regexProblem('(\\d+)\\s*[-:]\\s*(\\d+)', 2)).toBeNull();
    expect(regexProblem('(a+)+$', 1)).toContain('nested');
    expect(regexProblem('(a|aa)+$', 1)).toContain('nested');
    expect(regexProblem('(a*)(a*)(a*)(a*)(a*)(a*)(a*)(a*)b', 1)).toContain('slow');
    expect(regexProblem('(' + 'a'.repeat(250) + ')', 1)).toContain('200');
    expect(regexProblem('(', 1)).toContain('compile');
    expect(regexProblem('\\d+', 2)).toContain('capture');
    const bad = { ...html.fields, score: { selector: '.s', regex: '(a+)+$' } };
    expect(row('generic-html', { ...html, fields: bad, scoreBasis: 'unknown' }).ok).toBe(false);
  });
});

describe('hostile documents', () => {
  const bodies: [string, string][] = [
    ['empty', ''],
    ['whitespace', '   \n'],
    ['not json', 'hello <b>'],
    ['wrong shape', '{"matches":42,"m":"x"}'],
    ['deep json', '['.repeat(200_000)],
    ['deep json balanced', '['.repeat(50_000) + ']'.repeat(50_000)],
    ['rtl', '{"m":[{"h":"فريق","a":"الهلال","k":"2025-03-01T10:00:00Z"}]}'],
    ['script html', '<script>throw 1</script><li><span class=h>x</span></li>'],
    ['6 MB', 'x'.repeat(6 * 1024 * 1024)],
    ['6 MB multibyte', 'é'.repeat(3 * 1024 * 1024 + 1)],
  ];
  it.each(bodies)('%s never throws and yields consistent stats', (_n, body) => {
    for (const a of adapters()) {
      const o = safeParse(a, doc(body));
      expect(o.stats.recordsAccepted).toBeLessThanOrEqual(o.stats.recordsSeen);
      expect(o.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
    }
  });
  it('a 6 MB body is fatal with no records', () => {
    for (const a of adapters()) {
      const o = a.parse(doc('x'.repeat(6 * 1024 * 1024)));
      expect(o.issues[0]).toMatchObject({ fatal: true, code: 'document_too_large' });
      expect(o.fixtures.length + o.results.length).toBe(0);
    }
  });
  it('the RTL record is accepted', () => {
    const o = adapters()[1]!.parse(doc(bodies.find((b) => b[0] === 'rtl')![1]));
    expect(o.fixtures[0]).toMatchObject({ home: 'فريق', away: 'الهلال' });
  });
  it('caps records and issues for huge arrays', () => {
    const list = Array.from({ length: MAX_RECORDS + 500 }, () => ({ h: 'A' }));
    const o = adapters()[1]!.parse(doc(JSON.stringify({ m: list })));
    expect(o.stats.recordsSeen).toBe(MAX_RECORDS);
    expect(o.stats.recordsAccepted).toBe(0);
    expect(o.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(o.issues.at(-1)?.code).toBe('issues_truncated');
  });
  it('safeParse turns a throwing adapter into a fatal issue', () => {
    const bad: SourceAdapter = {
      ...adapters()[0]!,
      parse: () => {
        throw new Error('boom');
      },
    };
    const o = safeParse(bad, doc('{}'));
    expect(o.issues[0]).toMatchObject({ fatal: true, code: 'parser_crashed' });
  });
});

describe('property: parse never throws', () => {
  it('arbitrary strings of any content type', () => {
    const as = adapters();
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.json()),
        fc.constantFrom(null, 'text/html', 'application/json'),
        (body, ct) => {
          for (const a of as) {
            const o = a.parse(doc(body, ct));
            expect(o.stats.recordsAccepted).toBeLessThanOrEqual(o.stats.recordsSeen);
            expect(o.fixtures.length + o.results.length).toBeGreaterThanOrEqual(
              o.stats.recordsAccepted,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
