import {
  closeReviewItemsBySubject,
  finishRun,
  findScrapedEventId,
  latestAcceptedRaw,
  linkMarketOddsToEvents,
  listUnresolvedMarketOddsNames,
  loadAliasInputs,
  openReviewItem,
  recentAcceptedCounts,
  recordRaw,
  setMarketOddsResolution,
  setObservationResolution,
  listCurrentObservations,
  listUnresolvedObservations,
  startRun,
  touchMarketOddsOfRaw,
  touchObservationsOfRaw,
  upsertMarketOdds,
  upsertObservation,
  type DbTransaction,
  type MarketOddsInput,
  type ScrapeRunIssueJson,
  type ScrapeRunTrigger,
  type ScrapeSource,
} from '@vamos/db';
import type { ScrapeRunStatus } from '@vamos/core';
import { createHash } from 'node:crypto';
import {
  buildAliasIndex,
  checkShape,
  creditKeyOf,
  createAdapter,
  normalizeName,
  resolveCompetition,
  resolveTeam,
  safeParse,
  sourceBrokenReview,
  suggestCompetitions,
  suggestTeams,
  toRawDocument,
  MARKET_ODDS_LINK_WINDOW_MS,
  MARKET_ODDS_MAX_AGE_MS,
  SHAPE_BASELINE_RUNS,
  type AliasIndex,
  type FetchResult,
  type MarketOddsObservation,
  type Observation,
  type ParseOutcome,
  type Resolution,
} from '@vamos/scraper';
import { raiseUnauthorized, raiseUnexpectedCost, resolveUnauthorized } from './credit-alarms';
import { scrapeObservations } from '@vamos/db/schema';
import { tryLock } from '../lib/lock';
import { secretProblemMessage } from '../lib/secrets';
import type { ScraperContext } from '../context';
import { compareText, competitionNames, teamNames } from './common';
import {
  applyAutoAlias,
  autoAliasPolicy,
  decideAutoAlias,
  lookupFixtureContext,
  SUGGEST_ONLY,
  type AutoAliasPolicy,
  type FixtureContextLookup,
  type UnknownFixtureContext,
} from './fixture-context';

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
export function sourceKeyOf(
  obs: Pick<Observation, 'externalRef' | 'competition' | 'home' | 'away' | 'kickoff'>,
): string {
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
export interface UnknownName {
  kind: NameKind;
  sport: string;
  raw: string;
  resolution: Resolution;
  sourceId: string;
  /** The competition label of the fixture the name was seen in (the name itself for a competition). */
  competition: string;
  /**
   * A team name only, when the row's kickoff is known and its competition and other team
   * resolved: the fixture context of rule N4.
   */
  fixture?: UnknownFixtureContext;
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
  /** Forgets every index: the next get loads the aliases again (after N4 wrote one). */
  clear(): void {
    this.#byGame.clear();
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
  input: {
    sport: string;
    sourceId: string;
    competition: string;
    home: string;
    away: string;
    /** The row's kickoff: gives an unknown team name its fixture context (N4). */
    kickoff?: Date;
  },
  unknown: UnknownName[],
): ResolvedIds {
  const query = (raw: string) => ({ sportId: input.sport, sourceId: input.sourceId, raw });
  const competition = resolveCompetition(index, query(input.competition));
  const home = resolveTeam(index, query(input.home));
  const away = resolveTeam(index, query(input.away));
  const idOf = (r: Resolution): string | null => (r.status === 'resolved' ? r.id : null);
  const contextOf = (side: 'home' | 'away'): UnknownFixtureContext | null => {
    const competitionId = idOf(competition);
    const opponentId = idOf(side === 'home' ? away : home);
    if (input.kickoff === undefined || competitionId === null || opponentId === null) return null;
    return { side, kickoff: input.kickoff, competitionId, opponentId };
  };
  const pick = (
    kind: NameKind,
    raw: string,
    resolution: Resolution,
    fixture: UnknownFixtureContext | null = null,
  ): string | null => {
    if (resolution.status === 'resolved') return resolution.id;
    unknown.push({
      kind,
      sport: input.sport,
      raw,
      resolution,
      sourceId: input.sourceId,
      competition: input.competition,
      ...(fixture === null ? {} : { fixture }),
    });
    return null;
  };
  return {
    competitionId: pick('competition', input.competition, competition),
    homeTeamId: pick('team', input.home, home, contextOf('home')),
    awayTeamId: pick('team', input.away, away, contextOf('away')),
  };
}

/** The subject of an unknown_team / unknown_competition item: one per sport and normalised name. */
export function unknownSubject(sport: string, raw: string): string {
  return `${sport}|${normalizeName(raw)}`;
}

export interface UnknownItemPlan {
  kind: 'unknown_team' | 'unknown_competition';
  subjectKey: string;
  name: UnknownName;
  /**
   * The distinct fixture contexts (N4) of the subject's sightings from `name`'s source, in
   * (kickoff, competition, opponent, side) order; empty for a competition.
   */
  contexts: UnknownFixtureContext[];
}

const contextKey = (c: UnknownFixtureContext): string =>
  `${c.kickoff.toISOString()}|${c.competitionId}|${c.opponentId}|${c.side}`;

/**
 * The unknown_team / unknown_competition items to open for these names: one per
 * (kind, subject), in (kind, subject key) order, whatever order the records
 * came in (review finding 10). Two runs that open overlapping sets then lock
 * the item rows in the same order and cannot deadlock.
 */
export function planUnknownItems(unknown: readonly UnknownName[]): UnknownItemPlan[] {
  const byId = new Map<string, UnknownItemPlan>();
  const contexts = new Map<string, Map<string, UnknownFixtureContext>>();
  for (const name of unknown) {
    const kind = name.kind === 'team' ? 'unknown_team' : 'unknown_competition';
    const subjectKey = unknownSubject(name.sport, name.raw);
    const id = `${kind}\u0000${subjectKey}`;
    let plan = byId.get(id);
    if (plan === undefined) {
      plan = { kind, subjectKey, name, contexts: [] };
      byId.set(id, plan);
      contexts.set(id, new Map());
    }
    // Only sightings from the item's own source: N4 maps a spelling for one source.
    if (name.fixture !== undefined && name.sourceId === plan.name.sourceId) {
      contexts.get(id)!.set(contextKey(name.fixture), name.fixture);
    }
  }
  for (const [id, plan] of byId) {
    plan.contexts = [...contexts.get(id)!.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([, c]) => c);
  }
  return [...byId.values()].sort(
    (a, b) => compareText(a.kind, b.kind) || compareText(a.subjectKey, b.subjectKey),
  );
}

/**
 * Opens unknown_team / unknown_competition items (deduplicated per subject, with suggestions N3),
 * sorted. A team name seen with a fixture context also gets rule N4: `payload.fixture`
 * (opponent, kickoff, candidates) and, when the context is strong, that team as the only
 * suggestion. Under `policy` (SCRAPER_AUTO_ALIAS and R2, a source's own fetch only) a strong
 * suggestion becomes an alias for the item's source. Returns the number of aliases written.
 */
export async function openUnknownNameItems(
  tx: DbTransaction,
  index: AliasIndex,
  unknown: readonly UnknownName[],
  now: Date,
  policy: AutoAliasPolicy = SUGGEST_ONLY,
): Promise<number> {
  let applied = 0;
  for (const { kind, subjectKey, name: item, contexts } of planUnknownItems(unknown)) {
    const found = (item.kind === 'team' ? suggestTeams : suggestCompetitions)(index, {
      sportId: item.sport,
      raw: item.raw,
      limit: 3,
    });
    const lookup: FixtureContextLookup | null =
      item.kind === 'team' && contexts.length > 0
        ? await lookupFixtureContext(tx, index, item, contexts)
        : null;
    const strong = lookup?.result.strong ?? null;
    const first = lookup?.sightings[0];
    // The back office reads { id, name, score 0 to 1 }: the catalogue's own name, the score in permille / 1000.
    const wanted = [
      ...new Set([
        ...found.map((s) => s.id),
        ...(lookup?.result.candidates.map((c) => c.teamId) ?? []),
        ...(first === undefined ? [] : [first.opponentId]),
      ]),
    ];
    const shown =
      wanted.length === 0
        ? new Map<string, string>()
        : await (item.kind === 'team' ? teamNames : competitionNames)(tx, wanted);
    // N4 strong: the opponent plays one match in the window, so the other N3 guesses are contradicted.
    const suggestions =
      strong !== null
        ? [
            {
              id: strong.teamId,
              name: shown.get(strong.teamId) ?? strong.matchedName,
              score: strong.score,
              matchedName: strong.matchedName,
              basis: 'fixture',
            },
          ]
        : found.map((s) => ({
            id: s.id,
            name: shown.get(s.id) ?? s.matchedName,
            score: s.score / 1000,
            matchedName: s.matchedName,
          }));
    // What the back office shows as "vs <opponent>, <kickoff>" (U-5), with N4's evidence.
    const fixture =
      lookup === null || first === undefined
        ? {}
        : {
            fixture: {
              opponent: shown.get(first.opponentId) ?? first.opponentId,
              opponentId: first.opponentId,
              kickoff: first.kickoff.toISOString(),
              side: first.side,
              competitionId: first.competitionId,
              sightings: lookup.sightings.length,
              strong: strong?.teamId ?? null,
              candidates: lookup.result.candidates.map((c) => ({
                id: c.teamId,
                name: shown.get(c.teamId) ?? c.matchedName,
                score: c.score,
                kickoff: c.kickoff.toISOString(),
              })),
            },
          };
    const opened = await openReviewItem(tx, {
      kind,
      subjectKey,
      severity: 'info',
      title:
        item.kind === 'team'
          ? `Unknown team name "${item.raw}"`
          : `Unknown competition name "${item.raw}"`,
      payload: {
        rules: lookup === null ? ['N2', 'N3'] : ['N2', 'N3', 'N4'],
        reasons: [item.resolution.status === 'ambiguous' ? 'ambiguous_name' : 'unknown_name'],
        sourceId: item.sourceId,
        sport: item.sport,
        raw: item.raw,
        competition: item.competition,
        normalized: normalizeName(item.raw),
        candidates: item.resolution.status === 'ambiguous' ? item.resolution.ids : [],
        suggestions,
        ...fixture,
      },
      now,
    });
    if (lookup === null || strong === null || !policy.enabled) continue;
    const decision = await decideAutoAlias(
      tx,
      policy,
      {
        sourceId: item.sourceId,
        raw: item.raw,
        unknown: item.resolution.status === 'unknown',
        // A person dismissed this name before: their decision stands, N4 only suggests.
        dismissedBefore: opened.item.payload.dismissals !== undefined,
      },
      lookup,
    );
    if (decision !== null && (await applyAutoAlias(tx, opened.item, item, decision, lookup))) {
      applied += 1;
    }
  }
  return applied;
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
          runId: run.id,
          reason: 'invalid_config',
          recordsAccepted: 0,
          baseline: null,
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
  /** Pages of this run that were parsed and accepted (a 304 is not one: nothing was parsed). */
  let pagesParsed = 0;
  /** The URL being processed, to forget its validators if the run crashes on it. */
  let currentUrl: string | null = null;
  /** A metered API's credits as its responses reported them (rule G2); null for other sources. */
  const credits =
    adapter.usage === undefined
      ? null
      : {
          spent: null as number | null,
          used: null as number | null,
          remaining: null as number | null,
        };

  const plan = adapter.plan(ctx.clock());
  /** The key whose guard and alarms this source shares (rule G1); only for metered APIs. */
  const creditKey = adapter.usage === undefined ? null : creditKeyOf(source.id, plan);
  try {
    for (const item of plan) {
      counts.requests += 1;
      const result: FetchResult = await ctx.fetcher.fetch(item, {
        allowedHosts: adapter.allowedHosts,
        sourceKey: source.id,
      });
      if (result.kind === 'not_modified') {
        const seen = await recordNotModified(ctx, source.id, run.id, result.url, result.fetchedAt);
        if (seen === null) {
          // Nothing we stored stands behind this 304 (a lost database, a crash before storing):
          // never trust it; the next run fetches the page in full.
          await ctx.fetcher.forgetValidators(result.url);
          worsen('failed');
          issues.push({
            severity: 'error',
            code: 'not_modified_unknown',
            message: 'the page was reported unchanged but no accepted copy of it is stored',
            context: { url: item.url },
          });
          continue;
        }
        counts.seen += seen.recordsSeen;
        counts.accepted += seen.recordsAccepted;
        counts.fixtures += seen.fixtures;
        counts.results += seen.results;
        continue;
      }
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
      if (result.kind === 'refused' && result.reason.startsWith('secret_')) {
        // A key problem is the same for every request of the source: stop here. Nothing is
        // quoted but the NAME of the variable; the value never reaches an issue or a log.
        worsen('failed');
        issues.push({
          severity: 'error',
          code: result.reason,
          message: secretProblemMessage(result.reason, item.auth?.secret),
          // Like invalid_config: the run could not proceed, and the run's error says why.
          fatal: true,
          context: { url: item.url },
        });
        break;
      }
      if (result.kind === 'refused' || result.kind === 'error') {
        worsen('failed');
        issues.push({
          severity: 'error',
          code: result.kind === 'refused' ? `refused_${result.reason}` : `fetch_${result.code}`,
          message: result.kind === 'refused' ? `refused: ${result.reason}` : result.message,
          // The status tells the credit guard a refused key (401) from other failures.
          context: {
            url: item.url,
            ...(result.kind === 'error' && result.status !== undefined
              ? { status: result.status }
              : {}),
          },
        });
        // A metered API that refuses the key: alarm (4.8); the guard stops the key's reads.
        if (creditKey !== null && result.kind === 'error' && result.status === 401) {
          await ctx.db.transaction((tx) =>
            raiseUnauthorized(tx, {
              creditKey,
              sourceId: source.id,
              runId: run.id,
              now: ctx.clock(),
            }),
          );
        }
        continue;
      }
      if (credits !== null && adapter.usage !== undefined) {
        const usage = adapter.usage.read(result.headers);
        if (usage !== null) {
          if (creditKey !== null) {
            await ctx.db.transaction((tx) => resolveUnauthorized(tx, creditKey, ctx.clock()));
          }
          if (usage.last !== null) credits.spent = (credits.spent ?? 0) + usage.last;
          if (usage.used !== null) credits.used = usage.used;
          if (usage.remaining !== null) credits.remaining = usage.remaining;
          // G3: a request that costs more than it should (a book list over 10, a changed default).
          if (usage.last !== null && usage.last > adapter.usage.expectedCost) {
            issues.push({
              severity: 'warning',
              code: 'unexpected_cost',
              message: `the request cost ${usage.last} credits; ${adapter.usage.expectedCost} expected`,
              context: { url: item.url, cost: usage.last, expected: adapter.usage.expectedCost },
            });
            if (creditKey !== null) {
              const cost = { cost: usage.last, expected: adapter.usage.expectedCost };
              await ctx.db.transaction((tx) =>
                raiseUnexpectedCost(
                  tx,
                  { creditKey, sourceId: source.id, runId: run.id, now: ctx.clock() },
                  cost,
                ),
              );
            }
          }
        }
      }
      currentUrl = result.url;
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
        // The ETag of this page was remembered on the 200; a later 304 must not stand for it.
        await ctx.fetcher.forgetValidators(result.url);
        issues.push({
          severity: 'error',
          code: 'shape_broken',
          message: `the page no longer parses as before (${shape.reason})`,
          context: { url: result.url, accepted: shape.accepted, baseline: shape.baseline },
        });
        await ctx.db.transaction(async (tx) => {
          const review = sourceBrokenReview(source.id, result.url, shape, run.id);
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
      pagesParsed += 1;
      currentUrl = null;
    }
  } catch (error) {
    // A bug or an archive/database failure: the run failed, whatever was committed stays valid.
    worsen('failed');
    if (currentUrl !== null) await ctx.fetcher.forgetValidators(currentUrl);
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ err: error, sourceId: source.id }, 'source run crashed');
    issues.push({ severity: 'error', code: 'run_crashed', message });
  }

  const status: ScrapeRunStatus = outcome;
  const errorText = issues.find((i) => i.fatal || i.code === 'run_crashed')?.message ?? null;
  await ctx.db.transaction(async (tx) => {
    // Only a run that parsed a page shows the source parses again; a 304 shows nothing.
    if (status === 'ok' && pagesParsed > 0) {
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
      ...(credits === null ? {} : { apiCredits: credits }),
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

/**
 * A 304 Not Modified is a sighting of the page we stored last time: a raw row
 * for this run (same bytes, hash and yield as that page), and the
 * observations that page produced move to this run and moment, so "last
 * listed" keeps up with a page that does not change. null when no accepted
 * copy is stored.
 */
async function recordNotModified(
  ctx: ScraperContext,
  sourceId: string,
  runId: string,
  url: string,
  fetchedAt: Date,
): Promise<{
  recordsSeen: number;
  recordsAccepted: number;
  fixtures: number;
  results: number;
} | null> {
  return ctx.db.transaction(async (tx) => {
    const previous = await latestAcceptedRaw(tx, sourceId, url);
    if (previous === null) return null;
    const { raw } = await recordRaw(tx, {
      runId,
      url,
      status: 304,
      contentType: previous.contentType,
      contentHash: previous.contentHash,
      bytes: previous.bytes,
      fetchedAt,
      ...(previous.recordsSeen === null ? {} : { recordsSeen: previous.recordsSeen }),
      ...(previous.recordsAccepted === null ? {} : { recordsAccepted: previous.recordsAccepted }),
    });
    const touched = await touchObservationsOfRaw(tx, {
      sourceId,
      fromRawId: previous.id,
      toRawId: raw.id,
      runId,
      seenAt: fetchedAt,
    });
    // The prices of the unchanged page are listed again too (their freshness is `observed_at`).
    await touchMarketOddsOfRaw(tx, {
      sourceId,
      fromRawId: previous.id,
      toRawId: raw.id,
      runId,
      seenAt: fetchedAt,
    });
    return {
      recordsSeen: previous.recordsSeen ?? 0,
      recordsAccepted: previous.recordsAccepted ?? 0,
      ...touched,
    };
  });
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

/**
 * The price rows of a document, one per (match, bookmaker, market, line, selection): a second row
 * with the same key would overwrite the first inside one statement, so the first wins and the
 * rest are reported once.
 */
function dedupeMarketOdds(
  rows: readonly MarketOddsObservation[],
  issues: ScrapeRunIssueJson[],
): Array<{ obs: MarketOddsObservation; sourceKey: string }> {
  const seen = new Set<string>();
  const out: Array<{ obs: MarketOddsObservation; sourceKey: string }> = [];
  let duplicates = 0;
  for (const obs of rows) {
    const sourceKey = sourceKeyOf(obs);
    const id = [sourceKey, obs.bookmaker, obs.market, obs.line ?? '', obs.selection].join('\u0000');
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    out.push({ obs, sourceKey });
  }
  if (duplicates > 0) {
    issues.push({
      severity: 'warning',
      code: 'duplicate_market_odds',
      message: `${duplicates} price rows repeated a bookmaker's price for the same selection; the first was kept`,
    });
  }
  return out;
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
          kickoff: obs.kickoff,
        },
        unknown,
      ),
    );
  }

  // Bookmaker prices (data class market_odds): one resolution per match of the document.
  const prices = dedupeMarketOdds(parsed.marketOdds, issues);
  const priceIds = new Map<string, ResolvedIds>();
  for (const { obs, sourceKey } of prices) {
    if (priceIds.has(sourceKey)) continue;
    priceIds.set(
      sourceKey,
      resolveNames(
        await indexes.get(obs.sport),
        {
          sport: obs.sport,
          sourceId: source.id,
          competition: obs.competition,
          home: obs.home,
          away: obs.away,
          kickoff: obs.kickoff,
        },
        unknown,
      ),
    );
  }

  const now = ctx.clock();
  let autoAliases = 0;
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
    if (prices.length > 0) {
      // The event of each match, found once per match; none or several: no link (nothing is guessed).
      const eventOf = new Map<string, string | null>();
      const rows: MarketOddsInput[] = [];
      for (const { obs, sourceKey } of prices) {
        const ids = priceIds.get(sourceKey)!;
        if (!eventOf.has(sourceKey)) {
          eventOf.set(
            sourceKey,
            ids.competitionId !== null && ids.homeTeamId !== null && ids.awayTeamId !== null
              ? await findScrapedEventId(
                  tx,
                  {
                    competitionId: ids.competitionId,
                    homeTeamId: ids.homeTeamId,
                    awayTeamId: ids.awayTeamId,
                    kickoff: obs.kickoff,
                  },
                  MARKET_ODDS_LINK_WINDOW_MS,
                )
              : null,
          );
        }
        rows.push({
          sourceKey,
          sport: obs.sport,
          competitionRaw: obs.competition,
          homeRaw: obs.home,
          awayRaw: obs.away,
          kickoff: obs.kickoff,
          market: obs.market,
          line: obs.line,
          selection: obs.selection,
          bookmaker: obs.bookmaker,
          priceMilli: obs.priceMilli,
          priceUpdatedAt: obs.priceUpdatedAt,
          observedAt: obs.observedAt,
          eventId: eventOf.get(sourceKey) ?? null,
          ...ids,
        });
      }
      await upsertMarketOdds(tx, { sourceId: source.id, runId, rawId, rows });
    }
    // One fixed order across runs: sport by sport (the sport is the prefix of every subject key), each sorted.
    const policy = autoAliasPolicy(ctx);
    for (const sport of [...new Set(unknown.map((u) => u.sport))].sort(compareText)) {
      autoAliases += await openUnknownNameItems(
        tx,
        await indexes.get(sport),
        unknown.filter((u) => u.sport === sport),
        now,
        policy,
      );
    }
  });
  if (autoAliases > 0) {
    // N4 wrote a source alias: later documents of this run resolve with it, and the stored rows
    // re-resolve now (their unknown_team item closes once every row with the name resolves).
    indexes.clear();
    await reresolveUnresolved(ctx);
  }
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
  const updated = await reresolveUnresolvedObservations(ctx);
  // Bookmaker prices follow: names that resolve now, and prices whose event exists now.
  return updated + (await reresolveMarketOdds(ctx));
}

/**
 * The bookmaker prices that are still current (read within MARKET_ODDS_MAX_AGE_MS) and have an
 * unresolved name are resolved again; then every current price without an event is linked to the
 * event it belongs to, if one exists now (an event created after the prices were read). Returns
 * the number of price rows that gained an id or an event.
 */
export async function reresolveMarketOdds(ctx: ScraperContext): Promise<number> {
  const now = ctx.clock();
  const since = new Date(now.getTime() - MARKET_ODDS_MAX_AGE_MS);
  let changed = 0;
  const names = await listUnresolvedMarketOddsNames(ctx.db, { since, limit: 5000 });
  if (names.length > 0) {
    const indexes = aliasIndexCache(ctx);
    for (const row of names) {
      const ids = resolveNames(
        await indexes.get(row.sport),
        {
          sport: row.sport,
          sourceId: row.sourceId,
          competition: row.competitionRaw,
          home: row.homeRaw,
          away: row.awayRaw,
        },
        [],
      );
      const gained =
        (ids.competitionId !== null && row.competitionId === null) ||
        (ids.homeTeamId !== null && row.homeTeamId === null) ||
        (ids.awayTeamId !== null && row.awayTeamId === null);
      if (!gained) continue;
      changed += await ctx.db.transaction((tx) => setMarketOddsResolution(tx, row, ids));
    }
  }
  changed += await ctx.db.transaction((tx) =>
    linkMarketOddsToEvents(tx, { since, windowMs: MARKET_ODDS_LINK_WINDOW_MS }),
  );
  return changed;
}

async function reresolveUnresolvedObservations(ctx: ScraperContext): Promise<number> {
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

/** Resolved observations are re-resolved for kickoffs in this window around now. */
const RERESOLVE_BACK_MS = 14 * 24 * 3_600_000;
const RERESOLVE_AHEAD_MS = 150 * 24 * 3_600_000;
const RERESOLVE_LIMIT = 20_000;

/**
 * Fingerprint of everything name resolution reads (catalogue names, aliases) per
 * sport, as last seen by this process. The first pass after a start therefore
 * re-resolves once; resolution is deterministic, so doing it again is harmless.
 */
const resolutionSeen = new WeakMap<object, Map<string, string>>();

/**
 * Review finding 8: removing or changing an alias must also change what is
 * already stored. When the names/aliases of a sport changed since the last pass,
 * every current observation of that sport is resolved again and its ids are
 * rewritten when they differ: a name that no longer resolves is un-mapped (null)
 * and gets its unknown_team / unknown_competition item, a name that now maps
 * elsewhere gets the new id. Returns the number of observations rewritten.
 */
export async function reresolveChangedAliases(ctx: ScraperContext): Promise<number> {
  const sports = await ctx.db
    .selectDistinct({ sport: scrapeObservations.sport })
    .from(scrapeObservations);
  const seen = resolutionSeen.get(ctx.db) ?? new Map<string, string>();
  resolutionSeen.set(ctx.db, seen);
  let rewritten = 0;
  for (const { sport } of sports) {
    const inputs = await loadAliasInputs(ctx.db, sport);
    const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
    if (seen.get(sport) === fingerprint) continue;
    const index = buildAliasIndex(inputs);
    const now = ctx.clock();
    const rows = await listCurrentObservations(ctx.db, {
      kickoffFrom: new Date(now.getTime() - RERESOLVE_BACK_MS),
      kickoffTo: new Date(now.getTime() + RERESOLVE_AHEAD_MS),
      includeDisabledSources: true,
      limit: RERESOLVE_LIMIT,
    });
    if (rows.length >= RERESOLVE_LIMIT) {
      ctx.logger.warn({ sport }, 'alias re-resolution reached its row limit');
    }
    const unknown: UnknownName[] = [];
    for (const row of rows) {
      if (row.sport !== sport) continue;
      const ids = resolveNames(
        index,
        {
          sport,
          sourceId: row.sourceId,
          competition: row.competitionRaw,
          home: row.homeRaw,
          away: row.awayRaw,
          kickoff: row.kickoff,
        },
        unknown,
      );
      if (
        ids.competitionId === row.competitionId &&
        ids.homeTeamId === row.homeTeamId &&
        ids.awayTeamId === row.awayTeamId
      ) {
        continue;
      }
      await ctx.db.transaction((tx) => setObservationResolution(tx, row.id, ids));
      rewritten += 1;
    }
    if (unknown.length > 0) {
      await ctx.db.transaction((tx) => openUnknownNameItems(tx, index, unknown, now));
    }
    seen.set(sport, fingerprint);
  }
  return rewritten;
}
