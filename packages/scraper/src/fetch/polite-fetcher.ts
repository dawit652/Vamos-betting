import { createHash } from 'node:crypto';
import { backoffCeilingMs, backoffDelayMs, parseRetryAfter } from './backoff';
import { detectBlockPage, BLOCK_PAGE_SCAN_BYTES } from './blockpage';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker';
import { InMemoryConditionalStore, type ConditionalStore } from './conditional';
import {
  FORBIDDEN_REQUEST_HEADERS,
  SECRET_NAME_RE,
  SECRET_VALUE_RE,
  authHeaderProblem,
  redactSecret,
  type SecretReader,
} from './auth';
import { decodeBody } from './decode';
import { HostRateLimiter } from './rate-limiter';
import {
  ROBOTS_ALLOW_ALL,
  ROBOTS_DISALLOW_ALL,
  ROBOTS_MAX_BYTES,
  isAllowed,
  parseRobots,
  productToken,
  robotsCrawlDelayMs,
  type RobotsRules,
} from './robots';
import type { FetchBlocked, FetchError, FetchOk, FetchRefused, FetchResult } from './types';
import type { FetchPlanItem } from '../types';

/** The subset of `fetch` we use; tests pass a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PoliteFetcherOptions {
  /** Identifies us to sources, contact included (docs/scraper.md 6.6). Sent on every request, robots.txt too. */
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1). */
  random?: () => number;
  /** 'enforce' (default) or 'off'. Licensed mode must never use 'off' (checked by the config, not here). */
  robots?: 'enforce' | 'off';
  /** Token matched against robots.txt groups; defaults to the product token of `userAgent`. */
  robotsToken?: string;
  robotsTtlMs?: number;
  /** How long "robots.txt unavailable" (treated as disallow-all) is remembered before we look again. */
  robotsFailureTtlMs?: number;
  minIntervalMs?: number;
  jitterFraction?: number;
  maxConcurrency?: number;
  conditionalStore?: ConditionalStore;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  breaker?: Omit<CircuitBreakerOptions, 'now'>;
  /** Allow http: and any port. For tests against a local server only. */
  allowInsecure?: boolean;
  /**
   * Where a plan item's `auth.secret` is read (the app passes its environment). Without it every
   * item that needs a key is refused as `secret_missing`.
   */
  secrets?: SecretReader;
}

/** A resolved API key: lives for one `fetch` call and is never returned, logged or stored. */
interface ResolvedAuth {
  header: string;
  value: string;
  /** Only requests to this origin carry the key. */
  origin: string;
}

export interface FetchContext {
  /** Hosts this fetch may touch, redirects included. Exact match on host name (or host:port). */
  allowedHosts: readonly string[];
  /** Identifies the source: one circuit breaker per key. */
  sourceKey: string;
}

/** `image`: a document's rules, but the answer must be a raster image (FetchPlanItem.accept). */
type Mode = 'document' | 'image' | 'robots';

type Exchange =
  | { kind: 'response'; status: number; headers: Headers; body: Uint8Array; durationMs: number }
  | { kind: 'refused'; reason: 'too_large' | 'content_type_not_allowed' }
  | { kind: 'failed'; code: 'timeout' | 'network' | 'decode'; message: string };

type Hop = { kind: 'result'; result: FetchResult } | { kind: 'redirect'; location: string };

interface RobotsEntry {
  rules: RobotsRules;
  crawlDelayMs: number;
  expiresAt: number;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ACCEPT =
  'text/html,application/json,application/xml,text/calendar;q=0.9,text/*;q=0.8';
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const IMAGE_ACCEPT = [...IMAGE_TYPES].join(',');

/** Content types we will read: text/*, JSON (also +json), XML, iCalendar (text/*). */
export function isAllowedContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    /^application\/[a-z0-9.-]+\+json$/.test(mime)
  );
}

