import { MARKET_TYPES, type MarketTypeCode } from '@vamos/core';
import { SCRAPED_FEED_PROVIDER } from '@vamos/core';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { bets } from '../schema/betting';
import { events } from '../schema/catalog';

/** Kickoff proximity within which an observation counts as listing an event (rule F5). */
export const DEFAULT_LISTED_WINDOW_MS = 36 * 3_600_000;

const HALF_TIME_MARKET_TYPES: readonly string[] = (Object.keys(MARKET_TYPES) as MarketTypeCode[])
  .filter((code) => MARKET_TYPES[code].period === 'half_time')
  .sort();

export type ScrapedEventStatus =
  'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed' | 'abandoned';

/** An event the scraper created (structurally ExistingEvent in @vamos/scraper, plus lastListedAt). */
export interface ScrapedEvent {
  eventId: string;
  gameId: number;
  /** events.feed_ref: the fixture key, which never changes. */
  feedRef: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  status: ScrapedEventStatus;
  bettingOpen: boolean;
  /** At least one bet (any status) has a leg on the event. */
  hasBets: boolean;
  /** The event has a market settled on the half-time score. */
  needsHalfTimeScore: boolean;
  resultedAt: Date | null;
  /** The score the event was resulted with (null until resulted, or when resulted without one). */
  score: { home: number; away: number; htHome: number | null; htAway: number | null } | null;
  /**
   * Rule F5: the latest last_seen_at among the event's current FIXTURE
   * observations (same competition and teams, kickoff within the window) of
   * ENABLED sources whose latest finished run was ok; null when none.
   */
  lastListedAt: Date | null;
}

export interface ListScrapedEventsQuery {
  /** Start-time range, inclusive. */
  from: Date;
  to: Date;
  /** Include events that are no longer scheduled or live (default: only scheduled and live). */
  includeFinished?: boolean;
  listedWindowMs?: number;
}

/** Scraped events starting in a range, by start time, with what the rules need to know about each. */
export async function listScrapedEvents(
  exec: DbExecutor,
  query: ListScrapedEventsQuery,
): Promise<ScrapedEvent[]> {
  const windowMs = query.listedWindowMs ?? DEFAULT_LISTED_WINDOW_MS;
  const halfTimeTypes = sql.join(
    HALF_TIME_MARKET_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const rows = await exec
    .select({
      eventId: events.id,
      gameId: events.gameId,
      feedRef: events.feedRef,
      competitionId: events.competitionId,
      homeTeamId: events.homeTeamId,
      awayTeamId: events.awayTeamId,
      startTime: events.startTime,
      status: events.status,
      bettingOpen: events.bettingOpen,
      resultedAt: events.resultedAt,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
      hasBets: sql<boolean>`EXISTS (SELECT 1 FROM bet_legs bl WHERE bl.event_id = events.id)`,
      needsHalfTimeScore: sql<boolean>`EXISTS (SELECT 1 FROM markets m WHERE m.event_id = events.id AND m.type IN (${halfTimeTypes}))`,
      lastListedAt: sql<Date | string | null>`(
        SELECT max(o.last_seen_at)
        FROM scrape_observations o
        JOIN scrape_sources s ON s.id = o.source_id
        WHERE o.kind = 'fixture' AND s.enabled
          AND o.competition_id = events.competition_id
          AND o.home_team_id = events.home_team_id
          AND o.away_team_id = events.away_team_id
          AND abs(extract(epoch FROM (o.kickoff - events.start_time))) * 1000 <= ${windowMs}
          AND (SELECT r.status FROM scrape_runs r
               WHERE r.source_id = s.id AND r.status NOT IN ('running', 'skipped')
               ORDER BY r.started_at DESC, r.id DESC LIMIT 1) = 'ok')`,
    })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, SCRAPED_FEED_PROVIDER),
        gte(events.startTime, query.from),
        lte(events.startTime, query.to),
        query.includeFinished ? undefined : inArray(events.status, ['scheduled', 'live']),
      ),
    )
    .orderBy(asc(events.startTime), asc(events.id));
  return rows.map(({ scoreHome, scoreAway, htScoreHome, htScoreAway, lastListedAt, ...row }) => ({
    ...row,
    score:
      row.resultedAt !== null && scoreHome !== null && scoreAway !== null
        ? { home: scoreHome, away: scoreAway, htHome: htScoreHome, htAway: htScoreAway }
        : null,
    lastListedAt: lastListedAt === null ? null : new Date(lastListedAt),
  }));
}

export interface EventExposure {
  /** Bets with a leg on the event that are not settled yet (open or awaiting acceptance). */
  openBets: number;
  /** Their total stake, santim as a decimal string. */
  totalStake: string;
}

/**
 * What a result decision puts at stake (rule R9): the unsettled bets on an
 * event. Counts a multi once however many legs it has on the event, like the
 * trading view (backoffice/trading.ts).
 */
export async function getEventExposure(exec: DbExecutor, eventId: string): Promise<EventExposure> {
  const [row] = await exec
    .select({
      openBets: sql<number>`count(*)::int`,
      totalStake: sql<string>`COALESCE(sum(bets.stake), 0)::text`,
    })
    .from(bets)
    .where(
      and(
        inArray(bets.status, ['open', 'pending_acceptance']),
        sql`EXISTS (SELECT 1 FROM bet_legs bl WHERE bl.bet_id = bets.id AND bl.event_id = ${eventId})`,
      ),
    );
  return { openBets: row?.openBets ?? 0, totalStake: row?.totalStake ?? '0' };
}
