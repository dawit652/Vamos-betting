import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isSelectionBettable, type EventStatus, type MarketStatus } from '../catalog/live';
import type { DbExecutor } from '../ledger/types';
import {
  competitions,
  events,
  markets,
  selections,
  sports,
  teams,
  type LocalizedName,
} from '../schema/catalog';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string (anything else cannot name a row). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A selection with its market, event, competition and teams, as needed for slips and bet views. */
export interface SelectionSnapshot {
  selectionId: string;
  /** Selection code ('1', 'X', 'over', '2-1', …). */
  code: string;
  oddsMilli: number;
  selectionStatus: 'open' | 'suspended' | 'settled';
  result: 'won' | 'lost' | 'void' | null;
  marketId: string;
  /** MarketTypeCode ('1x2', 'ou', …). */
  marketType: string;
  marketLine: string | null;
  marketKey: string;
  marketStatus: MarketStatus;
  /** markets.price_valid_until: the price is refused from this instant (rule P7); null never expires. */
  priceValidUntil: Date | null;
  eventId: string;
  gameId: number;
  sportId: string;
  competitionId: string;
  competitionName: LocalizedName;
  homeTeam: LocalizedName;
  awayTeam: LocalizedName;
  startTime: Date;
  /** events.close_lead_ms: prematch betting closes this long before startTime. */
  closeLeadMs: number;
  eventStatus: EventStatus;
  bettingOpen: boolean;
  scoreHome: number | null;
  scoreAway: number | null;
  sportActive: boolean;
  competitionActive: boolean;
}

/**
 * Why a selection cannot be bet on now:
 * - not_found: no such selection;
 * - inactive: its sport or competition is switched off;
 * - event_started: prematch betting closed (at the start time, or the event's
 *   close lead before it: see prematchClosesAt);
 * - event_closed: the event is finished, cancelled, postponed or abandoned;
 * - suspended: betting on the event, the market or the selection is suspended, or the
 *   market's price has expired (markets.price_valid_until is at or before `now`, rule P7);
 * - market_closed: the market is closed, settled or void (or the selection settled).
 */
export type UnavailableReason =
  'not_found' | 'inactive' | 'event_started' | 'event_closed' | 'suspended' | 'market_closed';

/**
 * null when the selection can be bet on at `now` (isSelectionBettable plus an
 * active sport and competition), else the reason it cannot.
 */
export function unavailableReason(
  snapshot: SelectionSnapshot | undefined,
  now: Date,
): UnavailableReason | null {
  if (snapshot === undefined) return 'not_found';
  if (!snapshot.sportActive || !snapshot.competitionActive) return 'inactive';
  const bettable = isSelectionBettable(
    {
      status: snapshot.eventStatus,
      bettingOpen: snapshot.bettingOpen,
      startTime: snapshot.startTime,
      closeLeadMs: snapshot.closeLeadMs,
    },
    snapshot.marketStatus,
    snapshot.selectionStatus,
    now,
  );
  if (bettable) return priceExpired(snapshot, now) ? 'suspended' : null;
  if (snapshot.eventStatus !== 'scheduled' && snapshot.eventStatus !== 'live') {
    return 'event_closed';
  }
  if (snapshot.marketStatus === 'suspended' || snapshot.selectionStatus === 'suspended') {
    return 'suspended';
  }
  if (snapshot.marketStatus !== 'open' || snapshot.selectionStatus !== 'open') {
    return 'market_closed';
  }
  if (!snapshot.bettingOpen) return 'suspended';
  return 'event_started';
}

/**
 * True when the market's price has expired at `now` (rule P7): from `price_valid_until` on, the
 * price is no longer offered. A missing timestamp (a snapshot built elsewhere) never expires.
 */
export function priceExpired(
  snapshot: Pick<SelectionSnapshot, 'priceValidUntil'>,
  now: Date,
): boolean {
  const until = snapshot.priceValidUntil;
  return until !== null && until !== undefined && now.getTime() >= until.getTime();
}

const homeTeams = alias(teams, 'home_team');
const awayTeams = alias(teams, 'away_team');

/**
 * Loads the snapshots of the given selections, keyed by selection id
 * (ids that are not UUIDs or do not exist are simply absent). With
 * `lock: 'share'` the selection rows (only) are locked FOR SHARE in id order,
 * so resulting or repricing them waits for the caller's transaction, while
 * events and markets are not locked (the live simulator and trading keep
 * their event → market → selection lock order free of cycles).
 */
export async function loadSelectionSnapshots(
  exec: DbExecutor,
  selectionIds: readonly string[],
  options: { lock?: 'share' } = {},
): Promise<Map<string, SelectionSnapshot>> {
  const ids = [...new Set(selectionIds.filter(isUuid).map((id) => id.toLowerCase()))].sort();
  const found = new Map<string, SelectionSnapshot>();
  if (ids.length === 0) return found;
  const query = exec
    .select({
      selectionId: selections.id,
      code: selections.code,
      oddsMilli: selections.oddsMilli,
      selectionStatus: selections.status,
      result: selections.result,
      marketId: markets.id,
      marketType: markets.type,
      marketLine: markets.line,
      marketKey: markets.key,
      marketStatus: markets.status,
      priceValidUntil: markets.priceValidUntil,
      eventId: events.id,
      gameId: events.gameId,
      sportId: events.sportId,
      competitionId: competitions.id,
      competitionName: competitions.name,
      homeTeam: homeTeams.name,
      awayTeam: awayTeams.name,
      startTime: events.startTime,
      closeLeadMs: events.closeLeadMs,
      eventStatus: events.status,
      bettingOpen: events.bettingOpen,
      scoreHome: events.scoreHome,
      scoreAway: events.scoreAway,
      sportActive: sports.active,
      competitionActive: competitions.active,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .innerJoin(events, eq(events.id, markets.eventId))
    .innerJoin(competitions, eq(competitions.id, events.competitionId))
    .innerJoin(sports, eq(sports.id, events.sportId))
    .innerJoin(homeTeams, eq(homeTeams.id, events.homeTeamId))
    .innerJoin(awayTeams, eq(awayTeams.id, events.awayTeamId))
    .where(inArray(selections.id, ids))
    .orderBy(asc(selections.id));
  const rows =
    options.lock === 'share' ? await query.for('share', { of: selections }) : await query;
  for (const row of rows) found.set(row.selectionId, row);
  return found;
}

/** The snapshot of a selection id as given by a client (ids are compared lower-cased). */
export function snapshotOf(
  snapshots: ReadonlyMap<string, SelectionSnapshot>,
  selectionId: string,
): SelectionSnapshot | undefined {
  return isUuid(selectionId) ? snapshots.get(selectionId.toLowerCase()) : undefined;
}
