import { JackpotTemplateCodeSchema, type UserMessage } from '@vamos/contracts';
import {
  AML_TRIGGER_TYPES,
  BET_ACCEPTED,
  BET_CASHED_OUT,
  BET_PLACED,
  BET_REJECTED,
  BET_REOPENED,
  BET_SETTLED,
  CHANNEL_REPLY_TEMPLATE,
  CHANNEL_SMS_REPLY,
  claimOutboxBatch,
  countDeadLetteredOutbox,
  DEPOSIT_SUCCEEDED,
  EVENT_RESULT_CORRECTED,
  EVENT_RESULTED,
  JACKPOT_ENTERED,
  JACKPOT_SETTLED,
  MARKET_RESULTED,
  RECONCILIATION_REQUESTED,
  markOutboxFailed,
  markOutboxPublished,
  OWNER_ALERT,
  WITHDRAWAL_APPROVED,
  WITHDRAWAL_CANCELLED,
  WITHDRAWAL_FAILED,
  WITHDRAWAL_PAID,
  WITHDRAWAL_REJECTED,
  WITHDRAWAL_REQUESTED,
  type OutboxEvent,
} from '@vamos/db';
import type { JobsOptions } from 'bullmq';
import { z } from 'zod';
import { intervalTask } from '../lib/interval';
import {
  createQueueSet,
  QUEUE_NAMES,
  TimeoutError,
  withTimeout,
  type QueueName,
  type QueueSet,
} from '../lib/queues';
import type { WorkerTask } from '../worker';
import type { TaskContext } from './context';

/**
 * The outbox dispatcher: the only reader of `outbox_events`. Every run claims
 * a batch of unpublished rows (FOR UPDATE SKIP LOCKED, so several workers can
 * run it), hands each row to the BullMQ queue(s) of its type and marks it
 * published, all in one transaction. The outbox has a single published_at
 * column, so new consumers (SMS, AML…) get a route here instead
 * of reading the outbox themselves.
 *
 * - The task drains: while a batch comes back full it takes the next one at
 *   once (up to `maxBatchesPerDrain`), so the pace is what Postgres and Redis
 *   take, not one batch per interval. One batch a second was 100 rows a
 *   second: less than the bets of a busy minute write, and a payout approved
 *   behind the settlement of an evening's matches waited minutes for its turn.
 * - Each job's id is `outbox-<row id>-<row job_key>` (BullMQ refuses ':' in
 *   custom ids), so a row queued again (a crash between the enqueue and the
 *   COMMIT) maps to the job already there: a row is never processed twice.
 *   Finished jobs are kept for a day (KEEP_COMPLETED) for this. job_key is
 *   random per row, so a rebuilt or restored database whose id sequence
 *   restarted, or another stack on the same Redis, never maps a new row to an
 *   old job. Consumers are idempotent anyway.
 * - Types without a route are just marked published.
 * - A row whose routing or enqueue fails gets markOutboxFailed with
 *   next_attempt_at = now + an exponential backoff (1 s, 2 s, 4 s… at most
 *   60 s), stored in the row, so every worker honours it and rows backing
 *   off are not claimed (they never hold back newer rows). A row that
 *   reaches `maxAttempts` is no longer claimed (dead letter) and is logged
 *   at error level; redriveOutboxEvents (@vamos/db) queues it again.
 * - Queue outages do not use up attempts: when Redis does not answer a PING
 *   the run claims nothing, and an enqueue that fails because Redis refuses
 *   writes while still answering PING (OOM, READONLY replica, MISCONF…),
 *   drops the connection or times out is recorded with a short retry delay
 *   but without counting the attempt (isQueueOutageError).
 * - Dead letters are counted and logged at error level at the first run and
 *   then every `deadLetterReportMs` while there are any.
 */

export const OUTBOX_DISPATCH_INTERVAL_MS = 1000;

