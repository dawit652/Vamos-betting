import { describe, expect, it } from 'vitest';
import { buildUrl } from './config';
import { ApiClientError, errorFromBody, errorMessageKey, networkError } from './errors';
import { newIdempotencyKey } from './idempotency';

describe('errorFromBody', () => {
  it('maps an API error body to a typed error', () => {
    const error = errorFromBody(
      422,
      { error: { code: 'insufficient_funds', message: 'Not enough', details: { need: '100' } } },
      'req-1',
    );
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('insufficient_funds');
    expect(error.message).toBe('Not enough');
    expect(error.details).toEqual({ need: '100' });
    expect(error.requestId).toBe('req-1');
  });

  it('falls back to http_<status> for other bodies', () => {
    expect(errorFromBody(502, '<html>bad gateway</html>').code).toBe('http_502');
    expect(errorFromBody(500, { error: 'x' }).code).toBe('http_500');
    expect(errorFromBody(500, undefined).code).toBe('http_500');
  });
});

describe('errorMessageKey', () => {
  it('picks a common message by status and code', () => {
    expect(errorMessageKey(networkError(new TypeError('fetch failed')))).toBe(
      'common.errors.network',
    );
    expect(errorMessageKey(networkError(null, true))).toBe('common.errors.network');
    expect(
      errorMessageKey(errorFromBody(401, { error: { code: 'unauthorized', message: '' } })),
    ).toBe('common.errors.unauthorized');
    expect(
      errorMessageKey(errorFromBody(403, { error: { code: 'csrf_invalid', message: '' } })),
    ).toBe('common.errors.sessionExpired');
    expect(
      errorMessageKey(errorFromBody(400, { error: { code: 'validation_error', message: '' } })),
    ).toBe('common.errors.validation');
    expect(errorMessageKey(errorFromBody(429, {}))).toBe('common.errors.rateLimited');
    expect(errorMessageKey(errorFromBody(404, {}))).toBe('common.errors.notFound');
    expect(errorMessageKey(errorFromBody(503, {}))).toBe('common.errors.server');
    expect(errorMessageKey(errorFromBody(409, {}))).toBe('common.errors.generic');
    expect(errorMessageKey(new Error('boom'))).toBe('common.errors.generic');
  });

  it('lets a page override specific codes', () => {
    const error = errorFromBody(422, { error: { code: 'insufficient_funds', message: '' } });
    expect(errorMessageKey(error, { insufficient_funds: 'common.nav.wallet' })).toBe(
      'common.nav.wallet',
    );
  });
});

describe('buildUrl', () => {
  it('joins paths and drops empty query values', () => {
    expect(buildUrl('http://api', '/events')).toBe('http://api/events');
    expect(
      buildUrl('http://api', 'events', { sport: 'football', cursor: undefined, x: null }),
    ).toBe('http://api/events?sport=football');
    expect(buildUrl('http://api', '/events', { limit: 30, live: true, q: 'a b' })).toBe(
      'http://api/events?limit=30&live=true&q=a+b',
    );
  });
});

describe('newIdempotencyKey', () => {
  it('makes unique keys the API accepts (8 to 100 printable characters)', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey('bet')));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^bet-[\w-]{8,96}$/);
    }
  });
});
