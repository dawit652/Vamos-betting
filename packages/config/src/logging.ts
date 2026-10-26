import { randomUUID } from 'node:crypto';

/**
 * Shared log settings of the API and the worker (pino): what is redacted,
 * and how a request id is accepted or made.
 */

/** What a redacted value is replaced with. */
export const LOG_REDACTED = '[redacted]';

/** Headers that carry credentials or signatures (lower case, as Node reports them). */
export const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-staff-csrf-token',
  'x-sms-signature',
  'x-ussd-secret',
] as const;

/**
 * Body, query and object fields that carry secrets: passwords, PINs, OTP and
 * TOTP codes, tokens and keys, and national ID numbers.
 */
export const SENSITIVE_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'pin',
  'otp',
  'totp',
  'totpCode',
  'totpSecret',
  'secret',
  'token',
  'sessionToken',
  'csrfToken',
  'accessToken',
  'refreshToken',
  'apiKey',
  'signature',
  'nationalId',
  'faydaId',
  'authorization',
  'cookie',
  // Personal data (PDPP): a phone number identifies a player.
  'phone',
  'msisdn',
] as const;

/**
 * Query parameters whose values are personal data rather than secrets: the
 * back-office searches (`q` is a phone number, a name or an id). They are
 * redacted from logged URLs only.
 */
export const SENSITIVE_QUERY_FIELDS = ['q'] as const;

/**
 * Fields that are secret only in a request body or query (OTP and TOTP codes
 * are sent as `code`); elsewhere `code` is an error code worth keeping.
 */
export const SENSITIVE_BODY_FIELDS = ['code'] as const;

const SENSITIVE_FIELD_SET = new Set<string>(
  [...SENSITIVE_FIELDS, ...SENSITIVE_BODY_FIELDS, ...SENSITIVE_QUERY_FIELDS].map((field) =>
    field.toLowerCase(),
  ),
);

/**
 * pino `redact` paths: the sensitive headers wherever a `headers` object is
 * logged (up to two levels down, e.g. `req.headers` or `{ headers }`), and the
 * sensitive fields at the top level and up to three levels down (e.g.
 * `{ body: { password } }` or `{ req: { body: { pin } } }`), and `code` in a
 * logged `body` or `query`.
 */
export function logRedactPaths(): string[] {
  const paths: string[] = [];
  for (const header of SENSITIVE_HEADERS) {
    const key = `["${header}"]`;
    paths.push(`headers${key}`, `*.headers${key}`, `*.*.headers${key}`);
  }
  for (const field of SENSITIVE_FIELDS) {
    paths.push(field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`);
  }
  for (const field of SENSITIVE_BODY_FIELDS) {
    for (const holder of ['body', 'query']) {
      paths.push(`${holder}.${field}`, `*.${holder}.${field}`, `*.*.${holder}.${field}`);
    }
  }
  return paths;
}

/** The pino options both services share (level, service name, redaction). */
export function baseLoggerOptions(input: { level: string; service: string }): {
  level: string;
  base: { service: string };
  redact: { paths: string[]; censor: string };
} {
  return {
    level: input.level,
    base: { service: input.service },
    redact: { paths: logRedactPaths(), censor: LOG_REDACTED },
  };
}

/**
 * A URL path with the values of sensitive query parameters replaced
 * (e.g. `/reset?token=abc` → `/reset?token=[redacted]`): secrets, phone
 * numbers and search terms (SENSITIVE_QUERY_FIELDS).
 */
export function redactUrl(url: string): string {
  const mark = url.indexOf('?');
  if (mark < 0) return url;
  const query = url
    .slice(mark + 1)
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      const name = eq < 0 ? part : part.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // Keep the raw name.
      }
      return eq >= 0 && SENSITIVE_FIELD_SET.has(decoded.toLowerCase())
        ? `${name}=${LOG_REDACTED}`
        : part;
    })
    .join('&');
  return `${url.slice(0, mark)}?${query}`;
}

/** Header of the request id (incoming and echoed). */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A well-formed incoming request id: 8 to 128 letters, digits, `.`, `_`, `=`,
 * `:` or `-`, starting with a letter or digit (UUIDs, trace ids, the usual
 * load balancer ids). Anything else could forge log lines or flood them.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{7,127}$/;

/** The request id to use: the incoming one when well formed, else a new UUID. */
export function requestIdFrom(header: unknown): string {
  const value = Array.isArray(header) ? (header as unknown[])[0] : header;
  return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : randomUUID();
}
