import { createHash } from 'node:crypto';
import {
  SCRAPE_FIXTURE_STATUSES,
  SCRAPE_RESULT_STATUSES,
  SCRAPE_SCORE_BASES,
  type ScrapeScoreBasis,
} from '@vamos/core';
import { and, asc, eq, gte, inArray, isNotNull, lt, or, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import {
  scrapeObservationHistory,
  scrapeObservations,
  scrapeSources,
  type ScrapeScoreJson,
} from '../schema/scrape';
import { clampLimit } from './common';

export type ObservationKind = 'fixture' | 'result';

/** A score as an observation carries it (structurally Score in @vamos/scraper). */
export type ObservationScore = ScrapeScoreJson;

export interface UpsertObservationInput {
  sourceId: string;
  kind: ObservationKind;
  /** The caller's stable key for the match within this source. */
  sourceKey: string;
  sport: string;
  competitionRaw: string;
  homeRaw: string;
  awayRaw: string;
  kickoff: Date;
  status: string;
  round?: string | null;
  /** Present exactly when kind is 'result' and status 'finished'. */
  score?: ObservationScore | null;
  /** Required for results, absent for fixtures. */
  scoreBasis?: ScrapeScoreBasis | null;
  /** When the source was read (the run's clock). */
  observedAt: Date;
  runId: string;
  rawId?: string | null;
  /** Resolved catalogue ids, when already known. */
  competitionId?: string | null;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
}

export interface UpsertObservationResult {
  /** true for a new key or a changed payload (a history row was appended). */
  changed: boolean;
  /** true for a new key. */
  created: boolean;
  id: string;
  firstSeenAt: Date;
  changedAt: Date;
  lastSeenAt: Date;
  payloadHash: string;
}

export interface ScrapeObservationRow {
  id: string;
  sourceId: string;
  /** scrape_sources.upstream: sources sharing it are one vote. */
  upstream: string;
  kind: ObservationKind;
  sourceKey: string;
  sport: string;
  competitionRaw: string;
  homeRaw: string;
  awayRaw: string;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  kickoff: Date;
  status: string;
  round: string | null;
  score: ObservationScore | null;
  scoreBasis: ScrapeScoreBasis | null;
  payloadHash: string;
  firstSeenAt: Date;
  changedAt: Date;
  lastSeenAt: Date;
  runId: string;
  rawId: string | null;
}

/** The canonical SHA-256 of what a source claimed (not its resolved ids, not when it was read). */
export function observationPayloadHash(
  input: Pick<
    UpsertObservationInput,
    | 'kind'
    | 'sport'
    | 'competitionRaw'
    | 'homeRaw'
    | 'awayRaw'
    | 'kickoff'
    | 'status'
    | 'round'
    | 'score'
    | 'scoreBasis'
  >,
): string {
  const score = input.score ?? null;
  const canonical = JSON.stringify([
    input.kind,
    input.sport,
    input.competitionRaw,
    input.homeRaw,
    input.awayRaw,
    input.kickoff.toISOString(),
    input.status,
    input.round ?? null,
    score === null ? null : [score.home, score.away, score.htHome, score.htAway],
    input.scoreBasis ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function assertConsistent(input: UpsertObservationInput): void {
  const statuses: readonly string[] =
    input.kind === 'fixture' ? SCRAPE_FIXTURE_STATUSES : SCRAPE_RESULT_STATUSES;
  if (!statuses.includes(input.status)) {
    throw new RangeError(`status "${input.status}" is not valid for a ${input.kind}`);
  }
  if (Number.isNaN(input.kickoff.getTime()) || Number.isNaN(input.observedAt.getTime())) {
    throw new RangeError('kickoff and observedAt must be valid dates');
  }
  const finished = input.kind === 'result' && input.status === 'finished';
  if (finished !== (input.score !== null && input.score !== undefined)) {
    throw new RangeError('a finished result has a score and anything else has none');
  }
  if (input.kind === 'result') {
    if (
      input.scoreBasis === null ||
      input.scoreBasis === undefined ||
      !SCRAPE_SCORE_BASES.includes(input.scoreBasis)
    ) {
      throw new RangeError('a result needs a score basis');
    }
  } else if (input.scoreBasis !== null && input.scoreBasis !== undefined) {
    throw new RangeError('a fixture has no score basis');
  }
  const points =
    input.score === null || input.score === undefined
      ? []
      : [
          input.score.home,
          input.score.away,
          ...[input.score.htHome, input.score.htAway].filter((v): v is number => v !== null),
        ];
  if (points.some((p) => !Number.isInteger(p) || p < 0 || p > 99)) {
    throw new RangeError('scores are whole numbers from 0 to 99');
  }
}

/**
 * Stores what a source said about a match. The current row is keyed by
 * (source, kind, source_key):
 *   - new key            → inserted, history row appended, changed = true;
 *   - changed payload    → current row updated (changed_at = observedAt), history row
 *                          appended in the same transaction, changed = true;
 *   - identical payload  → only last_seen_at, run_id and raw_id move; changed = false;
 *   - older than the row → ignored (a late, out-of-order read never rewinds a claim).
 * Concurrency: the insert is ON CONFLICT DO NOTHING and an existing row is
 * read FOR UPDATE, so two concurrent upserts of one key serialise on the row
 * and the history stays one row per distinct payload, in commit order.
 * Resolved ids given in the input are kept when the names did not change;
 * when a name did change and the input carries no ids, resolution is cleared
 * (the new names have to resolve again).
 */
export async function upsertObservation(
  tx: DbTransaction,
  input: UpsertObservationInput,
): Promise<UpsertObservationResult> {
  assertConsistent(input);
  const payloadHash = observationPayloadHash(input);
  const payload = {
    sport: input.sport,
    competitionRaw: input.competitionRaw,
    homeRaw: input.homeRaw,
    awayRaw: input.awayRaw,
    kickoff: input.kickoff,
    status: input.status,
    round: input.round ?? null,
    score: input.score ?? null,
    scoreBasis: input.scoreBasis ?? null,
    payloadHash,
  };
  const appendHistory = (id: string) =>
    tx.insert(scrapeObservationHistory).values({
      observationId: id,
      sourceId: input.sourceId,
      kind: input.kind,
      sourceKey: input.sourceKey,
      ...payload,
      seenAt: input.observedAt,
      runId: input.runId,
      rawId: input.rawId ?? null,
    });

  const [inserted] = await tx
    .insert(scrapeObservations)
    .values({
      sourceId: input.sourceId,
      kind: input.kind,
      sourceKey: input.sourceKey,
      ...payload,
      competitionId: input.competitionId ?? null,
      homeTeamId: input.homeTeamId ?? null,
      awayTeamId: input.awayTeamId ?? null,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      changedAt: input.observedAt,
      runId: input.runId,
      rawId: input.rawId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: scrapeObservations.id });
  if (inserted !== undefined) {
    await appendHistory(inserted.id);
    return {
      changed: true,
      created: true,
      id: inserted.id,
      firstSeenAt: input.observedAt,
      changedAt: input.observedAt,
      lastSeenAt: input.observedAt,
      payloadHash,
    };
  }

  const [current] = await tx
    .select()
    .from(scrapeObservations)
    .where(
      and(
        eq(scrapeObservations.sourceId, input.sourceId),
        eq(scrapeObservations.kind, input.kind),
        eq(scrapeObservations.sourceKey, input.sourceKey),
      ),
    )
    .for('update');
  if (current === undefined) {
    // Only possible if the row was deleted between the two statements: fail closed.
    throw new Error('scrape observation vanished during upsert');
  }
  const unchangedResult = (): UpsertObservationResult => ({
    changed: false,
    created: false,
    id: current.id,
    firstSeenAt: current.firstSeenAt,
    changedAt: current.changedAt,
    lastSeenAt: current.lastSeenAt,
    payloadHash: current.payloadHash,
  });
  if (input.observedAt.getTime() < current.lastSeenAt.getTime()) return unchangedResult();

  if (current.payloadHash === payloadHash) {
    const [row] = await tx
      .update(scrapeObservations)
      .set({
        lastSeenAt: input.observedAt,
        runId: input.runId,
        rawId: input.rawId ?? null,
        ...(input.competitionId === null || input.competitionId === undefined
          ? {}
          : { competitionId: input.competitionId }),
        ...(input.homeTeamId === null || input.homeTeamId === undefined
          ? {}
          : { homeTeamId: input.homeTeamId }),
        ...(input.awayTeamId === null || input.awayTeamId === undefined
          ? {}
          : { awayTeamId: input.awayTeamId }),
      })
      .where(eq(scrapeObservations.id, current.id))
      .returning({ lastSeenAt: scrapeObservations.lastSeenAt });
    return { ...unchangedResult(), lastSeenAt: row!.lastSeenAt };
  }

  const namesSame =
    current.competitionRaw === input.competitionRaw &&
    current.homeRaw === input.homeRaw &&
    current.awayRaw === input.awayRaw &&
    current.sport === input.sport;
  const keep = <T>(given: T | null | undefined, existing: T | null): T | null =>
    given ?? (namesSame ? existing : null);
  await tx
    .update(scrapeObservations)
    .set({
      ...payload,
      competitionId: keep(input.competitionId, current.competitionId),
      homeTeamId: keep(input.homeTeamId, current.homeTeamId),
      awayTeamId: keep(input.awayTeamId, current.awayTeamId),
      lastSeenAt: input.observedAt,
      changedAt: input.observedAt,
      runId: input.runId,
      rawId: input.rawId ?? null,
    })
    .where(eq(scrapeObservations.id, current.id));
  await appendHistory(current.id);
  return {
    changed: true,
    created: false,
    id: current.id,
    firstSeenAt: current.firstSeenAt,
    changedAt: input.observedAt,
    lastSeenAt: input.observedAt,
    payloadHash,
  };
}

export interface ListObservationsQuery {
  kind?: ObservationKind;
  competitionId?: string;
  kickoffFrom?: Date;
  /** Exclusive. */
  kickoffTo?: Date;
  sourceIds?: readonly string[];
  /** Only observations whose competition and both teams are resolved. */
  resolvedOnly?: boolean;
  /**
   * Observations of DISABLED sources are left out unless this is true: a
   * source that was switched off (S4) must stop voting at once. Only the
   * back office should ask for them.
   */
  includeDisabledSources?: boolean;
  limit: number;
}

const observationColumns = {
  id: scrapeObservations.id,
  sourceId: scrapeObservations.sourceId,
  upstream: scrapeSources.upstream,
  kind: scrapeObservations.kind,
  sourceKey: scrapeObservations.sourceKey,
  sport: scrapeObservations.sport,
  competitionRaw: scrapeObservations.competitionRaw,
  homeRaw: scrapeObservations.homeRaw,
  awayRaw: scrapeObservations.awayRaw,
  competitionId: scrapeObservations.competitionId,
  homeTeamId: scrapeObservations.homeTeamId,
  awayTeamId: scrapeObservations.awayTeamId,
  kickoff: scrapeObservations.kickoff,
  status: scrapeObservations.status,
  round: scrapeObservations.round,
  score: scrapeObservations.score,
  scoreBasis: scrapeObservations.scoreBasis,
  payloadHash: scrapeObservations.payloadHash,
  firstSeenAt: scrapeObservations.firstSeenAt,
  changedAt: scrapeObservations.changedAt,
  lastSeenAt: scrapeObservations.lastSeenAt,
  runId: scrapeObservations.runId,
  rawId: scrapeObservations.rawId,
};

type SelectedObservation = Omit<ScrapeObservationRow, 'kind' | 'scoreBasis'> & {
  kind: string;
  scoreBasis: string | null;
};

function toRow(row: SelectedObservation): ScrapeObservationRow {
  return {
    ...row,
    kind: row.kind as ObservationKind,
    scoreBasis: row.scoreBasis as ScrapeScoreBasis | null,
  };
}

/** The current observations matching a query, by kickoff then id. */
export async function listCurrentObservations(
  exec: DbExecutor,
  query: ListObservationsQuery,
): Promise<ScrapeObservationRow[]> {
  const conditions: Array<SQL | undefined> = [
    query.kind === undefined ? undefined : eq(scrapeObservations.kind, query.kind),
    query.competitionId === undefined
      ? undefined
      : eq(scrapeObservations.competitionId, query.competitionId),
    query.kickoffFrom === undefined
      ? undefined
      : gte(scrapeObservations.kickoff, query.kickoffFrom),
    query.kickoffTo === undefined ? undefined : lt(scrapeObservations.kickoff, query.kickoffTo),
    query.sourceIds === undefined
      ? undefined
      : query.sourceIds.length === 0
        ? sql`false`
        : inArray(scrapeObservations.sourceId, [...query.sourceIds]),
    query.resolvedOnly
      ? and(
          isNotNull(scrapeObservations.competitionId),
          isNotNull(scrapeObservations.homeTeamId),
          isNotNull(scrapeObservations.awayTeamId),
        )
      : undefined,
    query.includeDisabledSources ? undefined : eq(scrapeSources.enabled, true),
  ];
  const rows = await exec
    .select(observationColumns)
    .from(scrapeObservations)
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeObservations.sourceId))
    .where(and(...conditions))
    .orderBy(asc(scrapeObservations.kickoff), asc(scrapeObservations.id))
    .limit(clampLimit(query.limit, 1000, 20_000));
  return rows.map(toRow);
}

/** Observations with a name that has not resolved yet (oldest first), of any source. */
export async function listUnresolvedObservations(
  exec: DbExecutor,
  options: { sourceIds?: readonly string[]; limit: number },
): Promise<ScrapeObservationRow[]> {
  const rows = await exec
    .select(observationColumns)
    .from(scrapeObservations)
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeObservations.sourceId))
    .where(
      and(
        or(
          isNull(scrapeObservations.competitionId),
          isNull(scrapeObservations.homeTeamId),
          isNull(scrapeObservations.awayTeamId),
        ),
        options.sourceIds === undefined
          ? undefined
          : options.sourceIds.length === 0
            ? sql`false`
            : inArray(scrapeObservations.sourceId, [...options.sourceIds]),
      ),
    )
    .orderBy(asc(scrapeObservations.firstSeenAt), asc(scrapeObservations.id))
    .limit(clampLimit(options.limit, 1000, 20_000));
  return rows.map(toRow);
}