export interface OutboxDispatchOptions {
  /** Default 1 s. */
  intervalMs?: number;
  /** Rows claimed per batch (default 200). */
  batchSize?: number;
  /**
   * Batches one drain takes before it gives the turn back to the interval
   * (default 50). It bounds how long stop() waits for a drain in progress.
   */
  maxBatchesPerDrain?: number;
  /** Failed attempts after which a row is dead-lettered (default 10). */
  maxAttempts?: number;
  /** First retry delay after a failed enqueue (default 1 s, doubled per attempt). */
  backoffBaseMs?: number;
  /** Longest retry delay (default 60 s). */
  backoffMaxMs?: number;
  /** Time limit of one enqueue (default 5 s). */
  enqueueTimeoutMs?: number;
  /** Retry delay of a row whose enqueue hit a queue outage (default 5 s; no attempt counted). */
  outageRetryMs?: number;
  /** How often dead letters are counted and logged while there are any (default 5 min). */
  deadLetterReportMs?: number;
  /** The producer queues (default createQueueSet(ctx.queues); tests pass a fake). */
  queueSet?: QueueSet;
}

/** Data of a `settlement` job. */
export interface SettlementJobData {
  outboxId: string;
  type: string;
  eventId: string;
  /** market.resulted only: settle the bets with a leg on this market (resulted early). */
  marketId?: string;
}

/** Data of a `bet-acceptance` job (a delayed job due at acceptAfter). */
export interface BetAcceptanceJobData {
  outboxId: string;
  betId: string;
  /** ISO time. */
  acceptAfter: string;
}

/** Data of a `payouts` job (payment.withdrawal_approved): send this payout. */
export interface PayoutJobData {
  outboxId: string;
  payoutId: string;
}

/** Data of an `sms` job for a payment notification to the player. */
export interface PaymentSmsJobData {
  outboxId: string;
  /** The outbox type (payment.deposit_succeeded, payment.withdrawal_paid / _failed). */
  type: string;
  userId: string;
  /** Santim, decimal string. */
  amount: string;
}

/**
 * Data of an `sms` job for the reply to an inbound SMS (channel.sms_reply,
 * Phase 11): the text is final (built and stored when the SMS was handled)
 * and goes to the number it came from, which need not be a player's.
 */
export interface ChannelReplySmsJobData {
  outboxId: string;
  type: typeof CHANNEL_SMS_REPLY;
  inboundMessageId: string;
  /** E.164 recipient. */
  to: string;
  body: string;
  template: typeof CHANNEL_REPLY_TEMPLATE;
}

/**
 * Data of an `sms` job for the outcome of a live bet (bet.accepted /
 * bet.rejected). Only bets placed by SMS or USSD are texted (the consumer
 * reads the bet's channel); web players see it in the app.
 */
export interface LiveBetSmsJobData {
  outboxId: string;
  type: typeof BET_ACCEPTED | typeof BET_REJECTED;
  betId: string;
  userId: string;
  shortId: string;
  /** bet.rejected only. */
  reason?: 'selection_unavailable' | 'odds_changed' | 'slip_invalid';
  /** bet.rejected only: the stake refunded, santim decimal string. */
  refund?: string;
}

/**
 * Data of an `sms` job for an alert to the owner (owner.alert, plan task 1.11): the text is final
 * and goes to every OWNER_ALERT_PHONES number, once per key and interval.
 */
export interface OwnerAlertSmsJobData {
  outboxId: string;
  type: typeof OWNER_ALERT;
  key: string;
  message: string;
  /** ISO time the alarm was raised; the deduplication window runs on it. */
  raisedAt: string;
  /** The alarm's own least time between two texts (OWNER_ALERT_POLICY); absent for older rows. */
  repeatMs?: number;
}

/** Data of an `sms` job. */
export type SmsJobData =
  PaymentSmsJobData | ChannelReplySmsJobData | LiveBetSmsJobData | OwnerAlertSmsJobData;

/**
 * Data of a `user-notify` job: push messages for one player, built from the
 * outbox payload when the row is dispatched. `wallet` adds a wallet.changed
 * message with the player's balances as they are when the job runs.
 */
export interface UserNotifyJobData {
  outboxId: string;
  type: string;
  userId: string;
  messages: UserMessage[];
  wallet: boolean;
}

/** Data of an `aml` job: evaluate this player's AML rules after the event (evaluateAmlForEvent). */
export interface AmlJobData {
  outboxId: string;
  type: string;
  userId: string;
}

