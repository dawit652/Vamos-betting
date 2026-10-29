import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAliasIndex,
  createAdapter,
  safeParse,
  type AliasIndex,
  type ParseOutcome,
  type SourceAdapter,
} from '@vamos/scraper';
import {
  CATALOG_CATEGORIES,
  CATALOG_TEAMS,
  type CatalogTeam,
} from '../../../../packages/db/src/seed/catalog';

/**
 * Shared helpers of the data-accuracy evaluation (docs/scraper-evaluation/01-data-accuracy.md).
 * Everything here is read-only: it parses files and builds in-memory structures, nothing is
 * written anywhere except by the callers' own output file.
 */

export const SOURCE_FILE = fileURLToPath(
  new URL('../../../../docs/scraper-plan/data/source-openfootball-en1.json', import.meta.url),
);

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0] ?? [];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export interface SourceEnvelope {
  id: string;
  name: string;
  adapter: 'openfootball';
  upstream: string;
  config: Record<string, unknown>;
}

export function readEnvelope(path: string): SourceEnvelope {
  return JSON.parse(readFileSync(path, 'utf8')) as SourceEnvelope;
}

export const ofUrl = (season: string, league: string): string =>
  `https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${league}.json`;

/** The real adapter (`createAdapter`) built from the shipped envelope with another URL, label and zone. */
export function buildAdapter(
  envelope: SourceEnvelope,
  url: string,
  competition: string,
  timeZone: string,
): SourceAdapter {
  const built = createAdapter({
    id: envelope.id,
    adapter: envelope.adapter,
    upstream: envelope.upstream,
    config: { ...envelope.config, requests: [{ url, competition }], timeZone },
  });
  if (!built.ok) throw new Error(`adapter config refused: ${built.errors.join('; ')}`);
  return built.adapter;
}

/** Parses one openfootball document the way `dry-parse` does (safeParse, fixed fetch time). */
export function parseDocument(
  adapter: SourceAdapter,
  url: string,
  body: string,
  fetchedAt: Date,
): ParseOutcome {
  return safeParse(adapter, {
    sourceId: adapter.descriptor.id,
    url,
    status: 200,
    contentType: 'application/json',
    body,
    fetchedAt,
    contentHash: createHash('sha256').update(body).digest('hex'),
  });
}

export interface OfMatch {
  round?: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: unknown;
}

export function readOfMatches(path: string): { name: string; body: string; matches: OfMatch[] } {
  const body = readFileSync(path, 'utf8');
  const json = JSON.parse(body) as { name?: string; matches: OfMatch[] };
  return { name: json.name ?? '', body, matches: json.matches };
}

/** FPL team name -> the name openfootball uses. Every mapping is listed, none is derived. */
export const FPL_TO_OPENFOOTBALL: Record<string, string> = {
  Arsenal: 'Arsenal FC',
  'Aston Villa': 'Aston Villa FC',
  Bournemouth: 'AFC Bournemouth',
  Brentford: 'Brentford FC',
  Brighton: 'Brighton & Hove Albion FC',
  Burnley: 'Burnley FC',
  Chelsea: 'Chelsea FC',
  'Coventry City': 'Coventry City FC',
  'Crystal Palace': 'Crystal Palace FC',
  Everton: 'Everton FC',
  Fulham: 'Fulham FC',
  'Hull City': 'Hull City AFC',
  'Ipswich Town': 'Ipswich Town FC',
  Leeds: 'Leeds United FC',
  Liverpool: 'Liverpool FC',
  'Man City': 'Manchester City FC',
  'Man Utd': 'Manchester United FC',
  Newcastle: 'Newcastle United FC',
  "Nott'm Forest": 'Nottingham Forest FC',
  Spurs: 'Tottenham Hotspur FC',
  Sunderland: 'Sunderland AFC',
  'West Ham': 'West Ham United FC',
  Wolves: 'Wolverhampton Wanderers FC',
};

export interface Fpl {
  id: string;
  home: string;
  away: string;
  kickoff: Date;
  finished: boolean;
  homeScore: number | null;
  awayScore: number | null;
  event: string;
}

const num = (v: string): number | null => (v === '' ? null : Math.round(Number(v)));

export function loadFpl(dir: string, season: string): Fpl[] {
  const teams = new Map(
    parseCsv(readFileSync(join(dir, 'fpl', season, 'teams.csv'), 'utf8')).map((t) => [
      t['id'] ?? '',
      t['name'] ?? '',
    ]),
  );
  const nameOf = (id: string): string => {
    const fpl = teams.get(id);
    const of = fpl === undefined ? undefined : FPL_TO_OPENFOOTBALL[fpl];
    if (of === undefined) throw new Error(`no manual mapping for FPL team id ${id} (${fpl})`);
    return of;
  };
  return parseCsv(readFileSync(join(dir, 'fpl', season, 'fixtures.csv'), 'utf8')).map((r) => ({
    id: r['id'] ?? '',
    home: nameOf(r['team_h'] ?? ''),
    away: nameOf(r['team_a'] ?? ''),
    kickoff: new Date(r['kickoff_time'] ?? ''),
    finished: r['finished'] === 'True',
    homeScore: num(r['team_h_score'] ?? ''),
    awayScore: num(r['team_a_score'] ?? ''),
    event: r['event'] ?? '',
  }));
}

/** The catalogue as the scraper sees it: `loadAliasInputs` builds names from `name` values plus the short name. */
export function catalogueIndex(
  teamAliases: Array<{ aliasNorm: string; sourceId: string | null; teamId: string }> = [],
): AliasIndex {
  return buildAliasIndex({
    teams: CATALOG_TEAMS.map((t) => ({
      id: teamId(t),
      sportId: t.sport,
      shortName: t.shortName,
      names: [...new Set(Object.values(t.name).filter((v) => v !== ''))],
    })),
    teamAliases,
    competitions: CATALOG_CATEGORIES.flatMap((c) =>
      c.competitions.map((comp) => ({
        id: `${c.sport}:${comp.slug}`,
        slug: comp.slug,
        sportId: c.sport,
        names: [...new Set(Object.values(comp.name).filter((v) => v !== ''))],
      })),
    ),
    competitionAliases: [],
  });
}

/** In-memory team id: `<sport>:<shortName>` (short names are unique per sport). */
export const teamId = (t: CatalogTeam): string => `${t.sport}:${t.shortName}`;

export const footballTeams = (): CatalogTeam[] =>
  CATALOG_TEAMS.filter((t) => t.sport === 'football');

export const minutesBetween = (a: Date, b: Date): number => (a.getTime() - b.getTime()) / 60_000;

export function argOf(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function requiredArg(args: string[], name: string): string {
  const v = argOf(args, name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(2)}%`;
