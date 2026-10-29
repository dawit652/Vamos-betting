import { SCRAPER_ACTOR } from '@vamos/core';
import {
  getEventExposure,
  getTeamRatings,
  listCompetitionPolicies,
  listCurrentObservations,
  listObservationHistory,
  listReviewItems,
  listScrapedEvents,
  lockEvent,
  markRatingApplied,
  markRawKeep,
  openReviewItem,
  closeReviewItemsBySubject,
  resultEvent,
  setTeamRatings,
  type DbTransaction,
  type ScrapedEvent,
  type ScrapeReviewItem,
} from '@vamos/db';
import { updateFootballRatings } from '@vamos/feed';
import {
  clusterObservations,
  decideResult,
  DAY_MS,
  KICKOFF_TOLERANCE_MS,
  MIN_MATCH_DURATION_MS,
  MINUTE_MS,
  matchEvent,
  reviewsOf,
  scoreContradicts,
  type CompetitionPolicy,
  type GateReview,
  type ResolvedObservation,
  type ResultObservation,
  type Score,
} from '@vamos/scraper';
import { auditLog, events as eventsTable, scrapeObservations, scrapeRaw } from '@vamos/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { ScraperContext } from '../context';
import { publishAfterCommit } from '../lib/publish';
import { auditScraper, openGateReviews, toResolved } from './common';

export interface PromoteResultsSummary {
  events: number;
  applied: number;
  held: number;
  failed: number;
  published: number;
}

/** Scheduled events are looked at from this far back; a late result still needs a person after that. */
const RESULT_LOOK_BACK_MS = 14 * DAY_MS;

type ResultObs = ResolvedObservation<ResultObservation>;

/** The current result observations of each scraped event (rule F3 matching, as for fixtures). */
async function resultObservationsByEvent(
  ctx: ScraperContext,
  events: readonly ScrapedEvent[],
  now: Date,
): Promise<Map<string, ResultObs[]>> {
  const out = new Map<string, ResultObs[]>();
  if (events.length === 0) return out;
  const policyRows = await listCompetitionPolicies(ctx.db, { sportId: 'football' });
  const slugs = new Map(policyRows.map((row) => [row.competitionId, row.slug]));
  const from = Math.min(...events.map((e) => e.startTime.getTime()));
  const rows = await listCurrentObservations(ctx.db, {
    kind: 'result',
    resolvedOnly: true,
    kickoffFrom: new Date(from - 2 * DAY_MS),
    kickoffTo: new Date(now.getTime() + DAY_MS),
    limit: 20_000,
  });
  const observations = rows.flatMap((row) => {
    const resolved = toResolved(row, slugs);
    return resolved !== null && resolved.obs.kind === 'result' ? [resolved as ResultObs] : [];
  });
  for (const cluster of clusterObservations(observations)) {
    const match = matchEvent(cluster, events);
    // Not found or ambiguous: nothing is decided from it (F3).
    if (match.kind !== 'existing') continue;
    const list = out.get(match.event.eventId) ?? [];
    list.push(...cluster.items);
    out.set(match.event.eventId, list);
  }
  return out;
}

/** Events a result decision applies to: scheduled and unresulted, or finished (R8 corrections). */
function decidable(event: ScrapedEvent): boolean {
  return (event.status === 'scheduled' && event.resultedAt === null) || event.status === 'finished';
}

async function listResultEvents(ctx: ScraperContext, now: Date): Promise<ScrapedEvent[]> {
  return listScrapedEvents(ctx.db, {
    from: new Date(now.getTime() - RESULT_LOOK_BACK_MS),
    to: now,
    includeFinished: true,
  });
}

/**
 * Promotes results (rules R1 to R11): for every scraped event that can still
 * be resulted (or was, for corrections), gather the current result
 * observations of its fixture and apply what `decideResult` returns. Only a
 * confirmed `finished` regular-time score is ever applied; no code path here
 * cancels, voids or abandons an event.
 */
