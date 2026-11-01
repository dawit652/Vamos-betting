import {
  AliasListQuery,
  AliasListResponse,
  CreateAliasRequest,
  CreateAliasResponse,
  RemoveAliasResponse,
  FEED_RESOLVE_DECISION_KINDS,
  FEED_SPORTS,
  FeedCompetitionsResponse,
  FeedHealthResponse,
  hasPermission,
  isRepriceItem,
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
import { marketKey, type MarketTypeCode, type SportCode } from '@vamos/core';
import {
  addCompetitionAlias,
  addTeamAlias,
  countReviewItemsByKind,
  DomainError,
  getReviewItem,
  getSource,
  getTeamRatings,
  listAliases,
  listCompetitionPolicies,
  listRecentRuns,
  listReviewItems,
  listSources,
  marketsWithSelections,
  recentAcceptedCounts,
  recordEventPriced,
  removeAlias,
  resolveReviewItem,
  ScrapeAliasConflictError,
  ScrapeReviewStateError,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
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
  MIN_LEAD_MS,
  normalizeName,
  ratingsKey,
  REPRICE_SUBJECT_SUFFIX,
  RESULTS_SLOW_INTERVAL_MS,
  type GateMarket,
} from '@vamos/scraper';
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
export default async function adminFeedRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  // -------------------------------------------------------------------------
  // Health and the kill switch.

  app.get('/admin/feed/health', { config: { staff: 'trading.view' } }, async () => {
    const now = deps.clock();
    const [sources, byKind, policies] = await Promise.all([
      sourceViews(deps.db, now),
      countReviewItemsByKind(deps.db),
      listCompetitionPolicies(deps.db),
    ]);
    return wire(FeedHealthResponse, {
      sources,
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
      return wire(ReviewDetailResponse, { item: reviewView(item) });
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
            const kind = item.kind === 'unknown_team' ? 'team' : 'competition';
            const payload = parseReviewPayload(
              item.kind as 'unknown_team' | 'unknown_competition',
              item.payload,
            );
            if (payload === null) throw badPayload();
            const targetId = parseUuid(input.targetId, kind === 'team' ? 'Team' : 'Competition');
            const sourceId = input.sourceId ?? null;
            if (sourceId !== null && (await getSource(tx, sourceId)) === null) {
              throw notFound('Source');
            }
            const alias = {
              sportId: payload.sport,
              aliasNorm: normalizeName(payload.raw),
              sourceId,
            };
            if (kind === 'team') await addTeamAlias(tx, { ...alias, teamId: targetId }, actor);
            else await addCompetitionAlias(tx, { ...alias, competitionId: targetId }, actor);
            resolution = { decision: 'map_alias', targetId, sourceId, by: actor.adminId };
            break;
          }
          case 'open_betting': {
            const payload = parseReviewPayload('odds_approval', item.payload);
            if (payload === null) throw badPayload();
            const event = await lockEvent(tx, payload.eventId);
            const refusal = eventRefusal(event);
            if (refusal !== null) throw refusal;
            if (event!.startTime.getTime() < now.getTime() + MIN_LEAD_MS) {
              throw unprocessable(
                'kickoff_too_close',
                'The event starts too soon to open betting by hand',
              );
            }
            if (event!.bettingOpen) {
              throw unprocessable('betting_already_open', 'Betting is already open on the event');
            }
            // The item was raised when both checks passed; ratings and prices may have changed
            // since, so they are checked again at the moment a person opens betting (O1, O2).
            await assertScrapedEventMayOpen(tx, event!.id, deps.config.scraper.minRatingMatches);
            const change = await setEventBettingOpen(tx, event!.id, true, actor);
            messages.push(...change.messages);
            resolution = { decision: 'open_betting', eventId: event!.id, by: actor.adminId };
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
            const currentKey = ratingsKey(
              rated.get(event!.homeTeamId)?.ratings,
              rated.get(event!.awayTeamId)?.ratings,
            );
            if (currentKey !== payload.ratingsKey) {
              throw conflict(
                'proposal_stale',
                'The team ratings changed since this proposal was made',
                { id },
              );
            }
            // Only prices change: the markets the upsert may touch must be exactly those of the
            // proposal and the book must pass the sanity rules; the size of the move is what the
            // trader is approving (O3), so it is not checked again.
            const stored = await marketsWithSelections(tx, event!.id);
            const updatable = stored.filter((m) => m.status === 'open' || m.status === 'suspended');
            const frozen = new Set(stored.filter((m) => !updatable.includes(m)).map((m) => m.key));
            const proposal: GateMarket[] = payload.proposal.map((m) => ({
              type: m.type as MarketTypeCode,
              line: m.line,
              selections: m.selections,
            }));
            const next = proposal.filter((m) => {
              try {
                return !frozen.has(marketKey(m.type, m.line));
              } catch {
                return true; // checkReprice names it
              }
            });
            const check = checkReprice(
              updatable.map((m) => ({
                type: m.type as MarketTypeCode,
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
