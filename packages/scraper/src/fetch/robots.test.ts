import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ROBOTS_ALLOW_ALL,
  ROBOTS_DISALLOW_ALL,
  isAllowed,
  parseRobots,
  productToken,
  robotsCrawlDelayMs,
} from './robots';

const UA = 'VamosBot';

describe('parseRobots / isAllowed (RFC 9309)', () => {
  it('allows everything without rules and disallows everything for ROBOTS_DISALLOW_ALL', () => {
    expect(isAllowed(ROBOTS_ALLOW_ALL, UA, '/anything')).toBe(true);
    expect(isAllowed(ROBOTS_DISALLOW_ALL, UA, '/anything')).toBe(false);
    expect(isAllowed(parseRobots(''), UA, '/x')).toBe(true);
  });

  it('always allows /robots.txt itself', () => {
    expect(isAllowed(ROBOTS_DISALLOW_ALL, UA, '/robots.txt')).toBe(true);
  });

  it('uses the longest match and lets Allow win a tie', () => {
    const r = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c\nAllow: /t\nDisallow: /t');
    expect(isAllowed(r, UA, '/a/x')).toBe(false);
    expect(isAllowed(r, UA, '/a/b/x')).toBe(true);
    expect(isAllowed(r, UA, '/a/b/c/d')).toBe(false);
    expect(isAllowed(r, UA, '/t')).toBe(true);
    expect(isAllowed(r, UA, '/other')).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /tmp*draft\nAllow: /tmp/ok');
    expect(isAllowed(r, UA, '/data/x.json')).toBe(false);
    expect(isAllowed(r, UA, '/data/x.json?x=1')).toBe(true);
    expect(isAllowed(r, UA, '/data/x.jsonl')).toBe(true);
    expect(isAllowed(r, UA, '/tmp/a/draft')).toBe(false);
    expect(isAllowed(r, UA, '/tmp/a/draft/more')).toBe(false);
    expect(isAllowed(r, UA, '/tmp/ok')).toBe(true);
  });

  it('treats an empty Disallow as allow-all and a bare "Disallow: /" as block-all', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), UA, '/x')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), UA, '/x')).toBe(false);
  });

  it('fails closed on a pattern without a leading slash', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: admin'), UA, '/admin/x')).toBe(false);
  });

  it('picks the group by product token, case-insensitively, falling back to *', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: OtherBot',
      'Disallow: /other',
      '',
      'User-agent: VAMOSBOT',
      'User-agent: AltBot',
      'Allow: /',
      'Disallow: /private',
    ].join('\n');
    const r = parseRobots(text);
    expect(isAllowed(r, 'vamosbot', '/fixtures')).toBe(true);
    expect(isAllowed(r, 'VamosBot/1.0 (+mailto:a@b.c)', '/private/x')).toBe(false);
    expect(isAllowed(r, 'altbot', '/fixtures')).toBe(true);
    expect(isAllowed(r, 'randombot', '/fixtures')).toBe(false); // falls back to *
    expect(isAllowed(r, 'otherbot', '/fixtures')).toBe(true);
  });

  it('merges several groups naming the same agent', () => {
    const r = parseRobots('User-agent: vamosbot\nDisallow: /a\n\nUser-agent: vamosbot\nDisallow: /b');
    expect(isAllowed(r, UA, '/a')).toBe(false);
    expect(isAllowed(r, UA, '/b')).toBe(false);
    expect(isAllowed(r, UA, '/c')).toBe(true);
  });

  it('handles comments, CRLF, CR, BOM, odd spacing and case of field names', () => {
    const text = '﻿USER-AGENT : *  # everyone\r\nDISALLOW:/x # no\r\rAllow:   /x/y\r\nSitemap: https://e.com/s.xml\r\n';
    const r = parseRobots(text);
    expect(isAllowed(r, UA, '/x/z')).toBe(false);
    expect(isAllowed(r, UA, '/x/y')).toBe(true);
  });

  it('ignores rules before any user-agent line and unknown fields', () => {
    const r = parseRobots('Disallow: /\nFoo: bar\nUser-agent: *\nSitemap: x\nDisallow: /a');
    expect(isAllowed(r, UA, '/b')).toBe(true);
    expect(isAllowed(r, UA, '/a')).toBe(false);
  });

  it('compares after percent-normalisation', () => {
    const r = parseRobots('User-agent: *\nDisallow: /caf%C3%A9\nDisallow: /a%2fb\nDisallow: /~user');
    expect(isAllowed(r, UA, '/café/menu')).toBe(false);
    expect(isAllowed(r, UA, '/a%2Fb')).toBe(false);
    expect(isAllowed(r, UA, '/%7Euser/x')).toBe(false);
    expect(isAllowed(r, UA, '/a/b')).toBe(true);
  });

  it('includes the query string in the match', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*?debug=');
    expect(isAllowed(r, UA, '/page?debug=1')).toBe(false);
    expect(isAllowed(r, UA, '/page?x=1')).toBe(true);
  });

  it('reads Crawl-delay, caps it at 60 s, ignores junk', () => {
    expect(robotsCrawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 10'), UA)).toBe(10_000);
    expect(robotsCrawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 2.5'), UA)).toBe(2500);
    expect(robotsCrawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: 9999'), UA)).toBe(60_000);
    expect(robotsCrawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: -3'), UA)).toBe(0);
    expect(robotsCrawlDelayMs(parseRobots('User-agent: *\nCrawl-delay: soon'), UA)).toBe(0);
    expect(robotsCrawlDelayMs(parseRobots('User-agent: vamosbot\nCrawl-delay: 7\nUser-agent: *\nCrawl-delay: 1'), UA)).toBe(7000);
  });

  it('stays fast on a pathological pattern', () => {
    const r = parseRobots(`User-agent: *\nDisallow: ${'*a'.repeat(2000)}b$`);
    const started = Date.now();
    expect(isAllowed(r, UA, `/${'a'.repeat(5000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('derives product tokens', () => {
    expect(productToken('VamosBot/1.0 (+https://x.example)')).toBe('vamosbot');
    expect(productToken('  Foo-Bar ')).toBe('foo-bar');
  });
});

describe('robots properties', () => {
  it('parseRobots never throws and isAllowed is deterministic', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (text, ua, path) => {
        const rules = parseRobots(text);
        const a = isAllowed(rules, ua, path);
        expect(isAllowed(rules, ua, path)).toBe(a);
        expect(isAllowed(parseRobots(text), ua, path)).toBe(a);
      }),
    );
  });

  it('structured robots files never throw either', () => {
    const line = fc.oneof(
      fc.constantFrom('User-agent: *', 'User-agent: vamosbot', 'Disallow: /', 'Allow: /a', 'Disallow: /*.x$', 'Crawl-delay: 5', '# c'),
      fc.string({ maxLength: 30 }),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 40 }), fc.string({ maxLength: 40 }), (lines, path) => {
        const rules = parseRobots(lines.join('\r\n'));
        expect(typeof isAllowed(rules, 'vamosbot', path)).toBe('boolean');
        expect(robotsCrawlDelayMs(rules, 'vamosbot')).toBeLessThanOrEqual(60_000);
      }),
    );
  });
});
