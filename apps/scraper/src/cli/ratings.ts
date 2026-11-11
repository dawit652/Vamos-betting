import { MAX_TEAM_RATING, MIN_TEAM_RATING, replayRatings, type FootballResult } from '@vamos/feed';
import {
  footballTeamNames,
  getTeamRatings,
  listRatedTeams,
  localizedNames,
  listUnratedTeams,
  setTeamRatings,
  type Database,
  type FootballTeamNames,
} from '@vamos/db';
import { competitions, teamAliases, teams } from '@vamos/db/schema';
import { isCalibrated, MIN_RATING_MATCHES, normalizeName } from '@vamos/scraper';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  CliFailure,
  EXIT_FAILED,
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  parseJson,
  readInput,
  requiredString,
  table,
  UsageError,
  type CliEnv,
} from './io';

/**
 * The key written next to attack, defence and matches: the date (YYYYMMDD) of
 * the newest result a backfill replayed for the team. A later run with a file
 * that ends earlier than this is refused: the ratings are newer than the file.
 */
export const BACKFILL_KEY = 'backfilled_through';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');
const goals = z.number().int().min(0).max(99);

/** results.json: regular-time scores of finished matches, in any order. */
export const BackfillFileSchema = z
  .array(
    z
      .object({
        date: isoDate,
        home: z.string().trim().min(1),
        away: z.string().trim().min(1),
        homeGoals: goals,
        awayGoals: goals,
      })
      .strict(),
  )
  .min(1);

const dayNumber = (date: string): number => Number(date.replaceAll('-', ''));

interface Snapshot {
  attack: number | null;
  defence: number | null;
  matches: number;
}

type Decision = { kind: 'update' } | { kind: 'unchanged' } | { kind: 'refused'; reason: string };

interface TeamRow {
  teamId: string;
  name: string;
  before: Snapshot;
  after: Snapshot;
  fileMatches: number;
  through: number;
  decision: Decision;
}

const close = (a: number | null, b: number | null) =>
  a !== null && b !== null && Math.abs(a - b) < 1e-9;

function snapshot(ratings: Record<string, number> | null): Snapshot {
  return {
    attack: ratings !== null && Number.isFinite(ratings.attack) ? (ratings.attack ?? null) : null,
    defence:
      ratings !== null && Number.isFinite(ratings.defence) ? (ratings.defence ?? null) : null,
    matches: ratings !== null && Number.isFinite(ratings.matches) ? (ratings.matches ?? 0) : 0,
  };
}

const fmt = (s: Snapshot): string =>
  s.attack === null && s.defence === null && s.matches === 0
    ? '-'
    : `attack ${s.attack?.toFixed(3) ?? '-'} defence ${s.defence?.toFixed(3) ?? '-'} matches ${s.matches}`;

/**
 * `ratings backfill --file results.json --competition <slug> [--dry-run]`:
 * learns team ratings from historical results (replayRatings, oldest first,
 * every team starting neutral) and stores them with setTeamRatings, `matches`
 * being the number of file results the team played.
 *
 * Safe to repeat: the replay always starts from neutral, so the same file
 * gives the same ratings and a second run changes (and audits) nothing. It
 * REFUSES, writing nothing at all, when a team
 *  - has `manual = 1` (a trader vouches for those ratings),
 *  - has already learned from more matches than the file holds (live results
 *    were applied since, a replay would throw them away), or
 *  - was last backfilled through a later date than the file reaches.
 * `--dry-run` computes and prints everything, including the refusals, and
 * writes nothing. Team names are catalogue short names (or any catalogue name), or global
 * team aliases (`aliases import` with an empty source).
 */