/** Content types an image request takes: raster images only (SVG is a document that can run code). */
export function isImageContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return IMAGE_TYPES.has((contentType.split(';')[0] ?? '').trim().toLowerCase());
}

function positive(name: string, value: number, integer = false): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function normaliseHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDecodeError(e: unknown): boolean {
  const code = (e as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code;
  const own = (e as { code?: unknown } | null)?.code;
  const c = typeof code === 'string' ? code : typeof own === 'string' ? own : '';
  return (
    c.startsWith('Z_') ||
    /incorrect header check|invalid (stored block|distance|code|block)|zlib/i.test(errorText(e))
  );
}

function containsBytes(body: Uint8Array, text: string): boolean {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).includes(text);
}

function swallow(promise: Promise<unknown> | undefined): void {
  promise?.catch(() => undefined);
}

/**
 * Fetches documents the way a well-mannered robot should (docs/scraper.md 1, 6.3, 6.6):
 * https only, hosts from an allow-list (rechecked after every redirect), robots.txt
 * obeyed, one request at a time per host with a minimum interval and jitter,
 * conditional requests, bounded retries that honour Retry-After, hard size and time
 * limits, and a circuit breaker per source. It never tries to get around a block.
 * `fetch` returns a `FetchResult` for every expected outcome and does not throw.
 */
export class PoliteFetcher {
  readonly #userAgent: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #robotsMode: 'enforce' | 'off';
  readonly #robotsToken: string;
  readonly #robotsTtlMs: number;
  readonly #robotsFailureTtlMs: number;
  readonly #store: ConditionalStore;
  readonly #maxAttempts: number;
  readonly #backoff: { baseMs: number; capMs: number };
  readonly #maxRetryAfterMs: number;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #minIntervalMs: number;
  readonly #breakerOptions: Omit<CircuitBreakerOptions, 'now'>;
  readonly #allowInsecure: boolean;
  readonly #secrets: SecretReader;
  readonly #limiter: HostRateLimiter;
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #robots = new Map<string, RobotsEntry>();
  readonly #robotsInflight = new Map<string, Promise<RobotsEntry>>();

