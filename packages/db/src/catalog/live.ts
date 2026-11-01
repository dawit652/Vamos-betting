import type { eventStatus, marketStatus, selectionStatus } from '../schema/catalog';

/**
 * Live-change envelopes returned by the catalogue write functions. Callers
 * publish them on LIVE_CHANNEL after COMMIT, never before (a rolled-back
 * change must not reach players).
 *
 * These types mirror `LiveMessage` / `LIVE_CHANNEL` in @vamos/contracts
 * (packages/contracts/src/catalog.ts), which @vamos/db does not depend on.
 * test/catalog-service.test.ts checks that both stay identical.
 */

export type EventStatus = (typeof eventStatus.enumValues)[number];
export type MarketStatus = (typeof marketStatus.enumValues)[number];
export type SelectionStatus = (typeof selectionStatus.enumValues)[number];

/** Redis pub/sub channel of live changes (same value as LIVE_CHANNEL in @vamos/contracts). */
export const LIVE_CHANNEL = 'vamos:live';

/** `odds`: { s: selectionId, o: oddsMilli, st: whether the selection can be bet on now }. */
export interface OddsDeltaData {
  s: string;
  o: number;
  st: 'open' | 'suspended';
}

/** `match`: minute, period, score ([home, away], null before kick-off), status, bettingOpen. */
export interface MatchDeltaData {
  e: string;
  m: number | null;
  p: string | null;
  sc: [number, number] | null;
  st: EventStatus;
  b: boolean;
}

/** `market`: { k: marketId, st: market status }. */
export interface MarketDeltaData {
  k: string;
  st: MarketStatus;
}

export type LiveMessage =
  | { type: 'odds'; eventId: string; data: OddsDeltaData }
  | { type: 'match'; eventId: string; data: MatchDeltaData }
  | { type: 'market'; eventId: string; data: MarketDeltaData };

/** The event fields a `match` delta is built from. */
export interface MatchDeltaSource {
  id: string;
  status: EventStatus;
  bettingOpen: boolean;
  liveMinute: number | null;
  period: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
}

/** Largest events.close_lead_ms (6 hours; the column's CHECK constraint). */
export const MAX_CLOSE_LEAD_MS = 6 * 60 * 60 * 1000;

/** The event fields that decide whether its selections can be bet on. */
export interface BettableEvent {
  status: EventStatus;
  bettingOpen: boolean;
  startTime: Date;
  /**
   * events.close_lead_ms: prematch betting closes this long before the start
   * time. Required, so that no caller can forget it and keep betting open up
   * to a kick-off a late feed has not reported yet.
   */
  closeLeadMs: number;
}

/**
 * The moment prematch betting on an event closes: `closeLeadMs` before its
 * start time. Null when the lead is not a whole number in
 * 0..MAX_CLOSE_LEAD_MS, which closes betting (fail closed).
 */
export function prematchClosesAt(
  event: Pick<BettableEvent, 'startTime' | 'closeLeadMs'>,
): Date | null {
  const lead = event.closeLeadMs;
  if (!Number.isSafeInteger(lead) || lead < 0 || lead > MAX_CLOSE_LEAD_MS) return null;
  return new Date(event.startTime.getTime() - lead);
}

/**
 * Whether a selection can be put on a bet slip at `now`: the selection and
 * its market are open, betting on the event is open, and the event is live,
 * or scheduled and its prematch betting has not closed yet. Prematch betting
 * closes at the start time minus the event's close lead (prematchClosesAt),
 * even when the kick-off has not been recorded yet. The read API
 * (`isSelectionOpen` in apps/api) uses this same rule, so an `odds` delta and
 * a fresh GET agree; bet placement must use it too.
 */
export function isSelectionBettable(
  event: BettableEvent,
  marketStatus: MarketStatus,
  selectionStatus: SelectionStatus,
  now: Date,
): boolean {
  if (selectionStatus !== 'open' || marketStatus !== 'open' || !event.bettingOpen) return false;
  if (event.status === 'live') return true;
  if (event.status !== 'scheduled') return false;
  const closesAt = prematchClosesAt(event);
  return closesAt !== null && closesAt.getTime() > now.getTime();
}

export function matchMessage(event: MatchDeltaSource): LiveMessage {
  const score: [number, number] | null =
    event.status === 'scheduled' || event.scoreHome === null || event.scoreAway === null
      ? null
      : [event.scoreHome, event.scoreAway];
  return {
    type: 'match',
    eventId: event.id,
    data: {
      e: event.id,
      m: event.liveMinute,
      p: event.period,
      sc: score,
      st: event.status,
      b: event.bettingOpen,
    },
  };
}

export function marketMessage(
  eventId: string,
  marketId: string,
  status: MarketStatus,
): LiveMessage {
  return { type: 'market', eventId, data: { k: marketId, st: status } };
}

export function oddsMessage(
  eventId: string,
  selectionId: string,
  oddsMilli: number,
  bettable: boolean,
): LiveMessage {
  return {
    type: 'odds',
    eventId,
    data: { s: selectionId, o: oddsMilli, st: bettable ? 'open' : 'suspended' },
  };
}