export async function ratingsBackfill(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    file: { type: 'string' },
    competition: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  noPositionals(parsed);
  const path = requiredString(parsed, 'file');
  const slug = requiredString(parsed, 'competition');
  const dryRun = parsed.values['dry-run'] === true;

  const file = BackfillFileSchema.safeParse(
    parseJson(await readInput(env, path, 'results file'), `results file ${path}`),
  );
  if (!file.success) {
    throw new CliFailure(
      `results file ${path} is not valid`,
      file.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.map(String).join('.') || 'file'}: ${issue.message}`),
    );
  }
  const input = file.data;
  const sameTeam = input.findIndex((r) => normalizeName(r.home) === normalizeName(r.away));
  if (sameTeam >= 0) {
    throw new CliFailure(`results file ${path} is not valid`, [
      `${sameTeam}: home and away are the same team`,
    ]);
  }

  const db: Database = await env.database();
  const plan = await db.transaction(async (tx) => {
    const found = await tx
      .select({ id: competitions.id, sportId: competitions.sportId })
      .from(competitions)
      .where(eq(competitions.slug, slug));
    if (found.length === 0) throw new CliFailure(`no competition with slug "${slug}"`);
    if (found.length > 1) throw new CliFailure(`the slug "${slug}" is ambiguous (several sports)`);
    const sportId = found[0]!.sportId;
    if (sportId !== 'football') {
      throw new CliFailure(`ratings are learned for football only, "${slug}" is ${sportId}`);
    }

    // Names -> catalogue teams (short name or any localized name, normalised).
    const rows = await tx
      .select({ id: teams.id, shortName: teams.shortName, name: teams.name })
      .from(teams)
      .where(and(eq(teams.sportId, sportId)));
    const byName = new Map<string, Set<string>>();
    const labels = new Map<string, string>();
    for (const row of rows) {
      labels.set(row.id, row.shortName);
      for (const text of [row.shortName, ...localizedNames(row.name)]) {
        const key = normalizeName(text);
        if (key === '') continue;
        (byName.get(key) ?? byName.set(key, new Set()).get(key)!).add(row.id);
      }
    }
    // Aliases that apply to every source (source_id null), as the scraper resolves names: a
    // results file written with a source's own spelling ("FC Internazionale Milano") then
    // learns the same team. A source-scoped alias is not used: the file names no source.
    const aliasRows = await tx
      .select({ aliasNorm: teamAliases.aliasNorm, teamId: teamAliases.teamId })
      .from(teamAliases)
      .where(and(eq(teamAliases.sportId, sportId), isNull(teamAliases.sourceId)));
    for (const alias of aliasRows) {
      if (alias.aliasNorm === '') continue;
      (
        byName.get(alias.aliasNorm) ?? byName.set(alias.aliasNorm, new Set()).get(alias.aliasNorm)!
      ).add(alias.teamId);
    }
    const problems: string[] = [];
    const resolve = (name: string, where: string): string => {
      const ids = byName.get(normalizeName(name));
      if (ids === undefined) problems.push(`${where}: unknown team "${name}"`);
      else if (ids.size > 1) problems.push(`${where}: "${name}" matches several teams`);
      else return [...ids][0]!;
      return '';
    };
    const results = input.map((r, i) => ({
      date: r.date,
      home: resolve(r.home, `result ${i}`),
      away: resolve(r.away, `result ${i}`),
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
    }));
    if (problems.length > 0) {
      throw new CliFailure(
        'some team names are not in the catalogue',
        [...new Set(problems)].slice(0, 30),
      );
    }
    if (results.some((r) => r.home === r.away)) {
      throw new CliFailure('results file is not valid', ['home and away are the same team']);
    }

    // Oldest first; equal dates keep the order of the file (Array.sort is stable).
    const ordered = [...results].sort((a, b) => a.date.localeCompare(b.date));
    const replayed = replayRatings(
      ordered.map<FootballResult>((r) => ({
        home: r.home,
        away: r.away,
        homeGoals: r.homeGoals,
        awayGoals: r.awayGoals,
      })),
    );
    const through = new Map<string, number>();
    for (const r of ordered) {
      for (const id of [r.home, r.away])
        through.set(id, Math.max(through.get(id) ?? 0, dayNumber(r.date)));
    }

    const ids = [...replayed.keys()];
    const current = await getTeamRatings(tx, ids, { forUpdate: true });
    const teamRows: TeamRow[] = ids
      .map((teamId): TeamRow => {
        const learned = replayed.get(teamId)!;
        const next: Record<string, number> = { ...learned, [BACKFILL_KEY]: through.get(teamId)! };
        const now = current.get(teamId);
        const was = now?.ratings ?? null;
        const fileMatches = learned.matches ?? 0;
        let decision: Decision;
        if (now?.manual === true) {
          decision = { kind: 'refused', reason: 'manual = 1: a trader set these ratings' };
        } else if ((now?.matches ?? 0) > fileMatches) {
          decision = {
            kind: 'refused',
            reason: `matches ${now?.matches} already exceeds the file's ${fileMatches} (live results were applied)`,
          };
        } else if ((was?.[BACKFILL_KEY] ?? 0) > through.get(teamId)!) {
          decision = {
            kind: 'refused',
            reason: `already backfilled through ${was?.[BACKFILL_KEY]}, the file ends ${through.get(teamId)}`,
          };
        } else if (
          was !== null &&
          close(was.attack ?? null, next.attack ?? null) &&
          close(was.defence ?? null, next.defence ?? null) &&
          was.matches === next.matches &&
          was[BACKFILL_KEY] === next[BACKFILL_KEY]
        ) {
          decision = { kind: 'unchanged' };
        } else {
          decision = { kind: 'update' };
        }
        return {
          teamId,
          name: labels.get(teamId) ?? teamId,
          before: snapshot(was),
          after: snapshot(next),
          fileMatches,
          through: through.get(teamId)!,
          decision,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const refused = teamRows.some((t) => t.decision.kind === 'refused');
    if (!dryRun && !refused) {
      for (const row of teamRows) {
        if (row.decision.kind !== 'update') continue;
        await setTeamRatings(
          tx,
          row.teamId,
          { ...replayed.get(row.teamId)!, [BACKFILL_KEY]: row.through },
          env.actor,
        );
      }
    }
    return { teamRows, refused };
  });

  const { teamRows, refused } = plan;
  const status = (t: TeamRow): string => {
    if (t.decision.kind === 'refused') return `REFUSED: ${t.decision.reason}`;
    if (t.decision.kind === 'unchanged') return 'unchanged';
    return dryRun ? 'would update' : refused ? 'not written (another team was refused)' : 'updated';
  };
  const count = (kind: Decision['kind']) => teamRows.filter((t) => t.decision.kind === kind).length;
  const summary = refused
    ? `refused: ${count('refused')} team(s) cannot be overwritten; nothing was written`
    : dryRun
      ? `dry run: ${count('update')} would change, ${count('unchanged')} unchanged; nothing was written`
      : `${count('update')} updated, ${count('unchanged')} unchanged`;
  emit(
    env,
    parsed,
    {
      competition: slug,
      dryRun,
      results: input.length,
      refused,
      teams: teamRows.map((t) => ({
        teamId: t.teamId,
        team: t.name,
        before: t.before,
        after: t.after,
        status: status(t),
      })),
    },
    [
      `${input.length} results for ${slug}, ${teamRows.length} teams`,
      ...table(
        ['team', 'before', 'after', 'result'],
        teamRows.map((t) => [t.name, fmt(t.before), fmt(t.after), status(t)]),
      ),
      summary,
    ],
  );
  return refused ? EXIT_FAILED : EXIT_OK;
}

