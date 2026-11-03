/** Regional-indicator base: 'A' (U+0041) maps to U+1F1E6. */
const REGIONAL_A = 0x1f1e6;
const GLOBE = '🌍';

/** UK home nations are subdivision flags: a black flag plus tag letters ("gbeng") and a cancel tag. */
const SUBDIVISIONS: Readonly<Record<string, string>> = {
  'GB-ENG': 'gbeng',
  'GB-SCT': 'gbsct',
  'GB-WLS': 'gbwls',
};

function tagSequence(tags: string): string {
  const letters = [...tags].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0)));
  return `\u{1F3F4}${letters.join('')}\u{E007F}`;
}

/**
 * The flag emoji of a category's country code: two-letter ISO codes become
 * regional indicator pairs ("ES" → 🇪🇸), 'GB-ENG' / 'GB-SCT' / 'GB-WLS' their
 * subdivision flags; null, empty or an unknown code is a globe.
 */
export function flagEmoji(countryCode: string | null | undefined): string {
  if (countryCode === null || countryCode === undefined) return GLOBE;
  const code = countryCode.trim().toUpperCase();
  const subdivision = SUBDIVISIONS[code];
  if (subdivision !== undefined) return tagSequence(subdivision);
  if (!/^[A-Z]{2}$/.test(code)) return GLOBE;
  return String.fromCodePoint(
    REGIONAL_A + code.charCodeAt(0) - 65,
    REGIONAL_A + code.charCodeAt(1) - 65,
  );
}
