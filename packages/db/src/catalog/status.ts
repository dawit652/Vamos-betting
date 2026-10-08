import { and, eq, sql } from 'drizzle-orm';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { events, markets } from '../schema/catalog';
import { CatalogNotFoundError, CatalogStateError } from './errors';
import {
  marketMessage,
  matchMessage,
  type EventStatus,
  type LiveMessage,
  type MarketStatus,
  type MatchDeltaSource,
} from './live';

/** Result of a state change: whether anything changed and the deltas to publish after COMMIT. */
export interface CatalogChange {
  changed: boolean;
  messages: LiveMessage[];
}

/** A back-office actor, recorded in the audit log. */
export interface TradingActor {
  adminId: string;
  ip?: string | null;
  reason?: string;
}

/** Market statuses that can be set directly; 'settled' and 'void' come from resultEvent. */
export type TradingMarketStatus = 'open' | 'suspended' | 'closed';

const TRADING_MARKET_STATUSES: ReadonlySet<string> = new Set(['open', 'suspended', 'closed']);
const OPEN_EVENT_STATUSES: ReadonlySet<EventStatus> = new Set(['scheduled', 'live']);
const FINAL_MARKET_STATUSES: ReadonlySet<MarketStatus> = new Set(['settled', 'void']);

const matchFields = {
  id: events.id,
  status: events.status,
  bettingOpen: events.bettingOpen,
  liveMinute: events.liveMinute,
  period: events.period,
  scoreHome: events.scoreHome,
  scoreAway: events.scoreAway,
};

/** Locks the event row (FOR UPDATE) and returns its live fields; throws when it does not exist. */
export async function lockEvent(
  tx: DbTransaction,
  eventId: string,
): Promise<MatchDeltaSource & { htScoreHome: number | null; htScoreAway: number | null }> {
  const [row] = await tx
    .select({ ...matchFields, htScoreHome: events.htScoreHome, htScoreAway: events.htScoreAway })
    .from(events)
    .where(eq(events.id, eventId))
    .for('update');
  if (row === undefined) throw new CatalogNotFoundError('event', eventId);
  return row;
}

function assertOpenEvent(event: { id: string; status: EventStatus }, action: string): void {
  if (!OPEN_EVENT_STATUSES.has(event.status)) {
    throw new CatalogStateError(`cannot ${action}: event ${event.id} is ${event.status}`);
  }
}

/**
 * Opens, suspends or closes one market. 'closed' takes a market off the board
 * without settling it (e.g. its outcome became certain in play). Settled and
 * void markets are final; markets of an event that is not scheduled or live
 * cannot change either (CatalogStateError).
 */
export async function setMarketStatus(
  tx: DbTransaction,
  marketId: string,
  status: TradingMarketStatus,
  actor?: TradingActor,
): Promise<CatalogChange> {
  if (!TRADING_MARKET_STATUSES.has(status)) {
    throw new RangeError(
      `market status must be open, suspended or closed (got "${String(status)}"); ` +
        'use resultEvent to settle or void',
    );
  }
  const [row] = await tx
    .select({
      id: markets.id,
      status: markets.status,
      eventId: markets.eventId,
      eventStatus: events.status,
    })
    .from(markets)
    .innerJoin(events, eq(events.id, markets.eventId))
    .where(eq(markets.id, marketId))
    .for('update', { of: markets });
  if (row === undefined) throw new CatalogNotFoundError('market', marketId);
  if (row.status === status) return { changed: false, messages: [] };
  if (FINAL_MARKET_STATUSES.has(row.status)) {
    throw new CatalogStateError(`market ${marketId} is already ${row.status}`);
  }
  assertOpenEvent({ id: row.eventId, status: row.eventStatus }, `${status} market ${marketId}`);

  await tx
    .update(markets)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(markets.id, marketId));
  if (actor !== undefined) {
    await audit(tx, actor, `catalog.market.${status}`, 'market', marketId, {
      eventId: row.eventId,
      from: row.status,
    });
  }
  return { changed: true, messages: [marketMessage(row.eventId, marketId, status)] };
}

/**
 * Opens or closes betting on a whole event (events.betting_open) without
 * touching its markets, e.g. during a VAR check or a feed outage. Only for
 * scheduled or live events.
 */
export async function setEventBettingOpen(
  tx: DbTransaction,
  eventId: string,
  open: boolean,
  actor?: TradingActor,
): Promise<CatalogChange> {
  const event = await lockEvent(tx, eventId);
  if (event.bettingOpen === open) return { changed: false, messages: [] };
  assertOpenEvent(event, `${open ? 'open' : 'close'} betting`);
  const [row] = await tx
    .update(events)
    .set({ bettingOpen: open, updatedAt: sql`now()` })
    .where(eq(events.id, eventId))
    .returning(matchFields);
  if (row === undefined) throw new CatalogNotFoundError('event', eventId);
  if (actor !== undefined) {
    await audit(
      tx,
      actor,
      open ? 'catalog.event.betting_opened' : 'catalog.event.betting_closed',
      'event',
      eventId,
      {},
    );
  }
  return { changed: true, messages: [matchMessage(row)] };
}

