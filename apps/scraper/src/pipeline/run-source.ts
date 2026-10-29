import {
  closeReviewItemsBySubject,
  finishRun,
  loadAliasInputs,
  openReviewItem,
  recentAcceptedCounts,
  recordRaw,
  setObservationResolution,
  listUnresolvedObservations,
  startRun,
  upsertObservation,
  type DbTransaction,
  type ScrapeRunIssueJson,
  type ScrapeRunTrigger,
  type ScrapeSource,
} from '@vamos/db';
import type { ScrapeRunStatus } from '@vamos/core';
import {
  buildAliasIndex,
  checkShape,
  createAdapter,
  normalizeName,
  resolveCompetition,
  resolveTeam,
  safeParse,
  sourceBrokenReview,
  suggestCompetitions,
  suggestTeams,
  toRawDocument,
  SHAPE_BASELINE_RUNS,
  type AliasIndex,
  type FetchResult,
  type Observation,
  type ParseOutcome,
  type Resolution,
} from '@vamos/scraper';
import { tryLock } from '../lib/lock';
import type { ScraperContext } from '../context';
import { compareText } from './common';

/** A source run holds its lock this long at most (a crashed holder blocks others no longer). */
export const SOURCE_LOCK_TTL_MS = 15 * 60_000;

export interface RunSourceResult {
  /** 'locked': another instance is running this source; nothing was done. */
  status: ScrapeRunStatus | 'locked';
  runId: string | null;
  requests: number;
  fixtures: number;
  results: number;
}

export function sourceLockKey(sourceId: string): string {
  return `scraper:source:${sourceId}`;
}

/** The source's own key for a match: its id for it, else competition, teams and kickoff day. */
export function sourceKeyOf(obs: Observation): string {
  if (obs.externalRef !== null) return obs.externalRef;
  return `${obs.competition}|${obs.home}|${obs.away}|${obs.kickoff.toISOString().slice(0, 10)}`;
}

// Worst outcome of a run's requests wins.
const RANK: Record<'ok' | 'broken' | 'failed' | 'blocked', number> = {
  ok: 0,
  broken: 1,
  failed: 2,
  blocked: 3,
};
type Outcome = keyof typeof RANK;

