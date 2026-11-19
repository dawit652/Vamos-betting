import { describe, expect, it } from 'vitest';
import { describeError, ApiClientError, errorFromBody } from './errors';
import { TEXT, paperWidthLabel } from './text';

describe('text', () => {
  it('keeps the required wording', () => {
    expect(TEXT.loginFailed).toBe('Wrong email or password, or this device is not registered yet.');
    expect(TEXT.registerDone).toBe(
      "Asked. An admin must approve this device on the agent's page; then sign in.",
    );
    expect(TEXT.sellingSoon).toBe('Selling tickets comes soon.');
    expect(TEXT.signIn).toBe('Sign in · ግባ');
    expect(TEXT.testReceiptTitle).toBe('TEST PRINT · Not a receipt');
    expect(TEXT.testReceiptChars).toBe('0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('labels the paper width', () => {
    expect(paperWidthLabel(58)).toBe('Paper width 58 mm');
  });
});

describe('describeError', () => {
  it('prefers the page message, then the common one, then the API message', () => {
    const conflict = new ApiClientError(409, 'agent_blocked', 'blocked by api');
    expect(describeError(conflict, TEXT.registerErrors)).toBe(TEXT.registerErrors.agent_blocked);
    expect(describeError(new ApiClientError(429, 'rate_limited', 'x'))).toBe(TEXT.rateLimited);
    expect(describeError(new ApiClientError(500, 'boom', 'Server says no'))).toBe('Server says no');
    expect(describeError(new Error('x'))).toBe(TEXT.genericError);
  });

  it('reads the API error body', () => {
    const error = errorFromBody(409, { error: { code: 'shop_inactive', message: 'closed' } });
    expect(error.code).toBe('shop_inactive');
    expect(errorFromBody(502, 'oops').code).toBe('http_502');
  });
});
