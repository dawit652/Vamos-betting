/**
 * Results of a polite fetch (docs/scraper.md 6.3, 6.6). `PoliteFetcher.fetch`
 * never throws for an expected failure; it returns one of these, so a caller
 * must handle every case and cannot forget one.
 */

export interface FetchOk {
  kind: 'ok';
  status: number;
  /** The final URL, after redirects. */
  url: string;
  /** Response headers, lower-case names (set-cookie dropped). */
  headers: Record<string, string>;
  body: Uint8Array;
  contentType: string | null;
  fetchedAt: Date;
  /** Wall time of the successful attempt: request sent until the body was complete. */
  durationMs: number;
  /** HTTP attempts made for this call, redirect hops and retries included (robots.txt excluded). */
  attempts: number;
  /** SHA-256 (hex) of `body`. */
  contentHash: string;
}

/** HTTP 304 answering a conditional request: the stored copy is still current. */
export interface FetchNotModified {
  kind: 'not_modified';
  url: string;
  fetchedAt: Date;
}

export type BlockReason = 'robots' | 'block_page' | 'rate_limited' | 'forbidden';

/** The site told us to go away. We back off; we never work around it. */
export interface FetchBlocked {
  kind: 'blocked';
  reason: BlockReason;
  /** Earliest sensible time to try again, when known. */
  retryAt: Date | null;
  status?: number;
}

export interface FetchCircuitOpen {
  kind: 'circuit_open';
  retryAt: Date;
}

export type RefusalReason =
  | 'host_not_allowed'
  | 'scheme_not_allowed'
  | 'too_many_redirects'
  | 'content_type_not_allowed'
  | 'too_large'
  /** The plan item needs an API key and its environment variable is not set (or empty): nothing was requested. */
  | 'secret_missing'
  /** The plan item's auth reference or the key's value is not usable (bad name, bad header, not printable ASCII). */
  | 'secret_invalid'
  /** The response contained the API key: it is dropped, never archived or parsed. */
  | 'secret_echoed';

/** A policy refusal: retrying cannot help. */
export interface FetchRefused {
  kind: 'refused';
  reason: RefusalReason;
}

export type FetchErrorCode = 'timeout' | 'network' | 'http_error' | 'decode';

export interface FetchError {
  kind: 'error';
  code: FetchErrorCode;
  /** The caller may try again later (the fetcher already retried what it should). */
  retryable: boolean;
  attempts: number;
  status?: number;
  message: string;
}

export type FetchResult =
  FetchOk | FetchNotModified | FetchBlocked | FetchCircuitOpen | FetchRefused | FetchError;
