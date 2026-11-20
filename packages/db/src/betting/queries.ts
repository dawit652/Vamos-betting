import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { domainBadRequest } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { betLegs, bets } from '../schema/betting';
import { isUuid, loadSelectionSnapshots, type SelectionSnapshot } from './selections';
import {
  CLOSED_BET_STATUSES,
  OPEN_BET_STATUSES,
  parseTerms,
  type UserBet,
  type UserBetLeg,
} from './types';

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
  return assembleUserBets(rows, legRows, snapshots);
}

/**
 * Builds bet views from rows already loaded (pure): `legRows` ordered by bet and position, and
 * the snapshots of their selections keyed by selection id. Keeps the order of `rows`; throws when
 * a leg's selection has no snapshot.
 */
export function assembleUserBets(
  rows: readonly BetRow[],
  legRows: readonly BetLegRow[],
  snapshots: ReadonlyMap<string, SelectionSnapshot>,
): UserBet[] {
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
    terms: parseTerms(row.terms),
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
    cashedOut: cashedOutOf(row),
    legs: legsByBet.get(row.id) ?? [],
  }));
}

/** What a cashed-out bet's cash-out paid (from its settled_* columns), else null. */
function cashedOutOf(row: BetRow): UserBet['cashedOut'] {
  if (row.status !== 'cashed_out') return null;
  const { settledGrossPayout, settledTax, settledNetPayout, settledAt } = row;
  if (
    settledGrossPayout === null ||
    settledTax === null ||
    settledNetPayout === null ||
    settledAt === null
  ) {
    throw new Error(`cashed-out bet ${row.id} has no settled amounts`);
  }
  return {
    gross: settledGrossPayout,
    tax: settledTax,
    net: settledNetPayout,
    cashedOutAt: settledAt,
  };
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

/** 9999-12-31T23:59:59.999Z: the latest time a cursor can carry. */
const MAX_CURSOR_MS = 253_402_300_799_999;

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
  const ms = Number(millis);
  // After year 9999 toISOString() gives an extended year ('+033658-…') that
  // Postgres refuses to cast; no bet is placed that late anyway.
  if (!Number.isSafeInteger(ms) || ms > MAX_CURSOR_MS) throw invalid();
  const placedAt = new Date(ms);
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
