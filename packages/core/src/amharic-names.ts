import { AMHARIC_CLUB_NAMES, AMHARIC_NAMES, AMHARIC_WORDS } from './amharic-names.data';

/**
 * Amharic names for the catalogue (owner, 16 Nov 2026: "when the user chooses Amharic, all
 * competitions, leagues and matches should be in Amharic"). The feeds give English names only, so
 * the API fills the Amharic of a team, competition or country that has none (a name staff wrote
 * in Amharic always wins).
 *
 * amharicName: a known name in its conventional Amharic (countries, competitions, clubs; see
 * amharic-names.data), else word by word: football words translated (Cup → ዋንጫ, Women → ሴቶች,
 * U20 → ከ20 ዓመት በታች), capital abbreviations spelled out (PSV → ፒኤስቪ), every other word written in
 * fidel by its sound (transliterate). Digits, brackets and hyphens stay. Pure: a name always gets
 * the same Amharic.
 */

/** First-order code point of each consonant row of the Ethiopic script ('' carries a lone vowel). */
const ROWS: Readonly<Record<string, number>> = {
  '': 0x12a0,
  h: 0x1200,
  l: 0x1208,
  m: 0x1218,
  r: 0x1228,
  s: 0x1230,
  sh: 0x1238,
  b: 0x1260,
  v: 0x1268,
  t: 0x1270,
  ch: 0x1278,
  n: 0x1290,
  ny: 0x1298,
  k: 0x12a8,
  w: 0x12c8,
  z: 0x12d8,
  zh: 0x12e0,
  y: 0x12e8,
  d: 0x12f0,
  j: 0x1300,
  g: 0x1308,
  ts: 0x1338,
  f: 0x1348,
  p: 0x1350,
};

/** Offset of each vowel order within a row: ä (1st), u, i, a, e, none (6th), o. */
const ORDER = { ä: 0, u: 1, i: 2, a: 3, e: 4, none: 5, o: 6 } as const;

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u';
type Phoneme = { c: string } | { v: Vowel };

const fidel = (row: string, order: number) => String.fromCodePoint(ROWS[row]! + order);

/** Letters of other alphabets, as the sound they stand for ('ɲ' is the ñ sound). */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  ñ: 'ɲ',
  ç: 'ch',
  ş: 'sh',
  ș: 'sh',
  ß: 'ss',
  ø: 'o',
  æ: 'e',
  œ: 'e',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 't',
  ı: 'i',
  ğ: '',
  č: 'ch',
  š: 'sh',
  ž: 'zh',
  ć: 'ch',
  ř: 'r',
  ț: 'ts',
};

const VOWELS: ReadonlySet<string> = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (letter: string | undefined) => letter !== undefined && VOWELS.has(letter);

/** The word in plain a-z (and ɲ), accents and other marks off. */
function plainLetters(word: string): string {
  let out = '';
  for (const letter of word.toLowerCase()) out += SPECIAL_LETTERS[letter] ?? letter;
  return out
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zɲ]/g, '');
}

/**
 * The sounds of a word spelled the European way (English, Spanish, Italian, German...). `english`
 * turns on the English-only spellings (igh, ea, ee, oo, ew, a silent final -le); a word with
 * accented letters is not English.
 */