/** Data of a `reconciliation` job: run this staff request (runRequestedReconciliation). */
export interface ReconciliationJobData {
  outboxId: string;
  requestId: string;
}

export interface RoutedJob {
  queue: QueueName;
  name: string;
  data: unknown;
  opts?: JobsOptions;
}

/** Turns an outbox row into a job, or null when this row needs none. Throws on a malformed payload. */
export type OutboxRoute = (row: OutboxEvent, now: Date) => RoutedJob | null;

const nonEmpty = z.string().min(1);

const settlementRoute: OutboxRoute = (row) => {
  const eventId = nonEmpty.parse(row.aggregateId);
  const data: SettlementJobData = { outboxId: row.id.toString(), type: row.type, eventId };
  return { queue: QUEUE_NAMES.settlement, name: row.type, data };
};

const marketResultedPayload = z.object({ eventId: z.uuid(), marketId: z.uuid() });

/** A market resulted early in play: settle the bets with a leg on it. */
const marketSettlementRoute: OutboxRoute = (row) => {
  const payload = marketResultedPayload.parse(row.payload);
  const data: SettlementJobData = {
    outboxId: row.id.toString(),
    type: row.type,
    eventId: payload.eventId,
    marketId: payload.marketId,
  };
  return { queue: QUEUE_NAMES.settlement, name: row.type, data };
};

/**
 * A resulted event (or a 1X2 market resulted early) may complete a jackpot
 * round: the `jackpot-settlement` consumer settles the rounds with a game
 * on it. Same job data as the bet settlement.
 */
const jackpotSettlementRoute: OutboxRoute = (row, now) => {
  const job =
    row.type === MARKET_RESULTED ? marketSettlementRoute(row, now) : settlementRoute(row, now);
  return job === null ? null : { ...job, queue: QUEUE_NAMES.jackpotSettlement };
};

const betPlacedPayload = z.object({
  betId: nonEmpty,
  status: nonEmpty,
  acceptAfter: z.iso.datetime({ offset: true }).nullable().optional(),
});

/** A live bet placed `pending_acceptance` gets a job delayed until its acceptAfter. */
const betAcceptanceRoute: OutboxRoute = (row, now) => {
  const payload = betPlacedPayload.parse(row.payload);
  if (payload.status !== 'pending_acceptance') return null;
  if (payload.acceptAfter === null || payload.acceptAfter === undefined) {
    throw new Error(`pending bet ${payload.betId} has no acceptAfter`);
  }
  const data: BetAcceptanceJobData = {
    outboxId: row.id.toString(),
    betId: payload.betId,
    acceptAfter: payload.acceptAfter,
  };
  const delay = Math.max(0, Date.parse(payload.acceptAfter) - now.getTime());
  return {
    queue: QUEUE_NAMES.betAcceptance,
    name: 'accept',
    data,
    opts: { delay, attempts: 5, backoff: { type: 'exponential', delay: 500 } },
  };
};

const approvedPayload = z.object({ payoutId: z.uuid() });

/** An approved withdrawal (automatically or by staff) goes to the payout worker at once. */
const payoutRoute: OutboxRoute = (row) => {
  const payload = approvedPayload.parse(row.payload);
  const data: PayoutJobData = { outboxId: row.id.toString(), payoutId: payload.payoutId };
  return { queue: QUEUE_NAMES.payouts, name: 'payout', data };
};

const notificationPayload = z.object({
  userId: z.uuid(),
  amount: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
});

/** Payment outcomes the player hears about by SMS. */
const smsRoute: OutboxRoute = (row) => {
  const payload = notificationPayload.parse(row.payload);
  const data: PaymentSmsJobData = {
    outboxId: row.id.toString(),
    type: row.type,
    userId: payload.userId,
    amount: String(payload.amount),
  };
  return { queue: QUEUE_NAMES.sms, name: row.type, data };
};

const channelReplyPayload = z.object({
  inboundMessageId: z.uuid(),
  to: z.string().regex(/^\+\d{8,15}$/),
  body: z.string().min(1).max(1_600),
  template: z.literal(CHANNEL_REPLY_TEMPLATE),
});

