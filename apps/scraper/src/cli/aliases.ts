import { SCRAPE_SPORTS } from '@vamos/core';
import {
  addCompetitionAlias,
  addTeamAlias,
  DomainError,
  getSource,
  listAliases,
  removeAlias,
  loadCatalogIds,
  ScrapeAliasConflictError,
  type Database,
} from '@vamos/db';
import { normalizeName } from '@vamos/scraper';
import { parseCsv } from './csv';
import {
  CliFailure,
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  readInput,
  requiredString,
  table,
  UsageError,
  type CliEnv,
} from './io';

/** Columns of aliases.csv (in any order, header required). `source` may be empty = every source. */
const COLUMNS = ['kind', 'sport', 'alias', 'target', 'source'] as const;

interface AliasRow {
  line: number;
  kind: 'team' | 'competition';
  sport: string;
  aliasNorm: string;
  target: string;
  sourceId: string | null;
}

function readRows(text: string): { rows: AliasRow[]; errors: string[] } {
  let csv: ReturnType<typeof parseCsv>;
  try {
    csv = parseCsv(text);
  } catch (error) {
    return { rows: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
  const header = csv[0];
  if (header === undefined) return { rows: [], errors: ['the file is empty'] };
  const names = header.cells.map((c) => c.trim().toLowerCase());
  const missing = COLUMNS.filter((c) => c !== 'source' && !names.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        `line ${header.line}: the header must have the columns ${COLUMNS.join(', ')} ` +
          `(source is optional); missing: ${missing.join(', ')}`,
      ],
    };
  }
  const at = (cells: string[], column: string) => (cells[names.indexOf(column)] ?? '').trim();
  const rows: AliasRow[] = [];
  const errors: string[] = [];
  for (const { line, cells } of csv.slice(1)) {
    const kind = at(cells, 'kind').toLowerCase();
    const sport = at(cells, 'sport').toLowerCase();
    const aliasNorm = normalizeName(at(cells, 'alias'));
    const target = at(cells, 'target');
    const source = at(cells, 'source');
    if (kind !== 'team' && kind !== 'competition') {
      errors.push(`line ${line}: kind must be "team" or "competition", got "${kind}"`);
    } else if (!(SCRAPE_SPORTS as readonly string[]).includes(sport)) {
      errors.push(`line ${line}: sport must be one of ${SCRAPE_SPORTS.join(', ')}, got "${sport}"`);
    } else if (aliasNorm === '') {
      errors.push(`line ${line}: the alias is empty`);
    } else if (target === '') {
      errors.push(`line ${line}: the target is empty`);
    } else {
      rows.push({
        line,
        kind,
        sport,
        aliasNorm,
        target,
        sourceId: source === '' || source === '*' ? null : source,
      });
    }
  }
  return { rows, errors };
}

class Rollback extends Error {}

/**
 * `aliases import --file aliases.csv`: bulk addTeamAlias / addCompetitionAlias.
 * Columns: kind (team|competition), sport, alias (the source's spelling, any
 * case), target (team short name or competition slug of the catalogue) and
 * source (a source id; empty = every source). Idempotent: rows that already
 * exist are counted, not rewritten. All or nothing: one bad row (unknown
 * target or source, an alias that already points elsewhere) stops the import
 * and nothing is written; every bad row is listed.
 */