function phonemes(input: string, english: boolean): Phoneme[] {
  // A silent t and e in "-stle" (Newcastle ኒውካስል), a silent e after a consonant in "-le".
  const word = english ? input.replace(/stle$/, 'sl').replace(/([^aeiou])le$/, '$1l') : input;
  const out: Phoneme[] = [];
  const consonant = (c: string) => out.push({ c });
  const vowel = (v: Vowel) => out.push({ v });
  let i = 0;
  while (i < word.length) {
    const three = word.slice(i, i + 3);
    const two = word.slice(i, i + 2);
    const after = word[i + 2];
    if (three === 'tch') consonant('ch');
    else if (three === 'sch') consonant('sh');
    else if (english && three === 'igh') {
      vowel('a');
      consonant('y');
    } else if (two === 'cc' && /[eiy]/.test(after ?? '')) consonant('ch');
    else if (two === 'sh' || two === 'sz') consonant('sh');
    else if (two === 'ch' || two === 'cz') consonant('ch');
    else if (two === 'ph') consonant('f');
    else if (two === 'th') consonant('t');
    else if (two === 'gh') consonant('g');
    else if (two === 'ck') consonant('k');
    else if (two === 'qu') {
      consonant('k');
      consonant('w');
    } else if (two === 'gn') consonant('ny');
    else if (two === 'tz') consonant('ts');
    else if (two === 'dj') consonant('j');
    else if (two === 'zh') consonant('zh');
    else if (english && (two === 'ee' || two === 'ea')) vowel('i');
    else if (english && two === 'ew') {
      vowel('i');
      consonant('w');
    } else if (two === 'oo' || two === 'ou') vowel('u');
    else if (two === 'au') vowel('o');
    else if (two === 'eu') {
      if (out.length === 0) consonant('y');
      vowel('u');
    } else if (two === 'ai' || two === 'ay' || two === 'ei') {
      vowel('a');
      consonant('y');
    } else if (two === 'ey' && i + 2 === word.length) vowel('i');
    else {
      i += singleLetter(word, i, out);
      continue;
    }
    i += three === 'tch' || three === 'sch' || (english && three === 'igh') ? 3 : 2;
  }
  return out;
}

/** One letter's sound; returns how many letters it used. */
function singleLetter(word: string, i: number, out: Phoneme[]): number {
  const letter = word[i]!;
  const next = word[i + 1];
  // A doubled letter sounds once (Tottenham, Alkmaar); doubled e and o are handled above.
  if (letter === next) return 1;
  const last = out[out.length - 1];
  switch (letter) {
    case 'a':
    case 'e':
    case 'i':
    case 'o':
    case 'u':
      out.push({ v: letter });
      break;
    case 'y':
      out.push(isVowel(next) ? { c: 'y' } : { v: 'i' });
      break;
    case 'w':
      // "ow" at the end of a syllable is an o (Glasgow).
      if (!isVowel(next) && last !== undefined && 'v' in last && last.v === 'o') break;
      out.push({ c: 'w' });
      break;
    case 'c':
      out.push({ c: /[eiy]/.test(next ?? '') ? 's' : 'k' });
      break;
    case 'x':
      out.push({ c: 'k' }, { c: 's' });
      break;
    case 'q':
      out.push({ c: 'k' });
      break;
    case 'h':
      // A silent h at the end, after a vowel.
      if (next === undefined && last !== undefined && 'v' in last) break;
      out.push({ c: 'h' });
      break;
    case 'ɲ':
      out.push({ c: 'ny' });
      break;
    default:
      if (ROWS[letter] !== undefined) out.push({ c: letter });
  }
  return 1;
}

const isConsonant = (p: Phoneme | undefined, ...cs: string[]) =>
  p !== undefined && 'c' in p && cs.includes(p.c);
const isVowelSound = (p: Phoneme | undefined, v: Vowel) => p !== undefined && 'v' in p && p.v === v;

/**
 * The vowel order of a syllable: an e is "é" (5th order) in the first syllable and at the end of
 * the word, the short "ä" (1st order) elsewhere, as Amharic writes Liverpool, Arsenal, Leverkusen.
 */
function vowelOrder(vowel: Vowel, syllable: number, last: boolean): number {
  if (vowel === 'e') return syllable === 0 || last ? ORDER.e : ORDER.ä;
  return ORDER[vowel];
}

