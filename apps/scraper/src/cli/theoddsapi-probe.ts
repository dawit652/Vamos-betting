import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '@vamos/config';

/**
 * Phase 0 probe for The Odds API (docs/theoddsapi-plan/README.md, tasks P0b and P0c).
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/cli/theoddsapi-probe.ts [options]
 *
 * options:
 *   --leagues a,b        sport keys (default: the five in the plan)
 *   --books a,b          bookmaker keys, at most 10 (default: the plan's ten)
 *   --regions uk,eu,us   discovery: every book of these regions instead of --books; costs
 *                        2 × regions per league (for choosing books, never for production)
 *   --participants       also read /participants (1 credit per league)
 *   --alt-totals <n>     per league, read `alternate_totals` for the next n events through the
 *                        per-event endpoint (1 credit per event and region)
 *   --events             print each event's books per goals line
 *   --epl-repeat <n>     extra Premier League /odds reads (default 0)
 *   --interval-min <m>   minutes between those reads (default 20)
 *   --max-credits <n>    never start a call that could pass this many credits in total (default 40)
 *   --from-dir <dir>     no network and no key: re-read the odds-*.json bodies an earlier run saved;
 *                        with --books, only those books (to try a book list on a discovery run)
 *
 * Reads the key from SCRAPER_SECRET_THEODDSAPI. Never prints the key or a URL that holds it: every
 * printed URL is the keyless one, errors pass through `redact`, redirects are refused, and a body
 * that echoes the key is dropped. Bodies are saved under the OS temp folder, outside the repo.
 * Once the free checks prove the `x-api-key` header works, every charged call uses the header.
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
  'betsson',
  'unibet_se',
  'tipico_de',
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
  let result = text.split(key).join('***');
  const enc = encodeURIComponent(key);
  if (enc !== key) result = result.split(enc).join('***');
  return result;
}

/** A key we are willing to send: printable ASCII, no spaces, sensible length. */
export function isUsableKey(key: string | undefined): key is string {
  return key !== undefined && /^[\x21-\x7e]{8,128}$/.test(key);
}

/** x.5 lines only: whole and quarter lines can push, and the consensus ignores them. */
export function isHalfLine(point: number): boolean {
  return Number.isInteger(point * 2) && !Number.isInteger(point);
}

function hasCompleteH2h(m: OddsMarket | undefined, home: string, away: string): boolean {
  if (m === undefined) return false;
  const names = new Set(m.outcomes.filter((o) => o.price > 1).map((o) => o.name));
  return names.has(home) && names.has(away) && names.has('Draw');
}

/** The points at which a totals market has both Over and Under, ascending. */
function completeLines(m: OddsMarket | undefined): number[] {
  if (m === undefined) return [];
  const sides = new Map<number, Set<string>>();
  for (const o of m.outcomes) {
    if (o.point === undefined || !(o.price > 1)) continue;
    let s = sides.get(o.point);
    if (s === undefined) sides.set(o.point, (s = new Set<string>()));
    s.add(o.name);
  }
  return [...sides]
    .filter(([, s]) => s.has('Over') && s.has('Under'))
    .map(([p]) => p)
    .sort((a, b) => a - b);
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
  /** Every totals point this book quoted, with the number of events. */
  lines: Record<string, number>;
  /** Median of (1/home + 1/draw + 1/away − 1) over complete 1X2s, in percent. */
  overroundPct?: number;
  /** Median age of the h2h `last_update`, in minutes, at `now`. */
  ageMin?: number;
}

export interface EventDetail {
  kickoff: string;
  match: string;
  /** Books with a complete 1X2. */
  h2h: number;
  /** x.5 line → books with both sides of it. */
  halfLines: Record<string, number>;
}

export interface LeagueReport {
  events: number;
  prematch: number;
  /** Per prematch event: books with a complete 1X2. */
  booksH2h: number[];
  /** Per prematch event: books with both sides of the 2.5 line. */
  books25: number[];
  /** Prematch events with a 2.5 consensus (at least 2 books), which the pricing fits today. */
  with25: number;
  /** Prematch events with at least 2 books on one x.5 line, whichever it is. */
  withAnyHalf: number;
  /** Totals points seen and how many book-events offered each. */
  totalsPoints: Record<string, number>;
  perBook: Record<string, BookStats>;
  /** Expected books never seen. */
  missingBooks: string[];
  detail: EventDetail[];
}

