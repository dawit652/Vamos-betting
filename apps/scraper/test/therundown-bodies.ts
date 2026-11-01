/**
 * SYNTHETIC TheRundown v2 responses, written by hand in the documented shape (like
 * packages/scraper/src/adapters/__fixtures__/therundown-day.json). Not real data: their licence
 * forbids keeping real responses beyond 24 hours.
 */

export interface BookPrices {
  home: number;
  draw: number;
  away: number;
  over: number;
  under: number;
}

/** Three books that agree to within a point or two: Pinnacle (3), BookMaker (7) and Circa (32). */
export const AGREEING_BOOKS: Readonly<Record<number, BookPrices>> = Object.freeze({
  3: { home: -120, draw: 290, away: 320, over: -105, under: -115 },
  7: { home: -118, draw: 295, away: 330, over: -102, under: -118 },
  32: { home: -125, draw: 285, away: 310, over: -108, under: -112 },
});

/** 5 minutes before T0 of the test harness (2026-10-29T12:00Z): fresh for every tier. */
export const FRESH = new Date('2026-10-29T11:55:00Z');

export interface EventSpec {
  id: string;
  sportId?: number;
  kickoff: Date;
  status?: string;
  home?: { id: number; name: string };
  away?: { id: number; name: string };
  books?: Readonly<Record<number, BookPrices>>;
  /** When the books last changed their prices (default: FRESH, 5 minutes before the tests' clock starts). */
  updatedAt?: Date;
  line?: string;
}

const price = (american: number, updatedAt: string, bookId: number) => ({
  price: american,
  is_main_line: true,
  updated_at: updatedAt,
  ...(bookId === 3 ? { liquidity_usd: 5000 } : {}),
});

export function eventJson(spec: EventSpec): Record<string, unknown> {
  const home = spec.home ?? { id: 7, name: 'Arsenal' };
  const away = spec.away ?? { id: 9, name: 'Chelsea' };
  const books = spec.books ?? AGREEING_BOOKS;
  const updatedAt = (spec.updatedAt ?? FRESH).toISOString();
  const side = (key: keyof BookPrices) =>
    Object.fromEntries(
      Object.entries(books).map(([bookId, prices]) => [
        bookId,
        price(prices[key], updatedAt, Number(bookId)),
      ]),
    );
  const line = spec.line ?? '2.5';
  return {
    event_id: spec.id,
    sport_id: spec.sportId ?? 11,
    event_date: spec.kickoff.toISOString(),
    score: {
      event_status: spec.status ?? 'STATUS_SCHEDULED',
      score_home: 0,
      score_away: 0,
      team_id_home: home.id,
      team_id_away: away.id,
      updated_at: updatedAt,
    },
    // The away team first, like TheRundown: never read by position.
    teams: [
      { team_id: away.id, name: away.name, is_away: true, is_home: false },
      { team_id: home.id, name: home.name, is_home: true, is_away: false },
    ],
    markets: [
      {
        market_id: 1,
        period_id: 0,
        participants: [
          {
            id: home.id,
            type: 'TYPE_TEAM',
            name: home.name,
            lines: [{ value: '', prices: side('home') }],
          },
          {
            id: away.id,
            type: 'TYPE_TEAM',
            name: away.name,
            lines: [{ value: '', prices: side('away') }],
          },
          {
            id: 3001,
            type: 'TYPE_RESULT',
            name: 'Draw',
            lines: [{ value: '', prices: side('draw') }],
          },
        ],
      },
      {
        market_id: 3,
        period_id: 0,
        participants: [
          {
            id: 4001,
            type: 'TYPE_RESULT',
            name: 'Over',
            lines: [{ value: line, prices: side('over') }],
          },
          {
            id: 4002,
            type: 'TYPE_RESULT',
            name: 'Under',
            lines: [{ value: line, prices: side('under') }],
          },
        ],
      },
    ],
  };
}

/** A day response: `{ meta, events: [...] }`. */
export const dayBody = (specs: readonly EventSpec[]): string =>
  JSON.stringify({ meta: { delta_last_id: '1' }, events: specs.map(eventJson) });

/** A single-event response: the event object itself. */
export const eventBody = (spec: EventSpec): string => JSON.stringify(eventJson(spec));

/** `GET /api/v2/affiliates`: the healthy books. */
export const affiliatesBody = (healthy: readonly number[] = [3, 7, 32, 9, 19]): string =>
  JSON.stringify({
    affiliates: healthy.map((id) => ({ affiliate_id: id, name: `book ${id}`, status: 'healthy' })),
  });
