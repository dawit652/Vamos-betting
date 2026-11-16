import { AMERICAS, ASIA, EUROPE, GLOBE, WORLD } from './flag';

/**
 * What stands in for the flag of a competition that has none (the Champions League, the World
 * Cup, the CAF Champions League...). The owner's choice, 16 Nov 2026: their own identification
 * image, the logo.
 *
 * - `logo`: the competition's logo, served by the web app from `public/league-logos/`. The PNGs are
 *   API-Football's league images (media.api-sports.io/football/leagues/<id>.png, the ids are in
 *   LOGO_SOURCES), cropped and shrunk to 96 px; `fifa-world-cup.svg` is our own drawing (the source
 *   only has a text banner). Logos are trademarks of their competitions: showing them is the
 *   owner's decision (docs/deployment.md, "Competition logos").
 * - `code` / `cup`: a drawn disc with a short code or a cup, for a competition without a usable logo
 *   here (out of date like "EURO 2024", or a text banner like the friendlies).
 *
 * Pure data (JSON-safe), so a server component can hand it to a client one.
 */
export type LeagueBadge =
  | { kind: 'logo'; src: string }
  | { kind: 'code'; label: string; bg: string; fg: string }
  | { kind: 'cup'; bg: string; fg: string };

/** What stands where the flag goes: the country flag, or the badge when there is no country. */
export interface LeagueMark {
  flag: string;
  badge: LeagueBadge | null;
}

/** API-Football league id of each logo file (to fetch them again). */
export const LOGO_SOURCES: Readonly<Record<string, number>> = {
  'uefa-champions-league': 2,
  'uefa-europa-league': 3,
  'uefa-conference-league': 848,
  'uefa-nations-league': 5,
  'uefa-super-cup': 531,
  'uefa-youth-league': 14,
  caf: 12,
  'africa-cup-of-nations': 6,
  'afc-champions-league': 17,
  'afc-asian-cup': 7,
  'afc-asian-qualifiers': 30,
  'conmebol-libertadores': 13,
  'conmebol-sudamericana': 11,
  conmebol: 34,
  'concacaf-champions-cup': 16,
  'concacaf-gold-cup': 22,
  'concacaf-nations-league': 536,
};

const EMBLEMS: ReadonlySet<string> = new Set([GLOBE, WORLD, EUROPE, AMERICAS, ASIA]);

const logo = (file: string): LeagueBadge => ({
  kind: 'logo',
  src: `/league-logos/${file}${file.includes('.') ? '' : '.png'}`,
});
const cup = (bg: string, fg: string): LeagueBadge => ({ kind: 'cup', bg, fg });
const code = (label: string, bg: string, fg: string): LeagueBadge => ({
  kind: 'code',
  label,
  bg,
  fg,
});

/** A UEFA competition, by its UEFA name or its plain one ("uefa-europa-league", "europa-league"). */
const uefa = (name: string) => new RegExp(`(^|-)uefa-${name}($|-)|^${name}($|-)`);

/** World Cup qualifiers of one confederation ("world-cup-qualification-caf", "wc-qualifiers-asia"). */
const qualifiers = (region: string) =>
  new RegExp(`(world-cup|wc)-.*qualif.*(${region})|(${region}).*(world-cup|wc)-.*qualif`);

/**
 * Known competitions, matched on the slug or the English name (lower case, words joined by '-').
 * First match wins: qualifiers before their tournament, the other confederations before UEFA.
 */