interface ResolvedIds {
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

type NameKind = 'team' | 'competition';
interface UnknownName {
  kind: NameKind;
  sport: string;
  raw: string;
  resolution: Resolution;
  sourceId: string;
}

/** The alias index per sport, built when first needed (once per run). */
export class AliasIndexCache {
  readonly #byGame = new Map<string, AliasIndex>();
  constructor(private readonly load: (sport: string) => Promise<AliasIndex>) {}
  async get(sport: string): Promise<AliasIndex> {
    let index = this.#byGame.get(sport);
    if (index === undefined) {
      index = await this.load(sport);
      this.#byGame.set(sport, index);
    }
    return index;
  }
}

export function aliasIndexCache(ctx: ScraperContext): AliasIndexCache {
  return new AliasIndexCache(async (sport) =>
    buildAliasIndex(await loadAliasInputs(ctx.db, sport)),
  );
}

/** Resolves the three names of an observation; unresolved ones are collected for review items. */
export function resolveNames(
  index: AliasIndex,
  input: { sport: string; sourceId: string; competition: string; home: string; away: string },
  unknown: UnknownName[],
): ResolvedIds {
  const query = (raw: string) => ({ sportId: input.sport, sourceId: input.sourceId, raw });
  const pick = (kind: NameKind, raw: string, resolution: Resolution): string | null => {
    if (resolution.status === 'resolved') return resolution.id;
    unknown.push({ kind, sport: input.sport, raw, resolution, sourceId: input.sourceId });
    return null;
  };
  return {
    competitionId: pick(
      'competition',
      input.competition,
      resolveCompetition(index, query(input.competition)),
    ),
    homeTeamId: pick('team', input.home, resolveTeam(index, query(input.home))),
    awayTeamId: pick('team', input.away, resolveTeam(index, query(input.away))),
  };
}

/** The subject of an unknown_team / unknown_competition item: one per sport and normalised name. */
export function unknownSubject(sport: string, raw: string): string {
  return `${sport}|${normalizeName(raw)}`;
}

/** Opens unknown_team / unknown_competition items (deduplicated per subject, with suggestions N3). */
export async function openUnknownNameItems(
  tx: DbTransaction,
  index: AliasIndex,
  unknown: readonly UnknownName[],
  now: Date,
): Promise<void> {
  const seen = new Set<string>();
  for (const item of unknown) {
    const kind = item.kind === 'team' ? 'unknown_team' : 'unknown_competition';
    const subjectKey = unknownSubject(item.sport, item.raw);
    if (seen.has(`${kind}\u0000${subjectKey}`)) continue;
    seen.add(`${kind}\u0000${subjectKey}`);
    const suggestions = (item.kind === 'team' ? suggestTeams : suggestCompetitions)(index, {
      sportId: item.sport,
      raw: item.raw,
      limit: 3,
    });
    await openReviewItem(tx, {
      kind,
      subjectKey,
      severity: 'info',
      title:
        item.kind === 'team'
          ? `Unknown team name "${item.raw}"`
          : `Unknown competition name "${item.raw}"`,
      payload: {
        rules: ['N2', 'N3'],
        reasons: [item.resolution.status === 'ambiguous' ? 'ambiguous_name' : 'unknown_name'],
        sourceId: item.sourceId,
        sport: item.sport,
        raw: item.raw,
        normalized: normalizeName(item.raw),
        candidates: item.resolution.status === 'ambiguous' ? item.resolution.ids : [],
        suggestions,
      },
      now,
    });
  }
}

/**
 * One run of a source (docs/scraper.md section 5): plan, fetch (politely),
 * archive, parse, shape check, store observations, resolve names, record the
 * run. Under the Redis lock `scraper:source:<id>`: a held lock means another
 * instance is on it, and nothing is done. Never throws for a bad source or
 * document; those become the run's status.
 */
export async function runSource(
  ctx: ScraperContext,
  source: ScrapeSource,
  options: { trigger: ScrapeRunTrigger },
): Promise<RunSourceResult> {
  const lock = await tryLock(ctx.redis, sourceLockKey(source.id), SOURCE_LOCK_TTL_MS);
  if (lock === null) {
    ctx.logger.debug({ sourceId: source.id }, 'source is locked by another run; skipping');
    return { status: 'locked', runId: null, requests: 0, fixtures: 0, results: 0 };
  }
  try {
    return await execute(ctx, source, options.trigger);
  } finally {
    await lock.release().catch(() => false);
  }
}

async function execute(
  ctx: ScraperContext,
  source: ScrapeSource,
  trigger: ScrapeRunTrigger,
): Promise<RunSourceResult> {
  const run = await startRun(ctx.db, { sourceId: source.id, trigger, startedAt: ctx.clock() });
  const subjectKey = `source|${source.id}`;
  const built = createAdapter({
    id: source.id,
    adapter: source.adapter,
    upstream: source.upstream,
    config: source.config,
  });
  if (!built.ok) {
    const message = `invalid configuration: ${built.errors.join('; ')}`;
    await ctx.db.transaction(async (tx) => {
      await openReviewItem(tx, {
        kind: 'source_broken',
        subjectKey,
        severity: 'warning',
        title: 'Source configuration is invalid',
        payload: {
          rules: ['S1'],
          reasons: ['invalid_config'],
          sourceId: source.id,
          errors: built.errors,
        },
        now: ctx.clock(),
      });
      await finishRun(tx, run.id, {
        status: 'failed',
        error: message,
        issues: [{ severity: 'error', code: 'invalid_config', message, fatal: true }],
        finishedAt: ctx.clock(),
      });
    });
    return { status: 'failed', runId: run.id, requests: 0, fixtures: 0, results: 0 };
  }
  const { adapter } = built;

  const issues: ScrapeRunIssueJson[] = [];
  let outcome: Outcome = 'ok';
  const worsen = (next: Outcome) => {
    if (RANK[next] > RANK[outcome]) outcome = next;
  };
  const counts = { requests: 0, bytes: 0, seen: 0, accepted: 0, fixtures: 0, results: 0 };
  const indexes = aliasIndexCache(ctx);

  try {
    for (const item of adapter.plan(ctx.clock())) {
      counts.requests += 1;
      const result: FetchResult = await ctx.fetcher.fetch(item, {
        allowedHosts: adapter.allowedHosts,
        sourceKey: source.id,
      });
      if (result.kind === 'not_modified') continue;
      if (result.kind === 'blocked') {
        worsen('blocked');
        issues.push({
          severity: 'error',
          code: 'blocked',
          message: `the site told us to stop (${result.reason}); backing off`,
          context: { url: item.url, retryAt: result.retryAt?.toISOString() ?? null },
        });
        break;
      }
      if (result.kind === 'circuit_open') {
        worsen('failed');
        issues.push({
          severity: 'error',
          code: 'circuit_open',
          message: 'too many recent failures; not trying until the breaker closes',
          context: { url: item.url, retryAt: result.retryAt.toISOString() },
        });
        break;
      }
      if (result.kind === 'refused' || result.kind === 'error') {
        worsen('failed');
        issues.push({
          severity: 'error',
          code: result.kind === 'refused' ? `refused_${result.reason}` : `fetch_${result.code}`,
          message: result.kind === 'refused' ? `refused: ${result.reason}` : result.message,
          context: { url: item.url },
        });
        continue;
      }
      counts.bytes += result.body.length;
      // Evidence first: nothing is parsed (let alone stored) that was not archived.
      await ctx.archive.put(result.body, { fetchedAt: result.fetchedAt });
      const doc = toRawDocument(source.id, result);
      const parsed = safeParse(adapter, doc);
      issues.push(...parsed.issues.map(toIssueJson));
      counts.seen += parsed.stats.recordsSeen;
      const baseline = await recentAcceptedCounts(
        ctx.db,
        source.id,
        result.url,
        SHAPE_BASELINE_RUNS,
      );
      const shape = checkShape(parsed.stats, parsed.issues, baseline);
      const { raw } = await recordRaw(ctx.db, {
        runId: run.id,
        url: result.url,
        status: result.status,
        contentType: result.contentType,
        contentHash: result.contentHash,
        bytes: result.body.length,
        fetchedAt: result.fetchedAt,
        recordsSeen: parsed.stats.recordsSeen,
        recordsAccepted: parsed.stats.recordsAccepted,
      });
      if (shape.status === 'broken') {
        // Nothing of this document is stored.
        worsen('broken');
        issues.push({
          severity: 'error',
          code: 'shape_broken',
          message: `the page no longer parses as before (${shape.reason})`,
          context: { url: result.url, accepted: shape.accepted, baseline: shape.baseline },
        });
        await ctx.db.transaction(async (tx) => {
          const review = sourceBrokenReview(source.id, result.url, shape);
          await openReviewItem(tx, {
            kind: review.kind,
            subjectKey: review.subjectKey,
            severity: review.severity,
            title: review.title,
            payload: review.payload,
            now: ctx.clock(),
          });
        });
        continue;
      }
      counts.accepted += parsed.stats.recordsAccepted;
      const stored = await storeObservations(ctx, source, run.id, raw.id, parsed, indexes, issues);
      counts.fixtures += stored.fixtures;
      counts.results += stored.results;
    }
  } catch (error) {
    // A bug or an archive/database failure: the run failed, whatever was committed stays valid.
    worsen('failed');
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ err: error, sourceId: source.id }, 'source run crashed');
    issues.push({ severity: 'error', code: 'run_crashed', message });
  }

  const status: ScrapeRunStatus = outcome;
  const errorText = issues.find((i) => i.fatal || i.code === 'run_crashed')?.message ?? null;
  await ctx.db.transaction(async (tx) => {
    if (status === 'ok') {
      await closeReviewItemsBySubject(tx, subjectKey, {
        kinds: ['source_broken'],
        resolution: 'the source parses as before again',
        now: ctx.clock(),
      });
    }
    await finishRun(tx, run.id, {
      status,
      requests: counts.requests,
      bytes: counts.bytes,
      recordsSeen: counts.seen,
      recordsAccepted: counts.accepted,
      fixtures: counts.fixtures,
      results: counts.results,
      issues,
      error: status === 'ok' ? null : errorText,
      finishedAt: ctx.clock(),
    });
  });
  ctx.logger.info({ sourceId: source.id, runId: run.id, status, ...counts }, 'source run finished');
  return {
    status,
    runId: run.id,
    requests: counts.requests,
    fixtures: counts.fixtures,
    results: counts.results,
  };
}

