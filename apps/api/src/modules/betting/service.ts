import type {
  BetView,
  BookingCodeResponse,
  CashOutOffersResponse,
  CashOutOfferView,
  CashOutResponse,
  CreateBookingCodeRequest,
  MyBetsQuery,
  MyBetsResponse,
  PlaceBetRequest,
  QuoteRequest,
  QuoteResponse,
} from '@vamos/contracts';
import {
  cashedOutView,
  cashOutBet,
  cashOutOfferView,
  createBookingCode,
  getCashOutOffer,
  getCashOutOffers,
  getUserBet,
  listUserBets,
  loadBookingCode,
  loadGameSettings,
  placeBet,
  quoteSlip,
  withTxRetry,
  type GameSettings,
} from '@vamos/db';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import { betView, bookingCodeView, quoteView, type CashOutPricing } from './views';

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
 * of checks and their errors), with the settings loaded in that transaction,
 * retried when Postgres aborts it with a deadlock or serialization failure.
 */
export async function placePlayerBet(
  deps: Pick<AppDeps, 'db' | 'clock' | 'randomBytes'>,
  command: PlaceBetCommand,
): Promise<PlacedBet> {
  const now = deps.clock();
  const { request } = command;
  // Retried on deadlock / serialization failure (a settlement or another
  // posting can lock the same ledger accounts): safe, as nothing of the failed
  // try was committed and the bet is keyed by its idempotency key.
  const { result, cashOut } = await withTxRetry(deps.db, async (tx) => {
    const settings = await loadGameSettings(tx);
    const placed = await placeBet(tx, {
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
    return { result: placed, cashOut: settings.cashOut };
  });
  return { bet: betView(result.bet, { config: cashOut, now }), replayed: result.replayed };
}

/** The player's bets, newest first (`open` or `settled` tab). */
export async function listMyBets(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  query: MyBetsQuery,
): Promise<MyBetsResponse> {
  const pricing = await cashOutPricing(deps);
  const page = await listUserBets(deps.db, {
    userId,
    status: query.status,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  return { items: page.items.map((bet) => betView(bet, pricing)), nextCursor: page.nextCursor };
}

/** One of the player's bets; 404 for an unknown id or someone else's bet. */
export async function getMyBet(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  betId: string,
): Promise<BetView> {
  const pricing = await cashOutPricing(deps);
  const bet = await getUserBet(deps.db, userId, betId);
  if (bet === null) throw notFound('Bet');
  return betView(bet, pricing);
}

/**
 * The cash-out settings (cached like the other read paths) and the time
 * offers shown in views are priced at. Executing a cash-out never uses the
 * cache: cashOutPlayerBet loads the settings in its own transaction.
 */
async function cashOutPricing(deps: Pick<AppDeps, 'db' | 'clock'>): Promise<CashOutPricing> {
  const settings = await cachedGameSettings(deps);
  return { config: settings.cashOut, now: deps.clock() };
}

/** GET /me/bets/:id/cash-out: the bet's current offer; 404 for an unknown id or someone else's bet. */
export async function getMyCashOutOffer(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  betId: string,
): Promise<CashOutOfferView> {
  const { config, now } = await cashOutPricing(deps);
  const quote = await getCashOutOffer(deps.db, { userId, betId, config, now });
  if (quote === null) throw notFound('Bet');
  return cashOutOfferView(quote);
}

/** GET /me/cash-out-offers: the offers of those of `betIds` that are the player's, in order. */
export async function getMyCashOutOffers(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  userId: string,
  betIds: readonly string[],
): Promise<CashOutOffersResponse> {
  const { config, now } = await cashOutPricing(deps);
  const quotes = await getCashOutOffers(deps.db, { userId, betIds, config, now });
  return { items: quotes.map(cashOutOfferView) };
}

export interface CashOutCommand {
  userId: string;
  betId: string;
  /** The offer's gross the player accepted (santim). */
  quotedGross: bigint;
  idempotencyKey: string;
  ip?: string | null;
}

export interface CashedOutBet {
  body: CashOutResponse;
  /** true when the idempotency key had been used for this cash-out already (nothing was written). */
  replayed: boolean;
}

/**
 * Cashes out one of the player's bets: cashOutBet (@vamos/db) in one
 * transaction with the cash-out settings loaded in it, retried on deadlock /
 * serialization failure (nothing of a failed try is committed and the
 * cash-out is keyed by its idempotency key). Its DomainErrors (404, 409
 * cashout_unavailable / cashout_offer_changed, 422 idempotency_key_reused /
 * invalid_amount) are rendered by the app's error handler.
 */
export async function cashOutPlayerBet(
  deps: Pick<AppDeps, 'db' | 'clock'>,
  command: CashOutCommand,
): Promise<CashedOutBet> {
  const now = deps.clock();
  const { result, config } = await withTxRetry(deps.db, async (tx) => {
    const settings = await loadGameSettings(tx);
    const cashedOut = await cashOutBet(tx, {
      userId: command.userId,
      betId: command.betId,
      quotedGross: command.quotedGross,
      idempotencyKey: command.idempotencyKey,
      now,
      config: settings.cashOut,
      ip: command.ip ?? null,
    });
    return { result: cashedOut, config: settings.cashOut };
  });
  return {
    body: {
      bet: betView(result.bet, { config, now }),
      cashOut: cashedOutView(result.cashOut),
    },
    replayed: result.replayed,
  };
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
