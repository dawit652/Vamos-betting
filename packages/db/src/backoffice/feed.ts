import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { domainBadRequest, domainNotFound, domainUnprocessable } from '../errors';
import { markFeedResultApplied, updateFeedLeagueSettings, type FeedLeagueRow } from '../feed/index';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { competitions, events, teams, type LocalizedName } from '../schema/catalog';
import { feedLeagues, feedResults } from '../schema/feed';
import type { StaffActor } from './common';
import { staffResultEvent } from './trading';

/** The only real-odds provider with a back office review queue. */
export const FEED_PROVIDER = 'theoddsapi';

/** Audit action of a staff change to a feed league. */
export const STAFF_FEED_LEAGUE_UPDATED = 'feed.league.updated';

/** The audit action recorded when staff accept or void a feed result (beside the trading one). */
export const STAFF_FEED_RESULT_REVIEWED = 'feed.result.reviewed';

/** A feed result waiting for staff, with its event. */
export interface FeedReviewItem {
  eventId: string;
  gameId: number;
  sportId: string;
  competition: LocalizedName;
  homeTeam: LocalizedName;
  awayTeam: LocalizedName;
  startTime: Date;
  eventStatus: (typeof events.$inferSelect)['status'];
  scoreHome: number | null;
  scoreAway: number | null;
  reviewReason: 'cup' | 'tennis' | 'overdue' | 'unreadable';
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const homeTeams = alias(teams, 'home_teams');
const awayTeams = alias(teams, 'away_teams');

const reviewColumns = {
  eventId: feedResults.eventId,
  gameId: events.gameId,
  sportId: events.sportId,
  competition: competitions.name,
  homeTeam: homeTeams.name,
  awayTeam: awayTeams.name,
  startTime: events.startTime,
  eventStatus: events.status,
  scoreHome: feedResults.scoreHome,
  scoreAway: feedResults.scoreAway,
  reviewReason: feedResults.reviewReason,
  firstSeenAt: feedResults.firstSeenAt,
  lastSeenAt: feedResults.lastSeenAt,
};

/**
 * The results the feed reported that need staff (cup / tennis in licensed
 * mode, overdue or unreadable ones), oldest first, with each event's teams,
 * competition, start time and Game ID.
 */
export async function listFeedReviewQueue(
  exec: DbExecutor,
  provider: string = FEED_PROVIDER,
): Promise<FeedReviewItem[]> {
  const rows = await exec
    .select(reviewColumns)
    .from(feedResults)
    .innerJoin(events, eq(events.id, feedResults.eventId))
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(
      and(
        eq(feedResults.provider, provider),
        isNull(feedResults.appliedAt),
        isNotNull(feedResults.reviewReason),
      ),
    )
    .orderBy(asc(feedResults.firstSeenAt), asc(feedResults.eventId));
  // The query keeps only rows with a reason, and the table's check limits it to these four.
  return rows.map((row) => ({
    ...row,
    reviewReason: row.reviewReason as FeedReviewItem['reviewReason'],
  }));
}

/** The queued row of the event, locked; 404 when it is not (or no longer) waiting for review. */
async function lockedReviewRow(tx: DbTransaction, eventId: string, provider: string) {
  const [row] = await tx
    .select({
      scoreHome: feedResults.scoreHome,
      scoreAway: feedResults.scoreAway,
      reviewReason: feedResults.reviewReason,
    })
    .from(feedResults)
    .where(
      and(
        eq(feedResults.eventId, eventId),
        eq(feedResults.provider, provider),
        isNull(feedResults.appliedAt),
        isNotNull(feedResults.reviewReason),
      ),
    )
    .for('update');
  if (row === undefined) throw domainNotFound('Feed result');
  return row;
}

interface ReviewInput {
  eventId: string;
  reason?: string;
  actor: StaffActor;
  now: Date;
  provider?: string;
}

/**
 * Staff accept the feed's score: the event is resulted `finished` with it
 * (through staffResultEvent, so it is audited and settles the bets) and the
 * feed result is marked applied, in the caller's transaction. A row without
 * a score (overdue / unreadable) is refused (400 `feed_result_has_no_score`):
 * staff then use the trading result screen, or void.
 */
export async function staffAcceptFeedResult(tx: DbTransaction, input: ReviewInput) {
  const row = await lockedReviewRow(tx, input.eventId, input.provider ?? FEED_PROVIDER);
  if (row.scoreHome === null || row.scoreAway === null) {
    throw domainBadRequest(
      'feed_result_has_no_score',
      'The feed gave no score for this event: result it on the trading screen, or void it.',
    );
  }
  const outcome = await staffResultEvent(tx, {
    eventId: input.eventId,
    result: {
      status: 'finished',
      score: { home: row.scoreHome, away: row.scoreAway, htHome: null, htAway: null },
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    actor: input.actor,
    now: input.now,
  });
  await markFeedResultApplied(tx, input.eventId, input.now);
  await auditReview(tx, input, 'accepted', row.reviewReason);
  return outcome;
}

/** Staff void the event (status `cancelled`, audited) and close the feed result. */
export async function staffVoidFeedResult(tx: DbTransaction, input: ReviewInput) {
  const row = await lockedReviewRow(tx, input.eventId, input.provider ?? FEED_PROVIDER);
  const outcome = await staffResultEvent(tx, {
    eventId: input.eventId,
    result: { status: 'cancelled' },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    actor: input.actor,
    now: input.now,
  });
  await markFeedResultApplied(tx, input.eventId, input.now);
  await auditReview(tx, input, 'voided', row.reviewReason);
  return outcome;
}

async function auditReview(
  tx: DbTransaction,
  input: ReviewInput,
  decision: 'accepted' | 'voided',
  reviewReason: string | null,
): Promise<void> {
  const reason = input.reason?.trim();
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.actor.adminId,
    action: STAFF_FEED_RESULT_REVIEWED,
    targetType: 'event',
    targetId: input.eventId,
    metadata: {
      decision,
      reviewReason,
      ...(reason === undefined || reason === '' ? {} : { reason }),
    },
    ip: input.actor.ip ?? null,
  });
}

