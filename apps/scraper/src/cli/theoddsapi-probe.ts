import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '@vamos/config';

/**
 * Phase 0b probe for The Odds API (docs/theoddsapi-plan/README.md, task P0b).
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/cli/theoddsapi-probe.ts [options]
 *
 * options:
 *   --leagues soccer_epl,...   sport keys (default: the five in the plan)
 *   --epl-repeat <n>           extra Premier League /odds reads (default 0; the plan uses 8 in a match day's last 3 h)
 *   --interval-min <m>         minutes between the extra reads (default 20)
 *   --max-credits <n>          stop before a call that could pass this many credits in total (default 40)
 *
 * Reads the key from SCRAPER_SECRET_THEODDSAPI. Never prints the key or a URL that holds it: every
 * printed URL is the keyless one, every error passes through `redact`, redirects are refused, and a
 * body that echoes the key is dropped. Bodies are saved under the OS temp folder, outside the repo.
 * Not used by the scraper process; it only reports.
 */

export const BASE = 'https://api.the-odds-api.com';
export const DEFAULT_LEAGUES = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_germany_bundesliga',
  'soccer_france_ligue_one',
] as const;
export const BOOKMAKERS = [
  'pinnacle',
  'betfair_ex_uk',
  'matchbook',
  'smarkets',
  'williamhill',
  'paddypower',
  'ladbrokes_uk',
  'betvictor',
  'marathonbet',
  'onexbet',
] as const;
const KEY_VAR = 'SCRAPER_SECRET_THEODDSAPI';
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// ---------------------------------------------------------------- response shape (only what we read)

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface OddsMarket {
  key: string;
  last_update?: string;
  outcomes: OddsOutcome[];
}
export interface OddsBookmaker {
  key: string;
  last_update?: string;
  markets: OddsMarket[];
}
export interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// ---------------------------------------------------------------- pure helpers (tested)

/** Replaces every occurrence of the key (raw and URL-encoded) with `***`. */
export function redact(text: string, key: string): string {
  if (key.length === 0) return text;
  let out = text.split(key).join('***');
  const enc = encodeURIComponent(key);
  if (enc !== key) out = out.split(enc).join('***');
  return out;
}

/** A key we are willing to send: printable ASCII, no spaces, sensible length. */
export function isUsableKey(key: string | undefined): key is string {
  return key !== undefined && /^[\x21-\x7e]{8,128}$/.test(key);
}

function hasCompleteH2h(m: OddsMarket | undefined, home: string, away: string): boolean {
  if (m === undefined) return false;
  const names = new Set(m.outcomes.filter((o) => o.price > 1).map((o) => o.name));
  return names.has(home) && names.has(away) && names.has('Draw');
}