/**
 * Sets the resolved catalogue ids of one observation (after the aliases
 * changed). Resolution is not part of the payload: changed_at does not move.
 * Returns false when the observation does not exist.
 */
export async function setObservationResolution(
  tx: DbTransaction,
  id: string,
  ids: {
    competitionId: string | null;
    homeTeamId: string | null;
    awayTeamId: string | null;
  },
): Promise<boolean> {
  const rows = await tx
    .update(scrapeObservations)
    .set({
      competitionId: ids.competitionId,
      homeTeamId: ids.homeTeamId,
      awayTeamId: ids.awayTeamId,
    })
    .where(eq(scrapeObservations.id, id))
    .returning({ id: scrapeObservations.id });
  return rows.length > 0;
}

export interface ObservationHistoryRow {
  id: bigint;
  observationId: string;
  status: string;
  score: ObservationScore | null;
  scoreBasis: string | null;
  kickoff: Date;
  payloadHash: string;
  seenAt: Date;
  runId: string;
  rawId: string | null;
}

/** Every payload an observation had, oldest first (the evidence trail). */
export async function listObservationHistory(
  exec: DbExecutor,
  observationId: string,
): Promise<ObservationHistoryRow[]> {
  return exec
    .select({
      id: scrapeObservationHistory.id,
      observationId: scrapeObservationHistory.observationId,
      status: scrapeObservationHistory.status,
      score: scrapeObservationHistory.score,
      scoreBasis: scrapeObservationHistory.scoreBasis,
      kickoff: scrapeObservationHistory.kickoff,
      payloadHash: scrapeObservationHistory.payloadHash,
      seenAt: scrapeObservationHistory.seenAt,
      runId: scrapeObservationHistory.runId,
      rawId: scrapeObservationHistory.rawId,
    })
    .from(scrapeObservationHistory)
    .where(eq(scrapeObservationHistory.observationId, observationId))
    .orderBy(asc(scrapeObservationHistory.id));
}

/**
 * A `304 Not Modified` is a sighting of everything the unchanged page lists:
 * moves last_seen_at, run_id and raw_id of the source's observations that came
 * from snapshot `fromRawId` onto the new run and snapshot (history is
 * untouched: the payloads did not change). Returns how many were touched.
 */
export async function touchObservationsOfRaw(
  tx: DbTransaction,
  input: { sourceId: string; fromRawId: string; toRawId: string; runId: string; seenAt: Date },
): Promise<{ fixtures: number; results: number }> {
  const rows = await tx
    .update(scrapeObservations)
    .set({
      lastSeenAt: sql`greatest(${scrapeObservations.lastSeenAt}, ${input.seenAt.toISOString()}::timestamptz)`,
      runId: input.runId,
      rawId: input.toRawId,
    })
    .where(
      and(
        eq(scrapeObservations.sourceId, input.sourceId),
        eq(scrapeObservations.rawId, input.fromRawId),
      ),
    )
    .returning({ kind: scrapeObservations.kind });
  return {
    fixtures: rows.filter((r) => r.kind === 'fixture').length,
    results: rows.filter((r) => r.kind === 'result').length,
  };
}
