/**
 * A business-rule failure that is safe to show to the player: an HTTP-style
 * status, a stable machine-readable code, a plain-English message and
 * optional details (JSON-safe; santim amounts as decimal strings).
 *
 * Shared services in @vamos/db (responsible gambling, betting) throw it so
 * the API and the worker can both use them. The API turns it into the same
 * error body as its own AppError (which extends this class).
 */
export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  /** Alias of `status`, matching the HTTP / Fastify error convention. */
  get statusCode(): number {
    return this.status;
  }

  /** The wire error body (`ApiError` in @vamos/contracts). */
  toBody(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** 400 */
export const domainBadRequest = (code: string, message: string, details?: unknown) =>
  new DomainError(400, code, message, details);
/** 403 */
export const domainForbidden = (code: string, message: string, details?: unknown) =>
  new DomainError(403, code, message, details);
/** 404 `not_found` with the message "<what> not found". */
export const domainNotFound = (what: string) =>
  new DomainError(404, 'not_found', `${what} not found`);
/** 409 */
export const domainConflict = (code: string, message: string, details?: unknown) =>
  new DomainError(409, code, message, details);
/** 410 */
export const domainGone = (code: string, message: string, details?: unknown) =>
  new DomainError(410, code, message, details);
/** 422 */
export const domainUnprocessable = (code: string, message: string, details?: unknown) =>
  new DomainError(422, code, message, details);
