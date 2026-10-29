import { replayRatings, type FootballResult } from '@vamos/feed';
import { getTeamRatings, localizedNames, setTeamRatings, type Database } from '@vamos/db';
import { competitions, teams } from '@vamos/db/schema';
import { normalizeName } from '@vamos/scraper';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CliFailure,
  EXIT_FAILED,
  EXIT_OK,
  emit,
  noPositionals,
  parseCommandArgs,
  parseJson,
  readInput,
  requiredString,
  table,
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
 * writes nothing. Team names are catalogue short names (or any catalogue name).
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
