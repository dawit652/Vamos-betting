import type { ApiError } from '@vamos/contracts';
import type { z } from 'zod';

/**
 * A failure that is safe to show to the client. Anything else that escapes a
 * handler is logged and returned as a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
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

/** Parses untrusted input with a zod schema, throwing a 400 `validation_error`. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      'validation_error',
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
