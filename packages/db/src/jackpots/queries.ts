import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { decodeBetCursor, encodeBetCursor } from '../betting/queries';
import { isUuid } from '../betting/selections';
import type { DbExecutor } from '../ledger/types';
import { jackpotEntries, jackpotRounds } from '../schema/jackpots';
import { loadJackpotGames } from './games';
import {
  parseRoundTerms,
  parseSettlement,
  PAST_ROUND_STATUSES,
  SETTLED_ENTRY_STATUSES,
  type JackpotEntryRow,
  type JackpotGame,
  type JackpotRound,
  type JackpotRoundRow,
  type JackpotTemplateCode,
  type UserJackpotEntry,
} from './types';

/** Largest page of the round and entry lists. */
export const MAX_JACKPOT_PAGE_SIZE = 100;

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JACKPOT_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_JACKPOT_PAGE_SIZE}`);
  }
}

/** Round rows with their games, keeping the row order. */
export async function toJackpotRounds(
  exec: DbExecutor,
  rows: readonly JackpotRoundRow[],
): Promise<JackpotRound[]> {
  if (rows.length === 0) return [];
  const games = await loadJackpotGames(
    exec,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const terms = parseRoundTerms(row.terms);
    return {
      id: row.id,
      templateCode: terms.template.code,
      status: row.status,
      template: terms.template,
      tax: terms.tax,
      gameCount: row.gameCount,
      costPerCombination: row.costPerCombination,
      maxCombinations: row.maxCombinations,
      pool: row.pool,
      closesAt: row.closesAt,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      settledAt: row.settledAt,
      settlement: row.settlement === null ? null : parseSettlement(row.settlement),
      resultsFlaggedAt: row.resultsFlaggedAt,
      games: (games.get(row.id) ?? []).map((game): JackpotGame => ({
        position: game.position,
        eventId: game.eventId,
        marketId: game.marketId,
        selectionIds: game.selectionIds,
        gameId: game.gameId,
        sportId: game.sportId,
        competitionName: game.competitionName,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        startTime: game.startTime,
        eventStatus: game.eventStatus,
        scoreHome: game.scoreHome,
        scoreAway: game.scoreAway,
        odds: game.odds,
        result: game.result,
      })),
    };
  });
}

/** One round with its games, or null when there is no such round. */
export async function getJackpotRound(
  exec: DbExecutor,
  roundId: string,
): Promise<JackpotRound | null> {
  if (!isUuid(roundId)) return null;
  const rows = await exec.select().from(jackpotRounds).where(eq(jackpotRounds.id, roundId));
  const [round] = await toJackpotRounds(exec, rows);
  return round ?? null;
}

/**
 * The rounds taking entries now (status open, closing after `now`), soonest
 * closing first, optionally of one template only.
 */
export async function listOpenJackpotRounds(
  exec: DbExecutor,
  options: { now: Date; templateCode?: JackpotTemplateCode },
): Promise<JackpotRound[]> {
  const conditions: SQL[] = [
    eq(jackpotRounds.status, 'open'),
    gt(jackpotRounds.closesAt, options.now),
  ];
  if (options.templateCode !== undefined) {
    conditions.push(eq(jackpotRounds.templateCode, options.templateCode));
  }
  const rows = await exec
    .select()
    .from(jackpotRounds)
    .where(and(...conditions))
    .orderBy(asc(jackpotRounds.closesAt), asc(jackpotRounds.id))
    .limit(MAX_JACKPOT_PAGE_SIZE);
  return toJackpotRounds(exec, rows);
}

/** Opaque page cursor of the round history: the (closes_at, id) of the last round shown. */
export function encodeRoundCursor(round: Pick<JackpotRound, 'closesAt' | 'id'>): string {
  return encodeBetCursor({ placedAt: round.closesAt, id: round.id });
}

export interface JackpotRoundPage {
  items: JackpotRound[];
  /** Cursor of the next page, or null on the last page. */
  nextCursor: string | null;
}

/**
 * Rounds no longer taking entries (closed, settled or cancelled), the
 * latest closing first, with keyset pagination (400 `invalid_cursor` for a
 * cursor that is not one), optionally of one template only.
 */
export async function listRecentJackpotRounds(
  exec: DbExecutor,
  options: { limit: number; cursor?: string; templateCode?: JackpotTemplateCode },
): Promise<JackpotRoundPage> {
  checkLimit(options.limit);
  const conditions: SQL[] = [inArray(jackpotRounds.status, [...PAST_ROUND_STATUSES])];
  if (options.templateCode !== undefined) {
    conditions.push(eq(jackpotRounds.templateCode, options.templateCode));
  }
  if (options.cursor !== undefined) {
    const cursor = decodeBetCursor(options.cursor);
    conditions.push(
      sql`(${jackpotRounds.closesAt}, ${jackpotRounds.id}) < (${cursor.placedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await exec
    .select()
    .from(jackpotRounds)
    .where(and(...conditions))
    .orderBy(desc(jackpotRounds.closesAt), desc(jackpotRounds.id))
    .limit(options.limit + 1);
  const items = await toJackpotRounds(exec, rows.slice(0, options.limit));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > options.limit && last !== undefined ? encodeRoundCursor(last) : null,
  };
}

