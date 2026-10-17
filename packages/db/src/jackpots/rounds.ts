import { toWire, type JackpotTemplate, type TaxConfig } from '@vamos/core';
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  lte,
  ne,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { isUuid } from '../betting/selections';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { competitions, events, markets, selections, sports } from '../schema/catalog';
import { jackpotEntries, jackpotGames, jackpotRounds } from '../schema/jackpots';
import { JackpotTemplateSchema, TaxSchema } from '../settings/index';
import { JACKPOT_ROUND_CLOSED, JACKPOT_ROUND_OPENED, JACKPOT_ROUND_SETTLED } from './events';
import { getJackpotRound } from './queries';
import {
  serializeRoundTerms,
  serializeSettlement,
  UNSETTLED_ROUND_STATUSES,
  type JackpotActor,
  type JackpotRound,
  type JackpotRoundSettlement,
  type JackpotTemplateCode,
} from './types';

/** The sport whose 1X2 markets jackpot rounds are made of. */
export const JACKPOT_SPORT = 'football';
/** The market every jackpot game is decided by. */
export const JACKPOT_MARKET_KEY = '1x2';

/** An upcoming event a new round could use. */
export interface JackpotCandidateEvent {
  eventId: string;
  startTime: Date;
  marketId: string;
}

export interface ListJackpotCandidateEventsOptions {
  /** Events already used by an unsettled round of this template are left out. */
  templateCode: JackpotTemplateCode;
  now: Date;
  /** Only events kicking off more than this long after `now` (ms). */
  leadMs: number;
  /** Only events kicking off within this long after `now` (ms); omit for no limit. */
  horizonMs?: number;
  limit: number;
}

/**
 * Upcoming football events a round of the template could be made of,
 * soonest kick-off first: scheduled, betting open, sport and competition
 * active, kicking off after now + leadMs (and within the horizon), with an
 * open 1X2 market whose three selections are open, and not a game of
 * another scheduled, open or closed round of the same template.
 */