const liveBetOutcomePayload = z.object({
  betId: z.uuid(),
  userId: z.uuid(),
  shortId: nonEmpty,
  reason: z.enum(['selection_unavailable', 'odds_changed', 'slip_invalid']).optional(),
  refund: z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
    .transform((value) => String(value))
    .optional(),
});

/**
 * A live bet accepted or rejected: texted to the player when it was placed
 * by SMS or USSD. A payload without what the text needs gets no job (like
 * the push messages), so it never holds back the row's other jobs.
 */
const liveBetSmsRoute: OutboxRoute = (row) => {
  const parsed = liveBetOutcomePayload.safeParse(row.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const data: LiveBetSmsJobData = {
    outboxId: row.id.toString(),
    type: row.type === BET_REJECTED ? BET_REJECTED : BET_ACCEPTED,
    betId: payload.betId,
    userId: payload.userId,
    shortId: payload.shortId,
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.refund === undefined ? {} : { refund: payload.refund }),
  };
  return { queue: QUEUE_NAMES.sms, name: row.type, data };
};

/** The reply to an inbound SMS (each send, re-sends included, is its own outbox row and job). */
const channelReplyRoute: OutboxRoute = (row) => {
  const payload = channelReplyPayload.parse(row.payload);
  const data: ChannelReplySmsJobData = {
    outboxId: row.id.toString(),
    type: CHANNEL_SMS_REPLY,
    inboundMessageId: payload.inboundMessageId,
    to: payload.to,
    body: payload.body,
    template: payload.template,
  };
  return { queue: QUEUE_NAMES.sms, name: row.type, data };
};

const ownerAlertPayload = z.object({
  key: nonEmpty.max(400),
  message: nonEmpty.max(160),
  raisedAt: nonEmpty,
  repeatMs: z.number().int().min(0).default(0),
});

/** An alert to the owner's phone: the `sms` consumer sends it (or does nothing with alerts off). */
const ownerAlertRoute: OutboxRoute = (row) => {
  const payload = ownerAlertPayload.parse(row.payload);
  const data: OwnerAlertSmsJobData = {
    outboxId: row.id.toString(),
    type: OWNER_ALERT,
    key: payload.key,
    message: payload.message,
    raisedAt: payload.raisedAt,
    repeatMs: payload.repeatMs,
  };
  return { queue: QUEUE_NAMES.sms, name: row.type, data };
};

/** Santim as stored in outbox payloads (enqueueOutbox writes bigint as a string). */
const wireSantim = z
  .union([z.string().regex(/^-?\d+$/), z.number().int()])
  .transform((value) => String(value));
const betRef = { betId: nonEmpty, userId: z.uuid(), shortId: nonEmpty };

/**
 * The push messages of each player-facing outbox type (null: the payload
 * does not carry them). `wallet`: the type changed the player's balances.
 */
const USER_NOTIFICATIONS: Readonly<
  Record<
    string,
    {
      wallet: boolean;
      messages: (payload: unknown) => { userId: string; messages: UserMessage[] } | null;
    }
  >
