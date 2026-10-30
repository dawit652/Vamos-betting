import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { auditScrape } from './common';

/**
 * The evidence behind the kickoff-safety rules K1 to K6 (docs/scraper.md 6.1a): what the enabled
 * sources currently say about an event's kickoff (its _statements_), whether each source is _fresh_,
 * and what a person has confirmed. Structural types only: this package does not import
 * @vamos/scraper, so every threshold is an option the caller passes (the scraper's constants), and
 * the shapes below are the ones `assessKickoff` takes.
 *
 * Definitions (all in SQL, the same predicates as the spec):
 * - listed row: an observation of an ENABLED source with `last_seen_at` at or after the `started_at`
 *   of that source's latest run with status `ok` (a 304 sighting counts; the old-day row a keyless
 *   source leaves when a match moves is not listed);
 * - statement about event E: a listed row (fixture or result) with E's competition, home and away and a
 *   kickoff at most `evidenceWindowMs` before or after E's start;
 * - healthy source: its latest finished run (not `running`, not `skipped`) is `ok`;
 * - known: a listed row of the source ended at least `minMatchDurationMs + staleAfterMs` ago;
 * - stale (S5 on the source's own rows): a listed `scheduled` fixture row ended (kickoff +
 *   `minMatchDurationMs`) at least `staleAfterMs` ago and after the largest `changed_at` of ALL the
 *   source's observations. It does not read the `source_stale` review item;
 * - fresh = healthy and known and not stale.
 */

export interface KickoffThresholds {
  /** MIN_MATCH_DURATION_MS: the earliest a match can be over. */
  minMatchDurationMs: number;
  /** SOURCE_STALE_AFTER_MS: how long after that end a source may stay silent. */
  staleAfterMs: number;
}

export interface SourceKickoffFacts {
  sourceId: string;
  /** scrape_sources.upstream (as declared; independence compares it trimmed and lower-cased). */
  upstream: string;
  /** The latest finished run of the source is `ok`. */
  healthy: boolean;
  /** A listed row of the source ended at least `minMatchDurationMs + staleAfterMs` ago. */
  known: boolean;
  /** Rule S5 on the source's own rows. */
  stale: boolean;
  /** healthy && known && !stale: the only sources whose statements can confirm a kickoff. */
  fresh: boolean;
  /** `started_at` of the source's latest `ok` run; null when it has none. */
  latestOkRunStartedAt: Date | null;
}

/** One statement, in the shape `assessKickoff` takes (`KickoffStatement` in @vamos/scraper). */
export interface KickoffStatementRow {
  sourceId: string;
  upstream: string;
  kind: 'fixture' | 'result';
  status: 'scheduled' | 'postponed' | 'cancelled' | 'finished' | 'abandoned';
  kickoff: Date;
  changedAt: Date;
  sourceFresh: boolean;
}

/** The latest person confirmation of an event (`KickoffPersonRecord` in @vamos/scraper). */
export interface KickoffPersonRow {
  startTime: Date;
  /** The audit row's time. */
  confirmedAt: Date;
  evidenceKey: string;
}

export interface KickoffEventFacts {
  eventId: string;
  feedProvider: string;
  feedRef: string | null;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  status: string;
  bettingOpen: boolean;
  resultedAt: Date | null;
  /** The score the event was resulted with (null until resulted). */
  score: { home: number; away: number; htHome: number | null; htAway: number | null } | null;
}

export interface KickoffEvidence {
  event: KickoffEventFacts;
  /** Sorted by source id, kind, kickoff, status, then changedAt. */
  statements: KickoffStatementRow[];
  person: KickoffPersonRow | null;
}

export interface LoadKickoffEvidenceOptions extends KickoffThresholds {
  eventIds: readonly string[];
  now: Date;
  /** KICKOFF_EVIDENCE_WINDOW_MS. */
  evidenceWindowMs: number;
}

export const KICKOFF_CONFIRMED_AUDIT_ACTION = 'scrape.fixture.kickoff_confirmed';

type Millis = SQL;
/** `<n> milliseconds` as an interval; n is summed in TypeScript (Postgres cannot type `$1 + $2`). */
const ms = (n: number): Millis => sql`(${n} * interval '1 millisecond')`;

/**
 * The per-source facts as a CTE `kickoff_facts` (enabled sources only). Shared by the two readers so
 * the freshness predicates exist once.
 */
