/**
 * The Telegram link of the player site. `TELEGRAM_PUBLIC_URL` is a run-time setting (not
 * NEXT_PUBLIC: server components read it per request, like API_INTERNAL_URL), so the owner can
 * set or change it without rebuilding the image. Only https://t.me/<name> is accepted: the
 * value ends up in an href, so nothing else (other hosts, javascript:, queries) gets through.
 */
const TELEGRAM_URL = /^https:\/\/t\.me\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\/?$/;

/** The URL when it is an acceptable Telegram link, else null. */
export function parseTelegramUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value !== undefined && TELEGRAM_URL.test(value) ? value : null;
}

let warned: string | undefined;

/** The configured Telegram link, or null (unset or invalid: then nothing is shown). */
export function telegramUrl(): string | null {
  const raw = process.env.TELEGRAM_PUBLIC_URL;
  const url = parseTelegramUrl(raw);
  if (url === null && raw !== undefined && raw.trim() !== '' && warned !== raw) {
    warned = raw; // once per value, not once per request
    console.warn(
      'TELEGRAM_PUBLIC_URL ignored: it must be an https://t.me/<name> URL (letters, digits, underscore).',
    );
  }
  return url;
}