> = {
  // The stake left the balance (the placing tab knows; the others hear it).
  [BET_PLACED]: { wallet: true, messages: walletOnly },
  [BET_ACCEPTED]: {
    wallet: false,
    messages: (payload) => {
      const parsed = z
        .object({ ...betRef, oddsChanged: z.array(z.unknown()).default([]) })
        .safeParse(payload);
      if (!parsed.success) return null;
      const { betId, userId, shortId, oddsChanged } = parsed.data;
      return {
        userId,
        messages: [
          { type: 'bet.accepted', data: { betId, shortId, oddsChanged: oddsChanged.length > 0 } },
        ],
      };
    },
  },
  [BET_REJECTED]: {
    wallet: true,
    messages: (payload) => {
      const parsed = z
        .object({ ...betRef, reason: nonEmpty, refund: wireSantim })
        .safeParse(payload);
      if (!parsed.success) return null;
      const { betId, userId, shortId, reason, refund } = parsed.data;
      return {
        userId,
        messages: [{ type: 'bet.rejected', data: { betId, shortId, reason, refund } }],
      };
    },
  },
  [BET_SETTLED]: {
    wallet: true,
    messages: (payload) => {
      const parsed = z
        .object({
          ...betRef,
          status: z.enum(['won', 'lost', 'void']),
          grossPayout: wireSantim,
          taxAmount: wireSantim,
          netPayout: wireSantim,
          corrected: z.boolean(),
        })
        .safeParse(payload);
      if (!parsed.success) return null;
      const { betId, userId, shortId, status, grossPayout, taxAmount, netPayout, corrected } =
        parsed.data;
      return {
        userId,
        messages: [
          {
            type: 'bet.settled',
            data: {
              betId,
              shortId,
              status,
              gross: grossPayout,
              tax: taxAmount,
              net: netPayout,
              corrected,
            },
          },
        ],
      };
    },
  },
  [BET_CASHED_OUT]: {
    wallet: true,
    messages: (payload) => {
      const parsed = z
        .object({ ...betRef, gross: wireSantim, tax: wireSantim, net: wireSantim })
        .safeParse(payload);
      if (!parsed.success) return null;
      const { betId, userId, shortId, gross, tax, net } = parsed.data;
      return {
        userId,
        messages: [{ type: 'bet.cashed_out', data: { betId, shortId, gross, tax, net } }],
      };
    },
  },
  [BET_REOPENED]: {
    wallet: true,
    messages: (payload) => {
      const parsed = z.object(betRef).safeParse(payload);
      if (!parsed.success) return null;
      const { betId, userId, shortId } = parsed.data;
      return { userId, messages: [{ type: 'bet.reopened', data: { betId, shortId } }] };
    },
  },
  // Jackpots: the entry's cost left the balance; an entry settled or refunded.
  [JACKPOT_ENTERED]: { wallet: true, messages: walletOnly },
  [JACKPOT_SETTLED]: {
    wallet: true,
    messages: (payload) => {
      const parsed = z
        .object({
          entryId: z.uuid(),
          roundId: z.uuid(),
          userId: z.uuid(),
          templateCode: JackpotTemplateCodeSchema,
          status: z.enum(['won', 'lost', 'void']),
          gross: wireSantim,
          tax: wireSantim,
          net: wireSantim,
          refund: wireSantim,
          bestCorrect: z.number().int().nullable(),
        })
        .safeParse(payload);
      if (!parsed.success) return null;
      const { userId, ...data } = parsed.data;
      return { userId, messages: [{ type: 'jackpot.settled', data }] };
    },
  },
  // Payments: a deposit credited, a withdrawal's hold taken or given back, a payout sent.
  [DEPOSIT_SUCCEEDED]: { wallet: true, messages: walletOnly },
  [WITHDRAWAL_REQUESTED]: { wallet: true, messages: walletOnly },
  [WITHDRAWAL_REJECTED]: { wallet: true, messages: walletOnly },
  [WITHDRAWAL_CANCELLED]: { wallet: true, messages: walletOnly },
  [WITHDRAWAL_PAID]: { wallet: true, messages: walletOnly },
  [WITHDRAWAL_FAILED]: { wallet: true, messages: walletOnly },
};

function walletOnly(payload: unknown): { userId: string; messages: UserMessage[] } | null {
  const parsed = z.object({ userId: z.uuid() }).safeParse(payload);
  return parsed.success ? { userId: parsed.data.userId, messages: [] } : null;
}

/** The outbox types that push a message to the player (GET /me/stream). */
export const USER_NOTIFY_TYPES: readonly string[] = Object.keys(USER_NOTIFICATIONS);

/**
 * Player push messages (the `user-notify` queue). A payload without what the
 * message needs routes no job (a missing notification must never hold back
 * the row's other jobs, such as a live bet's acceptance); notifications are
 * hints, re-fetched by the client anyway. Few attempts: a late hint is worth
 * little.
 */
const userNotifyRoute: OutboxRoute = (row) => {
  const spec = USER_NOTIFICATIONS[row.type];
  if (spec === undefined) return null;
  const built = spec.messages(row.payload);
  if (built === null) return null;
  const data: UserNotifyJobData = {
    outboxId: row.id.toString(),
    type: row.type,
    userId: built.userId,
    messages: built.messages,
    wallet: spec.wallet,
  };
  return {
    queue: QUEUE_NAMES.userNotify,
    name: row.type,
    data,
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 500 } },
  };
};

