import { describe, expect, it } from 'vitest';
import { ApiClientError, describeError, errorFromBody } from './errors';

describe('errors', () => {
  it('reads the API error body', () => {
    const error = errorFromBody(403, { error: { code: 'forbidden', message: 'no' } });
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(errorFromBody(500, 'oops').code).toBe('http_500');
  });

  it('explains known codes and lists invalid setting issues', () => {
    expect(describeError(new ApiClientError(403, 'forbidden', 'x'))).toMatch(/not allowed/);
    expect(
      describeError(new ApiClientError(422, 'invalid_setting', 'x', { issues: ['a', 'b'] })),
    ).toBe('Invalid setting: a; b');
    expect(describeError(new ApiClientError(409, 'something_else', 'Plain message'))).toBe(
      'Plain message',
    );
  });
});
