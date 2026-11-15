import {
  closePriceEvents,
  listClosePrices,
  listCompetitionPolicies,
  listLadderShadow,
  listMarketFamilyMoves,
  listScrapedEvents,
  marketFamilyReviewExists,
  reviewQueueSummary,
  type Database,
  type ScrapedEvent,
} from '@vamos/db';
import { auditLog, markets, selections } from '@vamos/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { collectResultsAudit } from './audit-data';
import { shadowLabel, shadowOutcome, summariseShadow } from './ladder-shadow';
import { median, summariseAudit } from './result-audit';
import { computeScorecard } from './scorecard';
import { runTruthCheck, seasonStart } from './truth-check';
import type { WeeklyInputs, WeekWindow } from './weekly-report';

const HOUR_MS = 3_600_000;
const AUDIT_AFTER_MS = 48 * HOUR_MS;
const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);
const CHUNK = 500;

/** Event ids whose result the result gate applied (a `scrape.result.applied` audit row), read in chunks. */
async function appliedByGate(db: Database, eventIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const rows = await db
      .selectDistinct({ id: auditLog.targetId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'scrape.result.applied'),
          eq(auditLog.targetType, 'event'),
          inArray(auditLog.targetId, eventIds.slice(i, i + CHUNK)),
        ),
      );
    for (const row of rows) if (row.id !== null) found.add(row.id);
  }
  return found;
}

/** Selections (options) per event, for events that have markets. */
async function optionsPerEvent(db: Database, eventIds: readonly string[]): Promise<number[]> {
  const counts: number[] = [];
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const rows = await db
      .select({ n: sql<number>`count(${selections.id})::int` })
      .from(markets)
      .innerJoin(selections, eq(selections.marketId, markets.id))
      .where(inArray(markets.eventId, eventIds.slice(i, i + CHUNK)))
      .groupBy(markets.eventId);
    counts.push(...rows.map((r) => r.n));
  }
  return counts;
}

/** Settled by kickoff + 48 h (finished and resulted in time) or void (cancelled, abandoned, postponed). */
function settledOrVoidBy48h(event: ScrapedEvent): boolean {
  if (VOID_STATUSES.has(event.status)) return true;
  return (
    event.status === 'finished' &&
    event.resultedAt !== null &&
    event.resultedAt.getTime() <= event.startTime.getTime() + AUDIT_AFTER_MS
  );
}

/**
 * Reads the numbers of section 8 for one week from the database, with the queries the commands use
 * (`review results-audit`, `eval scorecard`, `review counts`, `sources truth-check`,
 * `review ladder-shadow`). Read-only: the truth-check is run without `--write`.
 */
export async function gatherWeeklyInputs(
  db: Database,
  week: WeekWindow,
  now: Date,
): Promise<WeeklyInputs> {
  const lastMs = week.to.getTime() - 1;
  const policies = await listCompetitionPolicies(db, { sportId: 'football' });
  const football = new Set(policies.map((p) => p.competitionId));
  const factory = new Set(policies.filter((p) => p.factoryMarkets).map((p) => p.competitionId));

  const weekEvents = (
    await listScrapedEvents(db, { from: week.from, to: new Date(lastMs), includeFinished: true })
  ).filter((e) => football.has(e.competitionId));
  const listed = weekEvents.filter((e) => !VOID_STATUSES.has(e.status));

  const finished = weekEvents.filter((e) => e.status === 'finished' && e.score !== null);
  const byGate = await appliedByGate(
    db,
    finished.map((e) => e.eventId),
  );
  const due = weekEvents.filter((e) => e.startTime.getTime() + AUDIT_AFTER_MS <= now.getTime());

  const factoryEvents = weekEvents.filter((e) => factory.has(e.competitionId));
  const optionCounts =
    factoryEvents.length === 0
      ? []
      : await optionsPerEvent(
          db,
          factoryEvents.map((e) => e.eventId),
        );

  const reviewOpen = (await reviewQueueSummary(db, 'open')).reduce((sum, k) => sum + k.count, 0);

  const auditTo = new Date(Math.min(lastMs, now.getTime() - AUDIT_AFTER_MS));
  const audit = summariseAudit(
    auditTo < week.from ? [] : await collectResultsAudit(db, { from: week.from, to: auditTo }),
  ).overall;

  const closeRows = await listClosePrices(db, { from: week.from, to: week.to });
  const scored = computeScorecard(
    closeRows,
    await closePriceEvents(db, [...new Set(closeRows.map((r) => r.eventId))]),
  ).overall;

  const trust = (
    await runTruthCheck(db, { sport: 'football', since: seasonStart(now), now, write: false })
  ).map((r) => ({ upstream: r.upstream, compared: r.compared, agreed: r.agreed, trust: r.trust }));

  const shadow = summariseShadow(
    (await listLadderShadow(db, { since: week.from }))
      .filter((e) => e.firstDecidedAt < week.to)
      .map((e) => ({ label: shadowLabel(e), outcome: shadowOutcome(e) })),
  );

  // Plan task 2.5: the weekly market family job's moves for the week.
  const familyRan = await marketFamilyReviewExists(db, week.id);
  const familyMoves = familyRan
    ? (await listMarketFamilyMoves(db, week.id)).map((m) => ({
        family: m.family,
        move: m.move,
        marginBps: m.marginBps,
        raisedMarginBps: m.raisedMarginBps,
        reason: m.reason,
      }))
    : [];

  return {
    week,
    generatedAt: now,
    catalogue: {
      competitionsWithMatches: new Set(listed.map((e) => e.competitionId)).size,
      matchesListed: listed.length,
    },
    options: {
      factoryCompetitions: factory.size,
      matches: optionCounts.length,
      typicalPerMatch: median(optionCounts),
    },
    reviewOpen,
    settlement: {
      finished: finished.length,
      onRungA: finished.filter((e) => byGate.has(e.eventId)).length,
      due48h: due.length,
      settledOrVoid48h: due.filter(settledOrVoidBy48h).length,
    },
    audit: {
      count: audit.count,
      mismatches: audit.mismatches,
      medianLatencyMinutes: audit.medianLatencyMinutes,
    },
    scorecard: {
      events: scored.sample.events,
      oneXTwoPinnacleN: scored.oneXTwo.withPinnacle.n,
      relLogLossVsPinnacle: scored.oneXTwo.withPinnacle.relLogLossVsPinnacle,
      bestPriceN: scored.prices.bestPrice.n,
      bestPriceShareAbove: scored.prices.bestPrice.shareAbove,
    },
    trust,
    shadow,
    familyMoves: { ran: familyRan, moves: familyMoves },
  };
}