/** Most matches a hand-set rating can claim; far above any calibration threshold. */
const MAX_MANUAL_MATCHES = 10_000;

type TeamCandidate = FootballTeamNames;

const footballTeams = (exec: Database): Promise<TeamCandidate[]> => footballTeamNames(exec);

const matchesName = (team: TeamCandidate, key: string): boolean =>
  team.names.some((n) => normalizeName(n) === key);

/** A strict decimal number: no empty text, no "1abc", no NaN or Infinity. */
function parseNumber(parsed: Parameters<typeof requiredString>[0], name: string): number {
  const text = requiredString(parsed, name).trim();
  const value = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got "${text}"`);
  return value;
}

const fmtRatings = (r: Record<string, number> | null): string => {
  if (r === null) return '-';
  const s = snapshot(r);
  return `${fmt(s)}${r.manual === 1 ? ' manual' : ''}`;
};

/**
 * `ratings set --team <name> --attack <n> --defence <n> [--matches <n>] [--dry-run]`:
 * a trader's hand-set ratings for one football team (for a team without a
 * season of history). Writes attack, defence, matches and `manual = 1`
 * through setTeamRatings (audited with before and after); other keys the team
 * has (such as the backfill date) are kept. `--matches` defaults to what the
 * team already has (0 for a new one); manual = 1 makes the team calibrated
 * whatever the count (rule O1). The numbers must lie in the band the ratings
 * model keeps every learned strength in (MIN_TEAM_RATING to MAX_TEAM_RATING);
 * the team name must match exactly one catalogue team (short name or any
 * localized name, normalised); unknown or ambiguous names are refused.
 */
export async function ratingsSet(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    team: { type: 'string' },
    attack: { type: 'string' },
    defence: { type: 'string' },
    matches: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  noPositionals(parsed);
  const name = requiredString(parsed, 'team').trim();
  const attack = parseNumber(parsed, 'attack');
  const defence = parseNumber(parsed, 'defence');
  const matches =
    optionalString(parsed, 'matches') === undefined ? null : parseNumber(parsed, 'matches');
  const dryRun = parsed.values['dry-run'] === true;
  const band = `${MIN_TEAM_RATING} to ${MAX_TEAM_RATING}`;
  for (const [label, value] of [
    ['attack', attack],
    ['defence', defence],
  ] as const) {
    if (value < MIN_TEAM_RATING || value > MAX_TEAM_RATING) {
      throw new UsageError(`--${label} must be between ${band} (1 = league average), got ${value}`);
    }
  }
  if (
    matches !== null &&
    (!Number.isInteger(matches) || matches < 0 || matches > MAX_MANUAL_MATCHES)
  ) {
    throw new UsageError(`--matches must be a whole number from 0 to ${MAX_MANUAL_MATCHES}`);
  }
  const key = normalizeName(name);
  if (key === '') throw new UsageError('--team is empty');

  const db: Database = await env.database();
  const result = await db.transaction(async (tx) => {
    const found = (await footballTeams(tx)).filter((t) => matchesName(t, key));
    if (found.length === 0) {
      const near = (await footballTeams(tx))
        .filter((t) => t.names.some((n) => normalizeName(n).includes(key)))
        .map((t) => t.shortName)
        .sort()
        .slice(0, 10);
      throw new CliFailure(
        `no football team named "${name}"`,
        near.length > 0 ? [`similar: ${near.join(', ')}`] : [],
      );
    }
    if (found.length > 1) {
      throw new CliFailure(
        `"${name}" matches ${found.length} teams; use a name that is unique`,
        found.map((t) => `${t.shortName} (${t.id})`),
      );
    }
    const team = found[0]!;
    const current = (await getTeamRatings(tx, [team.id], { forUpdate: true })).get(team.id);
    const was = current?.ratings ?? null;
    const next: Record<string, number> = {
      ...(was ?? {}),
      attack,
      defence,
      matches: matches ?? current?.matches ?? 0,
      manual: 1,
    };
    const unchanged =
      was !== null &&
      Object.keys(next).length === Object.keys(was).length &&
      Object.entries(next).every(([k, v]) => was[k] === v);
    if (!dryRun && !unchanged) await setTeamRatings(tx, team.id, next, env.actor);
    return { team, was, next, unchanged };
  });

  const status = result.unchanged ? 'unchanged' : dryRun ? 'would update' : 'updated';
  emit(
    env,
    parsed,
    {
      teamId: result.team.id,
      team: result.team.shortName,
      dryRun,
      status,
      before: result.was,
      after: result.next,
    },
    [
      `${result.team.shortName}: ${status}`,
      `  before  ${fmtRatings(result.was)}`,
      `  after   ${fmtRatings(result.next)}`,
      ...(dryRun ? ['dry run: nothing was written'] : []),
    ],
  );
  return EXIT_OK;
}

/**
 * `ratings list [--team text] [--unrated [--min-matches n]] [--json]`: football teams that have
 * ratings (learned or set by hand), by name. `--team` keeps the teams whose name contains the
 * text (normalised).
 *
 * `--unrated` lists instead the teams that keep a match from opening on the model (rule O1): every
 * football team of a scheduled scraped match still to come whose ratings are not calibrated (fewer
 * than `--min-matches` learned matches, default SCRAPER_MIN_RATING_MATCHES, never below 8, and not
 * set by hand), with its match count and its upcoming matches, most matches first. These are the teams
 * behind the `ratings_uncalibrated` review items: backfill them, or set them by hand.
 */
export async function ratingsList(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    team: { type: 'string' },
    unrated: { type: 'boolean' },
    'min-matches': { type: 'string' },
  });
  noPositionals(parsed);
  const text = optionalString(parsed, 'team');
  const key = text === undefined ? '' : normalizeName(text);
  if (text !== undefined && key === '') throw new UsageError('--team is empty');
  if (parsed.values.unrated === true) return ratingsUnrated(parsed, key, env);
  if (parsed.values['min-matches'] !== undefined) {
    throw new UsageError('--min-matches goes with --unrated');
  }

  const db: Database = await env.database();
  const rows = (await listRatedTeams(db, { nameKey: key, normalize: normalizeName })).map((r) => ({
    teamId: r.teamId,
    team: r.team,
    ...snapshot(r.ratings),
    manual: r.manual,
    ratings: r.ratings,
  }));
  emit(env, parsed, { teams: rows }, [
    ...table(
      ['team', 'attack', 'defence', 'matches', 'manual'],
      rows.map((r) => [
        r.team,
        r.attack?.toFixed(3) ?? '-',
        r.defence?.toFixed(3) ?? '-',
        String(r.matches),
        r.manual ? 'yes' : 'no',
      ]),
    ),
    `${rows.length} team(s) with ratings`,
  ]);
  return EXIT_OK;
}

/** O1's threshold for `--unrated`: `--min-matches`, else SCRAPER_MIN_RATING_MATCHES, else 8. */
function minMatchesOf(parsed: Parameters<typeof requiredString>[0]): number {
  const given = optionalString(parsed, 'min-matches');
  const fromEnv = process.env.SCRAPER_MIN_RATING_MATCHES;
  const text = given ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined);
  if (text === undefined) return MIN_RATING_MATCHES;
  const value = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(
      `${given !== undefined ? '--min-matches' : 'SCRAPER_MIN_RATING_MATCHES'} must be a whole number of at least 1, got "${text}"`,
    );
  }
  return value;
}

async function ratingsUnrated(
  parsed: Parameters<typeof requiredString>[0],
  key: string,
  env: CliEnv,
): Promise<number> {
  // O1 never takes the bar below MIN_RATING_MATCHES (isCalibrated), so neither does the list.
  const minMatches = Math.max(minMatchesOf(parsed), MIN_RATING_MATCHES);
  const db: Database = await env.database();
  const rows = (
    await listUnratedTeams(db, {
      nameKey: key,
      normalize: normalizeName,
      now: env.clock(),
      calibrated: (ratings) => isCalibrated(ratings, minMatches),
    })
  ).map((r) => ({
    teamId: r.teamId,
    team: r.team,
    matches: r.matches,
    needed: minMatches,
    hasRatings: r.hasRatings,
    upcoming: r.upcoming,
    nextKickoff: r.nextKickoff.toISOString(),
  }));
  emit(env, parsed, { minMatches, teams: rows }, [
    ...table(
      ['team', 'matches', 'needed', 'ratings', 'upcoming', 'next kickoff (UTC)'],
      rows.map((r) => [
        r.team,
        String(r.matches),
        String(r.needed),
        r.hasRatings ? 'yes' : 'none',
        String(r.upcoming),
        r.nextKickoff.slice(0, 16).replace('T', ' '),
      ]),
    ),
    `${rows.length} team(s) of upcoming matches without calibrated ratings (O1: ${minMatches} matches, or set by hand)`,
  ]);
  return EXIT_OK;
}