/**
 * Staff change a league's `enabled` flag and/or margin (null: the default).
 * Returns the league after the change, or null for an unknown league; a
 * margin outside 0..3000 is 422 `invalid_feed_setting`. Audited with the
 * before and after values.
 */
export async function staffUpdateFeedLeague(
  tx: DbTransaction,
  input: {
    sportKey: string;
    enabled?: boolean;
    marginBps?: number | null;
    actor: StaffActor;
    provider?: string;
  },
): Promise<FeedLeagueRow | null> {
  const provider = input.provider ?? FEED_PROVIDER;
  const where = and(eq(feedLeagues.provider, provider), eq(feedLeagues.sportKey, input.sportKey));
  const [before] = await tx.select().from(feedLeagues).where(where).for('update');
  if (before === undefined) return null;
  const settings = {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.marginBps === undefined ? {} : { marginBps: input.marginBps }),
  };
  try {
    await updateFeedLeagueSettings(tx, provider, input.sportKey, settings);
  } catch (error) {
    if (error instanceof RangeError) {
      throw domainUnprocessable('invalid_feed_setting', error.message);
    }
    throw error;
  }
  const [after] = await tx.select().from(feedLeagues).where(where);
  if (after === undefined) return null;
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.actor.adminId,
    action: STAFF_FEED_LEAGUE_UPDATED,
    targetType: 'feed_league',
    targetId: `${provider}/${input.sportKey}`,
    metadata: {
      before: { enabled: before.enabled, marginBps: before.marginBps },
      after: { enabled: after.enabled, marginBps: after.marginBps },
    },
    ip: input.actor.ip ?? null,
  });
  return after;
}