export async function promoteResults(ctx: ScraperContext): Promise<PromoteResultsSummary> {
  const now = ctx.clock();
  const summary: PromoteResultsSummary = {
    events: 0,
    applied: 0,
    held: 0,
    failed: 0,
    published: 0,
  };
  const all = await listResultEvents(ctx, now);
  const candidates = all.filter(decidable);
  if (candidates.length === 0) return summary;
  const byEvent = await resultObservationsByEvent(ctx, all, now);
  const policyRows = await listCompetitionPolicies(ctx.db, { sportId: 'football' });
  const policies = new Map<string, CompetitionPolicy>(
    policyRows.map((row) => [
      row.competitionId,
      {
        competitionId: row.competitionId,
        enabled: row.enabled,
        autoOpen: row.autoOpen,
        autoResults: row.autoResults,
        extraTime: row.extraTime,
      },
    ]),
  );
  const confirmMs = ctx.config.scraper.resultConfirmMinutes * MINUTE_MS;

  for (const event of candidates) {
    const observations = byEvent.get(event.eventId);
    const policy = policies.get(event.competitionId);
    if (observations === undefined || policy === undefined) continue;
    summary.events += 1;
    try {
      const exposure = await getEventExposure(ctx.db, event.eventId);
      const decision = decideResult({
        event,
        observations,
        policy,
        now,
        confirmMs,
        exposure: { openBets: exposure.openBets, totalStake: BigInt(exposure.totalStake) },
      });
      if (decision.action === 'apply') {
        const done = await applyConfirmedResult(ctx, {
          eventId: decision.eventId,
          feedRef: decision.feedRef,
          score: decision.score,
          upstreams: [...decision.upstreams],
          sources: [...decision.sources],
          observations,
          via: 'auto',
        });
        if (done.applied) summary.applied += 1;
        summary.published += done.published;
      } else if (decision.action === 'hold') {
        await ctx.db.transaction((tx) =>
          openResultReviews(tx, reviewsOf(decision), observations, now),
        );
        summary.held += 1;
      }
    } catch (error) {
      summary.failed += 1;
      ctx.logger.error({ err: error, eventId: event.eventId }, 'result promotion failed');
    }
  }
  ctx.logger[summary.applied + summary.held > 0 ? 'info' : 'debug'](
    { ...summary },
    'result promotion run',
  );
  return summary;
}

const sameScore = (a: Score, b: Score): boolean =>
  a.home === b.home && a.away === b.away && a.htHome === b.htHome && a.htAway === b.htAway;

export interface ApplyConfirmedInput {
  eventId: string;
  feedRef: string;
  score: Score;
  upstreams: string[];
  sources: string[];
  /** The current result observations of the fixture; the agreeing ones are kept as evidence. */
  observations: readonly ResultObs[];
  via: 'auto' | 'staff';
  reviewItemId?: string;
}

/**
 * Applies a confirmed regular-time score: ONE transaction with the event row
 * locked. Re-checks the event is still scheduled and unresulted (so running
 * twice changes nothing), results it, updates both teams' ratings once
 * (scrape_rating_applied), marks the raw snapshots behind the agreeing
 * observations as evidence, closes the result items about the event and
 * audits. The deltas are published after COMMIT.
 */
export async function applyConfirmedResult(
  ctx: ScraperContext,
  input: ApplyConfirmedInput,
): Promise<{ applied: boolean; published: number }> {
  const now = ctx.clock();
  const outcome = await ctx.db.transaction(async (tx) => {
    const locked = await lockEvent(tx, input.eventId);
    const [event] = await tx
      .select({
        resultedAt: eventsTable.resultedAt,
        homeTeamId: eventsTable.homeTeamId,
        awayTeamId: eventsTable.awayTeamId,
      })
      .from(eventsTable)
      .where(eq(eventsTable.id, input.eventId));
    if (event === undefined || locked.status !== 'scheduled' || event.resultedAt !== null) {
      return null;
    }
    const resulted = await resultEvent(tx, input.eventId, {
      status: 'finished',
      score: {
        home: input.score.home,
        away: input.score.away,
        ...(input.score.htHome === null || input.score.htAway === null
          ? {}
          : { htHome: input.score.htHome, htAway: input.score.htAway }),
      },
    });
    if (resulted.outcome !== 'resulted') return null;

    let ratingsUpdated = false;
    if (await markRatingApplied(tx, input.feedRef)) {
      const ratings = await getTeamRatings(tx, [event.homeTeamId, event.awayTeamId], {
        forUpdate: true,
      });
      const next = updateFootballRatings(
        ratings.get(event.homeTeamId)?.ratings ?? null,
        ratings.get(event.awayTeamId)?.ratings ?? null,
        { home: input.score.home, away: input.score.away },
      );
      await setTeamRatings(tx, event.homeTeamId, next.home, { system: SCRAPER_ACTOR });
      await setTeamRatings(tx, event.awayTeamId, next.away, { system: SCRAPER_ACTOR });
      ratingsUpdated = true;
    }

    const hashes = await evidenceHashes(tx, input.observations, input.score);
    await markRawKeep(tx, hashes);
    await closeReviewItemsBySubject(tx, input.feedRef, {
      kinds: ['result_ready', 'result_unverified'],
      resolution: 'the result was applied',
      now,
    });
    await auditScraper(tx, {
      action: 'scrape.result.applied',
      targetType: 'event',
      targetId: input.eventId,
      metadata: {
        feedRef: input.feedRef,
        via: input.via,
        reviewItemId: input.reviewItemId ?? null,
        score: input.score,
        sources: input.sources,
        upstreams: input.upstreams,
        evidenceHashes: hashes,
        ratingsUpdated,
        marketsSettled: resulted.marketsSettled,
      },
    });
    return resulted.messages;
  });
  if (outcome === null) return { applied: false, published: 0 };
  const published = await publishAfterCommit(ctx.redis, outcome, ctx.channel, ctx.logger);
  return { applied: true, published };
}