/** Summarises an /odds body. Live events (kickoff at or before `now`) are left out, as the adapter will. */
export function analyseOdds(
  events: OddsEvent[],
  now: Date,
  expectedBooks: readonly string[] = BOOKMAKERS,
): LeagueReport {
  const prematch = events.filter((e) => Date.parse(e.commence_time) > now.getTime());
  const perBook: Record<string, { s: BookStats; over: number[]; age: number[] }> = {};
  const totalsPoints: Record<string, number> = {};
  const booksH2h: number[] = [];
  const books25: number[] = [];
  const detail: EventDetail[] = [];
  let with25 = 0;
  let withAnyHalf = 0;

  for (const e of prematch) {
    let nH2h = 0;
    const half: Record<string, number> = {};
    for (const b of e.bookmakers) {
      const entry = (perBook[b.key] ??= {
        s: { events: 0, h2hComplete: 0, line25: 0, lines: {} },
        over: [],
        age: [],
      });
      entry.s.events++;
      const h2h = b.markets.find((m) => m.key === 'h2h');
      const totals = b.markets.find((m) => m.key === 'totals');
      if (h2h !== undefined && hasCompleteH2h(h2h, e.home_team, e.away_team)) {
        nH2h++;
        entry.s.h2hComplete++;
        const inv = h2h.outcomes.reduce((acc, o) => acc + 1 / o.price, 0);
        entry.over.push((inv - 1) * 100);
        const ts = Date.parse(h2h.last_update ?? b.last_update ?? '');
        if (Number.isFinite(ts)) entry.age.push((now.getTime() - ts) / 60_000);
      }
      for (const p of new Set((totals?.outcomes ?? []).map((o) => o.point))) {
        if (p === undefined) continue;
        const k = String(p);
        totalsPoints[k] = (totalsPoints[k] ?? 0) + 1;
        entry.s.lines[k] = (entry.s.lines[k] ?? 0) + 1;
      }
      for (const p of completeLines(totals)) {
        if (!isHalfLine(p)) continue;
        half[String(p)] = (half[String(p)] ?? 0) + 1;
        if (p === 2.5) entry.s.line25++;
      }
    }
    const n25 = half['2.5'] ?? 0;
    booksH2h.push(nH2h);
    books25.push(n25);
    if (n25 >= 2) with25++;
    if (Object.values(half).some((n) => n >= 2)) withAnyHalf++;
    detail.push({
      kickoff: e.commence_time,
      match: `${e.home_team} v ${e.away_team}`,
      h2h: nH2h,
      halfLines: half,
    });
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
    with25,
    withAnyHalf,
    totalsPoints,
    perBook: stats,
    missingBooks: expectedBooks.filter((b) => !seen.has(b)),
    detail,
  };
}

/** One per-event `alternate_totals` body: each book's complete lines, and how many have 2.5. */
export function analyseAltTotals(e: OddsEvent): {
  books: Record<string, number[]>;
  with25: number;
} {
  const books: Record<string, number[]> = {};
  let with25 = 0;
  for (const b of e.bookmakers) {
    const lines = completeLines(b.markets.find((m) => m.key === 'alternate_totals'));
    if (lines.length === 0) continue;
    books[b.key] = lines;
    if (lines.includes(2.5)) with25++;
  }
  return { books, with25 };
}

// ---------------------------------------------------------------- I/O

type Auth = 'query' | 'header' | 'none';

interface CallResult {
  status: number;
  body: unknown;
}

class Probe {
  spent = 0;
  constructor(
    private readonly key: string,
    private readonly outDir: string,
    private readonly maxCredits: number,
  ) {}

