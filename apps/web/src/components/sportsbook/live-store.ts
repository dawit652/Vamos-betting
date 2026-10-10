import type { MarketStatus } from './events';

/**
 * Live deltas from GET /live/stream (Server-Sent Events), kept per selection,
 * market and event. Plain TypeScript (no React) so it is unit tested; the
 * LiveProvider feeds it and components read it with useSyncExternalStore.
 *
 * Frames (see LiveMessage in @vamos/contracts):
 * - `odds`:   { s: selectionId, o: oddsMilli, st: 'open' | 'suspended' }
 * - `match`:  { e: eventId, m: minute | null, p: period | null, sc: [home, away] | null, st, b }
 * - `market`: { k: marketId, st: market status }
 * Frames are validated by hand: zod stays out of the browser bundle.
 */

export interface OddsState {
  oddsMilli: number;
  open: boolean;
}

export type EventStatus =
  'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed' | 'abandoned';

export interface MatchState {
  minute: number | null;
  period: string | null;
  score: { home: number; away: number } | null;
  status: EventStatus;
  bettingOpen: boolean;
}

export type LiveChange =
  | { type: 'odds'; selectionId: string; state: OddsState }
  | { type: 'match'; eventId: string; state: MatchState }
  | { type: 'market'; marketId: string; status: MarketStatus };

const MARKET_STATUSES: readonly string[] = ['open', 'suspended', 'closed', 'settled', 'void'];
const EVENT_STATUSES: readonly string[] = [
  'scheduled',
  'live',
  'finished',
  'cancelled',
  'postponed',
  'abandoned',
];

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

/** Parses one SSE frame (`event` name and `data` text); null when it is not a valid delta. */
export function parseLiveFrame(type: string, data: string): LiveChange | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  switch (type) {
    case 'odds':
      if (!isId(r.s) || !isInt(r.o) || (r.st !== 'open' && r.st !== 'suspended')) return null;
      return { type, selectionId: r.s, state: { oddsMilli: r.o, open: r.st === 'open' } };
    case 'market':
      if (!isId(r.k) || typeof r.st !== 'string' || !MARKET_STATUSES.includes(r.st)) return null;
      return { type, marketId: r.k, status: r.st as MarketStatus };
    case 'match': {
      if (!isId(r.e) || typeof r.st !== 'string' || !EVENT_STATUSES.includes(r.st)) return null;
      if (typeof r.b !== 'boolean') return null;
      if (r.m !== null && !isInt(r.m)) return null;
      if (r.p !== null && typeof r.p !== 'string') return null;
      let score: MatchState['score'] = null;
      if (r.sc !== null) {
        if (!Array.isArray(r.sc) || r.sc.length !== 2 || !r.sc.every(isInt)) return null;
        score = { home: r.sc[0] as number, away: r.sc[1] as number };
      }
      return {
        type,
        eventId: r.e.toLowerCase(),
        state: {
          minute: r.m,
          period: r.p,
          score,
          status: r.st as EventStatus,
          bettingOpen: r.b,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The latest live state. `apply` records a change; listeners are notified
 * once per `flush` (the provider batches frames so a burst of odds ticks
 * re-renders once).
 *
 * Live values win over the server-rendered ones they patch, so they must not
 * outlive fresher server data: every value carries the sequence number of the
 * frame that set it, the provider takes a `mark()` when it asks the server for
 * a re-render, and calls `dropUpTo(mark)` when the new server props arrive.
 * Values from frames received after the mark are newer than that render and
 * stay; older ones are dropped, so the server's values show again.
 */
export class LiveStore {
  private readonly odds = new Map<string, { value: OddsState; seq: number }>();
  private readonly markets = new Map<string, { value: MarketStatus; seq: number }>();
  private readonly matches = new Map<string, { value: MatchState; seq: number }>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private dirty = false;
  private online = true;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getOdds(selectionId: string): OddsState | undefined {
    return this.odds.get(selectionId)?.value;
  }

  getMarket(marketId: string): MarketStatus | undefined {
    return this.markets.get(marketId)?.value;
  }

  getMatch(eventId: string): MatchState | undefined {
    return this.matches.get(eventId.toLowerCase())?.value;
  }

  get connected(): boolean {
    return this.online;
  }

  apply(change: LiveChange): void {
    const seq = ++this.seq;
    switch (change.type) {
      case 'odds':
        this.odds.set(change.selectionId, { value: change.state, seq });
        break;
      case 'market':
        this.markets.set(change.marketId, { value: change.status, seq });
        break;
      case 'match':
        this.matches.set(change.eventId, { value: change.state, seq });
        break;
    }
    this.dirty = true;
  }

  /** A point in the frame sequence: values applied so far are at or before it. */
  mark(): number {
    return this.seq;
  }

  /** Drops the values set at or before `mark` (the server's props are fresher than them). */
  dropUpTo(mark: number): void {
    for (const map of [this.odds, this.markets, this.matches] as Map<string, { seq: number }>[]) {
      for (const [key, entry] of map) {
        if (entry.seq <= mark) {
          map.delete(key);
          this.dirty = true;
        }
      }
    }
  }

  setConnected(connected: boolean): void {
    if (this.online === connected) return;
    this.online = connected;
    this.dirty = true;
  }

  /** Notifies listeners when something changed since the last flush. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }
}