/** Content hashes of every snapshot behind the agreeing finished observations (their whole history). */
async function evidenceHashes(
  tx: DbTransaction,
  observations: readonly ResultObs[],
  score: Score,
): Promise<string[]> {
  return snapshotHashes(
    tx,
    observations.filter(
      (o) =>
        o.obs.status === 'finished' &&
        o.obs.scoreBasis === 'regular_time' &&
        o.obs.score !== null &&
        o.obs.score.home === score.home &&
        o.obs.score.away === score.away,
    ),
    (history) => history.status === 'finished',
  );
}

/**
 * Content hashes of the snapshots behind these observations: the page each one
 * currently stands on, and the pages of the history rows `inHistory` accepts.
 */
async function snapshotHashes(
  tx: DbTransaction,
  observations: readonly ResultObs[],
  inHistory: (history: { status: string }) => boolean,
): Promise<string[]> {
  const rawIds = new Set<string>();
  for (const o of observations) {
    if (o.obs.externalRef === null) continue;
    const [row] = await tx
      .select({ id: scrapeObservations.id, rawId: scrapeObservations.rawId })
      .from(scrapeObservations)
      .where(
        and(
          eq(scrapeObservations.sourceId, o.obs.sourceId),
          eq(scrapeObservations.kind, 'result'),
          eq(scrapeObservations.sourceKey, o.obs.externalRef),
        ),
      );
    if (row === undefined) continue;
    if (row.rawId !== null) rawIds.add(row.rawId);
    for (const h of await listObservationHistory(tx, row.id)) {
      if (inHistory(h) && h.rawId !== null) rawIds.add(h.rawId);
    }
  }
  if (rawIds.size === 0) return [];
  const rows = await tx
    .select({ hash: scrapeRaw.contentHash })
    .from(scrapeRaw)
    .where(inArray(scrapeRaw.id, [...rawIds]));
  return [...new Set(rows.map((r) => r.hash))].sort();
}

/** The review kinds that dispute a result; the pages behind them are evidence for the person who decides. */
const DISPUTE_KINDS: ReadonlySet<string> = new Set([
  'result_conflict',
  'result_correction',
  'result_unverified',
]);

/**
 * Opens (or refreshes) the items of a result hold and, when one of them is a
 * dispute (`result_conflict`, `result_correction`, `result_unverified`), marks
 * the raw snapshots of every current result observation of the fixture, and of
 * their history, as kept, in the same transaction. Without this the pages a
 * person needs to judge the dispute would be pruned after the retention period
 * (30 days) while the item may still be open. Same mechanism as the applied
 * path: `markRawKeep` by content hash.
 */
async function openResultReviews(
  tx: DbTransaction,
  reviews: readonly GateReview[],
  observations: readonly ResultObs[],
  now: Date,
): Promise<void> {
  await openGateReviews(tx, reviews, now);
  if (!reviews.some((review) => DISPUTE_KINDS.has(review.kind))) return;
  await markRawKeep(tx, await snapshotHashes(tx, observations, () => true));
}

// ---------------------------------------------------------------------------
// Staff confirmations

/** What a staff resolution said: JSON `{"decision": ...}`, or the bare decision text. */
export function decisionOf(resolution: string | null): string | null {
  if (resolution === null) return null;
  const text = resolution.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { decision?: unknown };
      return typeof parsed.decision === 'string' ? parsed.decision : null;
    } catch {
      return null;
    }
  }
  return text === 'apply_result' || text.startsWith('apply_result:') ? 'apply_result' : null;
}

