import { legalFormStripped, normalizeName } from '../normalize';

/**
 * Final scores from API-Football (API-Sports v3) for the Hulusport-only matches (owner's decision of
 * 14 Nov 2026, docs/plans/hulusport-feed.md). Pure: no network, no clock. One request per day
 * (`GET /fixtures?date=YYYY-MM-DD`, UTC) lists every fixture of that day worldwide; a board match is
 * matched to one of them by kickoff and both team names, and only a single confident candidate counts.
 *
 * `score.fulltime` is the score after 90 minutes (extra time and penalties are separate fields), the
 * score every football market settles on.
 */

export const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
export const API_FOOTBALL_KEY_HEADER = 'x-apisports-key';
export const API_FOOTBALL_SECRET = 'SCRAPER_SECRET_API_FOOTBALL';
export const apiFootballFixturesUrl = (date: string): string =>
  `https://${API_FOOTBALL_HOST}/fixtures?date=${date}`;

/** Statuses whose `score.fulltime` is final: ended in 90 minutes, after extra time, on penalties. */
export const API_FOOTBALL_FINISHED = ['FT', 'AET', 'PEN'] as const;
/** Kickoffs further apart than this are different matches. */
export const RESULT_MATCH_KICKOFF_MS = 15 * 60_000;

export interface Score {
  home: number;
  away: number;
}

export interface ApiFootballFixture {
  id: number;
  kickoff: Date;
  home: string;
  away: string;
  /** API-Football's team ids (the team logos are media.api-sports.io/football/teams/<id>.png). */
  homeId: number | null;
  awayId: number | null;
  league: string | null;
  country: string | null;
  /** fixture.status.short: NS, 1H, HT, FT, AET, PEN, PST, CANC, ABD, AWD, WO, ... */
  status: string;
  /** The score after 90 minutes; null when not given. */
  fullTime: Score | null;
  halfTime: Score | null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const goals = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;

function scoreOf(value: unknown): Score | null {
  if (!isObject(value)) return null;
  const home = goals(value.home);
  const away = goals(value.away);
  return home === null || away === null ? null : { home, away };
}

/**
 * The fixtures of a `/fixtures` response, or null when the document is not one. API-Football reports
 * problems (a missing or wrong key, the daily limit) in `errors` with an empty `response`; they are
 * returned so the caller can log them.
 */
export function parseApiFootballFixtures(
  body: string,
): { fixtures: ApiFootballFixture[]; errors: string[] } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isObject(doc) || !Array.isArray(doc.response)) return null;
  const errors = Array.isArray(doc.errors)
    ? doc.errors.map(String)
    : isObject(doc.errors)
      ? Object.entries(doc.errors).map(([k, v]) => `${k}: ${String(v)}`)
      : [];
  const fixtures: ApiFootballFixture[] = [];
  for (const row of doc.response as unknown[]) {
    if (!isObject(row) || !isObject(row.fixture) || !isObject(row.teams)) continue;
    const id = row.fixture.id;
    const date = text(row.fixture.date);
    const kickoff = date === null ? null : new Date(date);
    const home = isObject(row.teams.home) ? text(row.teams.home.name) : null;
    const away = isObject(row.teams.away) ? text(row.teams.away.name) : null;
    const status = isObject(row.fixture.status) ? text(row.fixture.status.short) : null;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      kickoff === null ||
      Number.isNaN(kickoff.getTime()) ||
      home === null ||
      away === null ||
      status === null
    ) {
      continue;
    }
    const score = isObject(row.score) ? row.score : {};
    const league = isObject(row.league) ? row.league : {};
    const teamId = (team: unknown) =>
      isObject(team) && typeof team.id === 'number' && Number.isSafeInteger(team.id) && team.id > 0
        ? team.id
        : null;
    fixtures.push({
      id,
      kickoff,
      home,
      away,
      homeId: teamId(row.teams.home),
      awayId: teamId(row.teams.away),
      league: text(league.name),
      country: text(league.country),
      status,
      fullTime: scoreOf(score.fulltime),
      halfTime: scoreOf(score.halftime),
    });
  }
  return { fixtures, errors };
}

/** Abbreviations the two sites write differently, as one token. */
const ABBREVIATIONS: Readonly<Record<string, string>> = { utd: 'united', untd: 'united' };

/** Name tokens without accents, punctuation or legal forms ("FK", "FC", "SC", ...). */
function tokens(name: string): string[] {
  const norm = normalizeName(name);
  const stripped = legalFormStripped(norm);
  return (stripped === '' ? norm : stripped)
    .split(' ')
    .filter((t) => t !== '')
    .map((t) => ABBREVIATIONS[t] ?? t);
}

/**
 * Two spellings of one team: the same tokens, or every token of the shorter name in the longer one
 * ("Mlada Boleslav" and "FK Mlada Boleslav"), or at least two thirds of all tokens shared.
 */
export function sameTeamName(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (x.length === 0 || y.length === 0) return false;
  const setX = new Set(x);
  const setY = new Set(y);
  const shared = [...setX].filter((t) => setY.has(t)).length;
  if (shared === 0) return false;
  if (shared === Math.min(setX.size, setY.size)) return true;
  return shared * 3 >= (setX.size + setY.size - shared) * 2;
}

/**
 * The API-Football fixture of a board match: kickoff within RESULT_MATCH_KICKOFF_MS and both names
 * the same team, home as home. Exactly one candidate, or none (nothing is guessed).
 */
export function matchApiFootballFixture(
  match: { home: string; away: string; kickoff: Date },
  fixtures: readonly ApiFootballFixture[],
): ApiFootballFixture | null {
  const candidates = fixtures.filter(
    (f) =>
      Math.abs(f.kickoff.getTime() - match.kickoff.getTime()) <= RESULT_MATCH_KICKOFF_MS &&
      sameTeamName(match.home, f.home) &&
      sameTeamName(match.away, f.away),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}
