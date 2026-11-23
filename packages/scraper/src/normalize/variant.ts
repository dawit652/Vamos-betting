import { countryCodeOfName } from '@vamos/core';
import { normalizeName } from './name';

/**
 * Rule L3's guard (docs/plans/name-learning.md; owner, 23 Nov 2026): a name is never linked to
 * another side of a club (its reserve, youth or women's team) or to a national team unless the
 * name itself says so. "sparta prague" is not "Sparta Prague B", "salzburg" is not "FC Salzburg
 * Frauen", "ararat armenia" is not "Armenia": the 11 wrong links of 23 Nov were all of this kind.
 * It filters what the scraper suggests (N3), learns by itself (N4) and reuses from another source
 * (L1), and the daily alias check lists existing aliases that break it. A person may still map
 * such a name by hand. Pure.
 */
export type TeamVariant = 'reserve' | 'youth' | 'women' | 'national';

/** Words (after N1 normalisation) that mark a women's side. */
const WOMEN = new Set([
  'w',
  'women',
  'womens',
  'woman',
  'ladies',
  'lady',
  'wfc',
  'frauen',
  'damen',
  'dames',
  'femenino',
  'femenina',
  'feminino',
  'feminina',
  'femminile',
  'feminine',
  'feminin',
  'fem',
  'kvinner',
  'kvinnor',
  'naiset',
  'zenski',
  'kobiety',
]);

/** Words that mark a youth side anywhere in the name; "u19", "sub 20" are matched separately. */
const YOUTH = new Set([
  'youth',
  'junior',
  'juniors',
  'juniores',
  'juvenil',
  'academy',
  'primavera',
]);

/** Words that mark a reserve side anywhere in the name. */
const RESERVE = new Set(['ii', 'iii', 'reserve', 'reserves', 'jong', 'amateure']);

/** Words that mark a reserve side only as the last word of a longer name ("Sparta Prague B"). */
const RESERVE_LAST = new Set(['b', 'c', '2', '3']);

const AGE = /^(1[5-9]|2[0-3])$/;
const AGE_TOKEN = /^(u|sub)(1[5-9]|2[0-3])$/;

/** The sides a normalised name says it is (empty for a club's first team). */
export function variantsOf(norm: string): Set<TeamVariant> {
  const tokens = norm.split(' ').filter((t) => t !== '');
  const out = new Set<TeamVariant>();
  tokens.forEach((token, i) => {
    if (WOMEN.has(token)) out.add('women');
    if (YOUTH.has(token) || AGE_TOKEN.test(token)) out.add('youth');
    if ((token === 'u' || token === 'sub' || token === 'under') && AGE.test(tokens[i + 1] ?? '')) {
      out.add('youth');
    }
    if (RESERVE.has(token)) out.add('reserve');
  });
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last !== undefined && RESERVE_LAST.has(last)) out.add('reserve');
  return out;
}

function isCountry(name: string): boolean {
  return countryCodeOfName(name) !== null;
}

/**
 * The side `raw` would wrongly be linked to by naming a team with `targetNames`: a mark that every
 * name of the target carries and the raw name lacks, or `national` when every name of the target is
 * a country and the raw name is not one. null when the link is not of this kind.
 */
export function variantConflict(raw: string, targetNames: readonly string[]): TeamVariant | null {
  const rawNorm = normalizeName(raw);
  if (rawNorm === '') return null;
  const names = targetNames.map(normalizeName).filter((n) => n !== '');
  if (names.length === 0) return null;
  const rawVariants = variantsOf(rawNorm);
  const marks = names.map(variantsOf);
  for (const variant of ['reserve', 'youth', 'women'] as const) {
    if (!rawVariants.has(variant) && marks.every((m) => m.has(variant))) return variant;
  }
  if (!isCountry(raw) && targetNames.every(isCountry)) return 'national';
  return null;
}

/** Words too common in club names to tell two clubs apart. */
const GENERIC = new Set([
  'athletic',
  'atletico',
  'athletico',
  'city',
  'club',
  'clube',
  'county',
  'deportivo',
  'football',
  'futbol',
  'futebol',
  'calcio',
  'olympique',
  'racing',
  'real',
  'rovers',
  'royal',
  'sociedad',
  'sport',
  'sports',
  'sporting',
  'town',
  'union',
  'united',
  'wanderers',
]);

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Two words name the same thing: equal, a shared start of 5+ letters, or one letter apart. */
function close(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n >= 5 || editDistanceAtMostOne(a, b);
}

/**
 * Why an existing alias looks wrong, for the daily alias check (L3): the guard's side or national
 * team (`variantConflict`), or `other_club` when the alias has a telling word (4+ letters, not a
 * number, not a word every second club uses) that no name of its team has: "viktoria plzen" to
 * "FC Viktoria Cologne", "red star belgrade" to "Red Star FC". It may flag a right link whose
 * source adds the city ("twente enschede"): the check only lists, a person decides. null: fine.
 */
export function suspiciousAlias(
  aliasNorm: string,
  targetNames: readonly string[],
): TeamVariant | 'other_club' | null {
  const variant = variantConflict(aliasNorm, targetNames);
  if (variant !== null) return variant;
  const targetWords = targetNames.flatMap((n) => normalizeName(n).split(' ')).filter((w) => w);
  if (targetWords.length === 0) return null;
  for (const word of normalizeName(aliasNorm).split(' ')) {
    if (word.length < 4 || /^\d+$/.test(word) || GENERIC.has(word)) continue;
    if (!targetWords.some((t) => close(word, t))) return 'other_club';
  }
  return null;
}
