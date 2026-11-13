import {
  AliasListQuery,
  AliasListResponse,
  type CreditKeyView,
  CreateAliasRequest,
  CreateAliasResponse,
  RemoveAliasResponse,
  FEED_RESOLVE_DECISION_KINDS,
  FEED_SPORTS,
  FeedCompetitionsResponse,
  FeedHealthResponse,
  hasPermission,
  isRepriceItem,
  MapBatchRequest,
  OpenBatchRequest,
  type OpenBatchResult,
  OpenBatchResponse,
  OpenCheckRequest,
  OpenCheckResponse,
  type OpenCheckResult,
  type MapBatchResult,
  MapBatchResponse,
  RATINGS_WINDOW,
  type RatingRow,
  RatingsQuery,
  RatingsResponse,
  SetRatingsRequest,
  SetRatingsResponse,
  parseReviewPayload,
  competitionPolicyPermission,
  resolveReviewPermission,
  ResolveReviewRequest,
  ResolveReviewResponse,
  ReviewDetailResponse,
  type ReviewItemView,
  ReviewListQuery,
  ReviewListResponse,
  SetSourceEnabledRequest,
  SetSourceEnabledResponse,
  UpdateCompetitionPolicyRequest,
  UpdateCompetitionPolicyResponse,
  type AliasView,
  type CompetitionPolicyView,
  type FeedSourceState,
  type SourceHealthView,
} from '@vamos/contracts';
import {
  MARKET_PRICING_KEY_PREFIX,
  anyMarketKey,
  type SportCode,
  uncappedPricingKey,
} from '@vamos/core';
import {
  addCompetitionAlias,
  addTeamAlias,
  addTeamWithAlias,
  apiCreditUsage,
  countReviewItemsByKind,
  DomainError,
  getReviewItem,
  getSource,
  getTeamRatings,
  listAliases,
  listCompetitionPolicies,
  listEventPricing,
  listRatedTeams,
  listUnratedTeams,
  listRecentRuns,
  listReviewItems,
  listSources,
  marketsWithSelections,
  nextMarketOddsKickoffs,
  recentAcceptedCounts,
  recordEventPriced,
  removeAlias,
  resolveReviewItem,
  ScrapeAliasConflictError,
  ScrapeReviewStateError,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
  setTeamRatings,
  sourceHealth,
  upsertFixture,
  writeAudit,
  type AliasListRow,
  type CompetitionPolicyRow,
  type DbExecutor,
  type DbTransaction,
  type LiveMessage,
  type ScrapeReviewItem,
  type SourceHealth,
} from '@vamos/db';
import { competitions, events, teams } from '@vamos/db/schema';
import {
  checkReprice,
  createAdapter,
  creditKeyOf,
  creditStatus,
  DAY_MS,
  utcMonthStart,
  heldKeyOf,
  isCalibrated,
  MIN_LEAD_MS,
  MIN_RATING_MATCHES,
  normalizeName,
  ratingsKey,
  REPRICE_SUBJECT_SUFFIX,
  RESULTS_SLOW_INTERVAL_MS,
  type GateMarket,
} from '@vamos/scraper';
import { MAX_TEAM_RATING, MIN_TEAM_RATING } from '@vamos/feed';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  parseInput,
  unprocessable,
} from '../../lib/errors';
import { requireStaff, staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, publishLive, wire } from './common';
import { assertScrapedEventMayOpen } from './open-betting';
import {
  OPEN_MARGIN_BPS,
  OPEN_TOLERANCE_BPS,
  openTolerance,
  reviewMarketComparison,
} from './review-market';

type IdParams = { Params: { id: string } };

/** Fewer successful runs than this and a source has no baseline yet (state `learning`). */
const LEARNING_RUNS = 3;
/**
 * A source is `stale` when its last successful run is older than three times
 * its cadence. The cadence used is the slowest a healthy source is polled at
 * (the quiet results interval), so a results-only source is not reported
 * stale between its polls; a fixtures source polled every 15 minutes is
 * reported after three hours of silence at the latest, and failing runs show
 * as `broken` or `blocked` long before.
 */
const STALE_AFTER_MS = 3 * RESULTS_SLOW_INTERVAL_MS;
/** Most rows one review-list request reads while it looks for matches of a multi-value filter. */
const REVIEW_SCAN_PAGE = 500;
const REVIEW_SCAN_PAGES = 20;
/** The window an alias list is built from (the service's largest page). */
const ALIAS_WINDOW = 2000;

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A field only when it is set (exactOptionalPropertyTypes). */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

// ---------------------------------------------------------------------------
// Source health.

/** The state of a source for the health page (docs/scraper.md section 8). */
function sourceState(health: SourceHealth, okRuns: number): FeedSourceState {
  if (!health.enabled) return 'disabled';
  if (health.lastStatus === 'broken') return 'broken';
  if (health.lastStatus === 'blocked') return 'blocked';
  if (health.sinceLastOkMs === null || health.sinceLastOkMs > STALE_AFTER_MS) return 'stale';
  if (okRuns < LEARNING_RUNS) return 'learning';
  return 'ok';
}

