import {
  type OddsApiEvent,
  type OddsApiParticipant,
  type OddsApiScore,
  type OddsApiSport,
  type Parsed,
  parseErrorBody,
  parseEvent,
  parseEvents,
  parseParticipants,
  parseScores,
  parseSports,
} from './schema';

/**
 * HTTP client for The Odds API (v4).
 *
 * It only fetches and parses; pricing and consensus live elsewhere. The API
 * key travels in the query string, so the client takes care that it never
 * reaches an error, a stack or a log: nothing is logged, and anything copied
 * from a failed request has the key replaced with `***`.
 */

/** Default API root. */
export const DEFAULT_ODDS_API_BASE_URL = 'https://api.the-odds-api.com/v4';
/** Default per-attempt timeout. */
export const DEFAULT_ODDS_API_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const JITTER = 0.2;
const BOOKMAKERS_PER_REGION = 10;
const SPORT_KEY = /^[a-z0-9_]{2,80}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Credits left, used and charged by the last call, from the `x-requests-*` headers. */
export interface OddsApiQuota {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

/** A parsed response, the quota headers that came with it and how many entries were dropped. */
export interface OddsApiResult<T> {
  data: T;
  quota: OddsApiQuota;
  dropped: number;
}

/** What went wrong. Only rate_limited, server, network and timeout are retried. */
export type OddsApiErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limited'
  | 'invalid_request'
  | 'not_found'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad_response';

const RETRYABLE: ReadonlySet<OddsApiErrorKind> = new Set([
  'rate_limited',
  'server',
  'network',
  'timeout',
]);

/** A failed request. `path` has no query string, so it cannot leak the API key. */
export class OddsApiError extends Error {
  readonly kind: OddsApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly quota: OddsApiQuota | null;
  readonly retryable: boolean;
  readonly path: string;
  /** Delay the server asked for with `Retry-After`, in ms. */
  readonly retryAfterMs: number | null;

