import type { ApiError } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n';

/**
 * Every failed API call rejects with an ApiClientError:
 * - `status` is the HTTP status, or 0 when the request never got an answer;
 * - `code` is the API's machine-readable code (`insufficient_funds`, `csrf_invalid`,
 *   `validation_error`, …), `network_error`, `timeout`, or `http_<status>` when the
 *   body was not an API error;
 * - `details` is the API's optional details object (field errors, limits, …).
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; requestId?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.requestId = options.requestId ?? null;
  }

  /** A 401: the session is missing or expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

/** Narrow check of the `{ error: { code, message, details? } }` body (no zod in the bundle). */
export function isApiErrorBody(body: unknown): body is ApiError {
  if (body === null || typeof body !== 'object') return false;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

/** Builds the error for a non-2xx response from its (already parsed) body. */
export function errorFromBody(
  status: number,
  body: unknown,
  requestId: string | null = null,
): ApiClientError {
  if (isApiErrorBody(body)) {
    return new ApiClientError(status, body.error.code, body.error.message, {
      details: body.error.details,
      requestId,
    });
  }
  return new ApiClientError(status, `http_${status}`, `Request failed with status ${status}`, {
    requestId,
  });
}

export function networkError(cause: unknown, timedOut = false): ApiClientError {
  return timedOut
    ? new ApiClientError(0, 'timeout', 'The request timed out', { cause })
    : new ApiClientError(0, 'network_error', 'The API could not be reached', { cause });
}

/**
 * The common message for an error, for a toast or an inline alert. Pages pass
 * their own `codes` map first for errors they explain better
 * (e.g. `{ insufficient_funds: 'sportsbook.betslip.insufficientFunds' }`).
 */
export function errorMessageKey(
  error: unknown,
  codes: Readonly<Partial<Record<string, MessageKey>>> = {},
): MessageKey {
  if (!isApiClientError(error)) return 'common.errors.generic';
  const specific = codes[error.code];
  if (specific !== undefined) return specific;
  if (error.status === 0) return 'common.errors.network';
  if (error.code === 'csrf_invalid') return 'common.errors.sessionExpired';
  if (error.status === 401) return 'common.errors.unauthorized';
  if (error.code === 'validation_error') return 'common.errors.validation';
  if (error.status === 429) return 'common.errors.rateLimited';
  if (error.status === 404) return 'common.errors.notFound';
  if (error.status >= 500) return 'common.errors.server';
  return 'common.errors.generic';
}
