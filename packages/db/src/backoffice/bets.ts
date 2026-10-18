import { birr, normalizeEthiopianMsisdn } from '@vamos/core';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getBetById } from '../betting/queries';
import type { BetStatus, UserBet } from '../betting/types';
import type { DbExecutor } from '../ledger/types';
import { users } from '../schema/accounts';
import { betLegs, bets } from '../schema/betting';
import { competitions, events, markets, selections, teams } from '../schema/catalog';
import type { LocalizedName } from '../schema/catalog';
import {
  afterCursor,
  cursorTime,
  decodeCursor,
  encodeCursor,
  pageLimit,
  type Page,
} from './common';

/**
 * Bets and risk in the back office (bets.view, risk.view). Reads only.
 *
 * Open bets are those `open` or `pending_acceptance`: their stakes sit in
 * house_stakes. A bet's potential payout is its potential gross payout
 * (bonus included, before tax): what the house pays out if every leg wins.
 */

const OPEN_STATUSES = ['open', 'pending_acceptance'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaffBetSummary {
  id: string;
  shortId: string;
  userId: string;
  phone: string;
  betType: 'single' | 'multi';
  status: BetStatus;
  channel: 'web' | 'sms' | 'ussd';
  stake: bigint;
  totalOddsMilli: bigint;
  potentialGrossPayout: bigint;
  potentialNetPayout: bigint;
  settledGrossPayout: bigint | null;
  settledTax: bigint | null;
  settledNetPayout: bigint | null;
  legCount: number;
  placedAt: Date;
  settledAt: Date | null;
}

export interface StaffBetFilter {
  /** A bet's short id (case-insensitive). */
  shortId?: string;
  userId?: string;
  /** The player's phone number, any form. */
  phone?: string;
  statuses?: BetStatus[];
  /** Placement time window [from, to). */
  from?: Date;
  to?: Date;
  /** Bets with a leg on this event. */
  eventId?: string;
  /** Bets staking at least this (santim). */
  minStake?: bigint;
  /** Bets whose potential gross payout is at least this (santim). */
  minPotentialPayout?: bigint;
  limit?: number;
  cursor?: string;
}

const summaryFields = {
  id: bets.id,
  shortId: bets.shortId,
  userId: bets.userId,
  phone: users.phone,
  betType: bets.betType,
  status: bets.status,
  channel: bets.channel,
  stake: bets.stake,
  totalOddsMilli: bets.totalOddsMilli,
  potentialGrossPayout: bets.potentialGrossPayout,
  potentialNetPayout: bets.potentialNetPayout,
  settledGrossPayout: bets.settledGrossPayout,
  settledTax: bets.settledTax,
  settledNetPayout: bets.settledNetPayout,
  legCount: sql<number>`(SELECT count(*)::int FROM ${betLegs} WHERE ${betLegs.betId} = ${bets.id})`,
  placedAt: bets.placedAt,
  settledAt: bets.settledAt,
};

/** An empty page: a filter that cannot match anything (an unknown phone, a malformed id). */
const NOTHING: Page<StaffBetSummary> = { items: [], nextCursor: null };

/**
 * Bets of every player, newest first (cursor paging), filtered by short
 * id, player, status, placement time, event or size.
 */
export async function searchBets(
  exec: DbExecutor,
  filter: StaffBetFilter = {},
): Promise<Page<StaffBetSummary>> {
  const limit = pageLimit(filter.limit, 25, 100);
  const conditions: SQL[] = [];
  if (filter.shortId !== undefined && filter.shortId.trim().length > 0) {
    conditions.push(eq(bets.shortId, filter.shortId.trim().toUpperCase()));
  }
  if (filter.userId !== undefined) {
    if (!UUID_RE.test(filter.userId)) return NOTHING;
    conditions.push(eq(bets.userId, filter.userId));
  }
  if (filter.phone !== undefined && filter.phone.trim().length > 0) {
    const phone = normalizeEthiopianMsisdn(filter.phone.trim());
    if (phone === null) return NOTHING;
    conditions.push(eq(users.phone, phone));
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    conditions.push(inArray(bets.status, filter.statuses));
  }
  if (filter.from !== undefined) conditions.push(gte(bets.placedAt, filter.from));
  if (filter.to !== undefined) conditions.push(lt(bets.placedAt, filter.to));
  if (filter.eventId !== undefined) {
    if (!UUID_RE.test(filter.eventId)) return NOTHING;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${betLegs} WHERE ${betLegs.betId} = ${bets.id} AND ${betLegs.eventId} = ${filter.eventId})`,
    );
  }
  const big: SQL[] = [];
  if (filter.minStake !== undefined) big.push(gte(bets.stake, filter.minStake));
  if (filter.minPotentialPayout !== undefined) {
    big.push(gte(bets.potentialGrossPayout, filter.minPotentialPayout));
  }
  if (big.length > 0) conditions.push(or(...big)!);
  if (filter.cursor !== undefined) {
    conditions.push(afterCursor(bets.placedAt, bets.id, decodeCursor(filter.cursor), 'desc'));
  }
  const rows = await exec
    .select({ ...summaryFields, cursorAt: cursorTime(bets.placedAt) })
    .from(bets)
    .innerJoin(users, eq(users.id, bets.userId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(bets.placedAt), desc(bets.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => row),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.cursorAt, id: last.id })
        : null,
  };
}

/** One bet with its legs and the player's phone, or null. */
export async function getStaffBet(
  exec: DbExecutor,
  betId: string,
): Promise<(UserBet & { phone: string }) | null> {
  if (!UUID_RE.test(betId)) return null;
  const bet = await getBetById(exec, betId);
  if (bet === null) return null;
  const [user] = await exec
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, bet.userId));
  return { ...bet, phone: user?.phone ?? '' };
}

/** Defaults of the big-bets list: a stake of 10,000 ETB or a potential payout of 100,000 ETB. */
export const BIG_BET_MIN_STAKE = birr(10_000);
export const BIG_BET_MIN_POTENTIAL_PAYOUT = birr(100_000);

/**
 * Open bets staking at least `minStake` or able to pay at least
 * `minPotentialPayout` (gross), newest first: the risk screen's big bets.
 */
export async function listBigBets(
  exec: DbExecutor,
  options: {
    minStake?: bigint;
    minPotentialPayout?: bigint;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<Page<StaffBetSummary>> {
  return searchBets(exec, {
    statuses: [...OPEN_STATUSES],
    minStake: options.minStake ?? BIG_BET_MIN_STAKE,
    minPotentialPayout: options.minPotentialPayout ?? BIG_BET_MIN_POTENTIAL_PAYOUT,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

/** The exposure on one selection from the open bets with an open leg on it. */
export interface SelectionLiability {
  selectionId: string;
  code: string;
  oddsMilli: number;
  marketId: string;
  marketKey: string;
  marketStatus: string;
  eventId: string;
  gameId: number;
  homeTeam: LocalizedName;
  awayTeam: LocalizedName;
  competition: LocalizedName;
  startTime: Date;
  eventStatus: string;
  /** Open bets with an open leg on the selection. */
  bets: number;
  /** Σ their stakes. */
  stake: bigint;
  /** Σ their potential gross payouts: paid if the selection and their other legs win. */
  liability: bigint;
  /** The same for the single bets alone (paid if the selection wins). */
  singlesStake: bigint;
  singlesLiability: bigint;
}

const homeTeams = alias(teams, 'home_team');
const awayTeams = alias(teams, 'away_team');

/**
 * Liability per selection over the open bets (risk.view), largest first:
 * for every selection with an open leg of an open (or pending) bet, the
 * number of such bets, their stakes and their potential gross payouts, in
 * total and for singles. Optionally for one event; `minLiability` drops
 * the small ones.
 */
export async function listSelectionLiabilities(
  exec: DbExecutor,
  options: { eventId?: string; minLiability?: bigint; limit?: number } = {},
): Promise<SelectionLiability[]> {
  const limit = pageLimit(options.limit, 50, 500);
  if (options.eventId !== undefined && !UUID_RE.test(options.eventId)) return [];
  const conditions: SQL[] = [eq(betLegs.state, 'open'), inArray(bets.status, [...OPEN_STATUSES])];
  if (options.eventId !== undefined) conditions.push(eq(betLegs.eventId, options.eventId));
  const liability = sql<string>`sum(${bets.potentialGrossPayout})`;
  const rows = await exec
    .select({
      selectionId: selections.id,
      code: selections.code,
      oddsMilli: selections.oddsMilli,
      marketId: markets.id,
      marketKey: markets.key,
      marketStatus: markets.status,
      eventId: events.id,
      gameId: events.gameId,
      homeTeam: homeTeams.name,
      awayTeam: awayTeams.name,
      competition: competitions.name,
      startTime: events.startTime,
      eventStatus: events.status,
      bets: sql<number>`count(*)::int`,
      stake: sql<string>`sum(${bets.stake})::text`,
      liability: sql<string>`${liability}::text`,
      singlesStake: sql<string>`COALESCE(sum(${bets.stake}) FILTER (WHERE ${bets.betType} = 'single'), 0)::text`,
      singlesLiability: sql<string>`COALESCE(sum(${bets.potentialGrossPayout}) FILTER (WHERE ${bets.betType} = 'single'), 0)::text`,
    })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .innerJoin(selections, eq(selections.id, betLegs.selectionId))
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .innerJoin(events, eq(events.id, markets.eventId))
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(and(...conditions))
    .groupBy(selections.id, markets.id, events.id, competitions.id, homeTeams.id, awayTeams.id)
    .having(
      options.minLiability === undefined
        ? undefined
        : sql`${liability} >= ${options.minLiability.toString()}::numeric`,
    )
    .orderBy(sql`${liability} DESC`, selections.id)
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    stake: BigInt(row.stake),
    liability: BigInt(row.liability),
    singlesStake: BigInt(row.singlesStake),
    singlesLiability: BigInt(row.singlesLiability),
  }));
}