function scoreOfPayload(payload: Record<string, unknown>): Score | null {
  const s = payload.score;
  if (typeof s !== 'object' || s === null) return null;
  const { home, away, htHome, htAway } = s as Record<string, unknown>;
  const isGoals = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const ht = (v: unknown): number | null | undefined =>
    v === null || v === undefined ? null : isGoals(v) ? v : undefined;
  const h = ht(htHome);
  const a = ht(htAway);
  if (!isGoals(home) || !isGoals(away) || h === undefined || a === undefined) return null;
  if ((h === null) !== (a === null)) return null;
  return { home, away, htHome: h, htAway: a };
}

const STAFF_LOOK_BACK_MS = DAY_MS;
const STAFF_KINDS = ['result_ready', 'result_unverified'] as const;

/**
 * Applies the results staff confirmed. A person resolves a `result_ready` /
 * `result_unverified` item with the decision `apply_result`; it carries no
 * score, so the score applied is the one the item proposed, and only if it
 * still holds: the event is scheduled and unresulted, the match could have
 * ended (R1), every current observation has the event's kickoff (R1), the
 * proposal has a half time when the event needs one (R2), a current regular-time
 * `finished` observation of an enabled source shows exactly that score, and no
 * current observation disagrees: full time, and half time when the event needs
 * it (R3), or a void status (R7). Anything else leaves the event untouched and opens a fresh review item
 * of the same kind saying why. Idempotent: an event that already has the
 * proposed score is left alone. A rejected confirmation is final: the item is
 * never replayed, whatever happens to the item reopened in its place.
 */
export async function applyStaffConfirmations(ctx: ScraperContext): Promise<{
  applied: number;
  rejected: number;
}> {
  const now = ctx.clock();
  const result = { applied: 0, rejected: 0 };
  let events: ScrapedEvent[] | null = null;
  for (const kind of STAFF_KINDS) {
    const items = await recentlyResolved(ctx, kind, now);
    const rejected = await rejectedConfirmations(ctx, items);
    for (const item of items) {
      if (item.status !== 'resolved' || decisionOf(item.resolution) !== 'apply_result') continue;
      if (
        item.resolvedAt === null ||
        now.getTime() - item.resolvedAt.getTime() > STAFF_LOOK_BACK_MS
      ) {
        continue;
      }
      if (items.some((other) => other.payload.reopenedFor === item.id)) continue;
      // A rejection is final (review finding 3): the reopened item's payload is replaced by
      // each gate pass, so the audit row, which nothing overwrites, is what remembers it.
      if (rejected.has(item.id)) continue;
      events ??= await listScrapedEvents(ctx.db, {
        from: new Date(now.getTime() - 60 * DAY_MS),
        to: new Date(now.getTime() + DAY_MS),
        includeFinished: true,
      });
      try {
        const verdict = await confirmOne(ctx, item, events, now);
        if (verdict === 'applied') result.applied += 1;
        else if (verdict !== 'noop') {
          result.rejected += 1;
          await rejectConfirmation(ctx, item, verdict.reason, now);
        }
      } catch (error) {
        ctx.logger.error({ err: error, itemId: item.id }, 'staff confirmation failed');
      }
    }
  }
  return result;
}

const STAFF_PAGE = 200;

/**
 * Every item of `kind` resolved within the look-back window (review finding 9),
 * newest first. The query is bounded by resolution time, not by a count, and
 * paged until exhausted, so a burst of newer items never hides an older
 * confirmation that is still inside the window.
 */
async function recentlyResolved(
  ctx: ScraperContext,
  kind: (typeof STAFF_KINDS)[number],
  now: Date,
): Promise<ScrapeReviewItem[]> {
  const resolvedSince = new Date(now.getTime() - STAFF_LOOK_BACK_MS);
  const all: ScrapeReviewItem[] = [];
  for (;;) {
    const last = all.at(-1);
    const page = await listReviewItems(ctx.db, {
      kind,
      status: 'resolved',
      resolvedSince,
      limit: STAFF_PAGE,
      ...(last === undefined ? {} : { after: { createdAt: last.createdAt, id: last.id } }),
    });
    all.push(...page);
    if (page.length < STAFF_PAGE) return all;
  }
}

