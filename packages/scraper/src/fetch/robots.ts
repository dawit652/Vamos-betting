/**
 * robots.txt, RFC 9309 (docs/scraper.md 6.6). Pure: no I/O, no clock.
 *
 * Why hand-rolled: the rules decide whether we may touch someone else's
 * server, so they must be exact, testable and impossible to make slow with a
 * hostile file. Matching is a linear-memory wildcard matcher (no regular
 * expressions, so no catastrophic backtracking) and the input is capped at
 * `ROBOTS_MAX_BYTES`, as the RFC allows.
 */

/** RFC 9309 2.5: a parser must handle at least 500 KiB; we read exactly this much and ignore the rest. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
/** Longest Crawl-delay we honour. A site asking for more than a minute between requests gets one minute. */
export const ROBOTS_MAX_CRAWL_DELAY_MS = 60_000;

export interface RobotsRule {
  allow: boolean;
  /** Percent-normalised pattern; `*` is a wildcard, a trailing `$` is stored as `anchored`. */
  pattern: string;
  anchored: boolean;
}

export interface RobotsGroup {
  /** Lower-cased user-agent product tokens (or `*`). */
  agents: string[];
  rules: RobotsRule[];
  /** Crawl-delay in seconds, when valid. */
  crawlDelaySec: number | null;
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

/** No robots.txt (4xx): everything is allowed. */
export const ROBOTS_ALLOW_ALL: RobotsRules = Object.freeze({ groups: [] }) as RobotsRules;

/** robots.txt unavailable (5xx, unreachable): RFC 9309 2.3.1.4 says assume complete disallow. */
export const ROBOTS_DISALLOW_ALL: RobotsRules = Object.freeze({
  groups: [
    {
      agents: ['*'],
      rules: [{ allow: false, pattern: '/', anchored: false }],
      crawlDelaySec: null,
    },
  ],
}) as RobotsRules;

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const HEX = '0123456789ABCDEF';
const textEncoder = new TextEncoder();

/**
 * RFC 9309 2.2.2: compare octets after normalising percent-encoding. Escapes of
 * unreserved characters are decoded, other escapes get upper-case hex, and
 * non-ASCII characters are UTF-8 percent-encoded. `*` and `$` are left alone
 * (callers treat them as pattern syntax).
 */
function normalisePercent(input: string): string {
  let out = '';
  for (let i = 0; i < input.length;) {
    const ch = input.charAt(i);
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 1, i + 3))) {
      const code = parseInt(input.slice(i + 1, i + 3), 16);
      const decoded = String.fromCharCode(code);
      out +=
        code < 0x80 && UNRESERVED.test(decoded) ? decoded : `%${HEX[code >> 4]}${HEX[code & 15]}`;
      i += 3;
    } else if (ch.charCodeAt(0) < 0x80) {
      out += ch;
      i += 1;
    } else {
      // A whole code point (surrogate pairs included).
      const cp = input.codePointAt(i) ?? 0xfffd;
      const text = String.fromCodePoint(cp);
      for (const byte of textEncoder.encode(text)) out += `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
      i += text.length;
    }
  }
  return out;
}

function parseRule(allow: boolean, rawValue: string): RobotsRule | null {
  let value = rawValue.trim();
  // An empty Disallow means "nothing is disallowed"; an empty Allow adds nothing.
  if (value === '') return null;
  let anchored = false;
  if (value.endsWith('$')) {
    anchored = true;
    value = value.slice(0, -1);
  }
  // A pattern must start at the root. Failing closed: "Disallow: admin" is read as "/admin".
  if (!value.startsWith('/') && !value.startsWith('*')) value = `/${value}`;
  return { allow, pattern: normalisePercent(value), anchored };
}

/** Parses a crawl-delay value: a non-negative decimal number of seconds, nothing else. */
function parseDelay(value: string): number | null {
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * Parses robots.txt. Never throws: arbitrary text yields a (possibly empty)
 * rule set. Handles BOM, CR / LF / CRLF, comments, case-insensitive field
 * names, and groups with several user-agent lines. Unknown fields (Sitemap,
 * Host, ...) are ignored and do not end a group.
 */
export function parseRobots(text: string): RobotsRules {
  const source = text.length > ROBOTS_MAX_BYTES ? text.slice(0, ROBOTS_MAX_BYTES) : text;
  const body = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  /** True while the lines since the group started are only user-agent lines. */
  let collectingAgents = false;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (agent === '') continue;
      if (current === null || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(agent);
      collectingAgents = true;
    } else if (field === 'allow' || field === 'disallow') {
      collectingAgents = false;
      if (current === null) continue;
      const rule = parseRule(field === 'allow', value);
      if (rule !== null) current.rules.push(rule);
    } else if (field === 'crawl-delay') {
      collectingAgents = false;
      if (current === null) continue;
      const delay = parseDelay(value);
      if (delay !== null) current.crawlDelaySec = delay;
    }
  }
  return { groups };
}

/**
 * The product token of a user agent: the part before the first '/', space or
 * '(' ("VamosBot/1.0 (+mailto:x)" -> "vamosbot"), lower-cased.
 */
export function productToken(userAgent: string): string {
  const match = /^[^\s/(;,]+/.exec(userAgent.trim());
  return (match?.[0] ?? '').toLowerCase();
}

/**
 * The groups that apply to a crawler: every group that names its product token
 * (merged, as RFC 9309 2.2.1 says), otherwise every `*` group, otherwise none.
 */
function applicableGroups(robots: RobotsRules, userAgentToken: string): RobotsGroup[] {
  const token = productToken(userAgentToken);
  if (token !== '' && token !== '*') {
    const specific = robots.groups.filter((g) => g.agents.includes(token));
    if (specific.length > 0) return specific;
  }
  return robots.groups.filter((g) => g.agents.includes('*'));
}

/**
 * Does `pattern` match the start of `path`? `*` matches any run of characters;
 * when `anchored`, the whole path must be consumed. Iterative with a single
 * backtrack point: O(pattern * path) worst case, no recursion, no regex.
 */
function patternMatches(pattern: string, anchored: boolean, path: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  for (;;) {
    if (p < pattern.length && pattern.charAt(p) === '*') {
      starP = p;
      starS = s;
      p += 1;
    } else if (p === pattern.length) {
      // Pattern exhausted: a prefix match is enough unless anchored.
      if (!anchored || s === path.length) return true;
      if (starP < 0) return false;
      p = starP + 1;
      starS += 1;
      s = starS;
      if (starS > path.length) return false;
    } else if (s < path.length && pattern.charAt(p) === path.charAt(s)) {
      p += 1;
      s += 1;
    } else if (starP >= 0 && starS < path.length) {
      p = starP + 1;
      starS += 1;
      s = starS;
    } else {
      return false;
    }
  }
}

/**
 * RFC 9309 2.2.2: may `userAgentToken` fetch `path` (path plus query, e.g.
 * "/fixtures?round=3")? The longest matching rule wins; Allow wins a tie; no
 * matching rule (or no applicable group) means allowed. `/robots.txt` itself is
 * always fetchable.
 */
export function isAllowed(robots: RobotsRules, userAgentToken: string, path: string): boolean {
  const normalised = normalisePercent(path.startsWith('/') ? path : `/${path}`);
  if (normalised === '/robots.txt') return true;
  let best: RobotsRule | null = null;
  for (const group of applicableGroups(robots, userAgentToken)) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, rule.anchored, normalised)) continue;
      if (
        best === null ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return best === null ? true : best.allow;
}

/**
 * The Crawl-delay for this crawler in milliseconds, capped at
 * `ROBOTS_MAX_CRAWL_DELAY_MS`; 0 when none. If several matching groups give
 * one, the largest wins (the polite choice).
 */
export function robotsCrawlDelayMs(robots: RobotsRules, userAgentToken: string): number {
  let seconds = 0;
  for (const group of applicableGroups(robots, userAgentToken)) {
    if (group.crawlDelaySec !== null && group.crawlDelaySec > seconds)
      seconds = group.crawlDelaySec;
  }
  return Math.min(ROBOTS_MAX_CRAWL_DELAY_MS, Math.round(seconds * 1000));
}
