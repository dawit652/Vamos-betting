import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  formatMsisdnLocal,
  normalizeEthiopianMsisdn,
  parseBirr,
  santimToBirrString,
} from '@vamos/core';
import { PaymentProviderError, ProviderRequestError, WebhookVerificationError } from './errors';
import type { ProviderDeps, WebhookInput } from './types';

export const DEFAULT_TIMEOUT_MS = 15_000;

/** The body as bytes, exactly as received. */
export function rawBytes(rawBody: WebhookInput['rawBody']): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
}

/** A header value, case-insensitively; the first one when repeated. */
export function headerValue(headers: WebhookInput['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    const first: unknown = typeof value === 'string' ? value : value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/** Lowercase hex HMAC-SHA256 of `data` under `key`. */
export function hmacSha256Hex(key: string, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Constant-time comparison of two hex digests. A malformed or wrong-length
 * candidate is simply unequal (the length of a SHA-256 digest is public).
 */
export function hexDigestEquals(expectedHex: string, candidateHex: string): boolean {
  const candidate = candidateHex.trim();
  if (candidate.length !== expectedHex.length || !HEX_RE.test(candidate)) return false;
  return timingSafeEqual(
    Buffer.from(expectedHex, 'hex'),
    Buffer.from(candidate.toLowerCase(), 'hex'),
  );
}

/** Parses a JSON webhook body into an object, or throws `malformed_payload`. */
export function parseJsonObject(
  provider: string,
  rawBody: WebhookInput['rawBody'],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes(rawBody).toString('utf8'));
  } catch {
    throw new WebhookVerificationError(provider, 'malformed_payload', 'webhook body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebhookVerificationError(
      provider,
      'malformed_payload',
      'webhook body is not an object',
    );
  }
  return parsed as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field (numbers are stringified), or undefined. */
export function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** "1250.50" for the provider (birr with two decimals). */
export function toBirrAmount(amount: bigint): string {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new RangeError('payment amounts must be positive bigint santim');
  }
  return santimToBirrString(amount);
}

/**
 * Santim from a provider's birr amount ("100", "100.5", "1,250.75" or a JSON
 * number). Null when absent; throws on anything that is not an exact amount
 * with at most two decimals (no rounding of money from the outside).
 */
export function birrToSantim(provider: string, value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') {
    throw new WebhookVerificationError(provider, 'malformed_payload', 'amount is not a number');
  }
  try {
    return parseBirr(text);
  } catch {
    throw new WebhookVerificationError(provider, 'malformed_payload', `invalid amount "${text}"`);
  }
}

/** 09XXXXXXXX / 07XXXXXXXX, the local form Ethiopian PSP APIs expect. */
export function localMsisdn(provider: string, phone: string): string {
  const e164 = normalizeEthiopianMsisdn(phone);
  if (e164 === null) {
    throw new PaymentProviderError(provider, 'not an Ethiopian mobile number');
  }
  return formatMsisdnLocal(e164).replace(/\s/g, '');
}

export interface JsonRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/**
 * Sends a JSON request with a timeout. Resolves with any HTTP status (the
 * caller decides what a 4xx means); throws a retryable ProviderRequestError
 * when no response arrives.
 */
export async function sendJson(
  provider: string,
  deps: ProviderDeps,
  request: JsonRequest,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await deps.fetch(request.url, {
      method: request.method,
      headers: {
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderRequestError(provider, `${provider} request failed: no response`, {
      status: null,
      retryable: true,
      cause: error,
    });
  }
  const text = await response.text().catch(() => '');
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
  }
  return { status: response.status, body };
}

/** Throws a ProviderRequestError unless the response is 2xx. 429 and 5xx are retryable. */
export function assertOk(provider: string, what: string, response: JsonResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  const retryable = response.status === 429 || response.status >= 500;
  const detail =
    isRecord(response.body) && typeof response.body.message === 'string'
      ? `: ${response.body.message}`
      : '';
  throw new ProviderRequestError(
    provider,
    `${provider} ${what} failed (HTTP ${response.status})${detail}`,
    {
      status: response.status,
      body: response.body,
      retryable,
    },
  );
}

/** Joins a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
