import type {
  JackpotEntryRequest,
  JackpotEntryView,
  JackpotListQuery,
  JackpotListResponse,
  JackpotRoundView,
  MyJackpotEntriesQuery,
  MyJackpotEntriesResponse,
  PromotionsResponse,
} from '@vamos/contracts';
import {
  getJackpotRound,
  getPromotions,
  getUserJackpotEntry,
  listOpenJackpotRounds,
  listRecentJackpotRounds,
  listUserJackpotEntries,
  placeJackpotEntry,
  withTxRetry,
} from '@vamos/db';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import { jackpotEntryView, jackpotRoundView, multiBonusView } from './views';

/** GET /jackpots: every open round and a page of past rounds (optionally of one template). */
export async function listJackpots(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  query: JackpotListQuery,
): Promise<JackpotListResponse> {
  const now = deps.clock();
  const templateCode = query.template;
  const [open, recent] = await Promise.all([
    listOpenJackpotRounds(deps.db, {
      now,
      ...(templateCode === undefined ? {} : { templateCode }),
    }),
    listRecentJackpotRounds(deps.db, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(templateCode === undefined ? {} : { templateCode }),
    }),
  ]);
  return {
    open: open.map(jackpotRoundView),
    recent: recent.items.map(jackpotRoundView),
    nextCursor: recent.nextCursor,
  };
}

/** GET /jackpots/:id; 404 for an unknown (or malformed) id. */
export async function getJackpot(
  deps: Pick<AppDeps, 'db'>,
  roundId: string,
): Promise<JackpotRoundView> {
  const round = await getJackpotRound(deps.db, roundId);
  if (round === null) throw notFound('Jackpot round');
  return jackpotRoundView(round);
}

export interface PlaceJackpotEntryCommand {
  userId: string;
  roundId: string;
  idempotencyKey: string;
  request: JackpotEntryRequest;
  ip?: string | null;
}

export interface PlacedJackpotEntry {
  entry: JackpotEntryView;
  /** true when the idempotency key had been used already (nothing was written). */
  replayed: boolean;
}

/**
 * Places a jackpot entry in one transaction (see placeJackpotEntry in
 * @vamos/db for the order of checks and their DomainErrors), retried when
 * Postgres aborts it with a deadlock or serialization failure: nothing of
 * the failed try is committed and the entry is keyed by its idempotency key.
 */
export async function placePlayerJackpotEntry(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  command: PlaceJackpotEntryCommand,
): Promise<PlacedJackpotEntry> {
  const now = deps.clock();
  const result = await withTxRetry(deps.db, (tx) =>
    placeJackpotEntry(tx, {
      userId: command.userId,
      roundId: command.roundId,
      picks: command.request.picks,
      idempotencyKey: command.idempotencyKey,
      now,
      channel: 'web',
      ip: command.ip ?? null,
    }),
  );
  return { entry: jackpotEntryView(result.entry), replayed: result.replayed };
}

/** GET /me/jackpot-entries: the player's entries, newest first. */
export async function listMyJackpotEntries(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  query: MyJackpotEntriesQuery,
): Promise<MyJackpotEntriesResponse> {
  const page = await listUserJackpotEntries(deps.db, {
    userId,
    limit: query.limit,
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return { items: page.items.map(jackpotEntryView), nextCursor: page.nextCursor };
}

/** GET /me/jackpot-entries/:id; 404 for an unknown id or someone else's entry. */
export async function getMyJackpotEntry(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  entryId: string,
): Promise<JackpotEntryView> {
  const entry = await getUserJackpotEntry(deps.db, userId, entryId);
  if (entry === null) throw notFound('Jackpot entry');
  return jackpotEntryView(entry);
}

/** GET /promotions: the multi-bonus ladder in force and the open jackpot rounds. */
export async function listPromotions(
  deps: Pick<AppDeps, 'db' | 'clock'>,
): Promise<PromotionsResponse> {
  const promotions = await getPromotions(deps.db, deps.clock());
  return {
    multiBonus: multiBonusView(promotions.multiBonus),
    jackpots: promotions.jackpots.map(jackpotRoundView),
  };
}
