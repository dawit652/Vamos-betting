import {
  balanceBody,
  betsBody,
  channelLocale,
  jackpotBody,
  parseUssdState,
  serializeUssdState,
  ussdEnd,
  ussdExpiredEnd,
  ussdLatestInput,
  ussdNext,
  ussdNotAvailableEnd,
  ussdOddsChanged,
  ussdPlacedEnd,
  ussdRateLimitedEnd,
  ussdRefusedEnd,
  ussdResponse,
  ussdSessionEndedEnd,
  ussdStart,
  ussdUnavailableEnd,
  type ChannelLocale,
  type UssdBetRequest,
  type UssdContext,
  type UssdGame,
  type UssdState,
  type UssdStep,
} from '@vamos/core';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { UserBet } from '../betting/types';
import type { Database } from '../client';
import type { DbTransaction } from '../ledger/types';
import { withTxRetry, type TxRetryOptions } from '../retry';
import { users } from '../schema/accounts';
import { ussdSessions } from '../schema/channels';
import { loadGameSettings, type GameSettings } from '../settings/index';
import { loadChannelGame } from './games';
import { placeChannelBet, placedBetSummary, ussdBetKey } from './place';
import {
  channelPhone,
  channelRequestsSince,
  findChannelPlayer,
  lockChannelPhone,
  type ChannelPlayer,
} from './players';
import type { ChannelRateLimit } from './sms';
import { channelBalances, openJackpotSummaries, recentBetLines } from './summaries';

/** A session with no callback for this long is over (aggregators time out sooner). */
export const USSD_SESSION_TTL_MS = 180_000;
/** Longest aggregator session id accepted. */
export const MAX_USSD_SESSION_ID_LENGTH = 128;
/** Longest callback `text` (the whole input history) read. */
export const MAX_USSD_TEXT_LENGTH = 500;
/** Game lookups per callback (one is enough; this bounds a misbehaving state machine). */
const MAX_GAME_LOOKUPS = 3;

/**
 * Callbacks handled in one session: a bet takes 6, so this only stops a
 * session kept open by endless input (each callback extends its expiry).
 */
export const USSD_MAX_CALLBACKS = 30;
/** Expired sessions without a bet are kept this long, then pruned (pruneUssdSessions). */
export const USSD_SESSION_RETENTION_MS = 7 * 24 * 3_600_000;
/** Sessions deleted per pruneUssdSessions call at most. */
export const USSD_PRUNE_BATCH_SIZE = 1_000;

/**
 * New sessions per number. Texts from the number count too: SMS and USSD
 * share one budget per number (channelRequestsSince).
 */
export const DEFAULT_USSD_RATE_LIMITS: readonly ChannelRateLimit[] = [
  { max: 10, windowMs: 300_000 },
];

export interface UssdCallbackInput {
  /** USSD_AGGREGATOR ('mock' in the demo). */
  aggregator: string;
  sessionId: string;
  /** The code dialled, as received. */
  serviceCode: string;
  /** The caller's number as the aggregator gives it (the network authenticates it). */
  phoneNumber: string;
  /** Everything typed in the session, '*'-joined ('' on the first callback). */
  text: string;
}

export interface UssdCallbackOptions {
  now: Date;
  randomBytes: (size: number) => Uint8Array;
  /** Play-money mode: the menu title says DEMO. */
  demo: boolean;
  /** The code shown in texts ("Dial *123# again"): USSD_SERVICE_CODE. */
  serviceCode: string;
  /** Default USSD_SESSION_TTL_MS. */
  sessionTtlMs?: number;
  /** Default DEFAULT_USSD_RATE_LIMITS (new sessions per number). */
  rateLimits?: readonly ChannelRateLimit[];
  ip?: string | null;
  txRetry?: TxRetryOptions;
}

export interface UssdCallbackResult {
  /** The body to answer the aggregator with: 'CON …' or 'END …' (≤ 182 characters). */
  response: string;
  /** The response ends the session (END). */
  ended: boolean;
  /** The same callback was handled before: its stored response, nothing done again. */
  replayed: boolean;
  /** The bet this callback placed. */
  bet: UserBet | null;
}

type SessionRow = typeof ussdSessions.$inferSelect;
type Screen = Extract<UssdStep, { kind: 'menu' | 'end' }>;

/** What a callback did, before it is stored. */
interface Outcome {
  step: Screen;
  userId: string | null;
  bet: UserBet | null;
}