async function sourceViews(
  exec: DbExecutor,
  now: Date,
  only?: string,
): Promise<SourceHealthView[]> {
  const [sources, health] = await Promise.all([listSources(exec), sourceHealth(exec, now)]);
  const healthById = new Map(health.map((row) => [row.sourceId, row]));
  const views: SourceHealthView[] = [];
  for (const source of sources) {
    if (only !== undefined && source.id !== only) continue;
    const h = healthById.get(source.id);
    if (h === undefined) continue;
    const okRuns = (await recentAcceptedCounts(exec, source.id, undefined, LEARNING_RUNS)).length;
    let lastRun: SourceHealthView['lastRun'] = null;
    if (h.lastRun !== null) {
      const runs = await listRecentRuns(exec, { sourceId: source.id, limit: 50 });
      const run = runs.find((candidate) => candidate.id === h.lastRun?.id);
      lastRun = {
        status: h.lastRun.status,
        startedAt: h.lastRun.startedAt.toISOString(),
        finishedAt: h.lastRun.finishedAt?.toISOString() ?? null,
        recordsSeen: run?.recordsSeen ?? h.lastRun.recordsAccepted,
        recordsAccepted: h.lastRun.recordsAccepted,
      };
    }
    views.push({
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      upstream: source.upstream,
      enabled: source.enabled,
      lastRun,
      lastOkAt: h.lastOkAt?.toISOString() ?? null,
      consecutiveFailures: h.consecutiveFailures,
      openReviewItems: h.openReviewItems,
      state: sourceState(h, okRuns),
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Competition policy.

function policyView(row: CompetitionPolicyRow): CompetitionPolicyView {
  return {
    competitionId: row.competitionId,
    name: row.name.en,
    sport: row.sportId,
    enabled: row.enabled,
    autoOpen: row.autoOpen,
    autoResults: row.autoResults,
    extraTime: row.extraTime,
    pricingSource: row.pricingSource,
    factoryMarkets: row.factoryMarkets,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

// ---------------------------------------------------------------------------
// Review queue.

/** The resolution text of a closed item as the view's object: JSON written by a person, or plain system text. */
function parseResolution(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Plain text, as the scraper writes it.
  }
  return { note: text };
}

function reviewView(item: ScrapeReviewItem): ReviewItemView {
  return {
    id: item.id,
    kind: item.kind,
    subjectKey: item.subjectKey,
    status: item.status,
    severity: item.severity,
    title: item.title,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    payload: item.payload,
    resolution: item.resolution === null ? null : parseResolution(item.resolution),
    resolvedBy: item.resolvedBy,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
  };
}

function encodeCursor(item: { createdAt: Date; id: string }): string {
  return Buffer.from(`${item.createdAt.toISOString()}|${item.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (id === undefined || !Uuid.test(id) || Number.isNaN(createdAt.getTime())) {
    throw badRequest('invalid_cursor', 'The cursor is not valid');
  }
  return { createdAt, id };
}

/** The service errors under the codes of the contract (`review_closed`, `alias_conflict`). */
function contractError(error: unknown): unknown {
  if (error instanceof ScrapeReviewStateError) {
    return conflict('review_closed', error.message, error.details);
  }
  if (error instanceof ScrapeAliasConflictError) {
    return conflict('alias_conflict', error.message, error.details);
  }
  return error;
}

/**
 * The `map_alias` decision on an open unknown_team / unknown_competition item: validates the
 * target and source, writes the alias (audited by the service) and returns the resolution to
 * store. Shared by the single resolve route and the batch route, so both apply the same rules.
 * The caller closes the item in the same transaction.
 */
async function applyMapAlias(
  tx: DbTransaction,
  item: ScrapeReviewItem,
  input: { targetId: string; sourceId: string | null },
  actor: ReturnType<typeof staffActor>,
): Promise<Record<string, unknown>> {
  const kind = item.kind === 'unknown_team' ? 'team' : 'competition';
  const payload = parseReviewPayload(
    item.kind as 'unknown_team' | 'unknown_competition',
    item.payload,
  );
  if (payload === null) {
    throw unprocessable('invalid_payload', `The ${item.kind} item has an unexpected payload`);
  }
  const targetId = parseUuid(input.targetId, kind === 'team' ? 'Team' : 'Competition');
  const sourceId = input.sourceId;
  if (sourceId !== null && (await getSource(tx, sourceId)) === null) throw notFound('Source');
  const alias = { sportId: payload.sport, aliasNorm: normalizeName(payload.raw), sourceId };
  if (kind === 'team') await addTeamAlias(tx, { ...alias, teamId: targetId }, actor);
  else await addCompetitionAlias(tx, { ...alias, competitionId: targetId }, actor);
  return { decision: 'map_alias', targetId, sourceId, by: actor.adminId };
}

/** attack, defence and matches of stored ratings, null where absent or not a finite number. */
function ratingFacts(
  ratings: Record<string, number> | null,
  manual: boolean,
): { attack: number | null; defence: number | null; matches: number; manual: boolean } {
  const num = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : null);
  return {
    attack: num(ratings?.attack),
    defence: num(ratings?.defence),
    matches: Math.max(0, Math.trunc(num(ratings?.matches) ?? 0)),
    manual,
  };
}

interface LockedEvent {
  id: string;
  status: string;
  bettingOpen: boolean;
  startTime: Date;
  resultedAt: Date | null;
  feedProvider: string;
  feedRef: string;
  sportId: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
}

/** The event a review item is about, locked for the rest of the transaction; null when there is none. */
async function lockEvent(tx: DbTransaction, eventId: string): Promise<LockedEvent | null> {
  if (!Uuid.test(eventId)) return null;
  const [row] = await tx
    .select({
      id: events.id,
      status: events.status,
      bettingOpen: events.bettingOpen,
      startTime: events.startTime,
      resultedAt: events.resultedAt,
      feedProvider: events.feedProvider,
      feedRef: events.feedRef,
      sportId: events.sportId,
      competitionId: events.competitionId,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .for('update');
  return row ?? null;
}

/** Why an event cannot be acted on by a scraper decision, or null when it is a scheduled, unresulted event. */
function eventRefusal(event: LockedEvent | null): DomainError | null {
  if (event === null) return unprocessable('event_not_found', 'The event no longer exists');
  if (event.status !== 'scheduled' || event.resultedAt !== null) {
    return unprocessable('event_not_scheduled', `The event is ${event.status}, not scheduled`);
  }
  return null;
}

type Actor = ReturnType<typeof staffActor>;

/**
 * The `open_betting` decision of one odds_approval item, in the caller's transaction (the single
 * resolve route and the bulk open of plan A-4 both run exactly this): event scheduled and unresulted,
 * kickoff far enough away, betting not open, O1 and O2 again (assertScrapedEventMayOpen), then
 * `beforeOpen` (the bulk route's tolerance check) and the change. Throws a DomainError to refuse.
 */
async function openBettingDecision(
  tx: DbTransaction,
  item: ScrapeReviewItem,
  actor: Actor,
  now: Date,
  minRatingMatches: number,
  beforeOpen?: (eventId: string) => Promise<void>,
): Promise<{ resolution: Record<string, unknown>; messages: LiveMessage[] }> {
  const payload = parseReviewPayload('odds_approval', item.payload);
  if (payload === null) {
    throw unprocessable('invalid_payload', `The ${item.kind} item has an unexpected payload`);
  }
  const event = await lockEvent(tx, payload.eventId);
  const refusal = eventRefusal(event);
  if (refusal !== null) throw refusal;
  if (event!.startTime.getTime() < now.getTime() + MIN_LEAD_MS) {
    throw unprocessable('kickoff_too_close', 'The event starts too soon to open betting by hand');
  }
  if (event!.bettingOpen) {
    throw unprocessable('betting_already_open', 'Betting is already open on the event');
  }
  // The item was raised when both checks passed; ratings and prices may have changed
  // since, so they are checked again at the moment a person opens betting (O1, O2).
  await assertScrapedEventMayOpen(tx, event!.id, minRatingMatches, now);
  if (beforeOpen !== undefined) await beforeOpen(event!.id);
  const change = await setEventBettingOpen(tx, event!.id, true, actor);
  return {
    resolution: { decision: 'open_betting', eventId: event!.id, by: actor.adminId },
    messages: [...change.messages],
  };
}

// ---------------------------------------------------------------------------
// Aliases.

async function targetName(
  exec: DbExecutor,
  kind: 'team' | 'competition',
  id: string,
): Promise<string> {
  if (kind === 'team') {
    const [row] = await exec
      .select({ name: teams.name, shortName: teams.shortName })
      .from(teams)
      .where(eq(teams.id, id));
    return row === undefined ? id : row.name.en || row.shortName;
  }
  const [row] = await exec
    .select({ name: competitions.name, slug: competitions.slug })
    .from(competitions)
    .where(eq(competitions.id, id));
  return row === undefined ? id : row.name.en || row.slug;
}

function aliasView(row: AliasListRow): AliasView {
  return {
    id: row.id,
    kind: row.kind,
    sport: row.sportId as AliasView['sport'],
    // Only the normalised form is stored (rule N1).
    raw: row.aliasNorm,
    normalized: row.aliasNorm,
    targetId: row.targetId,
    targetName: row.targetLabel,
    sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ?? 'system',
  };
}

/**
 * The back office of the data scraper (/admin/feed/*, docs/scraper.md section
 * 8): source health and the kill switch, the review queue, name aliases and
 * the competition policy. Each route's permission is FEED_ROUTE_PERMISSIONS of
 * @vamos/contracts. Every change is audited with the staff actor (the
 * services write the audit records). No request can carry a score or cancel
 * an event: applying a result only records the decision, and the scraper
 * applies the score of the item's payload after re-validating it.
 */
/**
 * The keys of metered odds feeds, each with its credit guard as the scheduler sees it (the same
 * pure creditStatus over the same runs), and its sources' reads.
 */
async function creditViews(exec: DbExecutor, now: Date): Promise<CreditKeyView[]> {
  const [sources, health] = await Promise.all([listSources(exec), sourceHealth(exec, now)]);
  const lastRun = new Map(health.map((h) => [h.sourceId, h.lastRun?.startedAt ?? null]));
  const groups = new Map<string, typeof sources>();
  for (const source of sources) {
    const built = createAdapter({
      id: source.id,
      adapter: source.adapter,
      upstream: source.upstream,
      config: source.config,
    });
    if (!built.ok || built.adapter.usage === undefined) continue;
    const key = creditKeyOf(source.id, built.adapter.plan(now));
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  if (groups.size === 0) return [];
  const next = await nextMarketOddsKickoffs(exec, {
    sourceIds: [...groups.values()].flat().map((s) => s.id),
    after: new Date(now.getTime() + MIN_LEAD_MS),
  });
  const views: CreditKeyView[] = [];
  for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const usage = await apiCreditUsage(exec, {
      sourceIds: members.map((s) => s.id),
      monthStart: utcMonthStart(now),
      since: new Date(now.getTime() - DAY_MS),
    });
    const status = creditStatus(
      usage,
      members.map((s) => s.updatedAt),
      now,
    );
    views.push({
      key,
      mode: status.mode,
      keyRefused: status.keyRefused,
      remaining: status.remaining,
      quota: status.quota,
      spentLast24h: status.spentLast24h,
      lastReadAt: status.lastReadAt?.toISOString() ?? null,
      sources: members.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        lastRunAt: lastRun.get(s.id)?.toISOString() ?? null,
        nextKickoff: next.get(s.id)?.toISOString() ?? null,
      })),
    });
  }
  return views;
}

export default async function adminFeedRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  // -------------------------------------------------------------------------
  // Health and the kill switch.

  app.get('/admin/feed/health', { config: { staff: 'trading.view' } }, async () => {
    const now = deps.clock();
    const [sources, byKind, policies, credits] = await Promise.all([
      sourceViews(deps.db, now),
      countReviewItemsByKind(deps.db),
      listCompetitionPolicies(deps.db),
      creditViews(deps.db, now),
    ]);
    return wire(FeedHealthResponse, {
      sources,
      credits,
      queue: {
        open: Object.values(byKind).reduce((sum, count) => sum + count, 0),
        byKind,
      },
      competitions: {
        total: policies.length,
        enabled: policies.filter((row) => row.enabled).length,
        autoOpen: policies.filter((row) => row.autoOpen).length,
        autoResults: policies.filter((row) => row.autoResults).length,
      },
      generatedAt: now.toISOString(),
    });
  });

  app.put<IdParams>(
    '/admin/feed/sources/:id',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const input = parseInput(SetSourceEnabledRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const id = request.params.id;
      const [source] = await inTx(deps, async (tx) => {
        await setSourceEnabled(tx, id, input.enabled, actor);
        return sourceViews(tx, now, id);
      });
      if (source === undefined) throw notFound('Source');
      return wire(SetSourceEnabledResponse, { source });
    },
  );

  // -------------------------------------------------------------------------
  // Review queue.

  app.get('/admin/feed/review', { config: { staff: 'trading.view' } }, async (request) => {
    const query = parseInput(ReviewListQuery, request.query);
    const statuses = query.status !== undefined && query.status.length > 0 ? query.status : null;
    const kinds = query.kind !== undefined && query.kind.length > 0 ? query.kind : null;
    const single = <T>(values: readonly T[] | null): T | undefined =>
      values !== null && values.length === 1 ? values[0] : undefined;
    const matches = (item: ScrapeReviewItem) =>
      (statuses === null || statuses.includes(item.status)) &&
      (kinds === null || kinds.includes(item.kind));

    // The service filters on at most one status and one kind; a longer list is
    // filtered here, reading on until the page (plus one) is full.
    const found: ScrapeReviewItem[] = [];
    let after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    let resumeAfter: ScrapeReviewItem | null = null;
    for (let pageNo = 0; pageNo < REVIEW_SCAN_PAGES && found.length <= query.limit; pageNo++) {
      const batch = await listReviewItems(deps.db, {
        ...opt('status', single(statuses)),
        ...opt('kind', single(kinds)),
        ...opt('after', after),
        limit: REVIEW_SCAN_PAGE,
      });
      for (const item of batch) {
        if (found.length > query.limit) break;
        if (matches(item)) found.push(item);
      }
      const last = batch.at(-1);
      if (last === undefined || batch.length < REVIEW_SCAN_PAGE) {
        resumeAfter = null;
        break;
      }
      resumeAfter = last;
      after = { createdAt: last.createdAt, id: last.id };
    }
    const items = found.slice(0, query.limit);
    let nextCursor: string | null = null;
    if (found.length > query.limit) nextCursor = encodeCursor(items[items.length - 1]!);
    else if (resumeAfter !== null) nextCursor = encodeCursor(resumeAfter);
    return wire(ReviewListResponse, { items: items.map(reviewView), nextCursor });
  });

  app.get<IdParams>(
    '/admin/feed/review/:id',
    { config: { staff: 'trading.view' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Review item');
      const item = await getReviewItem(deps.db, id);
      if (item === null) throw notFound('Review item');
      return wire(ReviewDetailResponse, {
        item: reviewView(item),
        comparison: await reviewMarketComparison(deps.db, item, deps.clock()),
      });
    },
  );

  /**
   * Resolves a review item. The body is a strict discriminated union, so a
   * client can never send a score. 422 `decision_not_allowed` for a decision
   * the item's kind does not take, 409 `review_closed` for an item that is
   * not open, 404 for an unknown id. `apply_result` stores only the decision
   * (`{"decision":"apply_result","by":"<admin id>"}`): the scraper applies the
   * score of the item's payload after re-validating it. `apply_reprice` (an
   * odds_approval item whose subject ends in `|reprice`, rule O3) applies the book
   * stored in the item, never a price from the request, in this transaction.
   */
  app.post<IdParams>(
    '/admin/feed/review/:id/resolve',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Review item');
      const input = parseInput(ResolveReviewRequest, request.body);
      const needed = resolveReviewPermission(input);
      if (!hasPermission(requireStaff(request).role, needed)) {
        throw forbidden('forbidden', 'Your role does not allow this.', { permission: needed });
      }
      const actor = staffActor(request);
      const now = deps.clock();

      const outcome = await inTx(deps, async (tx) => {
        const item = await getReviewItem(tx, id);
        if (item === null) throw notFound('Review item');
        const allowedKinds: readonly string[] = FEED_RESOLVE_DECISION_KINDS[input.decision];
        if (!allowedKinds.includes(item.kind)) {
          throw unprocessable(
            'decision_not_allowed',
            `The decision ${input.decision} does not apply to ${item.kind} items`,
            { decision: input.decision, kind: item.kind },
          );
        }
        // An odds_approval item is either the F7 request to open betting or a re-price
        // (subject `<feedRef>|reprice`): each takes only its own decision.
        if (
          (input.decision === 'apply_reprice' && !isRepriceItem(item)) ||
          (input.decision === 'open_betting' && isRepriceItem(item))
        ) {
          throw unprocessable(
            'decision_not_allowed',
            `The decision ${input.decision} does not apply to this ${item.kind} item`,
            { decision: input.decision, kind: item.kind, subjectKey: item.subjectKey },
          );
        }
        if (item.status !== 'open') {
          throw conflict('review_closed', `The review item is already ${item.status}`, {
            id,
            status: item.status,
          });
        }
        const badPayload = () =>
          unprocessable('invalid_payload', `The ${item.kind} item has an unexpected payload`);
        const messages: LiveMessage[] = [];
        let status: 'resolved' | 'dismissed' = 'resolved';
        let resolution: Record<string, unknown> = { decision: input.decision, by: actor.adminId };

        switch (input.decision) {
          case 'dismiss': {
            status = 'dismissed';
            resolution = { decision: 'dismiss', note: input.note, by: actor.adminId };
            break;
          }
          case 'map_alias': {
            resolution = await applyMapAlias(
              tx,
              item,
              { targetId: input.targetId, sourceId: input.sourceId ?? null },
              actor,
            );
            break;
          }
          case 'add_team': {
            const payload = parseReviewPayload('unknown_team', item.payload);
            if (payload === null) throw badPayload();
            const sourceId = input.sourceId ?? null;
            if (sourceId !== null && (await getSource(tx, sourceId)) === null) {
              throw notFound('Source');
            }
            const name = input.name.am === undefined ? { en: input.name.en } : input.name;
            const created = await addTeamWithAlias(
              tx,
              {
                sportId: payload.sport,
                name,
                shortName: input.shortName,
                countryCode: input.countryCode ?? null,
                aliasNorm: normalizeName(payload.raw),
                sourceId,
                normalize: normalizeName,
              },
              actor,
            );
            resolution = {
              decision: 'add_team',
              teamId: created.teamId,
              sourceId,
              by: actor.adminId,
            };
            break;
          }
          case 'open_betting': {
            const opened = await openBettingDecision(
              tx,
              item,
              actor,
              now,
              deps.config.scraper.minRatingMatches,
            );
            messages.push(...opened.messages);
            resolution = opened.resolution;
            break;
          }
          case 'apply_result': {
            // Nothing but the decision: the scraper applies the item's own score
            // after re-validating it (rules R1, R8 to R11).
            resolution = { decision: 'apply_result', by: actor.adminId };
            break;
          }
          case 'apply_kickoff': {
            const payload = parseReviewPayload('kickoff_change', item.payload);
            if (payload === null) throw badPayload();
            const event = await lockEvent(tx, payload.eventId);
            const refusal = eventRefusal(event);
            if (refusal !== null) throw refusal;
            const proposed = new Date(payload.proposedKickoff);
            if (
              Number.isNaN(proposed.getTime()) ||
              proposed.getTime() < now.getTime() + MIN_LEAD_MS
            ) {
              throw unprocessable(
                'kickoff_too_close',
                'The proposed kickoff is too close or already past',
              );
            }
            // No markets: only the start time moves, nothing is re-priced.
            const moved = await upsertFixture(
              tx,
              {
                feedProvider: event!.feedProvider,
                feedRef: event!.feedRef,
                sport: event!.sportId as SportCode,
                competitionId: event!.competitionId,
                homeTeamId: event!.homeTeamId,
                awayTeamId: event!.awayTeamId,
                startTime: proposed,
              },
              [],
              { now },
            );
            messages.push(...moved.messages);
            resolution = {
              decision: 'apply_kickoff',
              eventId: event!.id,
              kickoff: proposed.toISOString(),
              by: actor.adminId,
            };
            break;
          }
          case 'apply_reprice': {
            const payload = parseReviewPayload('odds_approval', item.payload);
            if (
              payload === null ||
              payload.proposal === undefined ||
              payload.ratingsKey === undefined
            ) {
              throw badPayload();
            }
            const event = await lockEvent(tx, payload.eventId);
            const refusal = eventRefusal(event);
            if (refusal !== null) throw refusal;
            if (item.subjectKey !== `${event!.feedRef}${REPRICE_SUBJECT_SUFFIX}`)
              throw badPayload();
            if (event!.startTime.getTime() < now.getTime() + MIN_LEAD_MS) {
              throw unprocessable(
                'kickoff_too_close',
                'The event starts too soon to change its prices by hand',
              );
            }
            // The proposal is the book of the ratings it was priced from; if they moved, a
            // newer proposal replaces it (the scraper refreshes the open item).
            const rated = await getTeamRatings(tx, [event!.homeTeamId, event!.awayTeamId]);
            let currentKey: string;
            if (payload.ratingsKey.startsWith(`${MARKET_PRICING_KEY_PREFIX}|`)) {
              // A market proposal is current while it is the one the scraper last raised for the
              // event (a newer proposal replaces it; applying or auto re-pricing clears it).
              const held = (await listEventPricing(tx, [event!.id])).get(event!.id)?.heldKey;
              if (
                held !== heldKeyOf(payload.ratingsKey, true) &&
                held !== heldKeyOf(payload.ratingsKey, false)
              ) {
                throw conflict(
                  'proposal_stale',
                  'The bookmaker prices changed since this proposal was made',
                  { id },
                );
              }
              currentKey = payload.ratingsKey;
            } else {
              currentKey = ratingsKey(
                rated.get(event!.homeTeamId)?.ratings,
                rated.get(event!.awayTeamId)?.ratings,
              );
              // A proposal capped at the best book price (rule O7) carries the cap in its key.
              if (currentKey !== uncappedPricingKey(payload.ratingsKey)) {
                throw conflict(
                  'proposal_stale',
                  'The team ratings changed since this proposal was made',
                  { id },
                );
              }
              currentKey = payload.ratingsKey;
            }
            // Only prices change: the markets the upsert may touch must be exactly those of the
            // proposal and the book must pass the sanity rules; the size of the move is what the
            // trader is approving (O3), so it is not checked again.
            const stored = await marketsWithSelections(tx, event!.id);
            const updatable = stored.filter((m) => m.status === 'open' || m.status === 'suspended');
            const frozen = new Set(stored.filter((m) => !updatable.includes(m)).map((m) => m.key));
            const proposal: GateMarket[] = payload.proposal.map((m) => ({
              type: m.type,
              line: m.line,
              selections: m.selections,
            }));
            const next = proposal.filter((m) => {
              try {
                return !frozen.has(anyMarketKey(m.type, m.line));
              } catch {
                return true; // checkReprice names it
              }
            });
            const check = checkReprice(
              updatable.map((m) => ({
                type: m.type,
                line: m.line,
                selections: m.selections,
              })),
              next,
            );
            const blocking = check.ok
              ? []
              : check.issues.filter((issue) => issue.code !== 'price_move_too_large');
            if (blocking.length > 0) {
              throw unprocessable(
                'proposal_not_applicable',
                "The proposal does not fit the event's markets any more",
                { issues: blocking.map((issue) => ({ ...issue })) },
              );
            }
            const repriced = await upsertFixture(
              tx,
              {
                feedProvider: event!.feedProvider,
                feedRef: event!.feedRef,
                sport: event!.sportId as SportCode,
                competitionId: event!.competitionId,
                homeTeamId: event!.homeTeamId,
                awayTeamId: event!.awayTeamId,
                startTime: event!.startTime,
              },
              next,
              { now },
            );
            await recordEventPriced(tx, event!.id, currentKey, now);
            await writeAudit(tx, {
              actorType: 'admin',
              actorId: actor.adminId,
              action: 'scrape.fixture.repriced',
              targetType: 'event',
              targetId: event!.id,
              metadata: {
                feedRef: event!.feedRef,
                via: 'staff',
                reviewItemId: id,
                ratingsKey: currentKey,
                oddsChanged: repriced.oddsChanged,
              },
              ip: actor.ip ?? null,
            });
            messages.push(...repriced.messages);
            resolution = {
              decision: 'apply_reprice',
              eventId: event!.id,
              oddsChanged: repriced.oddsChanged,
              by: actor.adminId,
            };
            break;
          }
        }

        const closed = await resolveReviewItem(tx, id, {
          status,
          resolution: JSON.stringify(resolution),
          actor,
          now,
        });
        return { item: closed, messages };
      }).catch((error: unknown) => {
        throw contractError(error);
      });

      await publishLive(app, outcome.messages);
      return wire(ResolveReviewResponse, { item: reviewView(outcome.item), changed: true });
    },
  );

  /**
   * Bulk `map_alias` for unknown_team items (plan U-5). Each item is applied exactly like the
   * single `map_alias` decision (applyMapAlias) and closed in its OWN transaction, so one item
   * that fails (closed meanwhile, unknown team, alias conflict) does not undo or block the
   * others: the response lists a result per item, in request order, and the status is 200 even
   * when some failed (`failed` counts them). Scope `source` uses the item's payload sourceId,
   * `all` writes a source-less alias. Needs `trading.status`, the single decision's permission.
   */
  app.post(
    '/admin/feed/review/map-batch',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const input = parseInput(MapBatchRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const results: MapBatchResult[] = [];
      for (const entry of input.items) {
        try {
          const closed = await inTx(deps, async (tx) => {
            const id = parseUuid(entry.itemId, 'Review item');
            const item = await getReviewItem(tx, id);
            if (item === null) throw notFound('Review item');
            if (item.kind !== 'unknown_team') {
              throw unprocessable(
                'decision_not_allowed',
                `The decision map_alias does not apply to ${item.kind} items in a batch`,
                { decision: 'map_alias', kind: item.kind },
              );
            }
            if (item.status !== 'open') {
              throw conflict('review_closed', `The review item is already ${item.status}`, {
                id,
                status: item.status,
              });
            }
            const payload = parseReviewPayload('unknown_team', item.payload);
            if (payload === null) {
              throw unprocessable(
                'invalid_payload',
                'The unknown_team item has an unexpected payload',
              );
            }
            const resolution = await applyMapAlias(
              tx,
              item,
              {
                targetId: entry.targetId,
                sourceId: entry.scope === 'source' ? payload.sourceId : null,
              },
              actor,
            );
            return resolveReviewItem(tx, id, {
              status: 'resolved',
              resolution: JSON.stringify(resolution),
              actor,
              now,
            });
          }).catch((error: unknown) => {
            throw contractError(error);
          });
          results.push({ itemId: entry.itemId, ok: true, item: reviewView(closed) });
        } catch (error) {
          if (error instanceof DomainError) {
            results.push({
              itemId: entry.itemId,
              ok: false,
              error: { code: error.code, message: error.message },
            });
          } else {
            throw error;
          }
        }
      }
      const mapped = results.filter((r) => r.ok).length;
      return wire(MapBatchResponse, { results, mapped, failed: results.length - mapped });
    },
  );

  /**
   * Bulk `open_betting` for odds_approval items (plan A-4). Each item goes through exactly the
   * single decision (openBettingDecision: event scheduled, kickoff, not open yet, O1 and O2 again)
   * in its OWN transaction, plus the tolerance test computed here from the fresh consensus
   * (openTolerance: every 1X2 price within OPEN_TOLERANCE_BPS of the no-vig consensus after our
   * margin; `no_consensus` when there is none). Re-price items (subject `|reprice`) are refused
   * (`decision_not_allowed`, as the single route does). One item failing does not undo or block
   * the others: a result per item, in request order, and status 200 even when some failed.
   * Needs `trading.status`, the single decision's permission. Audited as the single route is
   * (catalog.event.betting_opened, scrape.review.resolved) with `batch: true` in the resolution
   * and in a scrape.review.open_batch record.
   */
  app.post(
    '/admin/feed/review/open-batch',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const input = parseInput(OpenBatchRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const results: OpenBatchResult[] = [];
      const messages: LiveMessage[] = [];
      for (const itemId of input.itemIds) {
        try {
          const closed = await inTx(deps, async (tx) => {
            const id = parseUuid(itemId, 'Review item');
            const item = await getReviewItem(tx, id);
            if (item === null) throw notFound('Review item');
            if (item.kind !== 'odds_approval' || isRepriceItem(item)) {
              throw unprocessable(
                'decision_not_allowed',
                `The decision open_betting does not apply to this ${item.kind} item`,
                { decision: 'open_betting', kind: item.kind, subjectKey: item.subjectKey },
              );
            }
            if (item.status !== 'open') {
              throw conflict('review_closed', `The review item is already ${item.status}`, {
                id,
                status: item.status,
              });
            }
            const opened = await openBettingDecision(
              tx,
              item,
              actor,
              now,
              deps.config.scraper.minRatingMatches,
              async (eventId) => {
                const check = await openTolerance(tx, eventId, now);
                if (check.reason === 'no_consensus') {
                  throw unprocessable(
                    'no_consensus',
                    'There is no fresh bookmaker consensus to compare the prices with',
                  );
                }
                if (!check.ok) {
                  throw unprocessable(
                    'out_of_tolerance',
                    check.reason === 'no_prices'
                      ? 'The event has no complete 1X2 prices to compare'
                      : `A 1X2 price is more than ${OPEN_TOLERANCE_BPS / 100}% away from the consensus`,
                    {
                      toleranceBps: OPEN_TOLERANCE_BPS,
                      marginBps: OPEN_MARGIN_BPS,
                      selections: check.selections.map((s) => ({ ...s })),
                    },
                  );
                }
              },
            );
            const resolution = { ...opened.resolution, batch: true };
            await writeAudit(tx, {
              actorType: 'admin',
              actorId: actor.adminId,
              action: 'scrape.review.open_batch',
              targetType: 'event',
              targetId: String(opened.resolution.eventId),
              metadata: {
                reviewItemId: id,
                batch: true,
                toleranceBps: OPEN_TOLERANCE_BPS,
                marginBps: OPEN_MARGIN_BPS,
              },
              ip: actor.ip ?? null,
            });
            const resolved = await resolveReviewItem(tx, id, {
              status: 'resolved',
              resolution: JSON.stringify(resolution),
              actor,
              now,
            });
            return { resolved, messages: opened.messages };
          }).catch((error: unknown) => {
            throw contractError(error);
          });
          messages.push(...closed.messages);
          results.push({ itemId, ok: true, item: reviewView(closed.resolved) });
        } catch (error) {
          if (error instanceof DomainError) {
            results.push({
              itemId,
              ok: false,
              error: { code: error.code, message: error.message },
            });
          } else {
            throw error;
          }
        }
      }
      await publishLive(app, messages);
      const opened = results.filter((r) => r.ok).length;
      return wire(OpenBatchResponse, { results, opened, failed: results.length - opened });
    },
  );

  /**
   * Read-only tolerance status of open odds_approval items (plan A-4), for the review page's
   * checkboxes: the same openTolerance the bulk open runs. It is advice only: the bulk open checks
   * everything again. Reasons: `not_open_item` (not an open, non-re-price odds_approval item with
   * an event), `no_consensus`, `no_prices`, `out_of_tolerance`.
   */
  app.post(
    '/admin/feed/review/open-check',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const input = parseInput(OpenCheckRequest, request.body);
      const now = deps.clock();
      const results: OpenCheckResult[] = [];
      for (const itemId of input.itemIds) {
        const item = Uuid.test(itemId) ? await getReviewItem(deps.db, itemId) : null;
        const payload =
          item !== null && item.kind === 'odds_approval' && !isRepriceItem(item)
            ? parseReviewPayload('odds_approval', item.payload)
            : null;
        if (item === null || item.status !== 'open' || payload === null) {
          results.push({
            itemId,
            withinTolerance: false,
            reason: 'not_open_item',
            selections: [],
          });
          continue;
        }
        const check = await openTolerance(deps.db, payload.eventId, now);
        results.push({
          itemId,
          withinTolerance: check.ok,
          reason: check.reason,
          selections: check.selections,
        });
      }
      return wire(OpenCheckResponse, {
        toleranceBps: OPEN_TOLERANCE_BPS,
        marginBps: OPEN_MARGIN_BPS,
        results,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Team ratings (plan R-3).

  app.get('/admin/feed/ratings', { config: { staff: 'trading.view' } }, async (request) => {
    const query = parseInput(RatingsQuery, request.query);
    const nameKey = query.team === undefined ? '' : normalizeName(query.team);
    if (query.team !== undefined && nameKey === '') {
      throw badRequest('validation_error', 'The team filter has no letters or digits');
    }
    // O1 never takes the bar below MIN_RATING_MATCHES; the configured bar may raise it.
    const minMatches = Math.max(deps.config.scraper.minRatingMatches, MIN_RATING_MATCHES);
    let rows: RatingRow[];
    if (query.unrated === true) {
      rows = (
        await listUnratedTeams(deps.db, {
          nameKey,
          normalize: normalizeName,
          now: deps.clock(),
          calibrated: (ratings) => isCalibrated(ratings, minMatches),
        })
      ).map((r) => ({
        teamId: r.teamId,
        team: r.team,
        ...ratingFacts(r.ratings, false),
        upcoming: r.upcoming,
        nextKickoff: r.nextKickoff.toISOString(),
      }));
    } else {
      rows = (await listRatedTeams(deps.db, { nameKey, normalize: normalizeName })).map((r) => ({
        teamId: r.teamId,
        team: r.team,
        ...ratingFacts(r.ratings, r.manual),
        upcoming: null,
        nextKickoff: null,
      }));
    }
    return wire(RatingsResponse, {
      minMatches,
      min: MIN_TEAM_RATING,
      max: MAX_TEAM_RATING,
      teams: rows.slice(0, RATINGS_WINDOW),
      truncated: rows.length > RATINGS_WINDOW,
    });
  });

  /**
   * Sets a football team's ratings by hand: attack, defence and optionally matches, with
   * `manual = 1` (rule O1 then counts the team calibrated whatever the match count). Same effect
   * as `ratings set` of the scraper CLI: other keys of the stored ratings are kept and the write
   * goes through setTeamRatings, which audits `scrape.ratings.updated` with before and after.
   * 422 `rating_out_of_band` outside MIN_TEAM_RATING..MAX_TEAM_RATING, 404 for an unknown or
   * non-football team.
   */
  app.put<{ Params: { teamId: string } }>(
    '/admin/feed/ratings/:teamId',
    { config: { staff: 'trading.odds' } },
    async (request) => {
      const teamId = parseUuid(request.params.teamId, 'Team');
      const input = parseInput(SetRatingsRequest, request.body);
      for (const [label, value] of [
        ['attack', input.attack],
        ['defence', input.defence],
      ] as const) {
        if (value < MIN_TEAM_RATING || value > MAX_TEAM_RATING) {
          throw unprocessable(
            'rating_out_of_band',
            `${label} must be between ${MIN_TEAM_RATING} and ${MAX_TEAM_RATING} (1 = league average)`,
            { field: label, min: MIN_TEAM_RATING, max: MAX_TEAM_RATING },
          );
        }
      }
      const actor = staffActor(request);
      const result = await inTx(deps, async (tx) => {
        const [team] = await tx
          .select({ id: teams.id, shortName: teams.shortName, sportId: teams.sportId })
          .from(teams)
          .where(eq(teams.id, teamId));
        if (team === undefined || team.sportId !== 'football') throw notFound('Team');
        const current = (await getTeamRatings(tx, [teamId], { forUpdate: true })).get(teamId);
        const was = current?.ratings ?? null;
        const next: Record<string, number> = {
          ...(was ?? {}),
          attack: input.attack,
          defence: input.defence,
          matches: input.matches ?? current?.matches ?? 0,
          manual: 1,
        };
        const unchanged =
          was !== null &&
          Object.keys(next).length === Object.keys(was).length &&
          Object.entries(next).every(([k, v]) => was[k] === v);
        if (!unchanged) await setTeamRatings(tx, teamId, next, actor);
        return { team, next, unchanged };
      });
      return wire(SetRatingsResponse, {
        team: {
          teamId,
          team: result.team.shortName,
          ...ratingFacts(result.next, true),
          upcoming: null,
          nextKickoff: null,
        },
        changed: !result.unchanged,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Aliases.

  app.get('/admin/feed/aliases', { config: { staff: 'trading.view' } }, async (request) => {
    const query = parseInput(AliasListQuery, request.query);
    const rows = await listAliases(deps.db, {
      ...opt('kind', query.kind),
      ...opt('sportId', query.sport),
      ...opt('sourceId', query.sourceId),
      limit: ALIAS_WINDOW,
    });
    const needle = query.q?.toLowerCase();
    const normalizedNeedle = query.q === undefined ? '' : normalizeName(query.q);
    let list = rows.filter(
      (row) =>
        (FEED_SPORTS as readonly string[]).includes(row.sportId) &&
        (needle === undefined ||
          row.aliasNorm.includes(needle) ||
          (normalizedNeedle !== '' && row.aliasNorm.includes(normalizedNeedle))),
    );
    if (query.cursor !== undefined) {
      const at = list.findIndex((row) => row.id === query.cursor);
      list = at < 0 ? [] : list.slice(at + 1);
    }
    const items = list.slice(0, query.limit);
    const nextCursor = list.length > query.limit ? items[items.length - 1]!.id : null;
    return wire(AliasListResponse, { items: items.map(aliasView), nextCursor });
  });

  /**
   * Maps a raw name to a team or competition (idempotent: 200 with
   * `created: false` for the same alias again, 201 for a new one). 404 for an
   * unknown target or source; 409 `alias_conflict` when the name already maps
   * to another target.
   */
  app.post(
    '/admin/feed/aliases',
    { config: { staff: 'trading.status' } },
    async (request, reply) => {
      const input = parseInput(CreateAliasRequest, request.body);
      const actor = staffActor(request);
      const kindLabel = input.kind === 'team' ? 'Team' : 'Competition';
      const targetId = parseUuid(input.targetId, kindLabel);
      const view = await inTx(deps, async (tx) => {
        if (input.sourceId !== undefined && (await getSource(tx, input.sourceId)) === null) {
          throw notFound('Source');
        }
        const alias = {
          sportId: input.sport,
          aliasNorm: normalizeName(input.raw),
          sourceId: input.sourceId ?? null,
        };
        const result =
          input.kind === 'team'
            ? await addTeamAlias(tx, { ...alias, teamId: targetId }, actor)
            : await addCompetitionAlias(tx, { ...alias, competitionId: targetId }, actor);
        return {
          created: result.created,
          alias: aliasView({
            ...result.alias,
            targetLabel: await targetName(tx, input.kind, targetId),
          }),
        };
      }).catch((error: unknown) => {
        throw contractError(error);
      });
      return reply.code(view.created ? 201 : 200).send(wire(CreateAliasResponse, view));
    },
  );

  /**
   * Removes an alias; the id says whether it is a team's or a competition's.
   * 404 for an unknown id. removeAlias audits (`scrape.alias.removed`), so this
   * route does not. Observations are re-resolved by the scraper's next
   * promotion pass; nothing else happens here.
   */
  app.delete<IdParams>(
    '/admin/feed/aliases/:id',
    { config: { staff: 'trading.status' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Alias');
      const actor = staffActor(request);
      const removed = await inTx(deps, async (tx) => {
        for (const kind of ['team', 'competition'] as const) {
          try {
            const record = await removeAlias(tx, kind, id, actor);
            return aliasView({
              ...record,
              targetLabel: await targetName(tx, kind, record.targetId),
            });
          } catch (error) {
            if (!(error instanceof DomainError && error.status === 404)) throw error;
          }
        }
        throw notFound('Alias');
      });
      return wire(RemoveAliasResponse, { removed });
    },
  );

  // -------------------------------------------------------------------------
  // Competition policy.

  app.get('/admin/feed/competitions', { config: { staff: 'trading.view' } }, async () =>
    wire(FeedCompetitionsResponse, {
      items: (await listCompetitionPolicies(deps.db)).map(policyView),
    }),
  );

  /**
   * Changes some flags of a competition's policy. Listed with its strictest
   * permission, `settings.edit`; a request that only turns `enabled`,
   * `autoOpen` or `autoResults` off needs just `trading.status` (the kill
   * switch of a trader), which `competitionPolicyPermission` decides.
   */
  app.put<IdParams>(
    '/admin/feed/competitions/:id',
    { config: { staff: 'settings.edit', staffOr: 'trading.status' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Competition');
      const staff = requireStaff(request);
      let input: UpdateCompetitionPolicyRequest;
      if (hasPermission(staff.role, 'settings.edit')) {
        input = parseInput(UpdateCompetitionPolicyRequest, request.body);
      } else {
        const parsed = UpdateCompetitionPolicyRequest.safeParse(request.body);
        if (!parsed.success || competitionPolicyPermission(parsed.data) !== 'trading.status') {
          throw forbidden('forbidden', 'Your role does not allow this.', {
            permission: 'settings.edit',
          });
        }
        input = parsed.data;
      }
      const actor = staffActor(request);
      const row = await inTx(deps, async (tx) => {
        await setCompetitionPolicy(
          tx,
          id,
          {
            ...opt('enabled', input.enabled),
            ...opt('autoOpen', input.autoOpen),
            ...opt('autoResults', input.autoResults),
            ...opt('extraTime', input.extraTime),
            ...opt('pricingSource', input.pricingSource),
            ...opt('factoryMarkets', input.factoryMarkets),
          },
          actor,
        );
        const rows = await listCompetitionPolicies(tx);
        return rows.find((candidate) => candidate.competitionId === id);
      });
      if (row === undefined) throw notFound('Competition');
      return wire(UpdateCompetitionPolicyResponse, { competition: policyView(row) });
    },
  );
}