/** Sounds into fidel: a consonant takes the vowel after it, or the 6th order when none follows. */
function toFidel(sounds: readonly Phoneme[], english: boolean): string {
  const n = sounds.length;
  const vowels = sounds.filter((p) => 'v' in p).length;
  // English "-ton" and "-don" endings sound "-tən": Brighton ብራይተን, Everton ኤቨርተን.
  const reducedO =
    english &&
    n >= 3 &&
    vowels >= 2 &&
    isConsonant(sounds[n - 1], 'n') &&
    isVowelSound(sounds[n - 2], 'o') &&
    isConsonant(sounds[n - 3], 't', 'd')
      ? n - 2
      : -1;
  let out = '';
  let syllable = 0;
  for (let j = 0; j < n; j += 1) {
    const sound = sounds[j]!;
    if ('c' in sound) {
      const next = sounds[j + 1];
      if (next !== undefined && 'v' in next) {
        const order = j + 1 === reducedO ? ORDER.ä : vowelOrder(next.v, syllable, j + 1 === n - 1);
        out += fidel(sound.c, order);
        syllable += 1;
        j += 1;
      } else {
        out += fidel(sound.c, ORDER.none);
      }
      continue;
    }
    // A vowel without a consonant: at the start, or after another vowel (a glide joins them).
    const prev = sounds[j - 1];
    const order = vowelOrder(sound.v, syllable, j === n - 1);
    if (prev === undefined) out += fidel('', sound.v === 'a' ? ORDER.ä : order);
    else if ('v' in prev && (prev.v === 'i' || prev.v === 'e')) out += fidel('y', order);
    else if ('v' in prev && (prev.v === 'u' || prev.v === 'o')) out += fidel('w', order);
    else out += fidel('', order);
    syllable += 1;
  }
  return out;
}

/** A word written in fidel by its sound ("Liverpool" → ሊቨርፑል); a word with no Latin letter stays. */
export function transliterate(word: string): string {
  const plain = plainLetters(word);
  if (plain === '') return word;
  // Only plain a-z letters: an accented letter means the word is not English.
  const english = /^[A-Za-z0-9'’.]*$/.test(word);
  return toFidel(phonemes(plain, english), english);
}

/** How Amharic says each Latin letter, to spell abbreviations (PSV → ፒኤስቪ). */
const LETTER_NAMES: Readonly<Record<string, string>> = {
  A: 'ኤ',
  B: 'ቢ',
  C: 'ሲ',
  D: 'ዲ',
  E: 'ኢ',
  F: 'ኤፍ',
  G: 'ጂ',
  H: 'ኤች',
  I: 'አይ',
  J: 'ጄ',
  K: 'ኬ',
  L: 'ኤል',
  M: 'ኤም',
  N: 'ኤን',
  O: 'ኦ',
  P: 'ፒ',
  Q: 'ኪው',
  R: 'አር',
  S: 'ኤስ',
  T: 'ቲ',
  U: 'ዩ',
  V: 'ቪ',
  W: 'ደብሊው',
  X: 'ኤክስ',
  Y: 'ዋይ',
  Z: 'ዜድ',
};

const ROMAN_NUMERALS = /^(?:II|III|IV|VI|VII|VIII|IX|XI)$/;

/** The dictionary's spelling of a word: lower case, accents, dots and apostrophes off. */
function keyOf(word: string): string {
  if (word === '&') return 'and';
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’]/g, '');
}

function phraseKey(english: string): string {
  return english
    .split(/[\s-]+/)
    .map(keyOf)
    .filter((word) => word !== '')
    .join(' ');
}

/** Names matched anywhere in a name, and one-word club names matched only as the whole name. */
const ANYWHERE = new Map<string, string>();
const WHOLE_NAME = new Map<string, string>();
for (const [amharic, ...spellings] of AMHARIC_NAMES) {
  for (const spelling of spellings) ANYWHERE.set(phraseKey(spelling), amharic);
}
for (const [amharic, ...spellings] of AMHARIC_CLUB_NAMES) {
  for (const spelling of spellings) {
    const key = phraseKey(spelling);
    (key.includes(' ') ? ANYWHERE : WHOLE_NAME).set(key, amharic);
  }
}
const MAX_PHRASE_WORDS = 6;

/** What may follow a club's name and still be that club: a second team, a youth or women's side. */
const TEAM_SUFFIX =
  /^(?:[a-d]|ii|iii|u1[5-9]|u2[0-3]|women|womens|ladies|reserves?|youth|academy)$/;

interface Token {
  kind: 'word' | 'number' | 'gap';
  text: string;
}

