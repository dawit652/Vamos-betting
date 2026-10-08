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

const BETTABLE_EVENT_STATUSES: ReadonlySet<EventStatus> = new Set(['scheduled', 'live']);

/**
 * Whether a selection can be put on a bet slip: the same rule as the read API
 * (`isSelectionOpen` in apps/api), so an `odds` delta and a fresh GET agree.
 */
export function isSelectionBettable(
  eventStatus: EventStatus,
  bettingOpen: boolean,
  marketStatus: MarketStatus,
  selectionStatus: SelectionStatus,
): boolean {
  return (
    selectionStatus === 'open' &&
    marketStatus === 'open' &&
    bettingOpen &&
    BETTABLE_EVENT_STATUSES.has(eventStatus)
  );
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
