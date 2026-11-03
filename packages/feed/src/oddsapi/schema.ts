import { z } from 'zod';

/**
 * Parsing The Odds API (v4) responses into domain objects.
 *
 * External data is never trusted and one bad item must not poison a batch, so
 * every parse function is lenient: each event, bookmaker, market and score is
 * validated on its own and dropped (and counted) when invalid. Nothing here
 * throws. Prices are decimal floats from the provider; they are converted to
 * integer milli odds later, not here.
 *
 * Checked against real responses (fixtures/real): the per-event odds endpoint
 * gives bookmakers no `last_update` of their own (only their markets have
 * one), and some books quote a line at exactly 1.0 to mean "no price" (1xBet's
 * alternate totals). Such an outcome is left out; its market stays.
 */

/** A sport (league or competition) the API covers. */
export interface OddsApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  hasOutrights: boolean;
}

/** One priced outcome. `point` is the line (totals, spreads); null for h2h. */
export interface OddsApiOutcome {
  name: string;
  price: number;
  point: number | null;
  description: string | null;
}

/**
 * A bookmaker's market. `lastUpdate` falls back to the bookmaker's when absent.
 * Outcomes quoted at exactly 1.0 (no price) are left out, so a line can lose
 * one side; consumers pair outcomes before using them.
 */
export interface OddsApiMarket {
  key: string;
  lastUpdate: Date;
  outcomes: OddsApiOutcome[];
}

/**
 * One bookmaker's prices for an event. `lastUpdate` is the bookmaker's own,
 * or its newest market's when the response has none (the per-event endpoint).
 */
export interface OddsApiBookmaker {
  key: string;
  title: string;
  lastUpdate: Date;
  markets: OddsApiMarket[];
}

/** An event, with bookmakers only when odds were requested. Team names are null for outrights. */
export interface OddsApiEvent {
  id: string;
  sportKey: string;
  sportTitle: string | null;
  commenceTime: Date;
  homeTeam: string | null;
  awayTeam: string | null;
  bookmakers: OddsApiBookmaker[];
}

/** An event's score. `scores` and `lastUpdate` are null before the event starts. */
export interface OddsApiScore {
  id: string;
  sportKey: string;
  commenceTime: Date;
  completed: boolean;
  homeTeam: string;
  awayTeam: string;
  scores: Array<{ name: string; score: string }> | null;
  lastUpdate: Date | null;
}

/** A team or player taking part in a sport. */
export interface OddsApiParticipant {
  id: string;
  fullName: string;
}

/** The valid items of a response and how many entries were dropped as invalid. */
export interface Parsed<T> {
  items: T[];
  dropped: number;
}

const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const sportSchema = z.object({
  key: z.string().min(1),
  group: z.string(),
  title: z.string(),
  description: z.string(),
  active: z.boolean(),
  has_outrights: z.boolean(),
});

/** A decimal price of exactly 1.0 returns nothing: the book's way of quoting no price. */
const NO_PRICE = 1;

const outcomeSchema = z.object({
  name: z.string(),
  // 1.0 passes here and is left out by parseBookmaker; below 1 is malformed.
  price: z.number().gte(NO_PRICE),
  point: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  description: nullableString,
});

const marketSchema = z.object({
  key: z.string().min(1),
  last_update: time.optional(),
  outcomes: z.array(outcomeSchema).min(1),
});

const bookmakerShellSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  last_update: time.optional(),
  markets: z.array(z.unknown()),
});

const eventShellSchema = z.object({
  id: z.string().min(1),
  sport_key: z.string().min(1),
  sport_title: nullableString,
  commence_time: time,
  home_team: nullableString,
  away_team: nullableString,
  bookmakers: z.unknown().optional(),
});

const scoreSchema = z.object({
  id: z.string().min(1),
  sport_key: z.string().min(1),
  commence_time: time,
  completed: z.boolean(),
  home_team: z.string(),
  away_team: z.string(),
  scores: z
    .array(z.object({ name: z.string(), score: z.string() }))
    .nullish()
    .transform((value) => value ?? null),
  last_update: time.nullish().transform((value) => value ?? null),
});

const participantSchema = z.object({ full_name: z.string().min(1), id: z.string().min(1) });

const errorBodySchema = z.object({
  message: z.string(),
  error_code: nullableString,
});

/** Parses each array entry with `parseOne`; a null item is a drop. A non-array counts as one drop. */
function parseList<T>(
  raw: unknown,
  parseOne: (entry: unknown) => { item: T | null; dropped: number },
): Parsed<T> {
  if (!Array.isArray(raw)) return { items: [], dropped: 1 };
  const result: Parsed<T> = { items: [], dropped: 0 };
  for (const entry of raw) {
    const { item, dropped } = parseOne(entry);
    result.dropped += dropped;
    if (item) result.items.push(item);
  }
  return result;
}

