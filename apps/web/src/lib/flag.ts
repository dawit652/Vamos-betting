const GLOBE = '\u{1F30D}';
const REGIONAL_A = 0x1f1e6;

/**
 * Flag emoji for an ISO 3166-1 alpha-2 country code (two regional-indicator
 * letters). Null or malformed codes give the globe.
 */
export function flagEmoji(countryCode: string | null | undefined): string {
  if (countryCode === null || countryCode === undefined || !/^[A-Za-z]{2}$/.test(countryCode)) {
    return GLOBE;
  }
  return [...countryCode.toUpperCase()]
    .map((letter) => String.fromCodePoint(REGIONAL_A + letter.charCodeAt(0) - 65))
    .join('');
}