function factsCte(now: Date, t: KickoffThresholds): SQL {
  const at = now.toISOString();
  const endAndAllowance = t.minMatchDurationMs + t.staleAfterMs;
  return sql`
    latest_ok AS (
      SELECT r.source_id, max(r.started_at) AS started_at
      FROM scrape_runs r WHERE r.status = 'ok' GROUP BY r.source_id
    ),
    listed AS (
      SELECT o.id, o.source_id, o.kind, o.status, o.kickoff, o.changed_at, o.competition_id,
        o.home_team_id, o.away_team_id
      FROM scrape_observations o
      JOIN scrape_sources s ON s.id = o.source_id AND s.enabled
      JOIN latest_ok l ON l.source_id = o.source_id
      WHERE o.last_seen_at >= l.started_at
    ),
    kickoff_facts AS (
      SELECT s.id AS source_id, s.upstream, l.started_at AS latest_ok_started_at,
        COALESCE((SELECT r.status FROM scrape_runs r
                  WHERE r.source_id = s.id AND r.status NOT IN ('running', 'skipped')
                  ORDER BY r.started_at DESC, r.id DESC LIMIT 1) = 'ok', false) AS healthy,
        EXISTS (SELECT 1 FROM listed o
                WHERE o.source_id = s.id
                  AND o.kickoff + ${ms(endAndAllowance)} <= ${at}::timestamptz) AS known,
        COALESCE((SELECT true FROM listed o
                  WHERE o.source_id = s.id AND o.kind = 'fixture' AND o.status = 'scheduled'
                    AND o.kickoff + ${ms(endAndAllowance)} <= ${at}::timestamptz
                    AND o.kickoff + ${ms(t.minMatchDurationMs)} >
                        (SELECT max(a.changed_at) FROM scrape_observations a WHERE a.source_id = s.id)
                  LIMIT 1), false) AS stale
      FROM scrape_sources s
      LEFT JOIN latest_ok l ON l.source_id = s.id
      WHERE s.enabled
    )`;
}

interface FactsRow extends Record<string, unknown> {
  source_id: string;
  upstream: string;
  healthy: boolean;
  known: boolean;
  stale: boolean;
  latest_ok_started_at: Date | string | null;
}

/**
 * For every ENABLED source: healthy, known, stale and the start of its latest ok run (see the
 * definitions above). Used by `loadKickoffEvidence` and by fixture promotion (the freshness of the
 * sources behind a fixture that has no event yet).
 */
export async function listSourceKickoffFacts(
  exec: DbExecutor,
  options: KickoffThresholds & { now: Date },
): Promise<SourceKickoffFacts[]> {
  const result = await exec.execute<FactsRow>(sql`
    WITH ${factsCte(options.now, options)}
    SELECT source_id, upstream, healthy, known, stale, latest_ok_started_at
    FROM kickoff_facts ORDER BY source_id`);
  return result.rows.map(toFacts);
}

function toFacts(row: FactsRow): SourceKickoffFacts {
  const healthy = row.healthy === true;
  const known = row.known === true;
  const stale = row.stale === true;
  return {
    sourceId: row.source_id,
    upstream: row.upstream,
    healthy,
    known,
    stale,
    fresh: healthy && known && !stale,
    latestOkRunStartedAt:
      row.latest_ok_started_at === null ? null : new Date(row.latest_ok_started_at),
  };
}

interface EventRow extends Record<string, unknown> {
  id: string;
  feed_provider: string;
  feed_ref: string | null;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  start_time: Date | string;
  status: string;
  betting_open: boolean;
  resulted_at: Date | string | null;
  score_home: number | null;
  score_away: number | null;
  ht_score_home: number | null;
  ht_score_away: number | null;
}

interface StatementRow extends Record<string, unknown> {
  event_id: string;
  source_id: string;
  upstream: string;
  kind: 'fixture' | 'result';
  status: KickoffStatementRow['status'];
  kickoff: Date | string;
  changed_at: Date | string;
  source_fresh: boolean;
}

interface PersonRow extends Record<string, unknown> {
  event_id: string;
  created_at: Date | string;
  start_time: string | null;
  evidence_key: string | null;
}

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/**
 * Per event (a Map keyed by event id; ids that do not exist are absent): the event row, its
 * statements and the latest person confirmation, read at `now`. Used by the K1 pass, by the K2
 * guard of both opening paths (inside the transaction that holds the event lock) and by fixture
 * promotion.
 *
 * The latest person record is the newest audit row `scrape.fixture.kickoff_confirmed` of the event; if
 * its metadata is malformed there is no record (fail closed: a doubtful confirmation confirms nothing).
 */