function toIssueJson(issue: ParseOutcome['issues'][number]): ScrapeRunIssueJson {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.fatal === true ? { fatal: true } : {}),
    ...(issue.context === undefined ? {} : { context: issue.context }),
  };
}

/** Stores one document's observations in a single transaction, in a stable order (no deadlocks). */
async function storeObservations(
  ctx: ScraperContext,
  source: ScrapeSource,
  runId: string,
  rawId: string,
  parsed: ParseOutcome,
  indexes: AliasIndexCache,
  issues: ScrapeRunIssueJson[],
): Promise<{ fixtures: number; results: number }> {
  const seen = new Set<string>();
  const drafts: Array<{ obs: Observation; sourceKey: string }> = [];
  for (const obs of [...parsed.fixtures, ...parsed.results]) {
    const sourceKey = sourceKeyOf(obs);
    const id = `${obs.kind}\u0000${sourceKey}`;
    if (seen.has(id)) {
      // Two records with one key would overwrite each other; the first one wins.
      issues.push({
        severity: 'warning',
        code: 'duplicate_key',
        message: `two records share the key "${sourceKey}"; the second was ignored`,
      });
      continue;
    }
    seen.add(id);
    drafts.push({ obs, sourceKey });
  }
  drafts.sort(
    (a, b) => compareText(a.obs.kind, b.obs.kind) || compareText(a.sourceKey, b.sourceKey),
  );

  const unknown: UnknownName[] = [];
  const resolved = new Map<string, ResolvedIds>();
  for (const { obs, sourceKey } of drafts) {
    const index = await indexes.get(obs.sport);
    resolved.set(
      `${obs.kind}\u0000${sourceKey}`,
      resolveNames(
        index,
        {
          sport: obs.sport,
          sourceId: source.id,
          competition: obs.competition,
          home: obs.home,
          away: obs.away,
        },
        unknown,
      ),
    );
  }

  const now = ctx.clock();
  await ctx.db.transaction(async (tx) => {
    for (const { obs, sourceKey } of drafts) {
      const ids = resolved.get(`${obs.kind}\u0000${sourceKey}`)!;
      await upsertObservation(tx, {
        sourceId: source.id,
        kind: obs.kind,
        sourceKey,
        sport: obs.sport,
        competitionRaw: obs.competition,
        homeRaw: obs.home,
        awayRaw: obs.away,
        kickoff: obs.kickoff,
        status: obs.status,
        round: obs.kind === 'fixture' ? obs.round : null,
        score: obs.kind === 'result' ? obs.score : null,
        scoreBasis: obs.kind === 'result' ? obs.scoreBasis : null,
        observedAt: obs.observedAt,
        runId,
        rawId,
        ...ids,
      });
    }
    for (const sport of new Set(unknown.map((u) => u.sport))) {
      await openUnknownNameItems(
        tx,
        await indexes.get(sport),
        unknown.filter((u) => u.sport === sport),
        now,
      );
    }
  });
  return {
    fixtures: drafts.filter((d) => d.obs.kind === 'fixture').length,
    results: drafts.filter((d) => d.obs.kind === 'result').length,
  };
}