const KNOWN: readonly (readonly [RegExp, LeagueBadge])[] = [
  [/caf-champions-league|champions-league-caf/, logo('caf')],
  [/caf-confederation-cup|confederation-cup-caf/, logo('caf')],
  [/africa-cup-of-nations|(^|-)afcon($|-)/, logo('africa-cup-of-nations')],
  [/afc-champions-league|asian-champions-league/, logo('afc-champions-league')],
  [/asian-cup/, logo('afc-asian-cup')],
  [/concacaf-champions/, logo('concacaf-champions-cup')],
  [/concacaf-nations-league/, logo('concacaf-nations-league')],
  [/gold-cup/, logo('concacaf-gold-cup')],
  [/libertadores/, logo('conmebol-libertadores')],
  [/sudamericana/, logo('conmebol-sudamericana')],
  [/copa-america/, cup('#0369a1', '#fbbf24')],
  [/club-world-cup/, code('CWC', '#0c4a6e', '#fbbf24')],
  [qualifiers('caf|africa'), logo('caf')],
  [qualifiers('conmebol|south-america'), logo('conmebol')],
  [qualifiers('afc|asia'), logo('afc-asian-qualifiers')],
  [/(world-cup|wc)-.*qualif/, code('WCQ', '#7f1d1d', '#ffffff')],
  [/world-cup/, logo('fifa-world-cup.svg')],
  [uefa('(europa-)?conference-league'), logo('uefa-conference-league')],
  [uefa('europa-league'), logo('uefa-europa-league')],
  [uefa('youth-league'), logo('uefa-youth-league')],
  [uefa('champions-league'), logo('uefa-champions-league')],
  [uefa('nations-league'), logo('uefa-nations-league')],
  [uefa('super-cup'), logo('uefa-super-cup')],
  [/(^|-)euro-(20\d\d-)?qualif|european-championship-.*qualif/, code('EQ', '#1d4ed8', '#ffffff')],
  [/(^|-)euro(-20\d\d)?($|-)|european-championship/, cup('#1d4ed8', '#ffffff')],
  [/olympic/, code('OLY', '#1e40af', '#ffffff')],
  [/club-friendl/, code('CF', '#64748b', '#ffffff')],
  [/friendl/, code('INT', '#475569', '#ffffff')],
  [/euroleague/, code('EL', '#ea580c', '#ffffff')],
];

/**
 * Any other competition of a confederation: its logo when we have one (CAF, CONMEBOL), else its
 * initials on the confederation's colour.
 */
const CONFEDERATIONS: readonly (readonly [RegExp, string, LeagueBadge?])[] = [
  [/(^|-)uefa($|-)/, '#0b1f5c'],
  [/(^|-)caf($|-)/, '#14532d', logo('caf')],
  [/(^|-)conmebol($|-)/, '#0e7490', logo('conmebol')],
  [/(^|-)concacaf($|-)/, '#111827'],
  [/(^|-)afc($|-)/, '#1e1b4b'],
  [/(^|-)fifa($|-)/, '#7f1d1d'],
];

const PALETTE = ['#334155', '#3f6212', '#1e40af', '#6b21a8', '#9a3412', '#0f766e'] as const;

/** Words that do not make an initial. */
const MINOR = new Set(['the', 'of', 'and', 'de', 'del', 'la', 'le', 'el', 'uefa', 'caf', 'fifa']);

function words(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A short code from the name: the initials of up to three words ("Premier League Cup" → "PLC"), an
 * age group kept whole ("UEFA U21 Championship" → "U21"), the first two letters of a one-word name
 * ("Eliteserien" → "EL"); "?" for an empty name.
 */
export function initials(name: string): string {
  const parts = words(name)
    .split('-')
    .filter((part) => part !== '' && !MINOR.has(part));
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  const numbered = parts.find((part) => /^u\d\d$/.test(part));
  if (numbered !== undefined) return numbered.toUpperCase();
  const text = parts
    .slice(0, 3)
    .map((part) => part[0]!)
    .join('')
    .toUpperCase();
  return text === '' ? '?' : text;
}

function paletteColour(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/**
 * The badge of a competition whose flag is no country's (`flag` from competitionFlag: the globe,
 * Europe's flag, a continent), or null to show the flag. A known competition gets its logo (or its
 * drawn badge), any other its confederation's logo or its initials.
 */
export function leagueBadge(
  competition: { slug: string; name: { en: string } },
  flag: string,
): LeagueBadge | null {
  if (!EMBLEMS.has(flag)) return null;
  const keys = [words(competition.slug), words(competition.name.en)];
  const matches = (pattern: RegExp) => keys.some((key) => pattern.test(key));
  for (const [pattern, badge] of KNOWN) if (matches(pattern)) return badge;
  const confederation = CONFEDERATIONS.find(([pattern]) => matches(pattern));
  if (confederation?.[2] !== undefined) return confederation[2];
  return code(
    initials(competition.name.en),
    confederation?.[1] ?? paletteColour(competition.slug),
    '#ffffff',
  );
}