function hasLine(m: OddsMarket | undefined, point: number): boolean {
  if (m === undefined) return false;
  const at = m.outcomes.filter((o) => o.point === point && o.price > 1).map((o) => o.name);
  return at.includes('Over') && at.includes('Under');
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export interface BookStats {
  events: number;
  h2hComplete: number;
  line25: number;
  /** Median of (1/home + 1/draw + 1/away − 1) over complete 1X2s, in percent. */
  overroundPct?: number;
  /** Median age of the h2h `last_update`, in minutes, at `now`. */
  ageMin?: number;
}

export interface LeagueReport {
  events: number;
  prematch: number;
  /** Per prematch event: books with a complete 1X2. */
  booksH2h: number[];
  /** Per prematch event: books with both sides of the 2.5 line. */
  books25: number[];
  /** Totals points seen and how many book-events offered each. */
  totalsPoints: Record<string, number>;
  perBook: Record<string, BookStats>;
  missingBooks: string[];
}

/** Summarises an /odds body. Live events (kickoff at or before `now`) are left out, as the adapter will. */
export function analyseOdds(events: OddsEvent[], now: Date): LeagueReport {
  const prematch = events.filter((e) => Date.parse(e.commence_time) > now.getTime());
  const perBook: Record<string, { s: BookStats; over: number[]; age: number[] }> = {};
  const totalsPoints: Record<string, number> = {};
  const booksH2h: number[] = [];
  const books25: number[] = [];

  for (const e of prematch) {
    let nH2h = 0;
    let n25 = 0;
    for (const b of e.bookmakers) {
      const entry = (perBook[b.key] ??= {
        s: { events: 0, h2hComplete: 0, line25: 0 },
        over: [],
        age: [],
      });
      entry.s.events++;
      const h2h = b.markets.find((m) => m.key === 'h2h');
      const totals = b.markets.find((m) => m.key === 'totals');
      if (hasCompleteH2h(h2h, e.home_team, e.away_team) && h2h !== undefined) {
        nH2h++;
        entry.s.h2hComplete++;
        const inv = h2h.outcomes.reduce((acc, o) => acc + 1 / o.price, 0);
        entry.over.push((inv - 1) * 100);
        const ts = Date.parse(h2h.last_update ?? b.last_update ?? '');
        if (Number.isFinite(ts)) entry.age.push((now.getTime() - ts) / 60_000);
      }
      if (hasLine(totals, 2.5)) {
        n25++;
        entry.s.line25++;
      }
      for (const p of new Set((totals?.outcomes ?? []).map((o) => o.point))) {
        if (p !== undefined) totalsPoints[String(p)] = (totalsPoints[String(p)] ?? 0) + 1;
      }
    }
    booksH2h.push(nH2h);
    books25.push(n25);
  }

  const stats: Record<string, BookStats> = {};
  for (const [k, v] of Object.entries(perBook)) {
    const o = median(v.over);
    const a = median(v.age);
    stats[k] = {
      ...v.s,
      ...(o === undefined ? {} : { overroundPct: Math.round(o * 100) / 100 }),
      ...(a === undefined ? {} : { ageMin: Math.round(a) }),
    };
  }
  const seen = new Set(Object.keys(stats));
  return {
    events: events.length,
    prematch: prematch.length,
    booksH2h,
    books25,
    totalsPoints,
    perBook: stats,
    missingBooks: BOOKMAKERS.filter((b) => !seen.has(b)),
  };
}

// ---------------------------------------------------------------- I/O

interface Credits {
  remaining?: string;
  used?: string;
  last?: string;
}

interface CallResult {
  status: number;
  body: unknown;
  credits: Credits;
}

class Probe {
  spent = 0;
  constructor(
    private readonly key: string,
    private readonly outDir: string,
    private readonly maxCredits: number,
  ) {}

  /**
   * GET `path` (keyless, with its own query). The key goes only into the copy passed to fetch,
   * as `apiKey=` or, with `viaHeader`, as an `x-api-key` header.
   */
  async call(
    label: string,
    path: string,
    cost: number,
    viaHeader = false,
  ): Promise<CallResult | undefined> {
    if (this.spent + cost > this.maxCredits) {
      out(`  skip ${label}: would pass --max-credits ${this.maxCredits}`);
      return undefined;
    }
    const plain = new URL(path, BASE);
    const real = new URL(plain);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (viaHeader) headers['x-api-key'] = this.key;
    else real.searchParams.set('apiKey', this.key);

    let res: Response;
    try {
      res = await fetch(real, { headers, redirect: 'manual' });
    } catch (err) {
      out(`  ${label}: network error: ${redact(String(err), this.key)}`);
      return undefined;
    }
    const credits: Credits = {
      remaining: res.headers.get('x-requests-remaining') ?? undefined,
      used: res.headers.get('x-requests-used') ?? undefined,
      last: res.headers.get('x-requests-last') ?? undefined,
    };
    const last = Number(credits.last);
    this.spent += Number.isFinite(last) ? last : 0;
    if (res.status >= 300 && res.status < 400) {
      out(`  ${label}: refused a redirect (${res.status}); the key is not sent on`);
      return { status: res.status, body: undefined, credits };
    }
    const text = await res.text();
    if (text.includes(this.key) || text.includes(encodeURIComponent(this.key))) {
      out(`  ${label}: the body echoes the key; dropped (not saved, not parsed)`);
      return { status: res.status, body: undefined, credits };
    }
    const file = join(this.outDir, `${label.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    writeFileSync(file, text);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    out(
      `  ${label}: ${res.status} ${plain.pathname}${plain.search}  credits last=${credits.last ?? '?'} used=${credits.used ?? '?'} remaining=${credits.remaining ?? '?'}`,
    );
    return { status: res.status, body, credits };
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function oddsPath(league: string): string {
  const q = new URLSearchParams({
    bookmakers: BOOKMAKERS.join(','),
    markets: 'h2h,totals',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  });
  return `/v4/sports/${league}/odds?${q.toString()}`;
}

function printLeague(league: string, r: LeagueReport): void {
  const fmt = (xs: number[]): string =>
    xs.length === 0
      ? '–'
      : `min ${Math.min(...xs)} / median ${median(xs)} / max ${Math.max(...xs)}`;
  out(`\n== ${league}: ${r.events} events, ${r.prematch} prematch`);
  out(`   books with a complete 1X2 per event: ${fmt(r.booksH2h)}`);
  out(`   books with the 2.5 line per event:   ${fmt(r.books25)}`);
  out(`   totals points (book-events): ${JSON.stringify(r.totalsPoints)}`);
  if (r.missingBooks.length > 0) out(`   books never seen: ${r.missingBooks.join(', ')}`);
  out('   book            events  1X2  2.5  overround%  age(min)');
  for (const [k, s] of Object.entries(r.perBook).sort()) {
    out(
      `   ${k.padEnd(15)} ${String(s.events).padStart(6)} ${String(s.h2hComplete).padStart(4)} ${String(s.line25).padStart(4)} ${String(s.overroundPct ?? '–').padStart(11)} ${String(s.ageMin ?? '–').padStart(9)}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadDotEnv();
  const key = process.env[KEY_VAR];
  if (!isUsableKey(key)) {
    console.error(`${KEY_VAR} is not set or not a usable key; nothing was requested`);
    return 1;
  }
  const leagues = (arg(argv, '--leagues') ?? DEFAULT_LEAGUES.join(',')).split(',').filter(Boolean);
  const repeat = Number(arg(argv, '--epl-repeat') ?? 0);
  const intervalMin = Number(arg(argv, '--interval-min') ?? 20);
  const maxCredits = Number(arg(argv, '--max-credits') ?? 40);
  if (![repeat, intervalMin, maxCredits].every((n) => Number.isFinite(n) && n >= 0)) {
    console.error('bad numeric option');
    return 2;
  }

  const outDir = join(
    tmpdir(),
    `vamos-theoddsapi-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(outDir, { recursive: true });
  out(`bodies saved under ${outDir}`);
  const probe = new Probe(key, outDir, maxCredits);

  out('\n-- auth (free)');
  const viaHeader = await probe.call('sports-header', '/v4/sports', 0, true);
  const viaQuery = await probe.call('sports-query', '/v4/sports', 0);
  out(
    `   header x-api-key accepted: ${viaHeader?.status === 200 ? 'YES (skip rules K, use the header)' : `no (${viaHeader?.status ?? 'error'})`}`,
  );
  if (viaQuery?.status !== 200) {
    console.error(`the key was refused (${viaQuery?.status ?? 'error'}); stopping`);
    return 1;
  }
  const active = new Set(
    (Array.isArray(viaQuery.body) ? (viaQuery.body as { key: string }[]) : []).map((s) => s.key),
  );

  out('\n-- participants (1 credit each)');
  for (const l of leagues) {
    if (!active.has(l)) out(`   ${l}: not in /v4/sports right now (out of season?)`);
    await probe.call(`participants-${l}`, `/v4/sports/${l}/participants`, 1);
  }

  out('\n-- odds (2 credits each)');
  for (const l of leagues) {
    const r = await probe.call(`odds-${l}`, oddsPath(l), 2);
    if (r?.status === 200 && Array.isArray(r.body))
      printLeague(l, analyseOdds(r.body as OddsEvent[], new Date()));
  }

  for (let i = 1; i <= repeat; i++) {
    out(`\n-- Premier League repeat ${i}/${repeat} in ${intervalMin} min`);
    await new Promise((res) => setTimeout(res, intervalMin * 60_000));
    const r = await probe.call(`odds-soccer_epl-repeat-${i}`, oddsPath('soccer_epl'), 2);
    if (r?.status === 200 && Array.isArray(r.body))
      printLeague('soccer_epl', analyseOdds(r.body as OddsEvent[], new Date()));
  }

  out(`\ncredits spent by this run: ${probe.spent}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      const key = process.env[KEY_VAR] ?? '';
      console.error(redact(String(err), key));
      process.exit(1);
    },
  );
}
