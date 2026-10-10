import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from './errors';
import {
  birrToSantim,
  headerValue,
  hexDigestEquals,
  hmacSha256Hex,
  joinUrl,
  localMsisdn,
  toBirrAmount,
} from './util';

describe('hmacSha256Hex', () => {
  it('matches the published HMAC-SHA256 test vector', () => {
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });
});

describe('hexDigestEquals', () => {
  const digest = hmacSha256Hex('k', 'body');

  it('accepts the same digest in any letter case', () => {
    expect(hexDigestEquals(digest, digest)).toBe(true);
    expect(hexDigestEquals(digest, digest.toUpperCase())).toBe(true);
    expect(hexDigestEquals(digest, ` ${digest} `)).toBe(true);
  });

  it('rejects a different, truncated, longer or non-hex candidate without throwing', () => {
    const flipped = (digest[0] === 'a' ? 'b' : 'a') + digest.slice(1);
    expect(hexDigestEquals(digest, flipped)).toBe(false);
    expect(hexDigestEquals(digest, digest.slice(0, -2))).toBe(false);
    expect(hexDigestEquals(digest, `${digest}00`)).toBe(false);
    expect(hexDigestEquals(digest, 'z'.repeat(64))).toBe(false);
    expect(hexDigestEquals(digest, '')).toBe(false);
  });
});

describe('headerValue', () => {
  it('reads headers case-insensitively and takes the first of repeated values', () => {
    const headers = { 'X-Chapa-Signature': 'abc', 'x-multi': ['one', 'two'], 'x-none': undefined };
    expect(headerValue(headers, 'x-chapa-signature')).toBe('abc');
    expect(headerValue(headers, 'X-MULTI')).toBe('one');
    expect(headerValue(headers, 'x-none')).toBeUndefined();
    expect(headerValue(headers, 'missing')).toBeUndefined();
  });
});

describe('amount conversion', () => {
  it('formats santim as birr with two decimals', () => {
    expect(toBirrAmount(15_050n)).toBe('150.50');
    expect(toBirrAmount(1n)).toBe('0.01');
    expect(() => toBirrAmount(0n)).toThrow(RangeError);
    expect(() => toBirrAmount(-5n)).toThrow(RangeError);
  });

  it('parses provider birr amounts exactly and refuses anything else', () => {
    expect(birrToSantim('x', '150.00')).toBe(15_000n);
    expect(birrToSantim('x', '150.5')).toBe(15_050n);
    expect(birrToSantim('x', 150.25)).toBe(15_025n);
    expect(birrToSantim('x', '1,250.75')).toBe(125_075n);
    expect(birrToSantim('x', undefined)).toBeNull();
    expect(birrToSantim('x', null)).toBeNull();
    expect(() => birrToSantim('x', '1.005')).toThrow(WebhookVerificationError);
    expect(() => birrToSantim('x', '-5')).toThrow(WebhookVerificationError);
    expect(() => birrToSantim('x', 'ten')).toThrow(WebhookVerificationError);
    expect(() => birrToSantim('x', { amount: 1 })).toThrow(WebhookVerificationError);
  });
});

describe('localMsisdn / joinUrl', () => {
  it('formats Ethiopian numbers in the local 10-digit form', () => {
    expect(localMsisdn('x', '+251911234567')).toBe('0911234567');
    expect(localMsisdn('x', '+251711234567')).toBe('0711234567');
    expect(() => localMsisdn('x', '+254711234567')).toThrow();
  });

  it('joins URLs with exactly one slash', () => {
    expect(joinUrl('https://a.example/v1/', '/transfers')).toBe('https://a.example/v1/transfers');
    expect(joinUrl('https://a.example/v1', 'transfers')).toBe('https://a.example/v1/transfers');
  });
});
