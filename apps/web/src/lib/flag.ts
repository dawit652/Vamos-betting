export const GLOBE = '\u{1F30D}';
/** Fallback for a competition with no country and no confederation. */
export const WORLD = '\u{1F310}';
export const EUROPE = '\u{1F1EA}\u{1F1FA}';
export const AFRICA = GLOBE;
export const AMERICAS = '\u{1F30E}';
export const ASIA = '\u{1F30F}';

const REGIONAL_A = 0x1f1e6;
const BLACK_FLAG = 0x1f3f4;
const TAG_A = 0xe0061;
const TAG_CANCEL = 0xe007f;

/** Tag-sequence flag (England, Scotland, Wales): a black flag, the tags of the subdivision, a cancel tag. */
function subdivisionFlag(tags: string): string {
  const letters = [...tags].map((letter) => TAG_A + letter.charCodeAt(0) - 97);
  return String.fromCodePoint(BLACK_FLAG, ...letters, TAG_CANCEL);
}

const SUBDIVISIONS: Readonly<Record<string, string>> = {
  'GB-ENG': subdivisionFlag('gbeng'),
  'GB-SCT': subdivisionFlag('gbsct'),
  'GB-WLS': subdivisionFlag('gbwls'),
  // Northern Ireland has no emoji of its own.
  'GB-NIR': '\u{1F1EC}\u{1F1E7}',
};

function regionalIndicators(countryCode: string): string {
  return [...countryCode.toUpperCase()]
    .map((letter) => String.fromCodePoint(REGIONAL_A + letter.charCodeAt(0) - 65))
    .join('');
}

/**
 * Flag emoji for an ISO 3166-1 alpha-2 country code (two regional-indicator
 * letters) or an ISO 3166-2 style `XX-...` subdivision code: the UK nations get
 * their own flags, any other subdivision the flag of its country. Null or
 * malformed codes give the globe.
 */
export function flagEmoji(countryCode: string | null | undefined): string {
  if (countryCode === null || countryCode === undefined) return GLOBE;
  if (/^[A-Za-z]{2}$/.test(countryCode)) return regionalIndicators(countryCode);
  if (/^[A-Za-z]{2}-[A-Za-z0-9]{1,3}$/.test(countryCode)) {
    const known = SUBDIVISIONS[countryCode.toUpperCase()];
    return known ?? regionalIndicators(countryCode.slice(0, 2));
  }
  return GLOBE;
}

/**
 * Flag for a competition: international competitions carry their confederation's
 * emblem (they have no country), domestic ones their category's country flag.
 */
export function competitionFlag(
  competition: { slug: string },
  category: { slug: string; countryCode: string | null },
): string {
  const slug = competition.slug.toLowerCase();
  if (slug.startsWith('uefa-')) return EUROPE;
  if (slug.startsWith('caf-') || category.slug === 'africa') return AFRICA;
  if (/^(conmebol-|copa-libertadores|copa-sudamericana|concacaf-)/.test(slug)) return AMERICAS;
  if (slug.startsWith('afc-')) return ASIA;
  if (
    slug.startsWith('fifa-') ||
    /world-cup|nations-league|friendl/.test(slug) ||
    slug.startsWith('int-friendl')
  ) {
    return WORLD;
  }
  return category.countryCode === null ? WORLD : flagEmoji(category.countryCode);
}