/**
 * AML (Phase 10): the events after which a player's rules are evaluated
 * (@vamos/db AML_TRIGGER_TYPES). A payload without a player routes no job
 * (the daily sweep still sees the activity).
 */
const amlRoute: OutboxRoute = (row) => {
  const parsed = z.object({ userId: z.uuid() }).safeParse(row.payload);
  if (!parsed.success) return null;
  const data: AmlJobData = {
    outboxId: row.id.toString(),
    type: row.type,
    userId: parsed.data.userId,
  };
  return { queue: QUEUE_NAMES.aml, name: row.type, data };
};

/**
 * A staff "Run now" reconciliation (Phase 12): run in the worker, off the
 * API request path. Few attempts: a request whose job gives up is marked
 * failed, and staff can ask again.
 */
const reconciliationRoute: OutboxRoute = (row) => {
  const parsed = z.object({ requestId: z.uuid() }).safeParse(row.payload);
  if (!parsed.success) return null;
  const data: ReconciliationJobData = {
    outboxId: row.id.toString(),
    requestId: parsed.data.requestId,
  };
  return {
    queue: QUEUE_NAMES.reconciliation,
    name: row.type,
    data,
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  };
};

/** The routes of each type, plus the compliance route (AML) of the types it covers. */
function withComplianceRoutes(
  routes: Record<string, readonly OutboxRoute[]>,
): Readonly<Record<string, readonly OutboxRoute[]>> {
  const all: Record<string, OutboxRoute[]> = {};
  for (const [type, list] of Object.entries(routes)) all[type] = [...list];
  for (const type of AML_TRIGGER_TYPES) (all[type] ??= []).push(amlRoute);
  return all;
}

/** Outbox type -> the jobs it fans out to. */
export const OUTBOX_ROUTES: Readonly<Record<string, readonly OutboxRoute[]>> = withComplianceRoutes(
  {
    [EVENT_RESULTED]: [settlementRoute, jackpotSettlementRoute],
    [EVENT_RESULT_CORRECTED]: [settlementRoute, jackpotSettlementRoute],
    [MARKET_RESULTED]: [marketSettlementRoute, jackpotSettlementRoute],
    [BET_PLACED]: [betAcceptanceRoute, userNotifyRoute],
    [BET_ACCEPTED]: [userNotifyRoute, liveBetSmsRoute],
    [BET_REJECTED]: [userNotifyRoute, liveBetSmsRoute],
    [BET_SETTLED]: [userNotifyRoute],
    [BET_CASHED_OUT]: [userNotifyRoute],
    [BET_REOPENED]: [userNotifyRoute],
    [JACKPOT_ENTERED]: [userNotifyRoute],
    [JACKPOT_SETTLED]: [userNotifyRoute],
    [WITHDRAWAL_APPROVED]: [payoutRoute],
    [DEPOSIT_SUCCEEDED]: [smsRoute, userNotifyRoute],
    [WITHDRAWAL_REQUESTED]: [userNotifyRoute],
    [WITHDRAWAL_REJECTED]: [userNotifyRoute],
    [WITHDRAWAL_CANCELLED]: [userNotifyRoute],
    [WITHDRAWAL_PAID]: [smsRoute, userNotifyRoute],
    [WITHDRAWAL_FAILED]: [smsRoute, userNotifyRoute],
    [CHANNEL_SMS_REPLY]: [channelReplyRoute],
    [OWNER_ALERT]: [ownerAlertRoute],
    [RECONCILIATION_REQUESTED]: [reconciliationRoute],
  },
);

/** The job id of an outbox row (the same in every queue it fans out to). */
export const outboxJobId = (row: Pick<OutboxEvent, 'id' | 'jobKey'>): string =>
  `outbox-${row.id}-${row.jobKey}`;

export interface OutboxDispatchSummary {
  claimed: number;
  /** Rows marked published (with or without jobs). */
  published: number;
  /** Jobs added (or found already queued under the same id). */
  jobs: number;
  /** Rows whose routing or enqueue failed in this run (outages included). */
  failed: number;
  /** Failed rows whose error was a queue outage (attempt not counted). */
  outage: number;
  /** Rows that reached maxAttempts in this run. */
  deadLettered: number;
  /** true when Redis did not answer and nothing was claimed. */
  redisDown: boolean;
}