/** Parses a list where each entry is validated against a plain schema. */
function parseSimple<S extends z.ZodType, T>(
  raw: unknown,
  schema: S,
  build: (value: z.output<S>) => T,
): Parsed<T> {
  return parseList<T>(raw, (entry) => {
    const result = schema.safeParse(entry);
    return result.success ? { item: build(result.data), dropped: 0 } : { item: null, dropped: 1 };
  });
}

/** Parses `/sports`. Invalid entries are dropped. */
export function parseSports(raw: unknown): Parsed<OddsApiSport> {
  return parseSimple(raw, sportSchema, (s) => ({
    key: s.key,
    group: s.group,
    title: s.title,
    description: s.description,
    active: s.active,
    hasOutrights: s.has_outrights,
  }));
}

function parseBookmaker(raw: unknown): { bookmaker: OddsApiBookmaker | null; dropped: number } {
  const shell = bookmakerShellSchema.safeParse(raw);
  if (!shell.success) return { bookmaker: null, dropped: 1 };
  const { key, title, last_update: bookUpdate, markets: rawMarkets } = shell.data;
  const markets: OddsApiMarket[] = [];
  let dropped = 0;
  for (const rawMarket of rawMarkets) {
    const market = marketSchema.safeParse(rawMarket);
    const lastUpdate = market.success ? (market.data.last_update ?? bookUpdate) : undefined;
    if (!market.success || lastUpdate === undefined) {
      // Malformed, or no time at all: a price of unknown age is never used.
      dropped += 1;
      continue;
    }
    const outcomes = market.data.outcomes.filter((outcome) => outcome.price > NO_PRICE);
    if (outcomes.length === 0) continue;
    markets.push({ key: market.data.key, lastUpdate, outcomes });
  }
  const lastUpdate = bookUpdate ?? newest(markets);
  // No time of its own and no usable market: nothing to keep.
  if (lastUpdate === null) return { bookmaker: null, dropped };
  return { bookmaker: { key, title, lastUpdate, markets }, dropped };
}

function newest(markets: readonly OddsApiMarket[]): Date | null {
  let best: Date | null = null;
  for (const market of markets) {
    if (best === null || market.lastUpdate.getTime() > best.getTime()) best = market.lastUpdate;
  }
  return best;
}

/** Parses one event object. Bookmakers and markets inside it are dropped individually. */
function parseEventObject(raw: unknown): { event: OddsApiEvent | null; dropped: number } {
  const shell = eventShellSchema.safeParse(raw);
  if (!shell.success) return { event: null, dropped: 1 };
  const e = shell.data;
  const rawBooks = e.bookmakers ?? [];
  let dropped = Array.isArray(rawBooks) ? 0 : 1;
  const bookmakers: OddsApiBookmaker[] = [];
  for (const rawBook of Array.isArray(rawBooks) ? rawBooks : []) {
    const parsed = parseBookmaker(rawBook);
    dropped += parsed.dropped;
    if (parsed.bookmaker) bookmakers.push(parsed.bookmaker);
  }
  const event: OddsApiEvent = {
    id: e.id,
    sportKey: e.sport_key,
    sportTitle: e.sport_title,
    commenceTime: e.commence_time,
    homeTeam: e.home_team,
    awayTeam: e.away_team,
    bookmakers,
  };
  return { event, dropped };
}

/** Parses an array of events (with or without bookmakers). An event with no bookmakers is kept. */
export function parseEvents(raw: unknown): Parsed<OddsApiEvent> {
  return parseList<OddsApiEvent>(raw, (entry) => {
    const { event, dropped } = parseEventObject(entry);
    return { item: event, dropped };
  });
}

/** Parses a single event object (the per-event odds endpoint): 0 or 1 item. */
export function parseEvent(raw: unknown): Parsed<OddsApiEvent> {
  const { event, dropped } = parseEventObject(raw);
  return { items: event ? [event] : [], dropped };
}

/** Parses `/scores`. Invalid entries are dropped. */
export function parseScores(raw: unknown): Parsed<OddsApiScore> {
  return parseSimple(raw, scoreSchema, (s) => ({
    id: s.id,
    sportKey: s.sport_key,
    commenceTime: s.commence_time,
    completed: s.completed,
    homeTeam: s.home_team,
    awayTeam: s.away_team,
    scores: s.scores,
    lastUpdate: s.last_update,
  }));
}

/** Parses `/participants`. Invalid entries are dropped. */
export function parseParticipants(raw: unknown): Parsed<OddsApiParticipant> {
  return parseSimple(raw, participantSchema, (p) => ({ id: p.id, fullName: p.full_name }));
}

/** Reads an error body, or returns null when it is not the documented shape. */
export function parseErrorBody(raw: unknown): { message: string; errorCode: string | null } | null {
  const result = errorBodySchema.safeParse(raw);
  return result.success
    ? { message: result.data.message, errorCode: result.data.error_code }
    : null;
}