export async function loadKickoffEvidence(
  exec: DbExecutor,
  options: LoadKickoffEvidenceOptions,
): Promise<Map<string, KickoffEvidence>> {
  const out = new Map<string, KickoffEvidence>();
  const ids = [...new Set(options.eventIds)];
  if (ids.length === 0) return out;

  const events = await exec.execute<EventRow>(sql`
    SELECT id, feed_provider, feed_ref, competition_id, home_team_id, away_team_id, start_time,
      status, betting_open, resulted_at, score_home, score_away, ht_score_home, ht_score_away
    FROM events WHERE id IN (${uuidList(ids)})`);
  for (const row of events.rows) {
    const resultedAt = row.resulted_at === null ? null : new Date(row.resulted_at);
    out.set(row.id, {
      event: {
        eventId: row.id,
        feedProvider: row.feed_provider,
        feedRef: row.feed_ref,
        competitionId: row.competition_id,
        homeTeamId: row.home_team_id,
        awayTeamId: row.away_team_id,
        startTime: new Date(row.start_time),
        status: row.status,
        bettingOpen: row.betting_open,
        resultedAt,
        score:
          resultedAt !== null && row.score_home !== null && row.score_away !== null
            ? {
                home: row.score_home,
                away: row.score_away,
                htHome: row.ht_score_home,
                htAway: row.ht_score_away,
              }
            : null,
      },
      statements: [],
      person: null,
    });
  }
  if (out.size === 0) return out;
  const known = [...out.keys()];

  const statements = await exec.execute<StatementRow>(sql`
    WITH ${factsCte(options.now, options)}
    SELECT e.id AS event_id, o.source_id, f.upstream, o.kind, o.status, o.kickoff, o.changed_at,
      (f.healthy AND f.known AND NOT f.stale) AS source_fresh
    FROM events e
    JOIN scrape_observations o
      ON o.competition_id = e.competition_id
     AND o.home_team_id = e.home_team_id
     AND o.away_team_id = e.away_team_id
     AND o.kickoff >= e.start_time - ${ms(options.evidenceWindowMs)}
     AND o.kickoff <= e.start_time + ${ms(options.evidenceWindowMs)}
    JOIN kickoff_facts f ON f.source_id = o.source_id
    WHERE e.id IN (${uuidList(known)})
      AND f.latest_ok_started_at IS NOT NULL
      AND o.last_seen_at >= f.latest_ok_started_at
    ORDER BY e.id, o.source_id, o.kind, o.kickoff, o.status, o.changed_at`);
  for (const row of statements.rows) {
    out.get(row.event_id)?.statements.push({
      sourceId: row.source_id,
      upstream: row.upstream,
      kind: row.kind,
      status: row.status,
      kickoff: new Date(row.kickoff),
      changedAt: new Date(row.changed_at),
      sourceFresh: row.source_fresh === true,
    });
  }

  const people = await exec.execute<PersonRow>(sql`
    SELECT DISTINCT ON (a.target_id) a.target_id AS event_id, a.created_at,
      a.metadata->>'startTime' AS start_time, a.metadata->>'evidenceKey' AS evidence_key
    FROM audit_log a
    WHERE a.action = ${KICKOFF_CONFIRMED_AUDIT_ACTION} AND a.target_type = 'event'
      AND a.target_id IN (${uuidList(known)})
    ORDER BY a.target_id, a.created_at DESC, a.id DESC`);
  for (const row of people.rows) {
    const startTime = row.start_time === null ? Number.NaN : Date.parse(row.start_time);
    const evidence = out.get(row.event_id);
    if (evidence === undefined || Number.isNaN(startTime) || row.evidence_key === null) continue;
    evidence.person = {
      startTime: new Date(startTime),
      confirmedAt: new Date(row.created_at),
      evidenceKey: row.evidence_key,
    };
  }
  return out;
}

export interface RecordKickoffConfirmationInput {
  eventId: string;
  /** The start the person confirmed: the event's start_time at that moment. */
  startTime: Date;
  /** The evidence key the person was shown. */
  evidenceKey: string;
  /** The staff member who confirmed. */
  actor: { adminId: string; ip?: string | null };
  via: 'review' | 'trading';
  /** The review item the person acted from, when via 'review'. */
  itemId?: string | null;
}

/**
 * Writes the person's confirmation (audit `scrape.fixture.kickoff_confirmed`, actor the staff
 * member). `confirmedAt` of the record is the audit row's time. Call it in the transaction that
 * opens betting, so a refusal after it rolls the record back; the caller has checked the start
 * time and the evidence key under the event lock.
 */
export async function recordKickoffConfirmation(
  tx: DbTransaction,
  input: RecordKickoffConfirmationInput,
): Promise<void> {
  if (!Number.isFinite(input.startTime.getTime())) {
    throw new RangeError('startTime must be a valid Date');
  }
  await auditScrape(tx, input.actor, {
    action: KICKOFF_CONFIRMED_AUDIT_ACTION,
    targetType: 'event',
    targetId: input.eventId,
    metadata: {
      startTime: input.startTime.toISOString(),
      evidenceKey: input.evidenceKey,
      via: input.via,
      itemId: input.itemId ?? null,
    },
  });
}