/**
 * Re-resolves stored observations that still have an unresolved name, after
 * aliases changed. Items about names that now resolve (for every observation)
 * are closed; names that stay unknown keep their item. Returns the number of
 * observations that gained an id.
 */
export async function reresolveUnresolved(ctx: ScraperContext): Promise<number> {
  const rows = await listUnresolvedObservations(ctx.db, { limit: 5000 });
  if (rows.length === 0) return 0;
  const indexes = aliasIndexCache(ctx);
  let updated = 0;
  const stillUnknown = new Set<string>();
  const nowResolved = new Map<string, 'unknown_team' | 'unknown_competition'>();
  const unknown: UnknownName[] = [];
  for (const row of rows) {
    const index = await indexes.get(row.sport);
    const before = unknown.length;
    const ids = resolveNames(
      index,
      {
        sport: row.sport,
        sourceId: row.sourceId,
        competition: row.competitionRaw,
        home: row.homeRaw,
        away: row.awayRaw,
      },
      unknown,
    );
    for (const u of unknown.slice(before)) {
      stillUnknown.add(`${u.kind}\u0000${unknownSubject(u.sport, u.raw)}`);
    }
    const gained =
      (ids.competitionId !== null && row.competitionId === null) ||
      (ids.homeTeamId !== null && row.homeTeamId === null) ||
      (ids.awayTeamId !== null && row.awayTeamId === null);
    if (!gained) continue;
    await ctx.db.transaction((tx) => setObservationResolution(tx, row.id, ids));
    updated += 1;
    if (row.competitionId === null && ids.competitionId !== null) {
      nowResolved.set(unknownSubject(row.sport, row.competitionRaw), 'unknown_competition');
    }
    for (const [had, got, raw] of [
      [row.homeTeamId, ids.homeTeamId, row.homeRaw],
      [row.awayTeamId, ids.awayTeamId, row.awayRaw],
    ] as const) {
      if (had === null && got !== null)
        nowResolved.set(unknownSubject(row.sport, raw), 'unknown_team');
    }
  }
  const now = ctx.clock();
  for (const [subject, kind] of nowResolved) {
    const stillOpen = stillUnknown.has(
      `${kind === 'unknown_team' ? 'team' : 'competition'}\u0000${subject}`,
    );
    if (stillOpen) continue;
    await ctx.db.transaction((tx) =>
      closeReviewItemsBySubject(tx, subject, {
        kinds: [kind],
        resolution: 'the name resolves now',
        now,
      }),
    );
  }
  return updated;
}
