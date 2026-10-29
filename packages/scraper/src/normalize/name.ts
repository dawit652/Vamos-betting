/**
 * Rule N1 (docs/scraper.md section 6.4): the one normal form every raw team
 * or competition name is reduced to before it is compared with an alias or a
 * catalogue name. Comparison is exact equality of normal forms (rule N2), so
 * this function decides what "the same name" means: it must be deterministic,
 * idempotent and locale-independent, and it must never throw on hostile input.
 *
 * It is deliberately conservative. Folding too much would make two different
 * clubs share a normal form and resolve to the wrong team; folding too little
 * only leaves a name unresolved for a person to map. So only the differences
 * that sources really disagree on are folded: case, Latin/Greek/Cyrillic
 * accents, a handful of letters that do not decompose, punctuation, spacing
 * and the club-type tokens at either end.
 */

/** Club-type tokens dropped at the start or end of a name (never in the middle). */
export const NAME_AFFIX_TOKENS: ReadonlySet<string> = new Set(['fc', 'cf', 'sc', 'afc', 'bsc']);

/**
 * Letters that NFD does not split into base + accent, folded by hand. Kept
 * small on purpose: each entry is a letter that sources demonstrably write
 * either way (Ødegaard / Odegaard, Łódź / Lodz, Kasımpaşa / Kasimpasa,
 * Straße / Strasse). `ς` is the word-final form of `σ`; dropping punctuation
 * can move a final sigma into the middle of a token, so both fold to `σ`.
 */
const TRANSLITERATION: ReadonlyMap<string, string> = new Map([
  ['ß', 'ss'],
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['ł', 'l'],
  ['ı', 'i'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['þ', 'th'],
  ['ħ', 'h'],
  ['ŧ', 't'],
  ['ς', 'σ'],
]);
const TRANSLITERATION_RE = new RegExp(`[${[...TRANSLITERATION.keys()].join('')}]`, 'gu');

/**
 * The combining-mark blocks that hold the accents of Latin, Greek and
 * Cyrillic letters (what NFD splits off `é`, `ç`, `ő`, `й`, `İ`…). Marks of
 * other scripts (Devanagari vowel signs, Arabic harakat, Hebrew points) are
 * KEPT: in those scripts a mark can be the only difference between two
 * names, and stripping it could make two clubs collide.
 */
const DIACRITIC_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/gu;

/** Apostrophes vanish without splitting a word: "Newell's" and "Newells" agree. */
const APOSTROPHE_RE = /['`´‘’ʼʻ]/gu;

/** Invisible format characters (zero-width space/joiners, BOM, bidi marks) vanish. */
const FORMAT_RE = /\p{Cf}/gu;

/** Everything that is not a letter, digit or (kept) mark separates words. */
const SEPARATOR_RE = /[^\p{L}\p{N}\p{M}]+/gu;

/** One pass of the N1 pipeline; see normalizeName for why it is iterated. */
function normalizeOnce(raw: string): string {
  const folded = raw
    .normalize('NFKC')
    // toLowerCase is locale-independent (unlike toLocaleLowerCase): `I` is
    // always `i`, and `İ` becomes `i` + U+0307, whose dot is stripped below.
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITIC_RE, '')
    // Recompose so that scripts NFD splits into letters (Hangul) come back
    // in their usual form and a second pass is a no-op.
    .normalize('NFKC')
    .replace(TRANSLITERATION_RE, (letter) => TRANSLITERATION.get(letter) ?? letter)
    .replace(/&/gu, ' and ')
    .replace(APOSTROPHE_RE, '')
    .replace(FORMAT_RE, '')
    .replace(SEPARATOR_RE, ' ')
    .trim();
  if (folded === '') return '';
  const tokens = folded.split(' ');
  // Drop affixes at either end, but never the last remaining token: "FC"
  // alone stays "fc" rather than becoming an empty (unresolvable) name.
  while (tokens.length > 1 && NAME_AFFIX_TOKENS.has(tokens[0] ?? '')) tokens.shift();
  while (tokens.length > 1 && NAME_AFFIX_TOKENS.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  return tokens.join(' ');
}

/**
 * Rule N1: NFKC, lower-case, strip diacritics, `&` to `and`, drop
 * punctuation, collapse spaces, drop `fc cf sc afc bsc` at the start or end.
 *
 * Total (any string, never throws), idempotent and free of leading,
 * trailing or double spaces. The empty string means "no usable name".
 *
 * Unicode normalisation and case mapping do not commute in every corner of
 * the standard, so a single pass is re-run until it is stable (in practice
 * one or two passes) to guarantee idempotency, which the alias tables rely
 * on: an alias is stored in normal form and normalised again on load.
 */
export function normalizeName(raw: string): string {
  if (typeof raw !== 'string') return '';
  let current = normalizeOnce(raw);
  for (let pass = 0; pass < 4; pass += 1) {
    const next = normalizeOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** The space-separated tokens of an already normalised name (empty name: no tokens). */
export function nameTokens(normalized: string): string[] {
  return normalized === '' ? [] : normalized.split(' ');
}
