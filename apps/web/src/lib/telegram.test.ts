import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTelegramUrl, telegramUrl } from './telegram';

describe('parseTelegramUrl', () => {
  it.each([
    'https://t.me/NahubetBot',
    'https://t.me/nahubet_channel/',
    'https://t.me/nahubet_channel/123',
    '  https://t.me/abc_123  ',
  ])('accepts %s', (value) => {
    expect(parseTelegramUrl(value)).toBe(value.trim());
  });

  it.each([
    undefined,
    '',
    'http://t.me/NahubetBot',
    'https://telegram.me/NahubetBot',
    'https://t.me/',
    'https://t.me/bad-name',
    'https://t.me/name?start=x',
    'https://t.me/name#x',
    'https://t.me.evil.com/name',
    'https://evil.com/https://t.me/name',
    'https://user@t.me/name',
    'javascript:alert(1)',
    'https://t.me/name" onclick="x',
  ])('rejects %s', (value) => {
    expect(parseTelegramUrl(value)).toBeNull();
  });
});

describe('telegramUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads the setting at call time', () => {
    vi.stubEnv('TELEGRAM_PUBLIC_URL', 'https://t.me/NahubetBot');
    expect(telegramUrl()).toBe('https://t.me/NahubetBot');
    vi.stubEnv('TELEGRAM_PUBLIC_URL', '');
    expect(telegramUrl()).toBeNull();
  });

  it('ignores an invalid value with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TELEGRAM_PUBLIC_URL', 'https://example.com/x');
    expect(telegramUrl()).toBeNull();
    expect(telegramUrl()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is silent when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TELEGRAM_PUBLIC_URL', '');
    expect(telegramUrl()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
