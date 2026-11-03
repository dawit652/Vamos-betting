import type { SportCode } from '@vamos/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import {
  categories,
  competitions,
  events,
  markets,
  teams,
  type LocalizedName,
} from '../schema/catalog';
import { feedApiCalls, feedLeagues, feedResults, feedTeamAliases } from '../schema/feed';

/**
 * Database side of the real odds feeds (FEED_PROVIDER=theoddsapi; see
 * docs/odds-api-integration-plan.md): the leagues and their polling state,
 * where a league's events go in the catalogue, the provider's team names,
 * the credit log and the results the provider reported.
 */

export type FeedLeagueRow = typeof feedLeagues.$inferSelect;
export type FeedResultRow = typeof feedResults.$inferSelect;

/** A provider league as the catalogue sync sees it (structurally a LeagueEntry of @vamos/feed). */
export interface FeedLeagueInput {
  provider: string;
  sportKey: string;
  sport: SportCode;
  group: string;
  title: string;
  description: string;
  active: boolean;
  cup: boolean;
  tier: 1 | 2 | 3;
  /** Whether a NEW row starts enabled; an existing row keeps what staff chose. */
  enabled: boolean;
}

/**
 * Inserts the league or refreshes its provider-side fields. `enabled`, the
 * margin and the competition belong to staff and are never overwritten.
 */
export async function upsertFeedLeague(exec: DbExecutor, input: FeedLeagueInput): Promise<void> {
  await exec
    .insert(feedLeagues)
    .values({
      provider: input.provider,
      sportKey: input.sportKey,
      sportId: input.sport,
      sportGroup: input.group,
      title: input.title,
      description: input.description,
      active: input.active,
      enabled: input.enabled,
      cup: input.cup,
      tier: input.tier,
    })
    .onConflictDoUpdate({
      target: [feedLeagues.provider, feedLeagues.sportKey],
      set: {
        sportGroup: input.group,
        title: input.title,
        description: input.description,
        active: input.active,
        cup: input.cup,
        tier: input.tier,
        updatedAt: sql`now()`,
      },
    });
}

