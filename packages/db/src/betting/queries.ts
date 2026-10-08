import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { domainBadRequest } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { betLegs, bets } from '../schema/betting';
import { isUuid, loadSelectionSnapshots } from './selections';
import { CLOSED_BET_STATUSES, OPEN_BET_STATUSES, type UserBet, type UserBetLeg } from './types';

export type BetRow = typeof bets.$inferSelect;
export type BetLegRow = typeof betLegs.$inferSelect;

/** Largest page of listUserBets. */
export const MAX_BET_PAGE_SIZE = 100;

/** Attaches legs (with their selection snapshots) to bet rows, keeping the row order. */
export async function toUserBets(exec: DbExecutor, rows: readonly BetRow[]): Promise<UserBet[]> {
  if (rows.length === 0) return [];
  const legRows = await exec
    .select()
    .from(betLegs)
    .where(
      inArray(
        betLegs.betId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(betLegs.betId), asc(betLegs.position));
  const snapshots = await loadSelectionSnapshots(
    exec,
    legRows.map((leg) => leg.selectionId),
  );
  const legsByBet = new Map<string, UserBetLeg[]>();
  for (const leg of legRows) {
    const selection = snapshots.get(leg.selectionId);
    if (selection === undefined) {
      throw new Error(`bet leg ${leg.id} references missing selection ${leg.selectionId}`);
    }
    const list = legsByBet.get(leg.betId) ?? [];
    list.push({
      id: leg.id,
      position: leg.position,
      selectionId: leg.selectionId,
      marketId: leg.marketId,
      eventId: leg.eventId,
      oddsMilli: leg.oddsMilli,
      requestedOddsMilli: leg.requestedOddsMilli,
      isLive: leg.isLive,
      state: leg.state,
      selection,
    });
    legsByBet.set(leg.betId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    shortId: row.shortId,
    userId: row.userId,
    betType: row.betType,
    status: row.status,
    stake: row.stake,
    totalOddsMilli: row.totalOddsMilli,
    potentialGrossPayout: row.potentialGrossPayout,
    potentialBonus: row.potentialBonus,
    potentialTax: row.potentialTax,
    potentialNetPayout: row.potentialNetPayout,
    bonusPercentBps: row.bonusPercentBps,
    oddsChangePolicy: row.oddsChangePolicy,
    channel: row.channel,
    settlementVersion: row.settlementVersion,
    settledGrossPayout: row.settledGrossPayout,
    settledTax: row.settledTax,
    settledNetPayout: row.settledNetPayout,
    placedAt: row.placedAt,
    acceptAfter: row.acceptAfter,
    acceptedAt: row.acceptedAt,
    settledAt: row.settledAt,
    rejectReason: row.rejectReason,
    legs: legsByBet.get(row.id) ?? [],
  }));
}

/** One bet of the player with its legs, or null when it does not exist or is someone else's. */
export async function getUserBet(
  exec: DbExecutor,
  userId: string,
  betId: string,
): Promise<UserBet | null> {
  if (!isUuid(betId) || !isUuid(userId)) return null;
  const rows = await exec
    .select()
    .from(bets)
    .where(and(eq(bets.id, betId), eq(bets.userId, userId)))
    .limit(1);
  const [bet] = await toUserBets(exec, rows);
  return bet ?? null;
}

/** Any bet by id, with its legs (back office, worker notifications). */
export async function getBetById(exec: DbExecutor, betId: string): Promise<UserBet | null> {
  if (!isUuid(betId)) return null;
  const rows = await exec.select().from(bets).where(eq(bets.id, betId)).limit(1);
  const [bet] = await toUserBets(exec, rows);
  return bet ?? null;
}

interface BetCursor {
  placedAt: Date;
  id: string;
}

/** Opaque page cursor: the (placed_at, id) of the last bet of the previous page. */
export function encodeBetCursor(bet: Pick<UserBet, 'placedAt' | 'id'>): string {
  return Buffer.from(`${bet.placedAt.getTime()}.${bet.id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor from encodeBetCursor; 400 `invalid_cursor` when it is not one. */
export function decodeBetCursor(cursor: string): BetCursor {
  const invalid = () =>
    domainBadRequest(
      'invalid_cursor',
      'The page cursor is not valid. Start again from the first page.',
    );
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 128) throw invalid();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(text);
  if (match === null) throw invalid();
  const [, millis, id] = match;
  const placedAt = new Date(Number(millis));
  if (id === undefined || !isUuid(id) || Number.isNaN(placedAt.getTime())) throw invalid();
  return { placedAt, id };
}

export interface ListUserBetsOptions {
  userId: string;
  /** open = pending acceptance or open; settled = won, lost, void, cashed out or rejected. */
  status: 'open' | 'settled';
  /** 1..MAX_BET_PAGE_SIZE. */
  limit: number;
  /** nextCursor of the previous page. */
  cursor?: string;
}

export interface UserBetPage {
  items: UserBet[];
  /** Cursor of the next page, or null on the last page. */
  nextCursor: string | null;
}

/** The player's bets, newest placement first, with keyset pagination. */
export async function listUserBets(
  exec: DbExecutor,
  options: ListUserBetsOptions,
): Promise<UserBetPage> {
  const { userId, limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BET_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_BET_PAGE_SIZE}`);
  }
  if (!isUuid(userId)) return { items: [], nextCursor: null };
  const statuses = options.status === 'open' ? OPEN_BET_STATUSES : CLOSED_BET_STATUSES;
  const conditions: SQL[] = [eq(bets.userId, userId), inArray(bets.status, [...statuses])];
  if (options.cursor !== undefined) {
    const cursor = decodeBetCursor(options.cursor);
    conditions.push(
      sql`(${bets.placedAt}, ${bets.id}) < (${cursor.placedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await exec
    .select()
    .from(bets)
    .where(and(...conditions))
    .orderBy(desc(bets.placedAt), desc(bets.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = await toUserBets(exec, page);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeBetCursor(last) : null,
  };
}