/** The ids among `items` whose confirmation was rejected before (audit `scrape.result.confirmation_rejected`). */
async function rejectedConfirmations(
  ctx: ScraperContext,
  items: readonly ScrapeReviewItem[],
): Promise<Set<string>> {
  const ids = items.filter((i) => i.status === 'resolved').map((i) => i.id);
  if (ids.length === 0) return new Set();
  const rows = await ctx.db
    .select({ id: auditLog.targetId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'scrape.result.confirmation_rejected'),
        eq(auditLog.targetType, 'scrape_review_item'),
        inArray(auditLog.targetId, ids),
      ),
    );
  return new Set(rows.flatMap((r) => (r.id === null ? [] : [r.id])));
}

async function confirmOne(
  ctx: ScraperContext,
  item: ScrapeReviewItem,
  events: readonly ScrapedEvent[],
  now: Date,
): Promise<'applied' | 'noop' | { reason: string }> {
  const proposed = scoreOfPayload(item.payload);
  const eventId = item.payload.eventId;
  if (proposed === null || typeof eventId !== 'string') {
    return { reason: 'the item carries no usable proposed score or event' };
  }
  const event = events.find((e) => e.eventId === eventId);
  if (event === undefined) return { reason: 'the event is not among the recent scraped events' };
  if (event.status === 'finished' && event.score !== null && sameScore(event.score, proposed)) {
    return 'noop';
  }
  if (event.status !== 'scheduled' || event.resultedAt !== null) {
    return { reason: `the event is no longer open for a result (status ${event.status})` };
  }
  if (now.getTime() < event.startTime.getTime() + MIN_MATCH_DURATION_MS) {
    return { reason: 'the match cannot have ended yet (R1)' };
  }
  // R2: an event with a half-time market is settled with a half time, or not at all.
  if (event.needsHalfTimeScore && (proposed.htHome === null || proposed.htAway === null)) {
    return { reason: 'the event needs a half-time score and the proposal has none (R2)' };
  }
  const observations = (await resultObservationsByEvent(ctx, events, now)).get(eventId) ?? [];
  // R3: any current observation that is not a `finished` one, or whose score contradicts the
  // proposal (full time, and half time when the event needs it), blocks it.
  const hardDissent = observations.filter(
    (o) =>
      o.obs.status !== 'finished' ||
      o.obs.score === null ||
      scoreContradicts(proposed, o.obs.score, event.needsHalfTimeScore),
  );
  if (hardDissent.length > 0) {
    return {
      reason: `a current observation disagrees (${hardDissent
        .map((o) => `${o.obs.sourceId}: ${o.obs.status}`)
        .join(', ')})`,
    };
  }
  // R1: an observation of another kickoff is a pending reschedule or the wrong match.
  const startMs = event.startTime.getTime();
  const mismatched = observations.filter(
    (o) => Math.abs(o.obs.kickoff.getTime() - startMs) > KICKOFF_TOLERANCE_MS,
  );
  if (mismatched.length > 0) {
    return {
      reason: `a current observation has another kickoff than the event (${mismatched
        .map((o) => o.obs.sourceId)
        .join(', ')}) (R1)`,
    };
  }
  const supporting = observations.filter(
    (o) =>
      o.obs.status === 'finished' &&
      o.obs.scoreBasis === 'regular_time' &&
      o.obs.score !== null &&
      o.obs.score.home === proposed.home &&
      o.obs.score.away === proposed.away &&
      (proposed.htHome === null ||
        (o.obs.score.htHome === proposed.htHome && o.obs.score.htAway === proposed.htAway)),
  );
  if (supporting.length === 0) {
    return { reason: 'no current regular-time observation of an enabled source shows that score' };
  }
  try {
    const done = await applyConfirmedResult(ctx, {
      eventId,
      feedRef: event.feedRef,
      score: proposed,
      upstreams: [...new Set(supporting.map((o) => o.upstream))].sort(),
      sources: [...new Set(supporting.map((o) => o.obs.sourceId))].sort(),
      observations,
      via: 'staff',
      reviewItemId: item.id,
    });
    return done.applied ? 'applied' : { reason: 'the event changed while the result was applied' };
  } catch (error) {
    return {
      reason: `the result was refused: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function rejectConfirmation(
  ctx: ScraperContext,
  item: ScrapeReviewItem,
  reason: string,
  now: Date,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await openReviewItem(tx, {
      kind: item.kind,
      subjectKey: item.subjectKey,
      severity: 'warning',
      title: 'A confirmed result could not be applied',
      payload: { ...item.payload, reopenedFor: item.id, rejectedBecause: reason },
      now,
    });
    await auditScraper(tx, {
      action: 'scrape.result.confirmation_rejected',
      targetType: 'scrape_review_item',
      targetId: item.id,
      metadata: { reason, subjectKey: item.subjectKey },
    });
  });
}
