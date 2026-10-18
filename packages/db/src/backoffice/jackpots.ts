import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { domainNotFound, domainUnprocessable } from '../errors';
import { cancelJackpotRound, type CancelJackpotRoundResult } from '../jackpots/cancel';
import { toJackpotRounds } from '../jackpots/queries';
import {
  parseSettlement,
  type JackpotRound,
  type JackpotRoundSettlement,
  type JackpotRoundStatus,
  type JackpotTemplateCode,
} from '../jackpots/types';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { users } from '../schema/accounts';
import { jackpotEntries, jackpotRounds } from '../schema/jackpots';
import { decodeCursor, encodeCursor, pageLimit, type Page, type StaffActor } from './common';

/**
 * Jackpots in the back office (jackpots.manage): rounds with their entry
 * totals, the entries of a round, and cancelling a round before its first
 * kick-off (cancelJackpotRound refunds every entry through settlement).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaffJackpotRound extends JackpotRound {
  /** Entries in the round and their cost. */
  entries: number;
  stakes: bigint;
  /** Entries still to be settled. */
  openEntries: number;
  /**
   * The round's decision as stored, also while its entries are still being
   * paid or refunded (`settlement` is only set once the round is final).
   */
  decision: JackpotRoundSettlement | null;
}

/**
 * Rounds, the latest closing first (cursor paging), optionally by status
 * and template, with entry totals.
 */
export async function listStaffJackpotRounds(
  exec: DbExecutor,
  options: {
    statuses?: JackpotRoundStatus[];
    templateCode?: JackpotTemplateCode;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<Page<StaffJackpotRound>> {
  const limit = pageLimit(options.limit, 25, 100);
  const conditions: SQL[] = [];
  if (options.statuses !== undefined && options.statuses.length > 0) {
    conditions.push(inArray(jackpotRounds.status, options.statuses));
  }
  if (options.templateCode !== undefined) {
    conditions.push(eq(jackpotRounds.templateCode, options.templateCode));
  }
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    conditions.push(
      or(
        lt(jackpotRounds.closesAt, cursor.at),
        and(eq(jackpotRounds.closesAt, cursor.at), lt(jackpotRounds.id, cursor.id)),
      )!,
    );
  }
  const rows = await exec
    .select()
    .from(jackpotRounds)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(jackpotRounds.closesAt), desc(jackpotRounds.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const rounds = await toJackpotRounds(exec, page);
  const totals = new Map<string, { entries: number; stakes: bigint; open: number }>();
  if (page.length > 0) {
    const sums = await exec
      .select({
        roundId: jackpotEntries.roundId,
        entries: sql<number>`count(*)::int`,
        stakes: sql<string>`COALESCE(sum(${jackpotEntries.cost}), 0)::text`,
        open: sql<number>`count(*) FILTER (WHERE ${jackpotEntries.status} = 'open')::int`,
      })
      .from(jackpotEntries)
      .where(
        inArray(
          jackpotEntries.roundId,
          page.map((row) => row.id),
        ),
      )
      .groupBy(jackpotEntries.roundId);
    for (const row of sums) {
      totals.set(row.roundId, { entries: row.entries, stakes: BigInt(row.stakes), open: row.open });
    }
  }
  const decisions = new Map(
    page.map((row) => [row.id, row.settlement === null ? null : parseSettlement(row.settlement)]),
  );
  const last = page.at(-1);
  return {
    items: rounds.map((round) => ({
      ...round,
      entries: totals.get(round.id)?.entries ?? 0,
      stakes: totals.get(round.id)?.stakes ?? 0n,
      openEntries: totals.get(round.id)?.open ?? 0,
      decision: decisions.get(round.id) ?? null,
    })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.closesAt, id: last.id })
        : null,
  };
}

/** An entry as the back office shows it. */
export interface StaffJackpotEntry {
  id: string;
  roundId: string;
  userId: string;
  phone: string;
  status: 'open' | 'won' | 'lost' | 'void';
  channel: string;
  picks: Array<Array<'1' | 'X' | '2'>>;
  combinations: number;
  cost: bigint;
  bestCorrect: number | null;
  prizeGross: bigint | null;
  prizeTax: bigint | null;
  prizeNet: bigint | null;
  placedAt: Date;
  settledAt: Date | null;
}

/** The entries of a round, oldest first (cursor paging). 404 for an unknown round. */
export async function listStaffJackpotEntries(
  exec: DbExecutor,
  roundId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<Page<StaffJackpotEntry>> {
  if (!UUID_RE.test(roundId)) throw domainNotFound('Jackpot round');
  const [round] = await exec
    .select({ id: jackpotRounds.id })
    .from(jackpotRounds)
    .where(eq(jackpotRounds.id, roundId));
  if (round === undefined) throw domainNotFound('Jackpot round');
  const limit = pageLimit(options.limit, 50, 200);
  const conditions: SQL[] = [eq(jackpotEntries.roundId, roundId)];
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    conditions.push(
      or(
        gt(jackpotEntries.placedAt, cursor.at),
        and(eq(jackpotEntries.placedAt, cursor.at), gt(jackpotEntries.id, cursor.id)),
      )!,
    );
  }
  const rows = await exec
    .select({
      id: jackpotEntries.id,
      roundId: jackpotEntries.roundId,
      userId: jackpotEntries.userId,
      phone: users.phone,
      status: jackpotEntries.status,
      channel: jackpotEntries.channel,
      picks: jackpotEntries.picks,
      combinations: jackpotEntries.combinations,
      cost: jackpotEntries.cost,
      bestCorrect: jackpotEntries.bestCorrect,
      prizeGross: jackpotEntries.prizeGross,
      prizeTax: jackpotEntries.prizeTax,
      prizeNet: jackpotEntries.prizeNet,
      placedAt: jackpotEntries.placedAt,
      settledAt: jackpotEntries.settledAt,
    })
    .from(jackpotEntries)
    .innerJoin(users, eq(users.id, jackpotEntries.userId))
    .where(and(...conditions))
    .orderBy(asc(jackpotEntries.placedAt), asc(jackpotEntries.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.placedAt, id: last.id })
        : null,
  };
}

/**
 * Cancels a round before its first kick-off (cancelJackpotRound): 422
 * `reason_required`, 404 for an unknown round, 409
 * `jackpot_round_not_cancellable` once a game started or the round is
 * closed or final; repeating it is 'unchanged'. With entries the round is
 * closed with a void decision and the jackpot settlement refunds every
 * entry (run runJackpotSettlement after COMMIT to refund at once).
 */
export async function staffCancelJackpotRound(
  tx: DbTransaction,
  input: { roundId: string; reason: string; actor: StaffActor; now: Date },
): Promise<CancelJackpotRoundResult> {
  if (typeof input.actor?.adminId !== 'string' || input.actor.adminId.length === 0) {
    throw new RangeError('cancelling a jackpot round needs the admin id');
  }
  if (!UUID_RE.test(input.roundId)) throw domainNotFound('Jackpot round');
  const reason = input.reason?.trim() ?? '';
  if (reason.length === 0) {
    throw domainUnprocessable('reason_required', 'Say why the round is cancelled.');
  }
  return cancelJackpotRound(tx, {
    roundId: input.roundId,
    adminId: input.actor.adminId,
    reason,
    now: input.now,
    ip: input.actor.ip ?? null,
  });
}