export interface OutboxDispatcher {
  /** One batch. */
  run(): Promise<OutboxDispatchSummary>;
  /**
   * Batches until one comes back less than full (the outbox is empty, or what
   * is left is backing off), Redis is down or refusing jobs, `shouldStop()`
   * says so, or `maxBatchesPerDrain` is reached. Returns the totals.
   */
  drain(shouldStop?: () => boolean): Promise<OutboxDispatchSummary>;
  /** Closes the queues' Redis connection. */
  close(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Redis replies that mean "Redis cannot take writes right now", not "this job is wrong". */
const OUTAGE_REPLY =
  /^(OOM|READONLY|MISCONF|LOADING|BUSY|MASTERDOWN|NOREPLICAS|CLUSTERDOWN|TRYAGAIN|NOAUTH|WRONGPASS)\b/;
const OUTAGE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * true for an enqueue failure caused by the queue's Redis (an outage), not
 * by the row: a refused write (OOM, READONLY, MISCONF, LOADING…), a lost or
 * closed connection, ioredis giving up on a command, or our enqueue timeout.
 */
export function isQueueOutageError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'ReplyError') return OUTAGE_REPLY.test(error.message);
  if (error.name === 'MaxRetriesPerRequestError') return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && OUTAGE_CODES.has(code)) return true;
  return /Connection is closed|Stream isn't writeable|Command timed out/i.test(error.message);
}

