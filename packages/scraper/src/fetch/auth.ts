/**
 * Request authentication for sources that need an API key in a header
 * (docs/scraper.md 6.7). A source config and a plan item name the environment
 * variable that holds the key; the key itself is read at fetch time by the
 * fetcher, sent to the origin of the first request only, and kept out of every
 * result, message and archive.
 */

/** Reads a secret by environment variable name; undefined when it is not set. Injected, so tests do not use process.env. */
export type SecretReader = (name: string) => string | undefined;

/** The only variable names a source may point at: the scraper's own secrets, nothing else in the environment. */
export const SECRET_NAME_RE = /^SCRAPER_SECRET_[A-Z0-9_]{1,64}$/;

/** An RFC 9110 field name (token). */
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/** Hop-by-hop headers (RFC 9110 7.6.1 and the legacy list): meaningful for one connection only. */
const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Headers a plan item may not set: identity, credentials ("no login") and
 * framing, plus the ones the fetcher owns (validators, user agent).
 */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'user-agent',
  'cookie',
  'authorization',
  'proxy-authorization',
  'content-length',
  'connection',
  'if-none-match',
  'if-modified-since',
]);

/**
 * Headers an auth block may not use: everything a plan item may not set,
 * hop-by-hop headers, and the response-only `set-cookie`.
 */
export const FORBIDDEN_AUTH_HEADERS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_REQUEST_HEADERS,
  ...HOP_BY_HOP_HEADERS,
  'set-cookie',
]);

/** Why this header name cannot carry an API key, or null. The message never contains the value of a secret. */
export function authHeaderProblem(name: string): string | null {
  if (!HEADER_TOKEN_RE.test(name)) {
    return "not a valid header name (letters, digits and !#$%&'*+.^_`|~- only, at most 64)";
  }
  if (FORBIDDEN_AUTH_HEADERS.has(name.toLowerCase())) {
    return `the header ${name.toLowerCase()} may not carry an API key`;
  }
  return null;
}

/** An API key as it may appear in a header value: printable ASCII, no leading or trailing blanks. */
export const SECRET_VALUE_RE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

export const REDACTED = '[redacted]';

/** `text` with every occurrence of `secret` replaced; a no-op for an empty secret. */
export function redactSecret(text: string, secret: string | null): string {
  return secret === null || secret === '' ? text : text.split(secret).join(REDACTED);
}
