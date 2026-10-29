import { describe, expect, it } from 'vitest';
import { createAdapter } from './index';

const base = {
  allowedHosts: ['v3.football.api-sports.io'],
  requests: [{ url: 'https://v3.football.api-sports.io/fixtures?league=162&season=2026' }],
  recordsPath: 'response',
  fields: {
    home: 'teams.home.name',
    away: 'teams.away.name',
    competition: { fixed: 'Liga Promerica' },
    kickoff: { path: 'fixture.date', format: 'iso' },
  },
};
const withAuth = (auth: unknown) => ({ ...base, auth });
const GOOD = { header: 'x-apisports-key', secret: 'SCRAPER_SECRET_API_FOOTBALL' };

function build(config: unknown) {
  return createAdapter({ id: 's', adapter: 'generic-json', upstream: 'u', config });
}
function errors(config: unknown): string[] {
  const r = build(config);
  if (r.ok) throw new Error('expected the config to be refused');
  return r.errors;
}

describe('generic-json auth block: validation', () => {
  it('accepts no auth block at all', () => {
    expect(build(base).ok).toBe(true);
  });

  it('accepts a header and the name of a SCRAPER_SECRET_ variable', () => {
    expect(build(withAuth(GOOD)).ok).toBe(true);
    expect(build(withAuth({ header: 'X-Api-Key', secret: 'SCRAPER_SECRET_A' })).ok).toBe(true);
    expect(
      build(withAuth({ header: 'api_key', secret: `SCRAPER_SECRET_${'A1_'.repeat(21)}X` })).ok,
    ).toBe(true);
  });

  it.each([
    ['not in the namespace', 'API_FOOTBALL_KEY'],
    ['another secret of the platform', 'SESSION_SECRET'],
    ['a database url', 'DATABASE_URL'],
    ['prefix only', 'SCRAPER_SECRET_'],
    ['lower case', 'SCRAPER_SECRET_api'],
    ['punctuation', 'SCRAPER_SECRET_A-B'],
    ['a trailing newline', 'SCRAPER_SECRET_A\n'],
    ['too long', `SCRAPER_SECRET_${'A'.repeat(65)}`],
    ['empty', ''],
  ])('refuses a variable name that is %s', (_why, secret) => {
    const found = errors(withAuth({ header: 'x-apisports-key', secret }));
    expect(found.some((e) => e.startsWith('auth.secret:'))).toBe(true);
  });

  it.each([
    'host',
    'Host',
    'cookie',
    'COOKIE',
    'content-length',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    // the fetcher's own headers and the platform's "no login" rule
    'user-agent',
    'authorization',
    'if-none-match',
    'if-modified-since',
    'set-cookie',
  ])('refuses the header %s', (header) => {
    const found = errors(withAuth({ header, secret: GOOD.secret }));
    expect(found.some((e) => e.startsWith('auth.header:'))).toBe(true);
  });

  it.each(['', 'x api key', 'x-key:', 'x-key\r\nhost: evil', 'ключ', 'x'.repeat(65), 'a/b'])(
    'refuses %j as a header name',
    (header) => {
      const found = errors(withAuth({ header, secret: GOOD.secret }));
      expect(found.some((e) => e.startsWith('auth.header:'))).toBe(true);
    },
  );

  it('refuses a key written into the config, wherever it is put, without repeating it', () => {
    const KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
    const attempts = [
      withAuth({ header: 'x-apisports-key', secret: KEY }),
      withAuth({ header: 'x-apisports-key', secret: GOOD.secret, value: KEY }),
      withAuth({ header: 'x-apisports-key', key: KEY }),
      withAuth({ headers: { 'x-apisports-key': KEY } }),
      { ...base, headers: { 'x-apisports-key': KEY } },
    ];
    for (const config of attempts) {
      const found = errors(config);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join('\n')).not.toContain(KEY);
    }
  });

  it('allows at most one auth header: the block is an object, not a list', () => {
    expect(errors(withAuth([GOOD])).length).toBeGreaterThan(0);
    expect(errors(withAuth([GOOD, { header: 'x-other', secret: 'SCRAPER_SECRET_B' }])).length).toBe(
      1,
    );
    expect(errors(withAuth({ ...GOOD, header2: 'x-other' })).length).toBeGreaterThan(0);
  });

  it('requires both fields', () => {
    expect(errors(withAuth({ header: 'x-apisports-key' })).length).toBeGreaterThan(0);
    expect(errors(withAuth({ secret: GOOD.secret })).length).toBeGreaterThan(0);
  });

  it('is not accepted by the other adapters', () => {
    const html = createAdapter({
      id: 's',
      adapter: 'generic-html',
      upstream: 'u',
      config: { ...base, auth: GOOD },
    });
    expect(html.ok).toBe(false);
  });
});

describe('generic-json auth block: plan', () => {
  it('puts a reference (header and variable NAME) on every plan item', () => {
    const r = build({
      ...withAuth({ header: 'X-ApiSports-Key', secret: GOOD.secret }),
      requests: [
        { url: 'https://v3.football.api-sports.io/fixtures?league=162&season=2026' },
        { url: 'https://v3.football.api-sports.io/fixtures?league=163&season=2026' },
      ],
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const plan = r.adapter.plan(new Date('2026-10-29T12:00:00Z'));
    expect(plan).toHaveLength(2);
    for (const item of plan) {
      expect(item.auth).toEqual({ header: 'X-ApiSports-Key', secret: GOOD.secret });
      expect(Object.keys(item).sort()).toEqual(['auth', 'purpose', 'url']);
    }
  });

  it('plans no auth without a block, and never a header value', () => {
    const r = build(base);
    if (!r.ok) throw new Error(r.errors.join('; '));
    const [item] = r.adapter.plan(new Date());
    expect(item).toBeDefined();
    expect(item && 'auth' in item).toBe(false);
    expect(item && 'headers' in item).toBe(false);
  });
});