  constructor(init: {
    kind: OddsApiErrorKind;
    message: string;
    path: string;
    status?: number | null;
    code?: string | null;
    quota?: OddsApiQuota | null;
    retryAfterMs?: number | null;
  }) {
    super(init.message);
    this.name = 'OddsApiError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.quota = init.quota ?? null;
    this.retryable = RETRYABLE.has(init.kind);
    this.path = init.path;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

/** Client settings. `fetch`, `sleep` and `random` are injectable for tests. */
export interface OddsApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Extra attempts after a retryable failure. Default 2. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Parameters of an odds call. `bookmakers`, when non-empty, replaces `regions`. */
export interface OddsQuery {
  markets: readonly string[];
  regions?: readonly string[];
  bookmakers?: readonly string[];
  eventIds?: readonly string[];
  commenceTimeFrom?: Date;
  commenceTimeTo?: Date;
}

type Params = Array<[string, string]>;

function checkedSportKey(key: string): string {
  if (!SPORT_KEY.test(key)) throw new RangeError(`invalid sport key: ${JSON.stringify(key)}`);
  return key;
}

function checkedEventIds(ids: readonly string[]): string {
  for (const id of ids) {
    if (!EVENT_ID.test(id)) throw new RangeError(`invalid event id: ${JSON.stringify(id)}`);
  }
  return ids.join(',');
}

/** `YYYY-MM-DDTHH:MM:SSZ`: the API rejects milliseconds. */
function formatDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Validates the markets / regions / bookmakers combination and returns the pricing scope. */
function oddsScope(query: Pick<OddsQuery, 'markets' | 'regions' | 'bookmakers'>): Params {
  if (query.markets.length === 0) throw new RangeError('markets must not be empty');
  const params: Params = [['markets', query.markets.join(',')]];
  if (query.bookmakers && query.bookmakers.length > 0) {
    params.push(['bookmakers', query.bookmakers.join(',')]);
  } else if (query.regions && query.regions.length > 0) {
    params.push(['regions', query.regions.join(',')]);
  } else {
    throw new RangeError('either regions or bookmakers is required');
  }
  return params;
}

/**
 * Credits an odds call costs: markets × regions. A bookmakers list counts one
 * region per 10 bookmakers (rounded up) and takes priority over regions, as
 * the API does.
 */
export function estimateOddsCost(
  query: Pick<OddsQuery, 'markets' | 'regions' | 'bookmakers'>,
): number {
  oddsScope(query);
  const regions =
    query.bookmakers && query.bookmakers.length > 0
      ? Math.ceil(query.bookmakers.length / BOOKMAKERS_PER_REGION)
      : (query.regions?.length ?? 0);
  return query.markets.length * regions;
}

/** Credits a scores call costs: 2 with daysFrom, else 1. */
export function estimateScoresCost(daysFrom?: number): number {
  return daysFrom === undefined ? 1 : 2;
}

function readCount(headers: Headers, name: string): number | null {
  const value = headers.get(name)?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function readQuota(headers: Headers): OddsApiQuota {
  return {
    remaining: readCount(headers, 'x-requests-remaining'),
    used: readCount(headers, 'x-requests-used'),
    last: readCount(headers, 'x-requests-last'),
  };
}

function readRetryAfterMs(headers: Headers): number | null {
  const value = headers.get('retry-after')?.trim();
  return value !== undefined && /^\d+(\.\d+)?$/.test(value)
    ? Math.min(MAX_DELAY_MS, Number(value) * 1000)
    : null;
}

function kindFor(status: number, code: string | null): OddsApiErrorKind {
  if (code === 'OUT_OF_USAGE_CREDITS' && (status === 401 || status === 429)) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return status >= 400 ? 'invalid_request' : 'bad_response';
}

/** Client for the v4 endpoints the feed needs. Retries transient failures with jittered backoff. */
export class OddsApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: OddsApiClientOptions) {
    if (options.apiKey.length === 0) throw new RangeError('apiKey must not be empty');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ODDS_API_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ODDS_API_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /** `GET /sports`: the sports list. Free. `all` includes out-of-season sports. */
  async sports(options: { all?: boolean } = {}): Promise<OddsApiResult<OddsApiSport[]>> {
    const params: Params = [['dateFormat', 'iso']];
    if (options.all) params.push(['all', 'true']);
    return this.get('/sports', params, parseSports);
  }

  /** `GET /sports/{key}/events`: upcoming and live events without odds. Free. */
  async events(
    sportKey: string,
    options: { eventIds?: readonly string[]; commenceTimeFrom?: Date; commenceTimeTo?: Date } = {},
  ): Promise<OddsApiResult<OddsApiEvent[]>> {
    const path = `/sports/${encodeURIComponent(checkedSportKey(sportKey))}/events`;
    return this.get(path, [['dateFormat', 'iso'], ...filters(options)], parseEvents);
  }

  /** `GET /sports/{key}/odds`: odds for all upcoming and live events of a sport. */
  async odds(sportKey: string, query: OddsQuery): Promise<OddsApiResult<OddsApiEvent[]>> {
    const path = `/sports/${encodeURIComponent(checkedSportKey(sportKey))}/odds`;
    const params: Params = [...oddsScope(query), ...oddsFormat(), ...filters(query)];
    return this.get(path, params, parseEvents);
  }

  /** `GET /sports/{key}/events/{id}/odds`: odds for one event, including non-featured markets. */
  async eventOdds(
    sportKey: string,
    eventId: string,
    query: Pick<OddsQuery, 'markets' | 'regions' | 'bookmakers'>,
  ): Promise<OddsApiResult<OddsApiEvent | null>> {
    checkedEventIds([eventId]);
    const path = `/sports/${encodeURIComponent(checkedSportKey(sportKey))}/events/${encodeURIComponent(eventId)}/odds`;
    const result = await this.get(path, [...oddsScope(query), ...oddsFormat()], parseEvent);
    return { ...result, data: result.data[0] ?? null };
  }

  /** `GET /sports/{key}/scores`: live and recently completed scores (up to `daysFrom` days back). */
  async scores(
    sportKey: string,
    options: { daysFrom?: 1 | 2 | 3; eventIds?: readonly string[] } = {},
  ): Promise<OddsApiResult<OddsApiScore[]>> {
    const path = `/sports/${encodeURIComponent(checkedSportKey(sportKey))}/scores`;
    const params: Params = [['dateFormat', 'iso']];
    if (options.daysFrom !== undefined) params.push(['daysFrom', String(options.daysFrom)]);
    if (options.eventIds && options.eventIds.length > 0) {
      params.push(['eventIds', checkedEventIds(options.eventIds)]);
    }
    return this.get(path, params, parseScores);
  }

  /** `GET /sports/{key}/participants`: the teams or players of a sport. */
  async participants(sportKey: string): Promise<OddsApiResult<OddsApiParticipant[]>> {
    const path = `/sports/${encodeURIComponent(checkedSportKey(sportKey))}/participants`;
    return this.get(path, [['dateFormat', 'iso']], parseParticipants);
  }

  private async get<T>(
    path: string,
    params: Params,
    parse: (raw: unknown) => Parsed<T>,
  ): Promise<OddsApiResult<T[]>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { body, quota } = await this.request(path, params);
        const parsed = parse(body);
        return { data: parsed.items, quota, dropped: parsed.dropped };
      } catch (error) {
        if (!(error instanceof OddsApiError) || !error.retryable || attempt >= this.retries) {
          throw error;
        }
        await this.sleep(this.delayMs(attempt + 1, error.retryAfterMs));
      }
    }
  }