export function createOutboxDispatcher(
  ctx: TaskContext,
  options: OutboxDispatchOptions = {},
): OutboxDispatcher {
  const batchSize = options.batchSize ?? 200;
  const maxBatchesPerDrain = Math.max(1, options.maxBatchesPerDrain ?? 50);
  const maxAttempts = options.maxAttempts ?? 10;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  const backoffMaxMs = options.backoffMaxMs ?? 60_000;
  const enqueueTimeoutMs = options.enqueueTimeoutMs ?? 5000;
  const outageRetryMs = options.outageRetryMs ?? 5000;
  const deadLetterReportMs = options.deadLetterReportMs ?? 5 * 60_000;
  const { logger } = ctx;
  const queues = options.queueSet ?? createQueueSet(ctx.queues, logger);
  let redisDown = false;
  let queueOutage = false;
  /** ctx.clock ms of the last successful dead-letter count (null: not yet). */
  let deadLettersCountedAt: number | null = null;

  const empty = (): OutboxDispatchSummary => ({
    claimed: 0,
    published: 0,
    jobs: 0,
    failed: 0,
    outage: 0,
    deadLettered: 0,
    redisDown: false,
  });

  const enqueue = async (row: OutboxEvent, now: Date): Promise<number> => {
    const jobs = (OUTBOX_ROUTES[row.type] ?? [])
      .map((route) => route(row, now))
      .filter((job): job is RoutedJob => job !== null);
    const jobId = outboxJobId(row);
    await Promise.all(
      jobs.map((job) =>
        withTimeout(
          queues.get(job.queue).add(job.name, job.data, { ...job.opts, jobId }),
          enqueueTimeoutMs,
          `enqueue to ${job.queue}`,
        ),
      ),
    );
    return jobs.length;
  };

  const reportDeadLetters = async (now: Date): Promise<void> => {
    if (
      deadLettersCountedAt !== null &&
      now.getTime() - deadLettersCountedAt < deadLetterReportMs
    ) {
      return;
    }
    const n = await countDeadLetteredOutbox(ctx.db, maxAttempts);
    // Only once the count succeeded: a failed count is tried again next run.
    deadLettersCountedAt = now.getTime();
    if (n > 0) {
      logger.error(
        { count: n, maxAttempts },
        'outbox has dead-lettered events (unpublished, attempts >= maxAttempts); they are not retried until redriven',
      );
    }
  };

  const run = async (): Promise<OutboxDispatchSummary> => {
    try {
      await queues.ping();
      if (redisDown) logger.info('outbox dispatch: redis is reachable again');
      redisDown = false;
    } catch (error) {
      if (!redisDown) logger.warn({ err: error }, 'outbox dispatch paused: redis unreachable');
      redisDown = true;
      return { ...empty(), redisDown: true };
    }

    const now = ctx.clock();
    await reportDeadLetters(now);
    return ctx.db.transaction(async (tx) => {
      const summary = empty();
      const rows = await claimOutboxBatch(tx, batchSize, { maxAttempts, now });
      summary.claimed = rows.length;
      const results = await Promise.allSettled(rows.map((row) => enqueue(row, now)));

      const published: bigint[] = [];
      for (const [i, result] of results.entries()) {
        const row = rows[i];
        if (row === undefined) continue;
        const key = row.id.toString();
        if (result.status === 'fulfilled') {
          published.push(row.id);
          summary.jobs += result.value;
          continue;
        }
        const error = message(result.reason);
        summary.failed += 1;
        if (isQueueOutageError(result.reason)) {
          summary.outage += 1;
          await markOutboxFailed(tx, row.id, error, {
            countAttempt: false,
            retryAt: new Date(now.getTime() + outageRetryMs),
          });
          continue;
        }
        const attempts = row.attempts + 1;
        if (attempts >= maxAttempts) {
          await markOutboxFailed(tx, row.id, error);
          summary.deadLettered += 1;
          logger.error(
            { outboxId: key, type: row.type, aggregateId: row.aggregateId, attempts, error },
            'outbox event dead-lettered: reached max attempts, it will not be retried',
          );
        } else {
          const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1));
          await markOutboxFailed(tx, row.id, error, {
            retryAt: new Date(now.getTime() + delay),
          });
          logger.warn(
            { outboxId: key, type: row.type, attempts, retryInMs: delay, error },
            'outbox event could not be queued; will retry',
          );
        }
      }
      await markOutboxPublished(tx, published);
      summary.published = published.length;

      if (summary.outage > 0 && !queueOutage) {
        queueOutage = true;
        logger.warn(
          { rows: summary.outage, retryInMs: outageRetryMs },
          'outbox dispatch: the queue redis refuses jobs (outage); rows are retried without using up attempts',
        );
      } else if (summary.outage === 0 && published.length > 0 && queueOutage) {
        queueOutage = false;
        logger.info('outbox dispatch: the queue redis takes jobs again');
      }
      if (summary.jobs > 0) {
        logger.debug({ ...summary }, 'outbox dispatched');
      }
      return summary;
    });
  };

  return {
    run,
    async drain(shouldStop = () => false) {
      const total = empty();
      for (let batch = 0; batch < maxBatchesPerDrain; batch += 1) {
        const summary = await run();
        total.claimed += summary.claimed;
        total.published += summary.published;
        total.jobs += summary.jobs;
        total.failed += summary.failed;
        total.outage += summary.outage;
        total.deadLettered += summary.deadLettered;
        total.redisDown = summary.redisDown;
        // Less than a full batch: nothing more is due. An outage: the rows carry their retry
        // time, and asking Redis again at once would only fail the next batch too.
        if (summary.claimed < batchSize || summary.redisDown || summary.outage > 0) break;
        if (shouldStop()) break;
      }
      return total;
    },
    close: () => queues.close(),
  };
}

/** The dispatcher as a WorkerTask (a drain every second by default). */
export function outboxDispatchTask(
  ctx: TaskContext,
  options: OutboxDispatchOptions = {},
): WorkerTask {
  let dispatcher: OutboxDispatcher | null = null;
  let stopping = false;
  const task = intervalTask({
    name: 'outbox-dispatch',
    intervalMs: options.intervalMs ?? OUTBOX_DISPATCH_INTERVAL_MS,
    logger: ctx.logger,
    run: async () => dispatcher?.drain(() => stopping),
  });
  return {
    name: task.name,
    start: async () => {
      stopping = false;
      dispatcher ??= createOutboxDispatcher(ctx, options);
      await task.start();
    },
    stop: async () => {
      // A drain in progress finishes its batch and stops; the rest waits for the next start.
      stopping = true;
      await task.stop();
      const current = dispatcher;
      dispatcher = null;
      await current?.close();
    },
  };
}