function toBigInts(values: readonly string[] | null): bigint[] | null {
  return values === null ? null : values.map((value) => BigInt(value));
}

/** Entry rows with their rounds (and the rounds' games), keeping the row order. */
export async function toUserJackpotEntries(
  exec: DbExecutor,
  rows: readonly JackpotEntryRow[],
): Promise<UserJackpotEntry[]> {
  if (rows.length === 0) return [];
  const roundIds = [...new Set(rows.map((row) => row.roundId))];
  const roundRows = await exec
    .select()
    .from(jackpotRounds)
    .where(inArray(jackpotRounds.id, roundIds));
  const rounds = new Map((await toJackpotRounds(exec, roundRows)).map((r) => [r.id, r]));
  return rows.map((row) => {
    const round = rounds.get(row.roundId);
    if (round === undefined) throw new Error(`jackpot entry ${row.id} has no round`);
    return {
      id: row.id,
      userId: row.userId,
      roundId: row.roundId,
      status: row.status,
      channel: row.channel,
      picks: row.picks,
      combinations: row.combinations,
      cost: row.cost,
      correct: toBigInts(row.correct),
      bestCorrect: row.bestCorrect,
      prizeGross: row.prizeGross,
      prizeTax: row.prizeTax,
      prizeNet: row.prizeNet,
      refund: row.status === 'void' ? row.cost : null,
      placedAt: row.placedAt,
      settledAt: row.settledAt,
      round,
    };
  });
}

/** One entry of the player, or null when it does not exist or is someone else's. */
export async function getUserJackpotEntry(
  exec: DbExecutor,
  userId: string,
  entryId: string,
): Promise<UserJackpotEntry | null> {
  if (!isUuid(entryId) || !isUuid(userId)) return null;
  const rows = await exec
    .select()
    .from(jackpotEntries)
    .where(and(eq(jackpotEntries.id, entryId), eq(jackpotEntries.userId, userId)))
    .limit(1);
  const [entry] = await toUserJackpotEntries(exec, rows);
  return entry ?? null;
}

export interface ListUserJackpotEntriesOptions {
  userId: string;
  /** open = the round has not settled yet; settled = won, lost or void; omitted = all. */
  status?: 'open' | 'settled';
  /** 1..MAX_JACKPOT_PAGE_SIZE. */
  limit: number;
  /** nextCursor of the previous page. */
  cursor?: string;
}

export interface UserJackpotEntryPage {
  items: UserJackpotEntry[];
  nextCursor: string | null;
}

/**
 * The player's entries, newest first, with keyset pagination on
 * (placed_at, id) (400 `invalid_cursor` for a cursor that is not one).
 */
export async function listUserJackpotEntries(
  exec: DbExecutor,
  options: ListUserJackpotEntriesOptions,
): Promise<UserJackpotEntryPage> {
  checkLimit(options.limit);
  if (!isUuid(options.userId)) return { items: [], nextCursor: null };
  const conditions: SQL[] = [eq(jackpotEntries.userId, options.userId)];
  if (options.status === 'open') conditions.push(eq(jackpotEntries.status, 'open'));
  if (options.status === 'settled') {
    conditions.push(inArray(jackpotEntries.status, [...SETTLED_ENTRY_STATUSES]));
  }
  if (options.cursor !== undefined) {
    const cursor = decodeBetCursor(options.cursor);
    conditions.push(
      sql`(${jackpotEntries.placedAt}, ${jackpotEntries.id}) < (${cursor.placedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await exec
    .select()
    .from(jackpotEntries)
    .where(and(...conditions))
    .orderBy(desc(jackpotEntries.placedAt), desc(jackpotEntries.id))
    .limit(options.limit + 1);
  const items = await toUserJackpotEntries(exec, rows.slice(0, options.limit));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > options.limit && last !== undefined
        ? encodeBetCursor({ placedAt: last.placedAt, id: last.id })
        : null,
  };
}
