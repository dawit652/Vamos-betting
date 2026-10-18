import type { ResolutionInput } from '@vamos/core';
import { and, asc, eq, gt, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { CatalogNotFoundError, CatalogStateError } from '../catalog/errors';
import type { EventStatus, LiveMessage, MarketStatus } from '../catalog/live';
import { setManualOdds } from '../catalog/odds';
import { resultEvent, type ResultEventOutcome } from '../catalog/results';
import {
  resumeEvent,
  setEventBettingOpen,
  setMarketStatus,
  suspendEvent,
  type CatalogChange,
  type TradingMarketStatus,
} from '../catalog/status';
import { voidMarket, voidSelection, type VoidOutcome } from '../catalog/void';
import { DomainError, domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { betLegs, bets } from '../schema/betting';
import { competitions, events, markets, selections, teams } from '../schema/catalog';
import type { LocalizedName } from '../schema/catalog';
import { decodeCursor, encodeCursor, pageLimit, type Page, type StaffActor } from './common';

/**
 * Trading (back office, trading.* permissions): the staff wrappers over the
 * catalogue services, and the event search and event view of the trading
 * screen. Every mutation records the staff member in the audit log in the
 * caller's transaction; the catalogue's own errors come back as DomainError
 * (404 `not_found`, 409 `invalid_trading_state`, 422 `invalid_trading_input`).
 * Publish the returned `messages` after COMMIT.
 */

/** Audit actions of staff resulting. */
export const STAFF_EVENT_RESULTED = 'catalog.event.resulted';
export const STAFF_EVENT_RESULT_CORRECTED = 'catalog.event.result_corrected';

const ENTITY_NAMES = { event: 'Event', market: 'Market', selection: 'Selection' } as const;

/** Runs a catalogue call, turning its errors into DomainErrors. */
async function catalogCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (error instanceof CatalogNotFoundError) throw domainNotFound(ENTITY_NAMES[error.entity]);
    if (error instanceof CatalogStateError) {
      throw domainConflict('invalid_trading_state', error.message);
    }
    if (error instanceof RangeError)
      throw domainUnprocessable('invalid_trading_input', error.message);
    throw error;
  }
}

function checkedActor(actor: StaffActor): StaffActor {
  if (typeof actor?.adminId !== 'string' || actor.adminId.length === 0) {
    throw new RangeError('a trading change needs the admin id');
  }
  return actor;
}

function trimmedReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed.slice(0, 500);
}

export interface StaffOddsChange {
  changed: boolean;
  selectionId: string;
  previousOddsMilli: number | null;
  oddsMilli: number;
  messages: LiveMessage[];
}

/**
 * A trader's price for one selection (setManualOdds: odds_history source
 * 'manual', audited as `catalog.odds.manual`). 409 when the selection
 * cannot be repriced (settled, market not open or suspended, event over),
 * 422 for odds outside 1001..1000000.
 */
