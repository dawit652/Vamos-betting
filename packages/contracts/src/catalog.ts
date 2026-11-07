import { z } from 'zod';

export const LocalizedNameSchema = z.object({
  en: z.string(),
  am: z.string().optional(),
  om: z.string().optional(),
  ti: z.string().optional(),
});
export type LocalizedNameValue = z.infer<typeof LocalizedNameSchema>;

export const SportCodeSchema = z.enum(['football', 'basketball', 'tennis', 'volleyball']);

export const EventStatusSchema = z.enum([
  'scheduled',
  'live',
  'finished',
  'cancelled',
  'postponed',
  'abandoned',
]);

export const SelectionView = z.object({
  id: z.string(),
  code: z.string(),
  /** Label for the slip, e.g. { en: 'Saint George', am: 'ቅዱስ ጊዮርጊስ' } or { en: 'Over 2.5' }. */
  label: LocalizedNameSchema,
  oddsMilli: z.number().int(),
  /** false when the market or selection is suspended or betting is closed. */
  open: z.boolean(),
});
export type SelectionView = z.infer<typeof SelectionView>;

export const MarketView = z.object({
  id: z.string(),
  type: z.string(),
  line: z.string().nullable(),
  name: LocalizedNameSchema,
  status: z.enum(['open', 'suspended', 'closed', 'settled', 'void']),
  selections: z.array(SelectionView),
});
export type MarketView = z.infer<typeof MarketView>;

export const TeamView = z.object({
  id: z.string(),
  name: LocalizedNameSchema,
  shortName: z.string(),
});

export const EventSummary = z.object({
  id: z.string(),
  gameId: z.string(),
  sport: SportCodeSchema,
  competition: z.object({
    slug: z.string(),
    name: LocalizedNameSchema,
    category: LocalizedNameSchema,
  }),
  home: TeamView,
  away: TeamView,
  startTime: z.string(),
  status: EventStatusSchema,
  liveMinute: z.number().int().nullable(),
  period: z.string().nullable(),
  score: z.object({ home: z.number().int(), away: z.number().int() }).nullable(),
  /** Main market for the list row: 1X2 (football), ML (basketball), winner (tennis/volleyball). */
  mainMarket: MarketView.nullable(),
  /** Number of other open markets ("+N markets"). */
  marketCount: z.number().int(),
});
export type EventSummary = z.infer<typeof EventSummary>;

export const EventDetail = EventSummary.extend({
  markets: z.array(MarketView),
  htScore: z.object({ home: z.number().int(), away: z.number().int() }).nullable(),
});
export type EventDetail = z.infer<typeof EventDetail>;

export const EventListFilter = z.enum(['highlights', 'today', 'upcoming', 'live']);

/** The market a list row shows: the 1X2 (football; ML / winner for the other sports) or double chance. */
export const EventListMarket = z.enum(['1x2', 'dc']);
export type EventListMarket = z.infer<typeof EventListMarket>;

const HOUR_MS = 60 * 60_000;
/** Africa/Addis_Ababa is UTC+3 all year (no daylight saving). */
const ADDIS_ABABA_OFFSET_MS = 3 * HOUR_MS;
/** The list's `day` may be today or up to this many days ahead (Addis Ababa calendar). */
export const EVENT_DAY_MAX_AHEAD = 14;

/** The Addis Ababa calendar date (YYYY-MM-DD) that is `daysAhead` days after the one containing `now`. */
export function addisAbabaDate(now: Date, daysAhead = 0): string {
  const local = new Date(now.getTime() + ADDIS_ABABA_OFFSET_MS + daysAhead * 24 * HOUR_MS);
  return local.toISOString().slice(0, 10);
}

/** Whether `day` (already shaped YYYY-MM-DD) is a real date from today to today + 14 in Addis Ababa. */
export function isEventDayInRange(day: string, now: Date): boolean {
  return day >= addisAbabaDate(now) && day <= addisAbabaDate(now, EVENT_DAY_MAX_AHEAD);
}

/** Whether `day` (YYYY-MM-DD) is a real calendar date. */
export function isCalendarDate(day: string): boolean {
  const time = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day;
}

const EventDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isCalendarDate, { message: 'Not a calendar date' });

