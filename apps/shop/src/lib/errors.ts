import { TEXT } from './text';

/** A failed API call: `status` 0 means no answer, `code` is the API's machine-readable code. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The error for a non-2xx response from its parsed body (`{ error: { code, message, details? } }`). */
export function errorFromBody(status: number, body: unknown): ApiClientError {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error !== null && typeof error === 'object') {
      const { code, message, details } = error as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
      };
      if (typeof code === 'string' && typeof message === 'string') {
        return new ApiClientError(status, code, message, details);
      }
    }
  }
  return new ApiClientError(status, `http_${status}`, `Request failed (${status})`);
}

const COMMON: Readonly<Record<string, string>> = {
  network_error: TEXT.networkError,
  rate_limited: TEXT.rateLimited,
  csrf_invalid: TEXT.csrfInvalid,
  password_change_required: TEXT.passwordChangeRequired,
};

/**
 * A sentence for an error: the page's own messages (`specific`, by API code) first, then the
 * common ones, then the API's message.
 */
export function describeError(
  error: unknown,
  specific: Readonly<Record<string, string>> = {},
): string {
  if (error instanceof ApiClientError) {
    return specific[error.code] ?? COMMON[error.code] ?? error.message;
  }
  return TEXT.genericError;
}
