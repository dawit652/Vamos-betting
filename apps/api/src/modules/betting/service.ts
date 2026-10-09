import type {
  BetView,
  BookingCodeResponse,
  CreateBookingCodeRequest,
  MyBetsQuery,
  MyBetsResponse,
  PlaceBetRequest,
  QuoteRequest,
  QuoteResponse,
} from '@vamos/contracts';
import {
  createBookingCode,
  getUserBet,
  listUserBets,
  loadBookingCode,
  loadGameSettings,
  placeBet,
  quoteSlip,
  type DbExecutor,
  type GameSettings,
} from '@vamos/db';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import { betView, bookingCodeView, quoteView } from './views';

/** How long read paths (quotes, booking codes) reuse loaded settings. */
export const SETTINGS_CACHE_TTL_MS = 5_000;

interface CachedSettings {
  loadedAt: number;
  settings: Promise<GameSettings>;
}

const settingsCache = new WeakMap<AppDeps['db'], CachedSettings>();

/**
 * Game settings for read paths: loaded at most once per SETTINGS_CACHE_TTL_MS
 * (by `deps.clock`) per database. Bet placement does not use this; it loads
 * the settings in its own transaction so the bet keeps the current terms.
 */
export async function cachedGameSettings(
  deps: Pick<AppDeps, 'db' | 'clock'>,
): Promise<GameSettings> {
  const now = deps.clock().getTime();
  const cached = settingsCache.get(deps.db);
  if (
    cached !== undefined &&
    now >= cached.loadedAt &&
    now - cached.loadedAt < SETTINGS_CACHE_TTL_MS
  ) {
    return cached.settings;
  }
  const settings = loadGameSettings(deps.db);
  settingsCache.set(deps.db, { loadedAt: now, settings });
  try {
    return await settings;
  } catch (error) {
    // Never keep a failed load.
    if (settingsCache.get(deps.db)?.settings === settings) settingsCache.delete(deps.db);
    throw error;
  }
}

/** Drops the cached settings (tests and the back office after an edit). */
export function clearGameSettingsCache(db: AppDeps['db']): void {
  settingsCache.delete(db);
}

/** Current odds, availability and the potential payout of a betslip. */
export async function quoteBetslip(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  input: QuoteRequest,
): Promise<QuoteResponse> {
  const settings = await cachedGameSettings(deps);
  const slip = await quoteSlip(deps.db, {
    legs: input.legs.map((leg) => ({
      selectionId: leg.selectionId,
      ...(leg.oddsMilli === undefined ? {} : { oddsMilli: leg.oddsMilli }),
    })),
    stake: BigInt(input.stake),
    settings,
    now: deps.clock(),
  });
  return quoteView(slip);
}

export interface PlaceBetCommand {
  userId: string;
  idempotencyKey: string;
  request: PlaceBetRequest;
  ip?: string | null;
}

export interface PlacedBet {
  bet: BetView;
  /** true when the idempotency key had been used already (nothing was written). */
  replayed: boolean;
}

/**
 * Places a bet in one transaction (see placeBet in @vamos/db for the order
 * of checks and their errors), with the settings loaded in that transaction.
 */
export async function placePlayerBet(
  deps: Pick<AppDeps, 'db' | 'clock' | 'randomBytes'>,
  command: PlaceBetCommand,
): Promise<PlacedBet> {
  const now = deps.clock();
  const { request } = command;
  const result = await deps.db.transaction(async (tx) => {
    const settings = await loadGameSettings(tx);
    return placeBet(tx, {
      userId: command.userId,
      legs: request.legs.map((leg) => ({ selectionId: leg.selectionId, oddsMilli: leg.oddsMilli })),
      stake: BigInt(request.stake),
      policy: request.oddsChangePolicy,
      channel: 'web',
      idempotencyKey: command.idempotencyKey,
      now,
      settings,
      randomBytes: deps.randomBytes,
      ip: command.ip ?? null,
    });
  });
  return { bet: betView(result.bet), replayed: result.replayed };
}

/** The player's bets, newest first (`open` or `settled` tab). */
export async function listMyBets(
  exec: DbExecutor,
  userId: string,
  query: MyBetsQuery,
): Promise<MyBetsResponse> {
  const page = await listUserBets(exec, {
    userId,
    status: query.status,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return { items: page.items.map(betView), nextCursor: page.nextCursor };
}

/** One of the player's bets; 404 for an unknown id or someone else's bet. */
export async function getMyBet(exec: DbExecutor, userId: string, betId: string): Promise<BetView> {
  const bet = await getUserBet(exec, userId, betId);
  if (bet === null) throw notFound('Bet');
  return betView(bet);
}

/** Shares a betslip under a new booking code (the creator is recorded when logged in). */
export async function createSlipBookingCode(
  deps: Pick<AppDeps, 'db' | 'clock' | 'randomBytes'>,
  input: CreateBookingCodeRequest,
  userId: string | null,
): Promise<BookingCodeResponse> {
  const settings = await cachedGameSettings(deps);
  const booking = await createBookingCode(deps.db, {
    legs: input.legs.map((leg) => ({ selectionId: leg.selectionId })),
    userId,
    now: deps.clock(),
    randomBytes: deps.randomBytes,
    rules: settings.betRules,
  });
  return bookingCodeView(booking);
}

/** A booking code with current odds (404 unknown, 410 expired). */
export async function getBookingCode(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  code: string,
): Promise<BookingCodeResponse> {
  return bookingCodeView(await loadBookingCode(deps.db, code, deps.clock()));
}