export interface LiveStateInput {
  /** 'live' once the match has kicked off; resultEvent moves it on from there. */
  status: 'scheduled' | 'live';
  /** Whole match minute, null before kick-off. */
  minute: number | null;
  /** '1H' | 'HT' | '2H' | 'FT', 'Q1'…'Q4' | 'OT', 'S1'…; null before kick-off. */
  period: string | null;
  /** Current score; both null before kick-off. */
  home: number | null;
  away: number | null;
  /** Half-time score once the first half is over (football). */
  htHome?: number | null;
  htAway?: number | null;
}

/**
 * Writes the live state of a scheduled or live event (status, clock, period,
 * score, half-time score). Writes nothing and returns no delta when nothing
 * changed. Resulted events are refused (CatalogStateError).
 */
export async function applyLiveState(
  tx: DbTransaction,
  eventId: string,
  state: LiveStateInput,
): Promise<CatalogChange> {
  const next = checkedLiveState(state);
  const event = await lockEvent(tx, eventId);
  assertOpenEvent(event, 'apply a live state');
  if (
    event.status === next.status &&
    event.liveMinute === next.minute &&
    event.period === next.period &&
    event.scoreHome === next.home &&
    event.scoreAway === next.away &&
    event.htScoreHome === next.htHome &&
    event.htScoreAway === next.htAway
  ) {
    return { changed: false, messages: [] };
  }
  const [row] = await tx
    .update(events)
    .set({
      status: next.status,
      liveMinute: next.minute,
      period: next.period,
      scoreHome: next.home,
      scoreAway: next.away,
      htScoreHome: next.htHome,
      htScoreAway: next.htAway,
      updatedAt: sql`now()`,
    })
    .where(eq(events.id, eventId))
    .returning(matchFields);
  if (row === undefined) throw new CatalogNotFoundError('event', eventId);
  return { changed: true, messages: [matchMessage(row)] };
}

/** Suspends every open market of a scheduled or live event. */
export async function suspendEvent(
  tx: DbTransaction,
  eventId: string,
  actor?: TradingActor,
): Promise<CatalogChange> {
  return moveMarkets(tx, eventId, 'open', 'suspended', actor);
}

/** Re-opens every suspended market of a scheduled or live event. */
export async function resumeEvent(
  tx: DbTransaction,
  eventId: string,
  actor?: TradingActor,
): Promise<CatalogChange> {
  return moveMarkets(tx, eventId, 'suspended', 'open', actor);
}

async function moveMarkets(
  tx: DbTransaction,
  eventId: string,
  from: 'open' | 'suspended',
  to: 'open' | 'suspended',
  actor: TradingActor | undefined,
): Promise<CatalogChange> {
  const event = await lockEvent(tx, eventId);
  assertOpenEvent(event, to === 'suspended' ? 'suspend markets' : 'resume markets');
  const moved = await tx
    .update(markets)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(markets.eventId, eventId), eq(markets.status, from)))
    .returning({ id: markets.id });
  moved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (actor !== undefined) {
    await audit(
      tx,
      actor,
      to === 'suspended' ? 'catalog.event.suspended' : 'catalog.event.resumed',
      'event',
      eventId,
      { markets: moved.length },
    );
  }
  return {
    changed: moved.length > 0,
    messages: moved.map((market) => marketMessage(eventId, market.id, to)),
  };
}

function checkedLiveState(state: LiveStateInput): Required<LiveStateInput> {
  if (state.status !== 'scheduled' && state.status !== 'live') {
    throw new RangeError(
      `live state status must be scheduled or live (got "${String(state.status)}"); ` +
        'use resultEvent to finish, cancel, abandon or postpone',
    );
  }
  const minute = optionalCount(state.minute, 'minute');
  const home = optionalCount(state.home, 'home score');
  const away = optionalCount(state.away, 'away score');
  const htHome = optionalCount(state.htHome, 'half-time home score');
  const htAway = optionalCount(state.htAway, 'half-time away score');
  if ((home === null) !== (away === null)) {
    throw new RangeError('home and away scores must both be set or both be null');
  }
  if ((htHome === null) !== (htAway === null)) {
    throw new RangeError('half-time scores must both be set or both be null');
  }
  if (
    htHome !== null &&
    htAway !== null &&
    (home === null || away === null || htHome > home || htAway > away)
  ) {
    throw new RangeError(`half-time score ${htHome}-${htAway} exceeds the score ${home}-${away}`);
  }
  if (state.period !== null && (typeof state.period !== 'string' || state.period.length > 16)) {
    throw new RangeError(`invalid period: ${String(state.period)}`);
  }
  return { status: state.status, minute, period: state.period, home, away, htHome, htAway };
}

function optionalCount(value: number | null | undefined, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid ${what}: ${String(value)}`);
  }
  return value;
}

async function audit(
  tx: DbTransaction,
  actor: TradingActor,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: actor.adminId,
    action,
    targetType,
    targetId,
    metadata: actor.reason === undefined ? metadata : { ...metadata, reason: actor.reason },
    ip: actor.ip ?? null,
  });
}