  constructor(options: PoliteFetcherOptions) {
    const ua = options.userAgent;
    if (typeof ua !== 'string' || ua.trim() === '' || !/^[\x20-\x7e]+$/.test(ua)) {
      throw new TypeError('userAgent is required and must be printable ASCII');
    }
    this.#userAgent = ua.trim();
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.#robotsMode = options.robots ?? 'enforce';
    this.#robotsToken = productToken(options.robotsToken ?? ua);
    this.#robotsTtlMs = positive('robotsTtlMs', options.robotsTtlMs ?? 3_600_000);
    this.#robotsFailureTtlMs = positive(
      'robotsFailureTtlMs',
      options.robotsFailureTtlMs ?? 300_000,
    );
    this.#store = options.conditionalStore ?? new InMemoryConditionalStore();
    this.#maxAttempts = positive('maxAttempts', options.maxAttempts ?? 3, true);
    this.#backoff = {
      baseMs: positive('backoffBaseMs', options.backoffBaseMs ?? 1000),
      capMs: positive('backoffCapMs', options.backoffCapMs ?? 30_000),
    };
    this.#maxRetryAfterMs = positive('maxRetryAfterMs', options.maxRetryAfterMs ?? 300_000);
    this.#timeoutMs = positive('timeoutMs', options.timeoutMs ?? 15_000);
    this.#maxBytes = positive('maxBytes', options.maxBytes ?? 5 * 1024 * 1024, true);
    this.#maxRedirects = options.maxRedirects ?? 5;
    if (!Number.isInteger(this.#maxRedirects) || this.#maxRedirects < 0) {
      throw new RangeError('maxRedirects must be a non-negative integer');
    }
    this.#minIntervalMs = options.minIntervalMs ?? 2000;
    const jitterFraction = options.jitterFraction ?? 0.25;
    if (!Number.isFinite(this.#minIntervalMs) || this.#minIntervalMs < 0) {
      throw new RangeError('minIntervalMs must be non-negative');
    }
    if (!(jitterFraction >= 0 && jitterFraction <= 1))
      throw new RangeError('jitterFraction must be in [0, 1]');
    this.#breakerOptions = options.breaker ?? {};
    this.#allowInsecure = options.allowInsecure === true;
    this.#secrets = options.secrets ?? (() => undefined);
    this.#limiter = new HostRateLimiter({
      minIntervalMs: this.#minIntervalMs,
      jitterFraction,
      maxConcurrency: positive('maxConcurrency', options.maxConcurrency ?? 4, true),
      now: this.#now,
      sleep: this.#sleep,
      random: this.#random,
    });
  }

  /** Fetches one plan item. Never throws for expected failures. */
  async fetch(item: FetchPlanItem, ctx: FetchContext): Promise<FetchResult> {
    let start: URL;
    try {
      start = new URL(item.url);
    } catch {
      return { kind: 'refused', reason: 'scheme_not_allowed' };
    }
    const refusal = this.#checkUrl(start, ctx);
    if (refusal) return refusal;

    // The key is resolved after the allow-list check (a refused host never sees it, not even
    // in memory) and before anything is requested: no key, no request, robots.txt included.
    const auth = this.#resolveAuth(item, start);
    if ('kind' in auth) return auth;

    const breaker = this.#breakerFor(ctx.sourceKey);
    const permit = breaker.tryAcquire();
    if (!permit.allowed) return { kind: 'circuit_open', retryAt: permit.retryAt };

    const secret = auth.value;
    let result: FetchResult;
    try {
      result = await this.#follow(
        start,
        item.headers ?? {},
        ctx,
        item.accept === 'image' ? 'image' : 'document',
        { attempts: 0 },
        auth.resolved,
      );
    } catch (e) {
      // A bug, not an expected failure: report it, but do not let it blame the server.
      breaker.recordNeutral();
      return {
        kind: 'error',
        code: 'network',
        retryable: false,
        attempts: 0,
        message: `unexpected: ${redactSecret(errorText(e), secret)}`,
      };
    }
    if (result.kind === 'error') {
      // A transport error can quote the request it failed on: the key must not leave with it.
      result = { ...result, message: redactSecret(result.message, secret) };
    } else if (result.kind === 'ok' && secret !== null && containsBytes(result.body, secret)) {
      // The server echoed our key back. The body would reach the archive and the database.
      result = { kind: 'refused', reason: 'secret_echoed' };
    }
    this.#settle(breaker, result);
    return result;
  }

  /**
   * The key for this item, or a refusal. `{ value: null, resolved: null }` for an item that needs none.
   * The plan item is checked again here (name, header): the fetcher does not rely on the adapter.
   */
  #resolveAuth(
    item: FetchPlanItem,
    start: URL,
  ): FetchRefused | { value: string | null; resolved: ResolvedAuth | null } {
    const ref = item.auth;
    if (ref === undefined) return { value: null, resolved: null };
    if (!SECRET_NAME_RE.test(ref.secret) || authHeaderProblem(ref.header) !== null) {
      return { kind: 'refused', reason: 'secret_invalid' };
    }
    let raw: string | undefined;
    try {
      raw = this.#secrets(ref.secret);
    } catch {
      raw = undefined;
    }
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') return { kind: 'refused', reason: 'secret_missing' };
    if (!SECRET_VALUE_RE.test(value)) return { kind: 'refused', reason: 'secret_invalid' };
    return {
      value,
      resolved: { header: ref.header.toLowerCase(), value, origin: start.origin },
    };
  }

  #breakerFor(key: string): CircuitBreaker {
    let breaker = this.#breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.#breakerOptions, now: this.#now });
      this.#breakers.set(key, breaker);
    }
    return breaker;
  }

  /** Transport failures, 5xx and blocks count against the source; policy refusals and robots do not. */
  #settle(breaker: CircuitBreaker, result: FetchResult): void {
    switch (result.kind) {
      case 'ok':
      case 'not_modified':
        breaker.recordSuccess();
        return;
      case 'blocked':
        if (result.reason === 'robots') breaker.recordNeutral();
        else breaker.recordFailure();
        return;
      case 'error':
        if (result.code !== 'http_error' || (result.status ?? 0) >= 500) breaker.recordFailure();
        else breaker.recordNeutral();
        return;
      default:
        breaker.recordNeutral();
    }
  }

  /** Scheme, credentials, port and host allow-list (S3). Applied to the first URL and to every redirect target. */
  #checkUrl(url: URL, ctx: FetchContext): FetchRefused | null {
    const httpsOk = url.protocol === 'https:';
    if (!httpsOk && !(this.#allowInsecure && url.protocol === 'http:')) {
      return { kind: 'refused', reason: 'scheme_not_allowed' };
    }
    if (url.username !== '' || url.password !== '')
      return { kind: 'refused', reason: 'host_not_allowed' };
    if (!this.#allowInsecure && url.port !== '')
      return { kind: 'refused', reason: 'host_not_allowed' };
    const hostname = normaliseHost(url.hostname);
    const hostWithPort = normaliseHost(url.host);
    const allowed = ctx.allowedHosts.some((entry) => {
      const e = normaliseHost(entry);
      return e !== '' && (e === hostname || e === hostWithPort);
    });
    return allowed ? null : { kind: 'refused', reason: 'host_not_allowed' };
  }

  async #follow(
    start: URL,
    planHeaders: Record<string, string>,
    ctx: FetchContext,
    mode: Mode,
    state: { attempts: number },
    auth: ResolvedAuth | null = null,
  ): Promise<FetchResult> {
    let url = start;
    for (let hops = 0; ; hops += 1) {
      if (hops > 0) {
        const refusal = this.#checkUrl(url, ctx);
        if (refusal) return refusal;
      }
      let crawlDelayMs = 0;
      if (mode !== 'robots' && this.#robotsMode === 'enforce') {
        const entry = await this.#robotsFor(url, ctx);
        if (!isAllowed(entry.rules, this.#robotsToken, url.pathname + url.search)) {
          return { kind: 'blocked', reason: 'robots', retryAt: new Date(entry.expiresAt) };
        }
        crawlDelayMs = entry.crawlDelayMs;
      }
      // The key goes to the origin it was meant for; a redirect (even inside the allow-list) loses it.
      const hopAuth = auth !== null && url.origin === auth.origin ? auth : null;
      const hop = await this.#hop(url, planHeaders, mode, state, crawlDelayMs, hopAuth);
      if (hop.kind === 'result') return hop.result;
      if (hops + 1 > this.#maxRedirects) return { kind: 'refused', reason: 'too_many_redirects' };
      try {
        url = new URL(hop.location, url);
      } catch {
        return this.#error('http_error', false, state, 'redirect with an unusable Location', 302);
      }
    }
  }

  #error(
    code: FetchError['code'],
    retryable: boolean,
    state: { attempts: number },
    message: string,
    status?: number,
  ): FetchError {
    return status === undefined
      ? { kind: 'error', code, retryable, attempts: state.attempts, message }
      : { kind: 'error', code, retryable, attempts: state.attempts, status, message };
  }

  async #hop(
    url: URL,
    planHeaders: Record<string, string>,
    mode: Mode,
    state: { attempts: number },
    crawlDelayMs: number,
    auth: ResolvedAuth | null,
  ): Promise<Hop> {
    const validators = mode === 'document' ? await this.#validatorsFor(url) : null;
    const headers = this.#requestHeaders(
      planHeaders,
      validators,
      auth,
      mode === 'image' ? IMAGE_ACCEPT : DEFAULT_ACCEPT,
    );
    const conditional = 'if-none-match' in headers || 'if-modified-since' in headers;
    const done = (result: FetchResult): Hop => ({ kind: 'result', result });

    for (let attempt = 1; ; attempt += 1) {
      state.attempts += 1;
      const ex = await this.#limiter.run(
        url.host,
        () => this.#exchange(url, headers, mode),
        crawlDelayMs,
      );

      if (ex.kind === 'refused') return done({ kind: 'refused', reason: ex.reason });
      if (ex.kind === 'failed') {
        if (ex.code === 'decode') return done(this.#error('decode', false, state, ex.message));
        if (attempt < this.#maxAttempts) {
          await this.#sleep(backoffDelayMs(attempt, this.#backoff, this.#random));
          continue;
        }
        return done(this.#error(ex.code, true, state, ex.message));
      }

      const { status, headers: resHeaders, body } = ex;
      const fetchedAt = new Date(this.#now());

      if (REDIRECT_STATUSES.has(status)) {
        const location = resHeaders.get('location');
        if (location === null || location.trim() === '') {
          return done(
            this.#error('http_error', false, state, `HTTP ${status} without Location`, status),
          );
        }
        return { kind: 'redirect', location: location.trim() };
      }
      if (status === 304) {
        if (conditional && mode === 'document')
          return done({ kind: 'not_modified', url: url.href, fetchedAt });
        return done(
          this.#error(
            'http_error',
            false,
            state,
            'unexpected 304 to an unconditional request',
            304,
          ),
        );
      }
      if (
        status === 200 ||
        (mode === 'robots' && status < 500 && !RETRYABLE_STATUSES.has(status))
      ) {
        if (mode === 'document' && detectBlockPage(status, body)) {
          return done(this.#blocked('block_page', status, resHeaders));
        }
        if (mode === 'document' && status === 200) await this.#rememberValidators(url, resHeaders);
        return done(this.#ok(url, ex, state, fetchedAt));
      }
      if (status === 401)
        return done(
          this.#error('http_error', false, state, 'HTTP 401: login is never attempted', 401),
        );
      if (status === 403) {
        return done(
          detectBlockPage(status, body)
            ? this.#blocked('block_page', status, resHeaders)
            : this.#blocked('forbidden', status, resHeaders, false),
        );
      }
      if (!RETRYABLE_STATUSES.has(status)) {
        return done(this.#error('http_error', false, state, `HTTP ${status}`, status));
      }

      // 408 / 429 / 5xx: a challenge page is a block, not a hiccup.
      if (detectBlockPage(status, body))
        return done(this.#blocked('block_page', status, resHeaders));
      const retryAfter = parseRetryAfter(resHeaders.get('retry-after'), this.#now());
      if (retryAfter !== null && retryAfter > this.#maxRetryAfterMs) {
        return done({
          kind: 'blocked',
          reason: 'rate_limited',
          retryAt: new Date(this.#now() + retryAfter),
          status,
        });
      }
      if (attempt < this.#maxAttempts) {
        await this.#sleep(retryAfter ?? backoffDelayMs(attempt, this.#backoff, this.#random));
        continue;
      }
      if (status === 429) {
        const wait = retryAfter ?? backoffCeilingMs(attempt, this.#backoff);
        return done({
          kind: 'blocked',
          reason: 'rate_limited',
          retryAt: new Date(this.#now() + wait),
          status,
        });
      }
      return done(
        this.#error(
          'http_error',
          true,
          state,
          `HTTP ${status} after ${state.attempts} attempts`,
          status,
        ),
      );
    }
  }

  #blocked(
    reason: FetchBlocked['reason'],
    status: number,
    headers: Headers,
    useRetryAfter = true,
  ): FetchBlocked {
    const ra = useRetryAfter ? parseRetryAfter(headers.get('retry-after'), this.#now()) : null;
    return {
      kind: 'blocked',
      reason,
      retryAt: ra === null ? null : new Date(this.#now() + ra),
      status,
    };
  }

  #ok(
    url: URL,
    ex: Extract<Exchange, { kind: 'response' }>,
    state: { attempts: number },
    fetchedAt: Date,
  ): FetchOk {
    const headers: Record<string, string> = {};
    ex.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'set-cookie') headers[name.toLowerCase()] = value;
    });
    return {
      kind: 'ok',
      status: ex.status,
      url: url.href,
      headers,
      body: ex.body,
      contentType: ex.headers.get('content-type'),
      fetchedAt,
      durationMs: ex.durationMs,
      attempts: state.attempts,
      contentHash: createHash('sha256').update(ex.body).digest('hex'),
    };
  }

  #requestHeaders(
    plan: Record<string, string>,
    validators: { etag: string | null; lastModified: string | null } | null,
    auth: ResolvedAuth | null,
    accept: string,
  ): Record<string, string> {
    const headers: Record<string, string> = { accept };
    for (const [name, value] of Object.entries(plan)) {
      const key = name.toLowerCase();
      if (!FORBIDDEN_REQUEST_HEADERS.has(key) && /^[\x20-\x7e]*$/.test(value)) headers[key] = value;
    }
    headers['user-agent'] = this.#userAgent;
    if (auth !== null) headers[auth.header] = auth.value;
    const printable = /^[\x20-\x7e]+$/;
    if (validators?.etag && printable.test(validators.etag))
      headers['if-none-match'] = validators.etag;
    if (validators?.lastModified && printable.test(validators.lastModified)) {
      headers['if-modified-since'] = validators.lastModified;
    }
    return headers;
  }

  /**
   * Forgets the ETag / Last-Modified remembered for a URL, so the next request
   * is unconditional. The caller does this when the page it got was not
   * accepted (broken markup, storing failed): a later 304 would otherwise
   * stand for a page that was never used.
   */
  async forgetValidators(url: string): Promise<void> {
    try {
      await this.#store.set(new URL(url).href, { etag: null, lastModified: null });
    } catch {
      /* best effort: the store is an optimisation */
    }
  }

  async #validatorsFor(url: URL) {
    try {
      return (await this.#store.get(url.href)) ?? null;
    } catch {
      return null; // the store is an optimisation; without it we just do a full fetch
    }
  }

  async #rememberValidators(url: URL, headers: Headers): Promise<void> {
    try {
      await this.#store.set(url.href, {
        etag: headers.get('etag'),
        lastModified: headers.get('last-modified'),
      });
    } catch {
      /* best effort */
    }
  }

  /**
   * One HTTP request with a deadline covering headers AND body (so a server that
   * trickles bytes cannot hold us), a size cap enforced on the decoded stream
   * (so a compression bomb is cut off), and the content-type allow-list.
   */
  async #exchange(url: URL, headers: Record<string, string>, mode: Mode): Promise<Exchange> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const startedAt = this.#now();
    const failed = (e: unknown, decodeAware: boolean): Exchange => ({
      kind: 'failed',
      code: timedOut ? 'timeout' : decodeAware && isDecodeError(e) ? 'decode' : 'network',
      message: timedOut ? `timed out after ${this.#timeoutMs} ms` : errorText(e),
    });
    try {
      let res: Response;
      try {
        res = await this.#fetch(url.href, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (e) {
        return failed(e, false);
      }
      const status = res.status;
      const fullBody = status === 200 || (mode === 'robots' && status < 400);
      if (!fullBody) {
        // Redirects and errors: the body is not wanted, except a peek to recognise a block page.
        const peek = REDIRECT_STATUSES.has(status) || status === 304 ? 0 : BLOCK_PAGE_SCAN_BYTES;
        const read = await this.#readBody(res, peek, 'truncate', controller.signal);
        if (read.kind === 'error') return failed(read.error, true);
        if (read.kind === 'too_large') return { kind: 'refused', reason: 'too_large' };
        return {
          kind: 'response',
          status,
          headers: res.headers,
          body: read.body,
          durationMs: this.#now() - startedAt,
        };
      }
      const contentType = res.headers.get('content-type');
      const readable =
        mode === 'robots' ||
        (mode === 'image' ? isImageContentType(contentType) : isAllowedContentType(contentType));
      if (!readable) {
        swallow(res.body?.cancel());
        return { kind: 'refused', reason: 'content_type_not_allowed' };
      }
      const declared = Number(res.headers.get('content-length'));
      if (
        mode !== 'robots' &&
        !res.headers.has('content-encoding') &&
        Number.isFinite(declared) &&
        declared > this.#maxBytes
      ) {
        swallow(res.body?.cancel());
        return { kind: 'refused', reason: 'too_large' };
      }
      const read = await this.#readBody(
        res,
        mode === 'robots' ? ROBOTS_MAX_BYTES : this.#maxBytes,
        mode === 'robots' ? 'truncate' : 'refuse',
        controller.signal,
      );
      if (read.kind === 'error') return failed(read.error, true);
      if (read.kind === 'too_large') return { kind: 'refused', reason: 'too_large' };
      return {
        kind: 'response',
        status,
        headers: res.headers,
        body: read.body,
        durationMs: this.#now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads up to `limit` bytes. Past the limit: 'refuse' reports too_large, 'truncate' keeps the head. Always cancels the stream. */
  async #readBody(
    res: Response,
    limit: number,
    overflow: 'refuse' | 'truncate',
    signal: AbortSignal,
  ) {
    if (res.body === null || limit === 0) {
      swallow(res.body?.cancel());
      return { kind: 'ok' as const, body: new Uint8Array(0) };
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Do not trust the body stream to notice the deadline: race every read against it.
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    aborted.catch(() => undefined);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          if (overflow === 'refuse') return { kind: 'too_large' as const };
          chunks.push(value.subarray(0, value.byteLength - (total - limit)));
          total = limit;
          break;
        }
        chunks.push(value);
      }
    } catch (error) {
      return { kind: 'error' as const, error };
    } finally {
      swallow(reader.cancel());
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'ok' as const, body };
  }

  /** robots.txt for the origin of `url`, from cache or fetched once (concurrent callers share one fetch). */
  async #robotsFor(url: URL, ctx: FetchContext): Promise<RobotsEntry> {
    const origin = url.origin;
    const cached = this.#robots.get(origin);
    if (cached && cached.expiresAt > this.#now()) return cached;
    let inflight = this.#robotsInflight.get(origin);
    if (!inflight) {
      inflight = this.#loadRobots(new URL('/robots.txt', origin), ctx).finally(() =>
        this.#robotsInflight.delete(origin),
      );
      this.#robotsInflight.set(origin, inflight);
    }
    const entry = await inflight;
    this.#robots.set(origin, entry);
    return entry;
  }

  async #loadRobots(robotsUrl: URL, ctx: FetchContext): Promise<RobotsEntry> {
    let rules = ROBOTS_DISALLOW_ALL;
    let ttl = this.#robotsFailureTtlMs;
    try {
      const result = await this.#follow(robotsUrl, {}, ctx, 'robots', { attempts: 0 });
      if (result.kind === 'ok' && result.status >= 200 && result.status < 300) {
        rules = parseRobots(decodeBody(result.body, null));
        ttl = this.#robotsTtlMs;
      } else if (result.kind === 'ok' && result.status >= 400) {
        rules = ROBOTS_ALLOW_ALL; // RFC 9309 2.3.1.3: "unavailable" means no restrictions
        ttl = this.#robotsTtlMs;
      }
    } catch {
      /* unreachable: stays disallow-all */
    }
    return {
      rules,
      crawlDelayMs: robotsCrawlDelayMs(rules, this.#robotsToken),
      expiresAt: this.#now() + ttl,
    };
  }
}