export async function aliasesImport(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { file: { type: 'string' } });
  noPositionals(parsed);
  const path = requiredString(parsed, 'file');
  const { rows, errors } = readRows(await readInput(env, path, 'aliases file'));
  if (errors.length > 0) throw new CliFailure(`${path} is not valid`, errors);

  const db: Database = await env.database();
  const problems: string[] = [];
  const created: AliasRow[] = [];
  let existing = 0;
  try {
    await db.transaction(async (tx) => {
      const ids = await loadCatalogIds(tx);
      const sourceKnown = new Map<string, boolean>();
      for (const row of rows) {
        if (row.sourceId !== null) {
          if (!sourceKnown.has(row.sourceId)) {
            sourceKnown.set(row.sourceId, (await getSource(tx, row.sourceId)) !== null);
          }
          if (sourceKnown.get(row.sourceId) !== true) {
            problems.push(`line ${row.line}: unknown source "${row.sourceId}"`);
            continue;
          }
        }
        const targetId =
          row.kind === 'team'
            ? ids.teams.get(`${row.sport}/${row.target}`)
            : ids.competitions.get(`${row.sport}/${row.target}`);
        if (targetId === undefined) {
          problems.push(
            `line ${row.line}: no ${row.kind === 'team' ? 'team with short name' : 'competition with slug'} ` +
              `"${row.target}" in ${row.sport}`,
          );
          continue;
        }
        try {
          const base = { sportId: row.sport, aliasNorm: row.aliasNorm, sourceId: row.sourceId };
          const result =
            row.kind === 'team'
              ? await addTeamAlias(tx, { ...base, teamId: targetId }, env.actor)
              : await addCompetitionAlias(tx, { ...base, competitionId: targetId }, env.actor);
          if (result.created) created.push(row);
          else existing += 1;
        } catch (error) {
          if (error instanceof ScrapeAliasConflictError) {
            problems.push(
              `line ${row.line}: "${row.aliasNorm}" already maps to a different ${row.kind} ` +
                `(remove that alias first)`,
            );
          } else throw error;
        }
      }
      if (problems.length > 0) throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (problems.length > 0) {
    throw new CliFailure(
      `nothing was imported: ${problems.length} problem(s) in ${path}`,
      problems,
    );
  }
  emit(
    env,
    parsed,
    {
      created: created.map((r) => ({
        kind: r.kind,
        alias: r.aliasNorm,
        target: r.target,
        source: r.sourceId,
      })),
      alreadyPresent: existing,
    },
    [
      ...created.map(
        (r) =>
          `added ${r.kind} alias "${r.aliasNorm}" -> ${r.target} (${r.sourceId ?? 'all sources'})`,
      ),
      `${created.length} added, ${existing} already present`,
    ],
  );
  return EXIT_OK;
}

/**
 * `aliases list [--kind team|competition] [--q text]`: aliases newest first,
 * with the id `aliases remove` takes. `--q` keeps the aliases whose name or
 * target contains the text (the name is compared normalised).
 */
export async function aliasesList(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { kind: { type: 'string' }, q: { type: 'string' } });
  noPositionals(parsed);
  const kind = optionalString(parsed, 'kind');
  if (kind !== undefined && kind !== 'team' && kind !== 'competition') {
    throw new UsageError(`--kind must be "team" or "competition", got "${kind}"`);
  }
  const q = optionalString(parsed, 'q');
  const needle = q?.trim().toLowerCase();
  const normalized = q === undefined ? '' : normalizeName(q);

  const db: Database = await env.database();
  const rows = (
    await listAliases(db, { ...(kind === undefined ? {} : { kind }), limit: 2000 })
  ).filter(
    (r) =>
      needle === undefined ||
      r.aliasNorm.includes(needle) ||
      (normalized !== '' && r.aliasNorm.includes(normalized)) ||
      r.targetLabel.toLowerCase().includes(needle),
  );
  emit(
    env,
    parsed,
    {
      aliases: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        sport: r.sportId,
        alias: r.aliasNorm,
        target: r.targetLabel,
        targetId: r.targetId,
        source: r.sourceId,
        createdAt: r.createdAt.toISOString(),
        createdBy: r.createdBy,
      })),
    },
    [
      ...table(
        ['id', 'kind', 'alias', 'target', 'source', 'created'],
        rows.map((r) => [
          r.id,
          r.kind,
          r.aliasNorm,
          r.targetLabel,
          r.sourceId ?? 'all',
          `${r.createdAt.toISOString().slice(0, 19)}Z by ${r.createdBy ?? 'system'}`,
        ]),
      ),
      `${rows.length} alias(es)`,
    ],
  );
  return EXIT_OK;
}

/**
 * `aliases remove --id <id>`: removes one alias, team or competition (the id
 * is unique across both). Audited by removeAlias. Observations keep what they
 * resolved to until the scraper's next promotion pass re-resolves them.
 */
export async function aliasesRemove(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { id: { type: 'string' } });
  noPositionals(parsed);
  const id = requiredString(parsed, 'id').trim();

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(id)) throw new CliFailure(`no alias with id "${id}" (see "aliases list")`);

  const db: Database = await env.database();
  const removed = await db.transaction(async (tx) => {
    for (const kind of ['team', 'competition'] as const) {
      try {
        return await removeAlias(tx, kind, id, env.actor);
      } catch (error) {
        if (!(error instanceof DomainError && error.status === 404)) throw error;
      }
    }
    return null;
  });
  if (removed === null) throw new CliFailure(`no alias with id "${id}" (see "aliases list")`);
  emit(
    env,
    parsed,
    {
      removed: {
        id: removed.id,
        kind: removed.kind,
        alias: removed.aliasNorm,
        targetId: removed.targetId,
        source: removed.sourceId,
      },
    },
    [
      `removed ${removed.kind} alias "${removed.aliasNorm}" (${removed.sourceId ?? 'all sources'})`,
      'observations are re-resolved on the next promotion pass',
    ],
  );
  return EXIT_OK;
}