export async function staffSetOdds(
  tx: DbTransaction,
  input: { selectionId: string; oddsMilli: number; reason?: string; actor: StaffActor; now: Date },
): Promise<StaffOddsChange> {
  const actor = checkedActor(input.actor);
  const reason = trimmedReason(input.reason);
  const result = await catalogCall(() =>
    setManualOdds(tx, input.selectionId, input.oddsMilli, actor.adminId, {
      now: input.now,
      ip: actor.ip ?? null,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
  const change = result.changed[0];
  return {
    changed: change !== undefined,
    selectionId: input.selectionId,
    previousOddsMilli: change?.previousOddsMilli ?? null,
    oddsMilli: input.oddsMilli,
    messages: result.messages,
  };
}

/**
 * Opens, suspends or closes one market (setMarketStatus with the staff
 * actor, audited as `catalog.market.<status>`). Settled and void markets
 * are final (409).
 */
export async function staffSetMarketStatus(
  tx: DbTransaction,
  input: { marketId: string; status: TradingMarketStatus; reason?: string; actor: StaffActor },
): Promise<CatalogChange> {
  const actor = checkedActor(input.actor);
  const reason = trimmedReason(input.reason);
  return catalogCall(() =>
    setMarketStatus(tx, input.marketId, input.status, {
      adminId: actor.adminId,
      ip: actor.ip ?? null,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

/**
 * Suspends every open market of an event (suspendEvent) or re-opens every
 * suspended one (resumeEvent), with the staff actor (audited as
 * `catalog.event.suspended` / `catalog.event.resumed`). Only for scheduled
 * or live events (409).
 */
export async function staffSetEventSuspended(
  tx: DbTransaction,
  input: { eventId: string; suspended: boolean; reason?: string; actor: StaffActor },
): Promise<CatalogChange> {
  const actor = checkedActor(input.actor);
  const reason = trimmedReason(input.reason);
  const tradingActor = {
    adminId: actor.adminId,
    ip: actor.ip ?? null,
    ...(reason === undefined ? {} : { reason }),
  };
  return catalogCall(() =>
    input.suspended
      ? suspendEvent(tx, input.eventId, tradingActor)
      : resumeEvent(tx, input.eventId, tradingActor),
  );
}

/** Opens or closes betting on a whole event (setEventBettingOpen; audited). */
export async function staffSetEventBettingOpen(
  tx: DbTransaction,
  input: { eventId: string; open: boolean; reason?: string; actor: StaffActor },
): Promise<CatalogChange> {
  const actor = checkedActor(input.actor);
  const reason = trimmedReason(input.reason);
  return catalogCall(() =>
    setEventBettingOpen(tx, input.eventId, input.open, {
      adminId: actor.adminId,
      ip: actor.ip ?? null,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

/**
 * Voids one market (voidMarket: every selection void for good, bets
 * re-settled through `market.resulted`). A reason is required (422).
 * Repeating it is 'unchanged'.
 */
export async function staffVoidMarket(
  tx: DbTransaction,
  input: { marketId: string; reason: string; actor: StaffActor },
): Promise<VoidOutcome> {
  const actor = checkedActor(input.actor);
  return catalogCall(() =>
    voidMarket(tx, input.marketId, {
      adminId: actor.adminId,
      ip: actor.ip ?? null,
      reason: input.reason,
    }),
  );
}

/**
 * Voids one selection (voidSelection). A reason is required (422); a
 * selection of a game of an unsettled jackpot round is refused (409: void
 * the market instead). Repeating it is 'unchanged'.
 */
export async function staffVoidSelection(
  tx: DbTransaction,
  input: { selectionId: string; reason: string; actor: StaffActor },
): Promise<VoidOutcome> {
  const actor = checkedActor(input.actor);
  return catalogCall(() =>
    voidSelection(tx, input.selectionId, {
      adminId: actor.adminId,
      ip: actor.ip ?? null,
      reason: input.reason,
    }),
  );
}

/**
 * A trader results an event by hand, or corrects its result (resultEvent:
 * `event.resulted` / `event.result_corrected`, and settlement re-settles
 * the bets). A correction (the event was resulted before) needs a reason
 * (422 `correction_reason_required`); a `finished` result before the start
 * time is refused (409 `event_not_started`). Audited as
 * `catalog.event.resulted` / `catalog.event.result_corrected` with the
 * previous result; giving the same result again is 'unchanged' and writes
 * nothing.
 */
export async function staffResultEvent(
  tx: DbTransaction,
  input: {
    eventId: string;
    result: ResolutionInput;
    reason?: string;
    actor: StaffActor;
    now: Date;
  },
): Promise<ResultEventOutcome> {
  const actor = checkedActor(input.actor);
  const reason = trimmedReason(input.reason);
  const [event] = await tx
    .select({
      status: events.status,
      startTime: events.startTime,
      resultedAt: events.resultedAt,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
    })
    .from(events)
    .where(eq(events.id, input.eventId))
    .for('update');
  if (event === undefined) throw domainNotFound('Event');
  const correction = event.resultedAt !== null;
  if (correction && reason === undefined) {
    throw domainUnprocessable(
      'correction_reason_required',
      'Say why the result is corrected: it is kept in the audit log.',
    );
  }
  if (input.result?.status === 'finished' && event.startTime.getTime() > input.now.getTime()) {
    throw domainConflict('event_not_started', 'This event has not started yet.');
  }
  const outcome = await catalogCall(() => resultEvent(tx, input.eventId, input.result));
  if (outcome.outcome !== 'unchanged') {
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: actor.adminId,
      action: outcome.outcome === 'corrected' ? STAFF_EVENT_RESULT_CORRECTED : STAFF_EVENT_RESULTED,
      targetType: 'event',
      targetId: input.eventId,
      metadata: {
        previous: {
          status: event.status,
          score:
            event.scoreHome === null || event.scoreAway === null
              ? null
              : {
                  home: event.scoreHome,
                  away: event.scoreAway,
                  htHome: event.htScoreHome,
                  htAway: event.htScoreAway,
                },
        },
        result: input.result,
        marketsSettled: outcome.marketsSettled,
        marketsVoided: outcome.marketsVoided,
        ...(reason === undefined ? {} : { reason }),
      },
      ip: actor.ip ?? null,
    });
  }
  return outcome;
}

/** An event in the trading search. */
export interface TradingEventSummary {
  id: string;
  gameId: number;
  sportId: string;
  competition: LocalizedName;
  homeTeam: LocalizedName;
  awayTeam: LocalizedName;
  startTime: Date;
  status: EventStatus;
  bettingOpen: boolean;
  liveMinute: number | null;
  period: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  resultedAt: Date | null;
  /** Markets by status. */
  markets: { total: number; open: number; suspended: number; voided: number };
  /** Open (or pending) bets with a leg on the event, and their stakes. */
  openBets: number;
  openStake: bigint;
}

export interface TradingEventFilter {
  /** Team or competition name (English, case-insensitive), or a Game ID. */
  q?: string;
  statuses?: EventStatus[];
  sportId?: string;
  /** Start time window. */
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

const homeTeams = alias(teams, 'home_team');
const awayTeams = alias(teams, 'away_team');

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Events for the trading screen, by start time then id (cursor paging),
 * with their market counts and open stakes.
 */
export async function searchTradingEvents(
  exec: DbExecutor,
  filter: TradingEventFilter = {},
): Promise<Page<TradingEventSummary>> {
  const limit = pageLimit(filter.limit, 50, 200);
  const conditions: SQL[] = [];
  const q = filter.q?.trim();
  if (q !== undefined && q.length > 0) {
    const pattern = likePattern(q);
    const nameMatch = or(
      ilike(sql`${homeTeams.name}->>'en'`, pattern),
      ilike(sql`${awayTeams.name}->>'en'`, pattern),
      ilike(sql`${competitions.name}->>'en'`, pattern),
    );
    const gameId = /^\d{3,6}$/.test(q) ? Number(q) : null;
    conditions.push(gameId === null ? nameMatch! : or(eq(events.gameId, gameId), nameMatch)!);
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    conditions.push(inArray(events.status, filter.statuses));
  }
  if (filter.sportId !== undefined) conditions.push(eq(events.sportId, filter.sportId));
  if (filter.from !== undefined) conditions.push(gte(events.startTime, filter.from));
  if (filter.to !== undefined) conditions.push(lt(events.startTime, filter.to));
  if (filter.cursor !== undefined) {
    const cursor = decodeCursor(filter.cursor);
    conditions.push(
      or(
        gt(events.startTime, cursor.at),
        and(eq(events.startTime, cursor.at), gt(events.id, cursor.id)),
      )!,
    );
  }
  const rows = await exec
    .select({
      id: events.id,
      gameId: events.gameId,
      sportId: events.sportId,
      competition: competitions.name,
      homeTeam: homeTeams.name,
      awayTeam: awayTeams.name,
      startTime: events.startTime,
      status: events.status,
      bettingOpen: events.bettingOpen,
      liveMinute: events.liveMinute,
      period: events.period,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      resultedAt: events.resultedAt,
    })
    .from(events)
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(events.startTime), asc(events.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const marketCounts = new Map<string, TradingEventSummary['markets']>();
  const stakes = new Map<string, { bets: number; stake: bigint }>();
  if (ids.length > 0) {
    const counts = await exec
      .select({
        eventId: markets.eventId,
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) FILTER (WHERE ${markets.status} = 'open')::int`,
        suspended: sql<number>`count(*) FILTER (WHERE ${markets.status} = 'suspended')::int`,
        voided: sql<number>`count(*) FILTER (WHERE ${markets.voidedAt} IS NOT NULL)::int`,
      })
      .from(markets)
      .where(inArray(markets.eventId, ids))
      .groupBy(markets.eventId);
    for (const row of counts) {
      marketCounts.set(row.eventId, {
        total: row.total,
        open: row.open,
        suspended: row.suspended,
        voided: row.voided,
      });
    }
    const open = await exec
      .select({
        eventId: sql<string>`per_bet.event_id`,
        bets: sql<number>`count(*)::int`,
        stake: sql<string>`COALESCE(sum(per_bet.stake), 0)::text`,
      })
      .from(
        sql`(SELECT DISTINCT ${betLegs.eventId} AS event_id, ${bets.id} AS bet_id, ${bets.stake} AS stake
             FROM ${betLegs} JOIN ${bets} ON ${bets.id} = ${betLegs.betId}
             WHERE ${inArray(betLegs.eventId, ids)}
               AND ${bets.status} IN ('open', 'pending_acceptance')) AS per_bet`,
      )
      .groupBy(sql`per_bet.event_id`);
    for (const row of open) stakes.set(row.eventId, { bets: row.bets, stake: BigInt(row.stake) });
  }
  const items = page.map((row): TradingEventSummary => ({
    ...row,
    markets: marketCounts.get(row.id) ?? { total: 0, open: 0, suspended: 0, voided: 0 },
    openBets: stakes.get(row.id)?.bets ?? 0,
    openStake: stakes.get(row.id)?.stake ?? 0n,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.startTime, id: last.id })
        : null,
  };
}

/** A selection on the trading screen, with the open bets on it. */
export interface TradingSelection {
  id: string;
  code: string;
  oddsMilli: number;
  status: 'open' | 'suspended' | 'settled';
  result: 'won' | 'lost' | 'void' | null;
  voidedAt: Date | null;
  /** Open (or pending) bets with an open leg on it. */
  openBets: number;
  openStake: bigint;
  /** Σ potential gross payout of those bets (what is paid if it and their other legs win). */
  liability: bigint;
}

export interface TradingMarket {
  id: string;
  key: string;
  type: string;
  line: string | null;
  status: MarketStatus;
  suspendedBy: 'feed' | 'trader' | null;
  voidedAt: Date | null;
  resultedInPlay: boolean;
  selections: TradingSelection[];
}

export interface TradingEventDetail extends Omit<TradingEventSummary, 'markets'> {
  htScoreHome: number | null;
  htScoreAway: number | null;
  markets: TradingMarket[];
}

/** One event with every market and selection (and the open bets on each), or null. */
export async function getTradingEvent(
  exec: DbExecutor,
  eventId: string,
): Promise<TradingEventDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const [event] = await exec
    .select({
      id: events.id,
      gameId: events.gameId,
      sportId: events.sportId,
      competition: competitions.name,
      homeTeam: homeTeams.name,
      awayTeam: awayTeams.name,
      startTime: events.startTime,
      status: events.status,
      bettingOpen: events.bettingOpen,
      liveMinute: events.liveMinute,
      period: events.period,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      htScoreHome: events.htScoreHome,
      htScoreAway: events.htScoreAway,
      resultedAt: events.resultedAt,
    })
    .from(events)
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(eq(events.id, eventId))
    .limit(1);
  if (event === undefined) return null;
  const marketRows = await exec
    .select({
      id: markets.id,
      key: markets.key,
      type: markets.type,
      line: markets.line,
      status: markets.status,
      suspendedBy: markets.suspendedBy,
      voidedAt: markets.voidedAt,
      resultedInPlay: markets.resultedInPlay,
    })
    .from(markets)
    .where(eq(markets.eventId, eventId))
    .orderBy(asc(markets.id));
  const selectionRows =
    marketRows.length === 0
      ? []
      : await exec
          .select({
            id: selections.id,
            marketId: selections.marketId,
            code: selections.code,
            oddsMilli: selections.oddsMilli,
            status: selections.status,
            result: selections.result,
            voidedAt: selections.voidedAt,
          })
          .from(selections)
          .where(
            inArray(
              selections.marketId,
              marketRows.map((row) => row.id),
            ),
          )
          .orderBy(asc(selections.sortOrder), asc(selections.id));
  const exposure = await exec
    .select({
      selectionId: betLegs.selectionId,
      bets: sql<number>`count(*)::int`,
      stake: sql<string>`COALESCE(sum(${bets.stake}), 0)::text`,
      liability: sql<string>`COALESCE(sum(${bets.potentialGrossPayout}), 0)::text`,
    })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .where(
      and(
        eq(betLegs.eventId, eventId),
        eq(betLegs.state, 'open'),
        inArray(bets.status, ['open', 'pending_acceptance']),
      ),
    )
    .groupBy(betLegs.selectionId);
  const bySelection = new Map(exposure.map((row) => [row.selectionId, row]));
  const [open] = await exec
    .select({
      bets: sql<number>`count(DISTINCT ${bets.id})::int`,
    })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .where(and(eq(betLegs.eventId, eventId), inArray(bets.status, ['open', 'pending_acceptance'])));
  const [openStake] = await exec
    .select({ stake: sql<string>`COALESCE(sum(${bets.stake}), 0)::text` })
    .from(bets)
    .where(
      and(
        inArray(bets.status, ['open', 'pending_acceptance']),
        sql`EXISTS (SELECT 1 FROM ${betLegs} WHERE ${betLegs.betId} = ${bets.id} AND ${betLegs.eventId} = ${eventId})`,
      ),
    );
  const selectionsByMarket = new Map<string, TradingSelection[]>();
  for (const { marketId, ...row } of selectionRows) {
    const stats = bySelection.get(row.id);
    const list = selectionsByMarket.get(marketId) ?? [];
    list.push({
      ...row,
      openBets: stats?.bets ?? 0,
      openStake: BigInt(stats?.stake ?? '0'),
      liability: BigInt(stats?.liability ?? '0'),
    });
    selectionsByMarket.set(marketId, list);
  }
  return {
    ...event,
    openBets: open?.bets ?? 0,
    openStake: BigInt(openStake?.stake ?? '0'),
    markets: marketRows.map((market) => ({
      ...market,
      selections: selectionsByMarket.get(market.id) ?? [],
    })),
  };
}