/** Marks every league of the provider not in `keys` inactive (the provider dropped it). */
export async function deactivateMissingLeagues(
  exec: DbExecutor,
  provider: string,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  const rows = await exec
    .update(feedLeagues)
    .set({ active: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(feedLeagues.provider, provider),
        eq(feedLeagues.active, true),
        sql`${feedLeagues.sportKey} NOT IN (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
      ),
    )
    .returning({ sportKey: feedLeagues.sportKey });
  return rows.length;
}

export async function listFeedLeagues(
  exec: DbExecutor,
  provider: string,
  filter: { enabled?: boolean } = {},
): Promise<FeedLeagueRow[]> {
  return exec
    .select()
    .from(feedLeagues)
    .where(
      and(
        eq(feedLeagues.provider, provider),
        filter.enabled === undefined ? undefined : eq(feedLeagues.enabled, filter.enabled),
      ),
    )
    .orderBy(asc(feedLeagues.sportId), asc(feedLeagues.sportKey));
}

/** The provider's enabled, active leagues whose odds (or scores) poll is due at `now`. */
export async function listDueLeagues(
  exec: DbExecutor,
  provider: string,
  kind: 'odds' | 'scores',
  now: Date,
): Promise<FeedLeagueRow[]> {
  const next = kind === 'odds' ? feedLeagues.nextOddsAt : feedLeagues.nextScoresAt;
  return exec
    .select()
    .from(feedLeagues)
    .where(
      and(
        eq(feedLeagues.provider, provider),
        eq(feedLeagues.enabled, true),
        kind === 'odds' ? eq(feedLeagues.active, true) : undefined,
        or(isNull(next), lte(next, now)),
      ),
    )
    .orderBy(sql`${next} ASC NULLS FIRST`, asc(feedLeagues.sportKey));
}

export type FeedLeaguePollPatch = Partial<
  Pick<
    FeedLeagueRow,
    | 'nextStartAt'
    | 'eventCount'
    | 'liveCount'
    | 'lastEventsAt'
    | 'lastOddsAt'
    | 'lastScoresAt'
    | 'nextOddsAt'
    | 'nextScoresAt'
    | 'lastError'
    | 'lastErrorAt'
  >
>;

export async function updateFeedLeaguePoll(
  exec: DbExecutor,
  provider: string,
  sportKey: string,
  patch: FeedLeaguePollPatch,
): Promise<void> {
  await exec
    .update(feedLeagues)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(feedLeagues.provider, provider), eq(feedLeagues.sportKey, sportKey)));
}

/** Staff settings of a league: on/off and its margin (null: the default). */
export async function updateFeedLeagueSettings(
  exec: DbExecutor,
  provider: string,
  sportKey: string,
  settings: { enabled?: boolean; marginBps?: number | null },
): Promise<boolean> {
  if (settings.marginBps !== undefined && settings.marginBps !== null) {
    if (
      !Number.isSafeInteger(settings.marginBps) ||
      settings.marginBps < 0 ||
      settings.marginBps > 3000
    ) {
      throw new RangeError(`marginBps must be an integer 0..3000, got ${settings.marginBps}`);
    }
  }
  const rows = await exec
    .update(feedLeagues)
    .set({
      ...(settings.enabled === undefined ? {} : { enabled: settings.enabled, nextOddsAt: null }),
      ...(settings.marginBps === undefined ? {} : { marginBps: settings.marginBps }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(feedLeagues.provider, provider), eq(feedLeagues.sportKey, sportKey)))
    .returning({ sportKey: feedLeagues.sportKey });
  return rows.length > 0;
}

/** Where a league's events go (structurally a LeagueEntry's category and competition). */
export interface LeaguePlacement {
  category: { slug: string; name: LocalizedName; countryCode: string | null; sortOrder: number };
  competition: { slug: string; name: LocalizedName; featured: boolean; sortOrder: number };
}

/**
 * The competition a league's events go to. The first time, the category and
 * competition are created unless they exist (seeded or created before),
 * whose names, flags and order are then left as they are; afterwards the
 * competition recorded on the league is used, so staff can re-point it.
 */
export async function ensureLeagueCompetition(
  tx: DbTransaction,
  provider: string,
  sportKey: string,
  sport: SportCode,
  placement: LeaguePlacement,
): Promise<string> {
  const [league] = await tx
    .select({ competitionId: feedLeagues.competitionId })
    .from(feedLeagues)
    .where(and(eq(feedLeagues.provider, provider), eq(feedLeagues.sportKey, sportKey)))
    .for('update');
  if (league === undefined) throw new RangeError(`unknown feed league ${provider}/${sportKey}`);
  if (league.competitionId !== null) return league.competitionId;

  await tx
    .insert(categories)
    .values({
      sportId: sport,
      slug: placement.category.slug,
      name: placement.category.name,
      countryCode: placement.category.countryCode,
      sortOrder: placement.category.sortOrder,
    })
    .onConflictDoNothing({ target: [categories.sportId, categories.slug] });
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.sportId, sport), eq(categories.slug, placement.category.slug)));
  if (category === undefined)
    throw new Error(`category ${sport}/${placement.category.slug} missing`);

  await tx
    .insert(competitions)
    .values({
      sportId: sport,
      categoryId: category.id,
      slug: placement.competition.slug,
      name: placement.competition.name,
      featured: placement.competition.featured,
      sortOrder: placement.competition.sortOrder,
    })
    .onConflictDoNothing({ target: [competitions.sportId, competitions.slug] });
  const [competition] = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(and(eq(competitions.sportId, sport), eq(competitions.slug, placement.competition.slug)));
  if (competition === undefined) {
    throw new Error(`competition ${sport}/${placement.competition.slug} missing`);
  }
  await tx
    .update(feedLeagues)
    .set({ competitionId: competition.id, updatedAt: sql`now()` })
    .where(and(eq(feedLeagues.provider, provider), eq(feedLeagues.sportKey, sportKey)));
  return competition.id;
}

/**
 * Our team for a provider's team name: the alias if there is one, else a
 * team of the sport whose short name or English name is that name (so seeded
 * teams such as "Man City" / "Manchester City" keep their Amharic names),
 * else a new team. The alias is recorded either way.
 */
export async function resolveFeedTeam(
  tx: DbTransaction,
  provider: string,
  sport: SportCode,
  externalName: string,
): Promise<string> {
  const name = externalName.trim();
  if (name.length === 0 || name.length > 120)
    throw new RangeError(`invalid team name "${externalName}"`);
  const [alias] = await tx
    .select({ teamId: feedTeamAliases.teamId })
    .from(feedTeamAliases)
    .where(
      and(
        eq(feedTeamAliases.provider, provider),
        eq(feedTeamAliases.sportId, sport),
        eq(feedTeamAliases.externalName, name),
      ),
    );
  if (alias !== undefined) return alias.teamId;

  const lower = name.toLowerCase();
  const [match] = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.sportId, sport),
        or(sql`lower(${teams.shortName}) = ${lower}`, sql`lower(${teams.name}->>'en') = ${lower}`),
      ),
    )
    .orderBy(desc(sql`${teams.shortName} = ${name}`), asc(teams.id))
    .limit(1);
  let teamId = match?.id;
  if (teamId === undefined) {
    await tx
      .insert(teams)
      .values({ sportId: sport, name: { en: name }, shortName: name })
      .onConflictDoNothing({ target: [teams.sportId, teams.shortName] });
    const [created] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.sportId, sport), eq(teams.shortName, name)));
    if (created === undefined) throw new Error(`team ${sport}/${name} missing`);
    teamId = created.id;
  }
  await tx
    .insert(feedTeamAliases)
    .values({ provider, sportId: sport, externalName: name, teamId })
    .onConflictDoNothing();
  return teamId;
}

export interface FeedCallRecord {
  provider: string;
  endpoint: string;
  sportKey?: string | null;
  status?: number | null;
  cost: number;
  remaining?: number | null;
  used?: number | null;
  errorKind?: string | null;
  calledAt?: Date;
}

export async function recordFeedCall(exec: DbExecutor, call: FeedCallRecord): Promise<void> {
  await exec.insert(feedApiCalls).values({
    provider: call.provider,
    endpoint: call.endpoint,
    sportKey: call.sportKey ?? null,
    status: call.status ?? null,
    cost: Math.max(0, Math.trunc(call.cost)),
    remaining: call.remaining ?? null,
    used: call.used ?? null,
    errorKind: call.errorKind ?? null,
    ...(call.calledAt === undefined ? {} : { calledAt: call.calledAt }),
  });
}

/** Credits spent since `since`. */
export async function feedCreditsSpent(
  exec: DbExecutor,
  provider: string,
  since: Date,
): Promise<number> {
  const [row] = await exec
    .select({ total: sql<string>`coalesce(sum(${feedApiCalls.cost}), 0)` })
    .from(feedApiCalls)
    .where(and(eq(feedApiCalls.provider, provider), gte(feedApiCalls.calledAt, since)));
  return Number(row?.total ?? 0);
}

/** The most recent quota the provider reported, or null before any call reported one. */
export async function latestFeedQuota(
  exec: DbExecutor,
  provider: string,
): Promise<{ remaining: number; used: number | null; at: Date } | null> {
  const [row] = await exec
    .select({
      remaining: feedApiCalls.remaining,
      used: feedApiCalls.used,
      at: feedApiCalls.calledAt,
    })
    .from(feedApiCalls)
    .where(and(eq(feedApiCalls.provider, provider), isNotNull(feedApiCalls.remaining)))
    .orderBy(desc(feedApiCalls.calledAt), desc(feedApiCalls.id))
    .limit(1);
  return row === undefined || row.remaining === null
    ? null
    : { remaining: row.remaining, used: row.used, at: row.at };
}

/** Deletes call records older than `before`; returns how many. */
export async function pruneFeedCalls(
  exec: DbExecutor,
  provider: string,
  before: Date,
): Promise<number> {
  const rows = await exec
    .delete(feedApiCalls)
    .where(and(eq(feedApiCalls.provider, provider), lt(feedApiCalls.calledAt, before)))
    .returning({ id: feedApiCalls.id });
  return rows.length;
}

export interface FeedEventRef {
  id: string;
  feedRef: string;
  status: (typeof events.$inferSelect)['status'];
  startTime: Date;
  competitionId: string;
  oddsUpdatedAt: Date | null;
  stateChangedAt: Date;
}

/** The provider's events with these references, keyed by reference. */
export async function feedEventsByRef(
  exec: DbExecutor,
  provider: string,
  refs: readonly string[],
): Promise<Map<string, FeedEventRef>> {
  if (refs.length === 0) return new Map();
  const rows = await exec
    .select({
      id: events.id,
      feedRef: events.feedRef,
      status: events.status,
      startTime: events.startTime,
      competitionId: events.competitionId,
      oddsUpdatedAt: events.oddsUpdatedAt,
      stateChangedAt: events.stateChangedAt,
    })
    .from(events)
    .where(and(eq(events.feedProvider, provider), inArray(events.feedRef, [...new Set(refs)])));
  return new Map(rows.map((row) => [row.feedRef, row]));
}

/**
 * The provider's unresulted events of a competition that started in
 * [from, to): the ones whose scores the poller still needs.
 */
export async function startedFeedEvents(
  exec: DbExecutor,
  provider: string,
  competitionId: string,
  from: Date,
  to: Date,
): Promise<FeedEventRef[]> {
  return exec
    .select({
      id: events.id,
      feedRef: events.feedRef,
      status: events.status,
      startTime: events.startTime,
      competitionId: events.competitionId,
      oddsUpdatedAt: events.oddsUpdatedAt,
      stateChangedAt: events.stateChangedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, provider),
        eq(events.competitionId, competitionId),
        inArray(events.status, ['scheduled', 'live']),
        gte(events.startTime, from),
        lt(events.startTime, to),
      ),
    )
    .orderBy(asc(events.startTime));
}

/**
 * The provider's events that still show open markets on prices older than
 * their limit: scheduled ones not started yet (and starting before
 * `startsBefore`, when given) priced before `prematchBefore` (or never), and
 * live ones priced before `liveBefore`.
 */
export async function staleFeedEvents(
  exec: DbExecutor,
  provider: string,
  limits: { now: Date; prematchBefore: Date; liveBefore: Date; startsBefore?: Date },
): Promise<string[]> {
  const rows = await exec
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, provider),
        or(
          and(
            eq(events.status, 'scheduled'),
            sql`${events.startTime} > ${limits.now}`,
            limits.startsBefore === undefined
              ? undefined
              : sql`${events.startTime} < ${limits.startsBefore}`,
            or(isNull(events.oddsUpdatedAt), lt(events.oddsUpdatedAt, limits.prematchBefore)),
          ),
          and(
            eq(events.status, 'live'),
            or(isNull(events.oddsUpdatedAt), lt(events.oddsUpdatedAt, limits.liveBefore)),
          ),
        ),
        sql`EXISTS (SELECT 1 FROM ${markets} WHERE ${markets.eventId} = ${events.id} AND ${markets.status} = 'open')`,
      ),
    );
  return rows.map((row) => row.id);
}

/** The provider's scheduled or live events that started before `startedBefore` without a result. */
export async function overdueFeedEvents(
  exec: DbExecutor,
  provider: string,
  startedBefore: Date,
): Promise<Array<{ id: string; startTime: Date }>> {
  return exec
    .select({ id: events.id, startTime: events.startTime })
    .from(events)
    .where(
      and(
        eq(events.feedProvider, provider),
        inArray(events.status, ['scheduled', 'live']),
        lt(events.startTime, startedBefore),
      ),
    )
    .orderBy(asc(events.startTime));
}

export type FeedReviewReason = 'cup' | 'tennis' | 'overdue' | 'unreadable';

export interface FeedResultInput {
  eventId: string;
  provider: string;
  /** The final score, or null when there is none (an overdue event). */
  score: { home: number; away: number } | null;
  seenAt: Date;
  /** Why staff must confirm it; null to apply it automatically. A reason once set stays. */
  reviewReason: FeedReviewReason | null;
}

/**
 * Records a final score the feed reported. A new or different score
 * (re)starts the confirmation wait (`first_seen_at`); the same score moves
 * `last_seen_at`. A result already applied is left alone. Returns the row.
 */
export async function recordFeedResult(
  exec: DbExecutor,
  input: FeedResultInput,
): Promise<FeedResultRow> {
  const home = input.score?.home ?? null;
  const away = input.score?.away ?? null;
  for (const value of [home, away]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`invalid feed score ${String(value)}`);
    }
  }
  const sameScore = sql`${feedResults.scoreHome} IS NOT DISTINCT FROM ${home} AND ${feedResults.scoreAway} IS NOT DISTINCT FROM ${away}`;
  const [row] = await exec
    .insert(feedResults)
    .values({
      eventId: input.eventId,
      provider: input.provider,
      scoreHome: home,
      scoreAway: away,
      firstSeenAt: input.seenAt,
      lastSeenAt: input.seenAt,
      reviewReason: input.reviewReason,
    })
    .onConflictDoUpdate({
      target: feedResults.eventId,
      set: {
        scoreHome: sql`CASE WHEN ${feedResults.appliedAt} IS NULL THEN excluded.score_home ELSE ${feedResults.scoreHome} END`,
        scoreAway: sql`CASE WHEN ${feedResults.appliedAt} IS NULL THEN excluded.score_away ELSE ${feedResults.scoreAway} END`,
        firstSeenAt: sql`CASE WHEN ${feedResults.appliedAt} IS NULL AND NOT (${sameScore}) THEN excluded.first_seen_at ELSE ${feedResults.firstSeenAt} END`,
        lastSeenAt: sql`CASE WHEN ${feedResults.appliedAt} IS NULL THEN excluded.last_seen_at ELSE ${feedResults.lastSeenAt} END`,
        reviewReason: sql`coalesce(${feedResults.reviewReason}, excluded.review_reason)`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (row === undefined) throw new Error(`feed result of ${input.eventId} was not written`);
  return row;
}

/**
 * Results to apply now: not applied, no review needed, a score, first seen
 * at or before `readyBefore` and seen again since (the score stood across
 * at least two polls).
 */
export async function dueFeedResults(
  exec: DbExecutor,
  provider: string,
  readyBefore: Date,
): Promise<FeedResultRow[]> {
  return exec
    .select()
    .from(feedResults)
    .where(
      and(
        eq(feedResults.provider, provider),
        isNull(feedResults.appliedAt),
        isNull(feedResults.reviewReason),
        isNotNull(feedResults.scoreHome),
        lte(feedResults.firstSeenAt, readyBefore),
        sql`${feedResults.lastSeenAt} > ${feedResults.firstSeenAt}`,
      ),
    )
    .orderBy(asc(feedResults.firstSeenAt));
}

/** Results waiting for staff (the back office review queue). */
export async function feedResultsForReview(
  exec: DbExecutor,
  provider: string,
): Promise<FeedResultRow[]> {
  return exec
    .select()
    .from(feedResults)
    .where(
      and(
        eq(feedResults.provider, provider),
        isNull(feedResults.appliedAt),
        isNotNull(feedResults.reviewReason),
      ),
    )
    .orderBy(asc(feedResults.firstSeenAt));
}

export async function markFeedResultApplied(
  exec: DbExecutor,
  eventId: string,
  at: Date,
): Promise<void> {
  await exec
    .update(feedResults)
    .set({ appliedAt: at, updatedAt: sql`now()` })
    .where(and(eq(feedResults.eventId, eventId), isNull(feedResults.appliedAt)));
}

/** Events of the provider with a feed result not applied yet (waiting or under review). */
export async function pendingFeedResultIds(
  exec: DbExecutor,
  provider: string,
): Promise<Set<string>> {
  const rows = await exec
    .select({ eventId: feedResults.eventId })
    .from(feedResults)
    .where(and(eq(feedResults.provider, provider), isNull(feedResults.appliedAt)));
  return new Set(rows.map((row) => row.eventId));
}
