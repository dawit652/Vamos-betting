import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors';

/** Request header carrying the client's idempotency key (allowed by CORS). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set to `true` on a response that replays an earlier request with the same key (exposed by CORS). */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';
/** 8–100 printable ASCII characters (a UUID is a good choice). */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{8,100}$/;

/** The request's Idempotency-Key header or a 400 `idempotency_key_required`. */
export function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw badRequest(
      'idempotency_key_required',
      'An Idempotency-Key header of 8 to 100 printable characters is required.',
    );
  }
  return value;
}