export async function listJackpotCandidateEvents(
  exec: DbExecutor,
  options: ListJackpotCandidateEventsOptions,
): Promise<JackpotCandidateEvent[]> {
  const { now, leadMs, horizonMs, limit } = options;
  if (!Number.isSafeInteger(leadMs) || leadMs < 0) {
    throw new RangeError('leadMs must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('limit must be an integer between 1 and 500');
  }
  const usedByTemplate = exec
    .select({ one: sql`1` })
    .from(jackpotGames)
    .innerJoin(jackpotRounds, eq(jackpotRounds.id, jackpotGames.roundId))
    .where(
      and(
        eq(jackpotGames.eventId, events.id),
        eq(jackpotRounds.templateCode, options.templateCode),
        inArray(jackpotRounds.status, [...UNSETTLED_ROUND_STATUSES]),
      ),
    );
  const conditions: SQL[] = [
    eq(events.sportId, JACKPOT_SPORT),
    eq(events.status, 'scheduled'),
    eq(events.bettingOpen, true),
    gt(events.startTime, new Date(now.getTime() + leadMs)),
    eq(sports.active, true),
    eq(competitions.active, true),
    eq(markets.status, 'open'),
    sql`(SELECT count(*) FROM ${selections} WHERE ${selections.marketId} = ${markets.id} AND ${selections.code} IN ('1', 'X', '2') AND ${selections.status} = 'open') = 3`,
    sql`NOT ${exists(usedByTemplate)}`,
  ];
  if (horizonMs !== undefined) {
    conditions.push(lte(events.startTime, new Date(now.getTime() + horizonMs)));
  }
  return exec
    .select({ eventId: events.id, startTime: events.startTime, marketId: markets.id })
    .from(events)
    .innerJoin(sports, eq(sports.id, events.sportId))
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(markets, and(eq(markets.eventId, events.id), eq(markets.key, JACKPOT_MARKET_KEY)))
    .where(and(...conditions))
    .orderBy(asc(events.startTime), asc(events.id))
    .limit(limit);
}

/**
 * Why an event cannot be a game of a new round:
 * - not_found: no such event;
 * - no_1x2_market: it has no 1X2 market (not football);
 * - not_scheduled: it is live, finished, cancelled, postponed or abandoned;
 * - started: its kick-off is not after now;
 * - market_not_open: the 1X2 market is suspended, closed or resulted;
 * - selections_missing: the 1X2 market lacks one of '1', 'X', '2'.
 */
export type JackpotEventProblem =
  | 'not_found'
  | 'no_1x2_market'
  | 'not_scheduled'
  | 'started'
  | 'market_not_open'
  | 'selections_missing';

export interface CreateJackpotRoundInput {
  /** The template to open (normally loadGameSettings().jackpots[code]); its terms are frozen. */
  template: JackpotTemplate;
  /** The winnings tax in force (loadGameSettings().tax); frozen with the round. */
  tax: TaxConfig;
  /** The events, in game order (kick-off order reads best), template.gameCount of them. */
  eventIds: readonly string[];
  now: Date;
  /** 'open' (default) takes entries at once; 'scheduled' waits for openJackpotRound. */
  status?: 'open' | 'scheduled';
  /** Default: the system (worker). */
  actor?: JackpotActor;
}

function invalidTemplate(issues: string[]) {
  return domainUnprocessable('jackpot_template_invalid', issues[0] ?? 'Invalid jackpot template.', {
    issues,
  });
}

/** Checks a template for opening a round (a stored template parses; this adds what a round needs). */
function checkedTemplate(template: JackpotTemplate): JackpotTemplate {
  const parsed = JackpotTemplateSchema.safeParse(template);
  if (!parsed.success) {
    throw invalidTemplate(
      parsed.error.issues.map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  const checked = parsed.data;
  if (checked.prizeTiers.length === 0) throw invalidTemplate(['a round needs a prize tier']);
  if (checked.prizeTiers.some((tier) => tier.correct < 1)) {
    throw invalidTemplate(['a prize tier needs at least one correct prediction']);
  }
  return checked;
}

function actorFields(actor: JackpotActor | undefined) {
  return actor?.type === 'admin'
    ? { actorType: 'admin' as const, actorId: actor.id, ip: actor.ip ?? null }
    : { actorType: 'system' as const, actorId: null, ip: null };
}

/**
 * Opens a jackpot round on the given events, in the caller's transaction:
 * 1. the template is checked (422 `jackpot_template_invalid`: it must parse
 *    as a stored template, have a prize tier, every tier at least one
 *    correct, and one event per game) and the tax parsed;
 * 2. the events are locked FOR SHARE in id order (resulting and the live
 *    simulator take them FOR UPDATE first), then each must be a scheduled
 *    football event kicking off after `now` with an open 1X2 market and
 *    its three selections (422 `jackpot_event_unavailable`, details
 *    `{ events: [{ eventId, reason: JackpotEventProblem }] }`);
 * 3. the round is inserted with its frozen terms (template and tax), the
 *    pool (the first tier's amount) and closes_at = the earliest kick-off,
 *    and its games in the order given;
 * 4. `jackpot.round_opened` (when open) and the audit record.
 */
export async function createJackpotRound(
  tx: DbTransaction,
  input: CreateJackpotRoundInput,
): Promise<JackpotRound> {
  const template = checkedTemplate(input.template);
  const tax = TaxSchema.parse(input.tax);
  const status = input.status ?? 'open';
  const ids = input.eventIds.map((id) => (isUuid(id) ? id.toLowerCase() : id));
  if (ids.length !== template.gameCount) {
    throw invalidTemplate([
      `the template has ${template.gameCount} games but ${ids.length} events were given`,
    ]);
  }
  if (new Set(ids).size !== ids.length) throw invalidTemplate(['an event is given twice']);
  const valid = ids.filter(isUuid).sort();
  if (valid.length > 0) {
    await tx
      .select({ id: events.id })
      .from(events)
      .where(inArray(events.id, valid))
      .orderBy(asc(events.id))
      .for('share');
  }
  const eventRows =
    valid.length === 0
      ? []
      : await tx
          .select({ id: events.id, status: events.status, startTime: events.startTime })
          .from(events)
          .where(inArray(events.id, valid));
  const marketRows =
    valid.length === 0
      ? []
      : await tx
          .select({
            eventId: markets.eventId,
            marketId: markets.id,
            marketStatus: markets.status,
            selectionId: selections.id,
            code: selections.code,
          })
          .from(markets)
          .leftJoin(selections, eq(selections.marketId, markets.id))
          .where(and(inArray(markets.eventId, valid), eq(markets.key, JACKPOT_MARKET_KEY)));

  const eventsById = new Map(eventRows.map((row) => [row.id, row]));
  const problems: Array<{ eventId: string; reason: JackpotEventProblem }> = [];
  const games = ids.map((eventId, position) => {
    const event = eventsById.get(eventId);
    const marketSelections = marketRows.filter((row) => row.eventId === eventId);
    const market = marketSelections[0];
    const selectionOf = (code: string) =>
      marketSelections.find((row) => row.code === code)?.selectionId ?? null;
    const home = selectionOf('1');
    const draw = selectionOf('X');
    const away = selectionOf('2');
    let reason: JackpotEventProblem | null = null;
    if (event === undefined) reason = 'not_found';
    else if (market === undefined) reason = 'no_1x2_market';
    else if (event.status !== 'scheduled') reason = 'not_scheduled';
    else if (event.startTime.getTime() <= input.now.getTime()) reason = 'started';
    else if (market.marketStatus !== 'open') reason = 'market_not_open';
    else if (home === null || draw === null || away === null) reason = 'selections_missing';
    if (reason !== null) problems.push({ eventId, reason });
    return {
      position,
      eventId,
      marketId: market?.marketId ?? '',
      homeSelectionId: home ?? '',
      drawSelectionId: draw ?? '',
      awaySelectionId: away ?? '',
      startTime: event?.startTime ?? input.now,
    };
  });
  if (problems.length > 0) {
    throw domainUnprocessable(
      'jackpot_event_unavailable',
      problems.length === 1
        ? 'An event cannot be used for this jackpot.'
        : `${problems.length} events cannot be used for this jackpot.`,
      { events: problems },
    );
  }

  const closesAt = new Date(Math.min(...games.map((game) => game.startTime.getTime())));
  const pool = template.prizeTiers[0]?.amount ?? 0n;
  const [round] = await tx
    .insert(jackpotRounds)
    .values({
      templateCode: template.code,
      status,
      gameCount: template.gameCount,
      costPerCombination: template.costPerCombination,
      maxCombinations: template.maxCombinations,
      pool,
      terms: serializeRoundTerms({ template, tax }),
      closesAt,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: jackpotRounds.id });
  if (round === undefined) throw new Error('jackpot round insert returned no row');
  await tx.insert(jackpotGames).values(
    games.map((game) => ({
      roundId: round.id,
      position: game.position,
      eventId: game.eventId,
      marketId: game.marketId,
      homeSelectionId: game.homeSelectionId,
      drawSelectionId: game.drawSelectionId,
      awaySelectionId: game.awaySelectionId,
    })),
  );

  const details = {
    roundId: round.id,
    templateCode: template.code,
    status,
    closesAt,
    gameCount: template.gameCount,
    costPerCombination: template.costPerCombination,
    maxCombinations: template.maxCombinations,
    pool,
    eventIds: ids,
  };
  if (status === 'open') {
    await enqueueOutbox(tx, {
      type: JACKPOT_ROUND_OPENED,
      aggregateType: 'jackpot_round',
      aggregateId: round.id,
      payload: details,
    });
  }
  await writeAudit(tx, {
    ...actorFields(input.actor),
    action: 'jackpot.round_created',
    targetType: 'jackpot_round',
    targetId: round.id,
    metadata: details,
  });
  const created = await getJackpotRound(tx, round.id);
  if (created === null) throw new Error(`jackpot round ${round.id} was not inserted`);
  return created;
}

export interface EnsureJackpotRoundInput {
  /** The template as configured now (loadGameSettings().jackpots[code]). */
  template: JackpotTemplate;
  /** The winnings tax in force (loadGameSettings().tax). */
  tax: TaxConfig;
  now: Date;
  /** Games must kick off more than this long after `now` (ms). */
  leadMs: number;
  /** ...and within this long after `now` (ms); omit for no limit. */
  horizonMs?: number;
}

export type EnsureJackpotRoundResult =
  | { outcome: 'created'; round: JackpotRound }
  | { outcome: 'exists'; roundId: string }
  | { outcome: 'disabled' }
  | { outcome: 'not_enough_events'; available: number; needed: number };

/**
 * Keeps one round of the template taking entries (the worker's round
 * task), in the caller's transaction: nothing to do when the template is
 * disabled or a scheduled or open round of it closes after `now`;
 * otherwise a round is opened (createJackpotRound) on the template's
 * number of candidate events (listJackpotCandidateEvents), if there are
 * enough. Runs under a transaction-level advisory lock per template, so
 * concurrent workers never open two rounds of the same template.
 */
export async function ensureJackpotRound(
  tx: DbTransaction,
  input: EnsureJackpotRoundInput,
): Promise<EnsureJackpotRoundResult> {
  const { template, now } = input;
  if (!template.enabled) return { outcome: 'disabled' };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:jackpot_round:${template.code}`}))`,
  );
  const [existing] = await tx
    .select({ id: jackpotRounds.id })
    .from(jackpotRounds)
    .where(
      and(
        eq(jackpotRounds.templateCode, template.code),
        inArray(jackpotRounds.status, ['scheduled', 'open']),
        gt(jackpotRounds.closesAt, now),
      ),
    )
    .limit(1);
  if (existing !== undefined) return { outcome: 'exists', roundId: existing.id };
  const candidates = await listJackpotCandidateEvents(tx, {
    templateCode: template.code,
    now,
    leadMs: input.leadMs,
    ...(input.horizonMs === undefined ? {} : { horizonMs: input.horizonMs }),
    limit: template.gameCount,
  });
  if (candidates.length < template.gameCount) {
    return {
      outcome: 'not_enough_events',
      available: candidates.length,
      needed: template.gameCount,
    };
  }
  const round = await createJackpotRound(tx, {
    template,
    tax: input.tax,
    eventIds: candidates.map((candidate) => candidate.eventId),
    now,
  });
  return { outcome: 'created', round };
}

/** 409 `jackpot_closed`, details `{ reason, status }`. */
export function jackpotClosedError(reason: 'not_open' | 'closed' | 'game_started', status: string) {
  return domainConflict(
    'jackpot_closed',
    reason === 'not_open'
      ? 'This jackpot is not open for entries yet.'
      : 'This jackpot is closed for entries.',
    { reason, status },
  );
}

/**
 * Games of the round whose event can no longer be part of an open round:
 * not scheduled any more, or kicking off at or before `now`.
 */
function startedGame(roundId: string, now: Date) {
  return exists(
    sql`(SELECT 1 FROM ${jackpotGames} INNER JOIN ${events} ON ${events.id} = ${jackpotGames.eventId} WHERE ${jackpotGames.roundId} = ${roundId} AND (${events.status} <> 'scheduled' OR ${events.startTime} <= ${now.toISOString()}::timestamptz))`,
  );
}

/**
 * Opens a scheduled round for entries (back office), in the caller's
 * transaction: 409 `jackpot_closed` unless it is scheduled, closes after
 * `now` and every game's event is still scheduled and not started. Writes
 * `jackpot.round_opened` and the audit record.
 */
export async function openJackpotRound(
  tx: DbTransaction,
  input: { roundId: string; now: Date; actor?: JackpotActor },
): Promise<JackpotRound> {
  const { now } = input;
  if (!isUuid(input.roundId)) throw domainNotFound('Jackpot round');
  const [round] = await tx
    .select()
    .from(jackpotRounds)
    .where(eq(jackpotRounds.id, input.roundId))
    .for('update');
  if (round === undefined) throw domainNotFound('Jackpot round');
  if (round.status !== 'scheduled') throw jackpotClosedError('closed', round.status);
  if (round.closesAt.getTime() <= now.getTime()) throw jackpotClosedError('closed', round.status);
  const [started] = await tx
    .select({ one: sql`1` })
    .from(jackpotRounds)
    .where(and(eq(jackpotRounds.id, round.id), startedGame(round.id, now)));
  if (started !== undefined) throw jackpotClosedError('game_started', round.status);
  await tx
    .update(jackpotRounds)
    .set({ status: 'open', updatedAt: now })
    .where(eq(jackpotRounds.id, round.id));
  const opened = await getJackpotRound(tx, round.id);
  if (opened === null) throw new Error(`jackpot round ${round.id} vanished`);
  const details = {
    roundId: round.id,
    templateCode: round.templateCode,
    status: 'open',
    closesAt: round.closesAt,
    gameCount: round.gameCount,
    costPerCombination: round.costPerCombination,
    maxCombinations: round.maxCombinations,
    pool: round.pool,
    eventIds: opened.games.map((game) => game.eventId),
  };
  await enqueueOutbox(tx, {
    type: JACKPOT_ROUND_OPENED,
    aggregateType: 'jackpot_round',
    aggregateId: round.id,
    payload: details,
  });
  await writeAudit(tx, {
    ...actorFields(input.actor),
    action: 'jackpot.round_opened',
    targetType: 'jackpot_round',
    targetId: round.id,
    metadata: details,
  });
  return opened;
}

/** Entries and their total cost of a round (for the closing event). */
async function entryTotals(exec: DbExecutor, roundId: string) {
  const [row] = await exec
    .select({ entries: count(), stakes: sum(jackpotEntries.cost) })
    .from(jackpotEntries)
    .where(eq(jackpotEntries.roundId, roundId));
  return { entries: row?.entries ?? 0, stakes: BigInt(row?.stakes ?? 0) };
}

/**
 * Closes an open round (status closed, closed_at = now) and writes
 * `jackpot.round_closed`. The caller holds the round row FOR UPDATE.
 */
export async function closeLockedRound(
  tx: DbTransaction,
  round: { id: string; templateCode: string; closesAt: Date },
  now: Date,
): Promise<void> {
  await tx
    .update(jackpotRounds)
    .set({ status: 'closed', closedAt: now, updatedAt: now })
    .where(and(eq(jackpotRounds.id, round.id), eq(jackpotRounds.status, 'open')));
  const totals = await entryTotals(tx, round.id);
  await enqueueOutbox(tx, {
    type: JACKPOT_ROUND_CLOSED,
    aggregateType: 'jackpot_round',
    aggregateId: round.id,
    payload: {
      roundId: round.id,
      templateCode: round.templateCode,
      closesAt: round.closesAt,
      closedAt: now,
      entries: totals.entries,
      stakes: toWire(totals.stakes),
    },
  });
}

/** Whether the round (status open) must close at `now`: its closing time came, or a game's event started or is no longer scheduled. */
export async function isRoundDue(
  exec: DbExecutor,
  round: { id: string; closesAt: Date },
  now: Date,
): Promise<boolean> {
  if (round.closesAt.getTime() <= now.getTime()) return true;
  const [row] = await exec
    .select({ one: sql`1` })
    .from(jackpotRounds)
    .where(and(eq(jackpotRounds.id, round.id), startedGame(round.id, now)));
  return row !== undefined;
}

/** A void settlement with no entries (a round cancelled before it opened). */
function notOpenedSettlement(): JackpotRoundSettlement {
  return {
    void: true,
    voidReason: 'not_opened',
    results: [],
    cancelledGames: 0,
    entries: 0,
    winners: 0,
    stakes: 0n,
    gross: 0n,
    tax: 0n,
    net: 0n,
    refunds: 0n,
    undistributed: 0n,
    payouts: [],
  };
}

export interface CloseDueRoundsResult {
  /** Open rounds closed by this call. */
  closed: string[];
  /** Scheduled rounds cancelled because they never opened before their closing time. */
  cancelled: string[];
}

/**
 * The worker's closing task, in the caller's transaction: closes every
 * open round whose closing time has come, or one of whose games' event
 * started or is no longer scheduled (an entry would be refused anyway),
 * writing `jackpot.round_closed`; and cancels scheduled rounds that never
 * opened before their closing time (no entries, nothing to refund),
 * writing `jackpot.round_settled`. Rounds locked by an entry being placed
 * are skipped (SKIP LOCKED) and closed by the next run. Settlement
 * (settleJackpotRound) closes a due round itself too.
 */
export async function closeDueJackpotRounds(
  tx: DbTransaction,
  now: Date,
  options: { limit?: number } = {},
): Promise<CloseDueRoundsResult> {
  const limit = options.limit ?? 100;
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const due = await tx
    .select({
      id: jackpotRounds.id,
      status: jackpotRounds.status,
      templateCode: jackpotRounds.templateCode,
      closesAt: jackpotRounds.closesAt,
    })
    .from(jackpotRounds)
    .where(
      or(
        and(
          eq(jackpotRounds.status, 'open'),
          or(
            lte(jackpotRounds.closesAt, now),
            exists(
              tx
                .select({ one: sql`1` })
                .from(jackpotGames)
                .innerJoin(events, eq(events.id, jackpotGames.eventId))
                .where(
                  and(
                    eq(jackpotGames.roundId, jackpotRounds.id),
                    or(ne(events.status, 'scheduled'), lte(events.startTime, now)),
                  ),
                ),
            ),
          ),
        ),
        and(eq(jackpotRounds.status, 'scheduled'), sql`${jackpotRounds.closesAt} <= ${nowSql}`),
      ),
    )
    .orderBy(asc(jackpotRounds.closesAt), asc(jackpotRounds.id))
    .limit(limit)
    .for('update', { skipLocked: true });

  const result: CloseDueRoundsResult = { closed: [], cancelled: [] };
  for (const round of due) {
    if (round.status === 'open') {
      await closeLockedRound(tx, round, now);
      result.closed.push(round.id);
      continue;
    }
    const settlement = notOpenedSettlement();
    await tx
      .update(jackpotRounds)
      .set({
        status: 'cancelled',
        closedAt: now,
        settledAt: now,
        settlement: serializeSettlement(settlement),
        updatedAt: now,
      })
      .where(eq(jackpotRounds.id, round.id));
    await enqueueOutbox(tx, {
      type: JACKPOT_ROUND_SETTLED,
      aggregateType: 'jackpot_round',
      aggregateId: round.id,
      payload: {
        roundId: round.id,
        templateCode: round.templateCode,
        status: 'cancelled',
        ...settlement,
      },
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'jackpot.round_voided',
      targetType: 'jackpot_round',
      targetId: round.id,
      metadata: { reason: 'not_opened', closesAt: round.closesAt },
    });
    result.cancelled.push(round.id);
  }
  return result;
}