export const EventListQuery = z.object({
  sport: SportCodeSchema.default('football'),
  filter: EventListFilter.default('highlights'),
  competition: z.string().optional(),
  /** Only events starting on this Addis Ababa calendar day (see `eventListQueryAt` for the range). */
  day: EventDay.optional(),
  /** Category (country) slug. */
  country: z.string().min(1).max(100).optional(),
  /** Market returned as each event's `mainMarket`; default '1x2'. */
  market: EventListMarket.default('1x2'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type EventListQuery = z.infer<typeof EventListQuery>;

/**
 * EventListQuery that also checks `day` against the clock: today up to
 * today + 14 days in Addis Ababa. The API parses with this (its own clock).
 */
export function eventListQueryAt(now: Date) {
  return EventListQuery.refine(
    (query) => query.day === undefined || isEventDayInRange(query.day, now),
    {
      message: `day must be today or up to ${EVENT_DAY_MAX_AHEAD} days ahead (Africa/Addis_Ababa)`,
      path: ['day'],
    },
  );
}

export const EventListResponse = z.object({
  items: z.array(EventSummary),
  nextCursor: z.string().nullable(),
});
export type EventListResponse = z.infer<typeof EventListResponse>;

export const SportsResponse = z.object({
  items: z.array(
    z.object({
      id: SportCodeSchema,
      name: LocalizedNameSchema,
      liveCount: z.number().int(),
      upcomingCount: z.number().int(),
    }),
  ),
});
export type SportsResponse = z.infer<typeof SportsResponse>;

export const CompetitionsResponse = z.object({
  items: z.array(
    z.object({
      category: z.object({
        slug: z.string(),
        name: LocalizedNameSchema,
        /** ISO 3166-1 alpha-2 code, or null for international groupings. */
        countryCode: z.string().nullable(),
      }),
      competitions: z.array(
        z.object({
          slug: z.string(),
          name: LocalizedNameSchema,
          eventCount: z.number().int(),
          featured: z.boolean(),
        }),
      ),
    }),
  ),
});
export type CompetitionsResponse = z.infer<typeof CompetitionsResponse>;

/**
 * Server-Sent Events on GET /live/stream. Compact keys keep mobile data low.
 * - event `odds`:  { s: selectionId, o: oddsMilli, st: 'open' | 'suspended' }
 * - event `match`: { e: eventId, m: minute | null, p: period | null, sc: [home, away] | null, st: status, b: bettingOpen }
 * - event `market`: { k: marketId, st: market status }
 */
export const OddsDelta = z.object({
  s: z.string(),
  o: z.number().int(),
  st: z.enum(['open', 'suspended']),
});
export const MatchDelta = z.object({
  e: z.string(),
  m: z.number().int().nullable(),
  p: z.string().nullable(),
  sc: z.tuple([z.number().int(), z.number().int()]).nullable(),
  st: EventStatusSchema,
  b: z.boolean(),
});
export const MarketDelta = z.object({
  k: z.string(),
  st: z.enum(['open', 'suspended', 'closed', 'settled', 'void']),
});

/** Redis pub/sub channel the worker publishes live changes to and the API's SSE endpoint relays. */
export const LIVE_CHANNEL = 'vamos:live';

/** Envelope published on LIVE_CHANNEL; `eventId` lets the SSE endpoint filter per match. */
export const LiveMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('odds'), eventId: z.string(), data: OddsDelta }),
  z.object({ type: z.literal('match'), eventId: z.string(), data: MatchDelta }),
  z.object({ type: z.literal('market'), eventId: z.string(), data: MarketDelta }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;

/** GET /search: team and competition name search (the query is trimmed first). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;

export const SearchQuery = z.object({
  q: z.string().trim().min(SEARCH_MIN_LENGTH).max(SEARCH_MAX_LENGTH),
  sport: SportCodeSchema.optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchCompetition = z.object({
  slug: z.string(),
  sport: SportCodeSchema,
  name: LocalizedNameSchema,
  category: z.object({
    slug: z.string(),
    name: LocalizedNameSchema,
    countryCode: z.string().nullable(),
  }),
  /** Live plus scheduled events in the next 72 hours (as on the leagues list). */
  eventCount: z.number().int(),
});
export type SearchCompetition = z.infer<typeof SearchCompetition>;

export const SearchResponse = z.object({
  competitions: z.array(SearchCompetition),
  events: z.array(EventSummary),
});
export type SearchResponse = z.infer<typeof SearchResponse>;
