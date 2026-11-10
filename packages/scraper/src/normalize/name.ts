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
// The class lists combining marks on purpose: it is the set to strip.
// eslint-disable-next-line no-misleading-character-class
const DIACRITIC_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/gu;

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

/**
 * Rule N1b (docs/scraper.md 6.4): the legal-form tokens legalFormStripped drops at either end, on top
 * of N1's (Beşiktaş JK, Çorum FK, Gençlerbirliği SK, Erzurum BB, AS Roma, VfB Stuttgart, SSC Napoli,
 * CD Tenerife, UD Las Palmas). Never part of N1 itself: folding them always would merge names the
 * catalogue keeps apart, so team resolution only falls back to them (N2b).
 */
export const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  ...NAME_AFFIX_TOKENS,
  'fk',
  'sk',
  'jk',
  'bb',
  'as',
  'ac',
  'ca',
  'cd',
  'ud',
  'sv',
  'fsv',
  'vfb',
  'vfl',
  'tsg',
  'ssc',
]);

/** Rule N1b: sponsor or municipal prefixes some sources put before a club's name (Torku Konyaspor). */
export const SPONSOR_PREFIX_TOKENS: ReadonlySet<string> = new Set(['torku', 'gazisehir']);

const isLetter = (token: string): boolean => /^\p{L}$/u.test(token);
const isNumber = (token: string): boolean => /^\p{N}+$/u.test(token);

/**
 * Rule N1b: an N1 normal form with the club's legal form taken off, for the fallback of team
 * resolution (N2b). Runs of single letters at either end are joined first ("falkirk f c" →
 * "falkirk fc", "a s roma" → "as roma"); then, until nothing changes, a LEGAL_FORM_TOKENS token is
 * dropped at either end (at the start together with a number just before it: "1 fsv mainz 05" →
 * "mainz 05") and a SPONSOR_PREFIX_TOKENS token at the start. The last remaining token is never
 * dropped. Total and idempotent; '' stays ''.
 */
export function legalFormStripped(normalized: string): string {
  // Every step that changes the tokens removes at least one, so this ends; it stops only when a
  // step changes nothing, which makes the result idempotent.
  const tokens = nameTokens(normalized);
  for (;;) {
    const before = tokens.length;
    joinLetterRuns(tokens);
    if (tokens.length > 2 && isNumber(tokens[0]!) && LEGAL_FORM_TOKENS.has(tokens[1]!)) {
      tokens.splice(0, 2);
    } else if (
      tokens.length > 1 &&
      (LEGAL_FORM_TOKENS.has(tokens[0]!) || SPONSOR_PREFIX_TOKENS.has(tokens[0]!))
    ) {
      tokens.shift();
    } else if (tokens.length > 1 && LEGAL_FORM_TOKENS.has(tokens[tokens.length - 1]!)) {
      tokens.pop();
    }
    if (tokens.length === before) return tokens.join(' ');
  }
}

/** Joins a run of two or more single letters at either end ("f c" → "fc"), unless it is the whole name. */
function joinLetterRuns(tokens: string[]): void {
  let run = 0;
  while (run < tokens.length && isLetter(tokens[run]!)) run += 1;
  if (run >= 2 && run < tokens.length) tokens.splice(0, run, tokens.slice(0, run).join(''));
  run = 0;
  while (run < tokens.length && isLetter(tokens[tokens.length - 1 - run]!)) run += 1;
  if (run >= 2 && run < tokens.length) {
    tokens.splice(tokens.length - run, run, tokens.slice(tokens.length - run).join(''));
  }
}