  /** 500 ms × 2^(retry-1) with ±20% jitter, at least `Retry-After`, at most 30 s. */
  private delayMs(retry: number, retryAfterMs: number | null): number {
    const base = BASE_DELAY_MS * 2 ** (retry - 1);
    const jittered = base * (1 + (this.random() * 2 - 1) * JITTER);
    return Math.min(MAX_DELAY_MS, Math.max(jittered, retryAfterMs ?? 0));
  }

  /** Replaces the API key (raw and URL-encoded) in text that came from a request. */
  private redact(text: string): string {
    return text.replaceAll(this.apiKey, '***').replaceAll(encodeURIComponent(this.apiKey), '***');
  }

  private async request(
    path: string,
    params: Params,
  ): Promise<{ body: unknown; quota: OddsApiQuota }> {
    const query = new URLSearchParams([['apiKey', this.apiKey], ...params]);
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    const where = `The Odds API GET ${path} failed`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OddsApiError({
          kind: 'timeout',
          path,
          message: `${where}: timed out after ${this.timeoutMs} ms`,
        });
      }
      // Copy name and message only: a raw fetch error can carry the URL, and so the key.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      throw new OddsApiError({
        kind: 'network',
        path,
        message: this.redact(`${where}: network error (${detail})`),
      });
    } finally {
      clearTimeout(timer);
    }

    const quota = readQuota(response.headers);
    let body: unknown;
    let json = true;
    try {
      body = JSON.parse(text);
    } catch {
      json = false;
    }

    if (response.ok) {
      if (!json) {
        throw new OddsApiError({
          kind: 'bad_response',
          path,
          status: response.status,
          quota,
          message: `${where}: ${response.status} (body is not JSON)`,
        });
      }
      return { body, quota };
    }

    const parsed = json ? parseErrorBody(body) : null;
    const code = parsed?.errorCode ?? null;
    const detail = parsed ? ` (${this.redact(parsed.message)})` : '';
    throw new OddsApiError({
      kind: kindFor(response.status, code),
      path,
      status: response.status,
      code,
      quota,
      retryAfterMs: readRetryAfterMs(response.headers),
      message: `${where}: ${response.status}${code ? ` ${this.redact(code)}` : ''}${detail}`,
    });
  }
}

function oddsFormat(): Params {
  return [
    ['dateFormat', 'iso'],
    ['oddsFormat', 'decimal'],
  ];
}

/** The optional eventIds / commenceTimeFrom / commenceTimeTo filters. */
function filters(options: {
  eventIds?: readonly string[];
  commenceTimeFrom?: Date;
  commenceTimeTo?: Date;
}): Params {
  const params: Params = [];
  if (options.eventIds && options.eventIds.length > 0) {
    params.push(['eventIds', checkedEventIds(options.eventIds)]);
  }
  if (options.commenceTimeFrom) {
    params.push(['commenceTimeFrom', formatDate(options.commenceTimeFrom)]);
  }
  if (options.commenceTimeTo) {
    params.push(['commenceTimeTo', formatDate(options.commenceTimeTo)]);
  }
  return params;
}