function assertInput(input: UssdCallbackInput): void {
  if (typeof input.aggregator !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(input.aggregator)) {
    throw new RangeError('aggregator must be 1–32 lowercase letters, digits, - or _');
  }
  if (
    typeof input.sessionId !== 'string' ||
    input.sessionId.length > MAX_USSD_SESSION_ID_LENGTH ||
    !/^[\x21-\x7e]+$/.test(input.sessionId)
  ) {
    throw new RangeError(
      `sessionId must be 1–${MAX_USSD_SESSION_ID_LENGTH} printable ASCII characters`,
    );
  }
  if (typeof input.phoneNumber !== 'string' || input.phoneNumber.length > 64) {
    throw new RangeError('phoneNumber must be a string of at most 64 characters');
  }
  if (typeof input.serviceCode !== 'string' || input.serviceCode.length > 32) {
    throw new RangeError('serviceCode must be a string of at most 32 characters');
  }
  if (typeof input.text !== 'string' || input.text.length > MAX_USSD_TEXT_LENGTH) {
    throw new RangeError(`text must be a string of at most ${MAX_USSD_TEXT_LENGTH} characters`);
  }
}

/** Every step the caller stores is a screen; anything else ends the session safely. */
function screenOf(step: UssdStep, ctx: Pick<UssdContext, 'locale'>): Screen {
  if (step.kind === 'menu' || step.kind === 'end') return step;
  return ussdUnavailableEnd(ctx) as Screen;
}

async function rateLimited(
  tx: DbTransaction,
  phone: string,
  now: Date,
  limits: readonly ChannelRateLimit[],
): Promise<boolean> {
  for (const limit of limits) {
    const since = new Date(now.getTime() - limit.windowMs);
    if ((await channelRequestsSince(tx, phone, since)) >= limit.max) return true;
  }
  return false;
}

/** The reply language of a session's player (English when unknown). */
async function sessionLocale(tx: DbTransaction, session: SessionRow): Promise<ChannelLocale> {
  if (session.userId === null) return 'en';
  const [row] = await tx
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  return channelLocale(row?.locale);
}

/** The menu context of a player, with the settings of this transaction. */
async function contextFor(
  tx: DbTransaction,
  player: ChannelPlayer,
  options: UssdCallbackOptions,
): Promise<{ ctx: UssdContext; settings: GameSettings }> {
  const settings = await loadGameSettings(tx);
  const ctx: UssdContext = {
    locale: channelLocale(player.locale),
    demo: options.demo,
    serviceCode: options.serviceCode,
    rules: settings.betRules,
    multiBonus: settings.multiBonus,
    tax: settings.tax,
    games: new Map(),
  };
  return { ctx, settings };
}

/** ussdNext, answering its game lookups from the catalogue (current odds). */
async function nextStep(
  tx: DbTransaction,
  state: UssdState,
  input: string,
  ctx: UssdContext,
  now: Date,
): Promise<UssdStep> {
  const games = new Map<number, UssdGame | null>(ctx.games);
  for (let lookups = 0; ; lookups += 1) {
    const step = ussdNext(state, input, { ...ctx, games });
    if (step.kind !== 'need_game') return step;
    if (lookups >= MAX_GAME_LOOKUPS) return ussdUnavailableEnd(ctx);
    games.set(step.gameId, await loadChannelGame(tx, step.gameId, now, ctx.locale));
  }
}

async function infoEnd(
  tx: DbTransaction,
  info: 'balance' | 'bets' | 'jackpot',
  player: ChannelPlayer,
  ctx: UssdContext,
  now: Date,
): Promise<UssdStep> {
  switch (info) {
    case 'balance':
      return ussdEnd(balanceBody(await channelBalances(tx, player.id), ctx.locale));
    case 'bets':
      return ussdEnd(betsBody(await recentBetLines(tx, player.id), ctx.locale));
    case 'jackpot':
      return ussdEnd(jackpotBody(await openJackpotSummaries(tx, now, ctx.locale), ctx.locale, 1));
  }
}

/** Places the bet the confirm screen showed (its odds and stake, nothing else). */
async function placeConfirmed(
  tx: DbTransaction,
  bet: UssdBetRequest,
  player: ChannelPlayer,
  context: { ctx: UssdContext; settings: GameSettings },
  input: UssdCallbackInput,
  callback: number,
  options: UssdCallbackOptions,
): Promise<{ step: UssdStep; bet: UserBet | null }> {
  const { ctx, settings } = context;
  const placed = await placeChannelBet(tx, {
    userId: player.id,
    channel: 'ussd',
    legs: [
      {
        gameId: bet.gameId,
        pick: bet.pick,
        selectionId: bet.selectionId,
        oddsMilli: bet.oddsMilli,
      },
    ],
    stake: bet.stake,
    idempotencyKey: ussdBetKey(input.aggregator, input.sessionId, callback),
    now: options.now,
    settings,
    randomBytes: options.randomBytes,
    ip: options.ip ?? null,
  });
  if (placed.ok) {
    return { step: ussdPlacedEnd(placedBetSummary(placed.bet), ctx), bet: placed.bet };
  }
  if (placed.refusal.code === 'odds_changed') {
    // The price moved since the confirm screen: show it again at the new odds.
    const game = await loadChannelGame(tx, bet.gameId, options.now, ctx.locale);
    if (game !== null) return { step: ussdOddsChanged(bet, game, ctx), bet: null };
  }
  return { step: ussdRefusedEnd(placed.refusal, ctx), bet: null };
}