  /**
   * GET `path` (keyless, with its own query). The key goes only into the copy passed to fetch:
   * as `apiKey=`, as an `x-api-key` header, or not at all.
   */
  async call(
    label: string,
    path: string,
    cost: number,
    auth: Auth,
  ): Promise<CallResult | undefined> {
    if (this.spent + cost > this.maxCredits) {
      out(`  skip ${label}: would pass --max-credits ${this.maxCredits}`);
      return undefined;
    }
    const plain = new URL(path, BASE);
    const real = new URL(plain);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth === 'header') headers['x-api-key'] = this.key;
    if (auth === 'query') real.searchParams.set('apiKey', this.key);

    let res: Response;
    try {
      res = await fetch(real, { headers, redirect: 'manual' });
    } catch (err) {
      out(`  ${label}: network error: ${redact(String(err), this.key)}`);
      return undefined;
    }
    const last = Number(res.headers.get('x-requests-last'));
    this.spent += Number.isFinite(last) ? last : 0;
    const credits = `credits last=${res.headers.get('x-requests-last') ?? '?'} used=${res.headers.get('x-requests-used') ?? '?'} remaining=${res.headers.get('x-requests-remaining') ?? '?'}`;
    if (res.status >= 300 && res.status < 400) {
      out(`  ${label}: refused a redirect (${res.status}); the key is not sent on`);
      return { status: res.status, body: undefined };
    }
    const text = await res.text();
    if (text.includes(this.key) || text.includes(encodeURIComponent(this.key))) {
      out(`  ${label}: the body echoes the key; dropped (not saved, not parsed)`);
      return { status: res.status, body: undefined };
    }
    writeFileSync(join(this.outDir, `${label.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), text);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    out(`  ${label}: ${res.status} ${plain.pathname}${plain.search}  ${credits}`);
    return { status: res.status, body };
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

type Selection = { bookmakers: readonly string[] } | { regions: readonly string[] };

function selectionQuery(sel: Selection): Record<string, string> {
  return 'regions' in sel
    ? { regions: sel.regions.join(',') }
    : { bookmakers: sel.bookmakers.join(',') };
}

/** Region-equivalents a request is charged for: each region, or each group of 10 named books. */
function regionCount(sel: Selection): number {
  return 'regions' in sel ? sel.regions.length : Math.ceil(sel.bookmakers.length / 10);
}

function oddsPath(league: string, sel: Selection): string {
  const q = new URLSearchParams({
    ...selectionQuery(sel),
    markets: 'h2h,totals',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  });
  return `/v4/sports/${league}/odds?${q.toString()}`;
}

function altTotalsPath(league: string, eventId: string, sel: Selection): string {
  const q = new URLSearchParams({
    ...selectionQuery(sel),
    markets: 'alternate_totals',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  });
  return `/v4/sports/${league}/events/${encodeURIComponent(eventId)}/odds?${q.toString()}`;
}

const pct = (n: number, of: number): string =>
  of === 0 ? '–' : `${n}/${of} (${Math.round((100 * n) / of)}%)`;

function printLeague(league: string, r: LeagueReport, showEvents: boolean): void {
  const fmt = (xs: number[]): string =>
    xs.length === 0
      ? '–'
      : `min ${Math.min(...xs)} / median ${median(xs)} / max ${Math.max(...xs)}`;
  out(`\n== ${league}: ${r.events} events, ${r.prematch} prematch`);
  out(`   books with a complete 1X2 per event: ${fmt(r.booksH2h)}`);
  out(`   books with the 2.5 line per event:   ${fmt(r.books25)}`);
  out(`   events with a 2.5 consensus (>= 2 books):    ${pct(r.with25, r.prematch)}`);
  out(`   events with >= 2 books on one x.5 line:      ${pct(r.withAnyHalf, r.prematch)}`);
  out(`   totals points (book-events): ${JSON.stringify(r.totalsPoints)}`);
  if (r.missingBooks.length > 0) out(`   books never seen: ${r.missingBooks.join(', ')}`);
  out('   book                 events  1X2  2.5  overround%  age(min)  totals lines');
  for (const [k, s] of Object.entries(r.perBook).sort(([a], [b]) => a.localeCompare(b))) {
    const lines = Object.entries(s.lines)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([p, n]) => `${p}x${n}`)
      .join(' ');
    out(
      `   ${k.padEnd(20)} ${String(s.events).padStart(6)} ${String(s.h2hComplete).padStart(4)} ${String(s.line25).padStart(4)} ${String(s.overroundPct ?? '–').padStart(11)} ${String(s.ageMin ?? '–').padStart(9)}  ${lines || '–'}`,
    );
  }
  if (showEvents) {
    for (const d of r.detail) {
      out(
        `   ${d.kickoff.slice(0, 16).replace('T', ' ')}  ${d.match.padEnd(44)} 1X2 ${String(d.h2h).padStart(2)}  x.5 lines ${JSON.stringify(d.halfLines)}`,
      );
    }
  }
}

/** The events with only the given books; every book when none are given. */
export function onlyBooks(events: OddsEvent[], books: readonly string[] | undefined): OddsEvent[] {
  if (books === undefined) return events;
  const keep = new Set(books);
  return events.map((e) => ({ ...e, bookmakers: e.bookmakers.filter((b) => keep.has(b.key)) }));
}

/** --from-dir: the saved /odds bodies again, each judged at its file's time. No network, no key. */
function reanalyse(dir: string, showEvents: boolean, books?: readonly string[]): number {
  const files = readdirSync(dir)
    .filter((f) => /^odds-.+\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    process.stderr.write(`no odds-*.json files in ${dir}\n`);
    return 1;
  }
  for (const f of files) {
    const path = join(dir, f);
    let body: unknown;
    try {
      body = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      out(`\n${f}: not JSON, skipped`);
      continue;
    }
    if (!Array.isArray(body)) {
      out(`\n${f}: not an event list, skipped`);
      continue;
    }
    printLeague(
      f.replace(/^odds-|\.json$/g, ''),
      analyseOdds(onlyBooks(body as OddsEvent[], books), statSync(path).mtime, books ?? []),
      showEvents,
    );
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const showEvents = argv.includes('--events');
  const fromDir = arg(argv, '--from-dir');
  if (fromDir !== undefined) return reanalyse(fromDir, showEvents, list(arg(argv, '--books')));

  loadDotEnv();
  const key = process.env[KEY_VAR];
  if (!isUsableKey(key)) {
    process.stderr.write(`${KEY_VAR} is not set or not a usable key; nothing was requested\n`);
    return 1;
  }
  const leagues = list(arg(argv, '--leagues')) ?? [...DEFAULT_LEAGUES];
  const books = list(arg(argv, '--books')) ?? [...BOOKMAKERS];
  const regions = list(arg(argv, '--regions'));
  const repeat = Number(arg(argv, '--epl-repeat') ?? 0);
  const intervalMin = Number(arg(argv, '--interval-min') ?? 20);
  const maxCredits = Number(arg(argv, '--max-credits') ?? 40);
  const altTotals = Number(arg(argv, '--alt-totals') ?? 0);
  if (![repeat, intervalMin, maxCredits, altTotals].every((n) => Number.isFinite(n) && n >= 0)) {
    process.stderr.write('bad numeric option\n');
    return 2;
  }
  const keyName = /^[a-z0-9_]+$/;
  if (
    books.length === 0 ||
    books.length > 10 ||
    !books.every((b) => keyName.test(b)) ||
    !leagues.every((l) => keyName.test(l)) ||
    (regions !== undefined && !regions.every((r) => /^[a-z]{2}$/.test(r)))
  ) {
    process.stderr.write('bad --books (1 to 10 keys), --leagues or --regions\n');
    return 2;
  }
  const sel: Selection = regions === undefined ? { bookmakers: books } : { regions };

  const outDir = join(
    tmpdir(),
    `vamos-theoddsapi-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(outDir, { recursive: true });
  out(`bodies saved under ${outDir}`);
  const probe = new Probe(key, outDir, maxCredits);

  out('\n-- auth (free)');
  const noKey = await probe.call('sports-nokey', '/v4/sports', 0, 'none');
  const viaHeader = await probe.call('sports-header', '/v4/sports', 0, 'header');
  const viaQuery = await probe.call('sports-query', '/v4/sports', 0, 'query');
  const headerProven =
    noKey !== undefined && noKey.status >= 400 && noKey.status < 500 && viaHeader?.status === 200;
  out(
    `   no key: ${noKey?.status ?? 'error'}; header x-api-key: ${viaHeader?.status ?? 'error'}; query apiKey: ${viaQuery?.status ?? 'error'}`,
  );
  out(
    headerProven
      ? '   header PROVEN (refused without a key, accepted with the header); charged calls below use the header'
      : '   header NOT proven; charged calls below use the query parameter',
  );
  const auth: Auth = headerProven ? 'header' : 'query';
  const sports = headerProven ? viaHeader : viaQuery;
  if (sports?.status !== 200) {
    process.stderr.write(`the key was refused (${sports?.status ?? 'error'}); stopping\n`);
    return 1;
  }
  const active = new Set(
    (Array.isArray(sports.body) ? (sports.body as { key: string }[]) : []).map((s) => s.key),
  );
  for (const l of leagues) {
    if (!active.has(l)) out(`   ${l}: not in /v4/sports right now (out of season?)`);
  }

  if (argv.includes('--participants')) {
    out('\n-- participants (1 credit each)');
    for (const l of leagues)
      await probe.call(`participants-${l}`, `/v4/sports/${l}/participants`, 1, auth);
  }

  const oddsCost = 2 * regionCount(sel);
  out(
    `\n-- odds (${oddsCost} credits each${regions === undefined ? '' : `, discovery: regions ${regions.join(',')}`})`,
  );
  for (const l of leagues) {
    const r = await probe.call(`odds-${l}`, oddsPath(l, sel), oddsCost, auth);
    if (r?.status === 200 && Array.isArray(r.body)) {
      printLeague(
        l,
        analyseOdds(r.body as OddsEvent[], new Date(), regions === undefined ? books : []),
        showEvents,
      );
    }
  }

  if (altTotals > 0) {
    const altCost = regionCount(sel);
    out(`\n-- alternate_totals, per event (${altCost} credit(s) each; the event list is free)`);
    for (const l of leagues) {
      const ev = await probe.call(`events-${l}`, `/v4/sports/${l}/events?dateFormat=iso`, 0, auth);
      const now = Date.now();
      const next = (Array.isArray(ev?.body) ? (ev.body as OddsEvent[]) : [])
        .filter((e) => Date.parse(e.commence_time) > now)
        .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time))
        .slice(0, altTotals);
      for (const e of next) {
        const r = await probe.call(`alt-${l}-${e.id}`, altTotalsPath(l, e.id, sel), altCost, auth);
        if (r?.status !== 200 || typeof r.body !== 'object' || r.body === null) continue;
        const a = analyseAltTotals({
          ...(r.body as OddsEvent),
          bookmakers: (r.body as OddsEvent).bookmakers ?? [],
        });
        out(`   ${e.home_team} v ${e.away_team}: ${a.with25} books with a complete 2.5 line`);
        for (const [b, lines] of Object.entries(a.books))
          out(`     ${b.padEnd(20)} ${lines.join(' ')}`);
        if (Object.keys(a.books).length === 0) out('     no book returned alternate_totals');
      }
    }
  }

  for (let i = 1; i <= repeat; i++) {
    out(`\n-- Premier League repeat ${i}/${repeat} in ${intervalMin} min`);
    await new Promise((res) => setTimeout(res, intervalMin * 60_000));
    const r = await probe.call(
      `odds-soccer_epl-repeat-${i}`,
      oddsPath('soccer_epl', sel),
      oddsCost,
      auth,
    );
    if (r?.status === 200 && Array.isArray(r.body)) {
      printLeague(
        'soccer_epl',
        analyseOdds(r.body as OddsEvent[], new Date(), regions === undefined ? books : []),
        showEvents,
      );
    }
  }

  out(`\ncredits spent by this run: ${probe.spent}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${redact(String(err), process.env[KEY_VAR] ?? '')}\n`);
      process.exit(1);
    },
  );
}
