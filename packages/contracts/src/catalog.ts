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

export const EventListQuery = z.object({
  sport: SportCodeSchema.default('football'),
  filter: EventListFilter.default('highlights'),
  competition: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type EventListQuery = z.infer<typeof EventListQuery>;

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