/** The first callback of a session: the main menu (or why there is none). */
async function startSession(
  tx: DbTransaction,
  phone: { key: string; e164: string | null },
  input: UssdCallbackInput,
  options: UssdCallbackOptions,
): Promise<Outcome> {
  const limits = options.rateLimits ?? DEFAULT_USSD_RATE_LIMITS;
  if (await rateLimited(tx, phone.key, options.now, limits)) {
    return { step: ussdRateLimitedEnd({ locale: 'en' }) as Screen, userId: null, bet: null };
  }
  const player = phone.e164 === null ? null : await findChannelPlayer(tx, phone.e164);
  if (player === null) return { step: ussdNotAvailableEnd() as Screen, userId: null, bet: null };
  const { ctx } = await contextFor(tx, player, options);
  // Sessions start with an empty text. Anything else is a session we never
  // started: its screens were not ours, so nothing typed in it is acted on.
  if (input.text !== '')
    return { step: ussdExpiredEnd(ctx) as Screen, userId: player.id, bet: null };
  return { step: screenOf(ussdStart(ctx), ctx), userId: player.id, bet: null };
}

/** A callback in a live session: the next screen. */
async function continueSession(
  tx: DbTransaction,
  session: SessionRow,
  input: UssdCallbackInput,
  options: UssdCallbackOptions,
): Promise<Outcome> {
  // The player is re-checked on every callback (suspended or excluded meanwhile).
  const found = await findChannelPlayer(tx, session.phone);
  const player = found !== null && found.id === session.userId ? found : null;
  if (player === null) return { step: ussdNotAvailableEnd() as Screen, userId: null, bet: null };
  const context = await contextFor(tx, player, options);
  const { ctx } = context;
  const latest = ussdLatestInput(session.lastText, input.text);
  const state = parseUssdState(session.state);
  if (latest === null || state === null) {
    // Not the next input of this session (or a state we cannot read): end it.
    return { step: ussdUnavailableEnd(ctx) as Screen, userId: player.id, bet: null };
  }
  const step = await nextStep(tx, state, latest, ctx, options.now);
  if (step.kind === 'info') {
    const info = await infoEnd(tx, step.info, player, ctx, options.now);
    return { step: screenOf(info, ctx), userId: player.id, bet: null };
  }
  if (step.kind === 'place') {
    const callback = session.callbacks + 1;
    const placed = await placeConfirmed(tx, step.bet, player, context, input, callback, options);
    return { step: screenOf(placed.step, ctx), userId: player.id, bet: placed.bet };
  }
  return { step: screenOf(step, ctx), userId: player.id, bet: null };
}

const storedState = (step: Screen): Record<string, unknown> =>
  serializeUssdState(step.kind === 'menu' ? step.state : { screen: 'ended' });

/**
 * Handles a USSD aggregator callback (POST /channels/ussd, after its shared
 * secret was checked) in one transaction retried on deadlock, and returns
 * the body to answer with ('CON …' keeps the session open, 'END …' ends it):
 *
 * 1. the number's channel lock (shared with SMS);
 * 2. the session row (FOR UPDATE). A callback whose text equals the last one
 *    handled is a redelivery, and one whose text is a prefix of it is a late
 *    retry of an earlier callback: both get the stored response and change
 *    nothing. A callback from another number is answered without touching
 *    the session; one after the session ended, expired (USSD_SESSION_TTL_MS
 *    without a callback) or reached USSD_MAX_CALLBACKS, or whose text does
 *    not extend the last one, ends it;
 * 3. a new session: per-number rate limit (DEFAULT_USSD_RATE_LIMITS, shared
 *    with inbound texts), an
 *    active player with a verified phone (else one generic bilingual END),
 *    an empty text (else "expired": nothing is acted on in a session we did
 *    not start), then the main menu;
 * 4. otherwise the stored state and the latest input go through ussdNext
 *    (@vamos/core), with games looked up from the catalogue at their current
 *    odds. Balance, My bets (last 3) and Jackpot end the session with the
 *    information. A confirmed bet is placed with placeChannelBet (channel
 *    'ussd', policy 'none' at the odds the confirm screen showed, idempotency
 *    key ussdBetKey(aggregator, sessionId, callback number)); when the price
 *    moved meanwhile, the confirm screen is shown again at the new odds;
 * 5. the new state, text and response are stored.
 *
 * Invalid input must be refused by the caller; this throws RangeError for it.
 */