/** Words (letters, inner digits, apostrophes, the dot of "St."), numbers, "&", and the gaps between. */
function tokenize(name: string): Token[] {
  const tokens: Token[] = [];
  for (const match of name.matchAll(
    /(\p{L}[\p{L}\p{M}\p{N}'’]*\.?)|(&)|(\p{N}+\.?)|([^\p{L}\p{N}&]+)/gu,
  )) {
    const kind = match[3] !== undefined ? 'number' : match[4] !== undefined ? 'gap' : 'word';
    tokens.push({ kind, text: match[0] });
  }
  return tokens;
}

/** One word of a name that matched no dictionary name. */
function wordToAmharic(word: string, allCaps: boolean): string {
  const key = keyOf(word);
  const known = AMHARIC_WORDS[key];
  if (known !== undefined) return known;
  const age = /^u(\d{2})$/.exec(key);
  if (age !== null) return `ከ${age[1]} ዓመት በታች`;
  const bare = word.replace(/[.'’]/g, '');
  if (ROMAN_NUMERALS.test(bare)) return bare;
  const capitals = bare.replace(/[^A-Z]/g, '').length;
  const abbreviation =
    /^[A-Za-z]{1,5}$/.test(bare) &&
    ((!allCaps && capitals === bare.length && bare.length <= 4) ||
      (capitals >= 2 && capitals < bare.length));
  if (abbreviation) {
    return [...bare.toUpperCase()].map((letter) => LETTER_NAMES[letter] ?? letter).join('');
  }
  return transliterate(word);
}

function render(name: string): string {
  const tokens = tokenize(name.trim());
  if (!tokens.some((t) => t.kind === 'word')) return name;
  // The whole name, numbers included ("Mekelle 70 Enderta"), then without words that drop ("FC").
  const words = tokens.filter((t) => t.kind !== 'gap').map((t) => keyOf(t.text));
  const whole = words.join(' ');
  const significant = words.filter((w) => AMHARIC_WORDS[w] !== '').join(' ');
  for (const key of [whole, significant]) {
    const known = ANYWHERE.get(key) ?? WHOLE_NAME.get(key);
    if (known !== undefined) return known;
  }
  const allCaps = !/\p{Ll}/u.test(name);
  const out: string[] = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i]!;
    if (token.kind === 'gap') {
      out.push(token.text);
      i += 1;
      continue;
    }
    // A one-word club name opening the name (after numbers or dropped words like "1. FC"), with
    // only numbers and team suffixes after it: Barcelona B, Mainz 05.
    const club = WHOLE_NAME.get(keyOf(token.text));
    if (
      club !== undefined &&
      out.every((part) => !/\p{L}/u.test(part)) &&
      tokens.slice(i + 1).every((t) => t.kind !== 'word' || TEAM_SUFFIX.test(keyOf(t.text)))
    ) {
      out.push(club);
      i += 1;
      continue;
    }
    // The longest dictionary name starting here: words joined only by spaces or hyphens.
    const run: { key: string; end: number }[] = [];
    let key = '';
    for (let j = i, count = 0; j < tokens.length && count < MAX_PHRASE_WORDS;) {
      key = key === '' ? keyOf(tokens[j]!.text) : `${key} ${keyOf(tokens[j]!.text)}`;
      count += 1;
      run.push({ key, end: j + 1 });
      const gap = tokens[j + 1];
      if (gap === undefined || gap.kind !== 'gap' || !/^[\s-]+$/.test(gap.text)) break;
      if (tokens[j + 2] === undefined || tokens[j + 2]!.kind === 'gap') break;
      j += 2;
    }
    const match = run.reverse().find((candidate) => ANYWHERE.has(candidate.key));
    if (match !== undefined) {
      out.push(ANYWHERE.get(match.key)!);
      i = match.end;
      continue;
    }
    out.push(token.kind === 'number' ? token.text : wordToAmharic(token.text, allCaps));
    i += 1;
  }
  return out
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

const CACHE_LIMIT = 20_000;
const cache = new Map<string, string>();

/** The Amharic of an English team, competition or country name (see the top of this file). */
export function amharicName(english: string): string {
  const cached = cache.get(english);
  if (cached !== undefined) return cached;
  const amharic = english.trim() === '' ? english : render(english);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(english, amharic);
  return amharic;
}
