import { z } from 'zod';

/**
 * Parsing The Odds API (v4) responses into domain objects.
 *
 * External data is never trusted and one bad item must not poison a batch, so
 * every parse function is lenient: each event, bookmaker, market and score is
 * validated on its own and dropped (and counted) when invalid. Nothing here
 * throws. Prices are decimal floats from the provider; they are converted to
 * integer milli odds later, not here.
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

/** A bookmaker's market. `lastUpdate` falls back to the bookmaker's when absent. */
export interface OddsApiMarket {
  key: string;
  lastUpdate: Date;
  outcomes: OddsApiOutcome[];
}

/** One bookmaker's prices for an event. */
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

const outcomeSchema = z.object({
  name: z.string(),
  price: z.number().gt(1),
  point: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  description: nullableString,
});

const marketSchema = z.object({
  key: z.string().min(1),
  last_update: time.optional(),
  outcomes: z.array(z.unknown()),
});

const bookmakerShellSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  // Absent from the per-event odds endpoint, which stamps each market instead.
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

/** An outcome priced at exactly 1.00: bookmakers keep dead alternate lines at that price. */
function isDeadPrice(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { price?: unknown }).price === 1;
}

function parseBookmaker(raw: unknown): { bookmaker: OddsApiBookmaker | null; dropped: number } {
  const shell = bookmakerShellSchema.safeParse(raw);
  if (!shell.success) return { bookmaker: null, dropped: 1 };
  const { key, title, markets: rawMarkets } = shell.data;
  const parsed: Array<{ key: string; last_update: Date | undefined; outcomes: OddsApiOutcome[] }> =
    [];
  let dropped = 0;
  for (const rawMarket of rawMarkets) {
    const market = marketSchema.safeParse(rawMarket);
    if (!market.success) {
      dropped += 1;
      continue;
    }
    // Outcomes are judged one by one: a line quoted at exactly 1.00 (a dead alternate
    // line) is skipped silently, a malformed one is dropped and counted. Whoever reads
    // the market checks it still has the outcomes it needs.
    const outcomes: OddsApiOutcome[] = [];
    for (const rawOutcome of market.data.outcomes) {
      const outcome = outcomeSchema.safeParse(rawOutcome);
      if (outcome.success) outcomes.push(outcome.data);
      else if (!isDeadPrice(rawOutcome)) dropped += 1;
    }
    if (outcomes.length === 0) {
      if (market.data.outcomes.length === 0) dropped += 1;
      continue;
    }
    parsed.push({ key: market.data.key, last_update: market.data.last_update, outcomes });
  }
  // The bookmaker's own stamp, else the newest of its markets'.
  const stamps = parsed.flatMap((m) => (m.last_update === undefined ? [] : [m.last_update]));
  const lastUpdate =
    shell.data.last_update ??
    (stamps.length === 0 ? null : new Date(Math.max(...stamps.map((d) => d.getTime()))));
  if (lastUpdate === null) return { bookmaker: null, dropped: dropped + 1 };
  const markets: OddsApiMarket[] = parsed.map((m) => ({
    key: m.key,
    lastUpdate: m.last_update ?? lastUpdate,
    outcomes: m.outcomes,
  }));
  return { bookmaker: { key, title, lastUpdate, markets }, dropped };
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