export async function handleUssdCallback(
  db: Database,
  input: UssdCallbackInput,
  options: UssdCallbackOptions,
): Promise<UssdCallbackResult> {
  assertInput(input);
  const phone = channelPhone(input.phoneNumber);
  const { now } = options;
  const expiresAt = new Date(now.getTime() + (options.sessionTtlMs ?? USSD_SESSION_TTL_MS));

  return withTxRetry(
    db,
    async (tx): Promise<UssdCallbackResult> => {
      await lockChannelPhone(tx, phone.key);
      const [session] = await tx
        .select()
        .from(ussdSessions)
        .where(
          and(
            eq(ussdSessions.aggregator, input.aggregator),
            eq(ussdSessions.sessionId, input.sessionId),
          ),
        )
        .limit(1)
        .for('update');

      if (session === undefined) {
        const outcome = await startSession(tx, phone, input, options);
        const ended = outcome.step.kind === 'end';
        const response = ussdResponse(outcome.step);
        await tx.insert(ussdSessions).values({
          aggregator: input.aggregator,
          sessionId: input.sessionId,
          phone: phone.key,
          serviceCode: input.serviceCode,
          userId: outcome.userId,
          state: storedState(outcome.step),
          lastText: input.text,
          lastResponse: response,
          callbacks: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          endedAt: ended ? now : null,
        });
        return { response, ended, replayed: false, bet: null };
      }

      if (session.phone !== phone.key) {
        const step = ussdUnavailableEnd({ locale: 'en' }) as Screen;
        return { response: ussdResponse(step), ended: true, replayed: false, bet: null };
      }
      // A late retry of an earlier callback (its text is a prefix of the last
      // one handled) is answered with the current screen and changes nothing:
      // it must not end the live session or overwrite the stored receipt.
      const earlier =
        input.text === '' ? session.lastText !== '' : session.lastText.startsWith(`${input.text}*`);
      if (input.text === session.lastText || earlier) {
        return {
          response: session.lastResponse,
          ended: session.lastResponse.startsWith('END'),
          replayed: true,
          bet: null,
        };
      }

      let outcome: Outcome;
      if (session.endedAt !== null) {
        const ctx = { locale: await sessionLocale(tx, session), serviceCode: options.serviceCode };
        outcome = { step: ussdSessionEndedEnd(ctx) as Screen, userId: session.userId, bet: null };
      } else if (
        now.getTime() > session.expiresAt.getTime() ||
        session.callbacks >= USSD_MAX_CALLBACKS
      ) {
        const ctx = { locale: await sessionLocale(tx, session), serviceCode: options.serviceCode };
        outcome = { step: ussdExpiredEnd(ctx) as Screen, userId: session.userId, bet: null };
      } else {
        outcome = await continueSession(tx, session, input, options);
      }
      const ended = outcome.step.kind === 'end';
      const response = ussdResponse(outcome.step);
      await tx
        .update(ussdSessions)
        .set({
          state: storedState(outcome.step),
          lastText: input.text,
          lastResponse: response,
          callbacks: session.callbacks + 1,
          betId: outcome.bet?.id ?? session.betId,
          updatedAt: now,
          expiresAt: ended ? session.expiresAt : expiresAt,
          endedAt: session.endedAt ?? (ended ? now : null),
        })
        .where(eq(ussdSessions.id, session.id));
      return { response, ended, replayed: false, bet: outcome.bet };
    },
    options.txRetry,
  );
}

/**
 * Deletes, at most `batchSize` (USSD_PRUNE_BATCH_SIZE) at a time, the USSD
 * sessions that expired more than `retentionMs` (USSD_SESSION_RETENTION_MS)
 * before `now` and placed no bet; returns how many went. Sessions with a bet
 * are kept with it. Inbound texts (inbound_messages) are evidence and are
 * never pruned. Run by the worker's ussd-session-prune task.
 */
export async function pruneUssdSessions(
  db: Database,
  options: { now: Date; retentionMs?: number; batchSize?: number },
): Promise<number> {
  const before = new Date(
    options.now.getTime() - (options.retentionMs ?? USSD_SESSION_RETENTION_MS),
  );
  const batchSize = options.batchSize ?? USSD_PRUNE_BATCH_SIZE;
  const expired = db
    .select({ id: ussdSessions.id })
    .from(ussdSessions)
    .where(and(isNull(ussdSessions.betId), lt(ussdSessions.expiresAt, before)))
    .orderBy(asc(ussdSessions.expiresAt))
    .limit(batchSize);
  const deleted = await db
    .delete(ussdSessions)
    .where(inArray(ussdSessions.id, expired))
    .returning({ id: ussdSessions.id });
  return deleted.length;
}
