import type { ApiError } from '@vamos/contracts';
import { DomainError } from '@vamos/db';
import type { z } from 'zod';

/**
 * A failure that is safe to show to the client. Anything else that escapes a
 * handler is logged and returned as a generic 500. It extends the shared
 * DomainError of @vamos/db, which services there (responsible gambling,
 * betting) throw; the error handler renders both the same way.
 */
export class AppError extends DomainError {
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(statusCode, code, message, details);
    this.name = 'AppError';
  }

  override toBody(): ApiError {
    return super.toBody();
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string, details?: unknown) =>
  new AppError(403, code, message, details);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
export const tooManyRequests = (code: string, message: string, details?: unknown) =>
  new AppError(429, code, message, details);
export const serviceUnavailable = (code: string, message: string, details?: unknown) =>
  new AppError(503, code, message, details);

/** Most validation issues a 400 lists (a flood of bad elements must not flood the response). */
export const MAX_VALIDATION_ISSUES = 20;

/** Parses untrusted input with a zod schema, throwing a 400 `validation_error` (the first issues). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      'validation_error',
      'Request validation failed',
      result.error.issues
        .slice(0, MAX_VALIDATION_ISSUES)
        .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
