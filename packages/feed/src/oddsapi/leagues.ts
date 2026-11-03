import type { SportCode } from '@vamos/core';
import type { OddsApiSport } from './schema';

/**
 * Where each Odds API sport key lives in our catalogue: sport, category
 * (country or region, with an ISO code for the flag) and competition.
 *
 * Known keys map onto the seeded rows (same slugs), so their Amharic names
 * and settings are kept. Any other football, basketball or tennis key gets a
 * place derived from its title ("La Liga - Spain" → category Spain) and stays
 * off until staff (or ODDS_API_SPORTS) switch it on. Other sport groups
 * (ice hockey, golf, politics…) are not supported yet and outright keys
 * (`has_outrights`) need outright markets first (docs/odds-api-integration-plan.md
 * phases 12 and 13).
 *
 * NOTE: every Amharic (`am`) name here is a working translation pending
 * review by a native speaker, like the rest of the catalogue.
 */

export interface LeagueName {
  en: string;
  am?: string;
}

export interface LeagueCategory {
  slug: string;
  name: LeagueName;
  /** ISO 3166 code ('ES', 'GB-ENG'), null for regions such as Europe or international. */
  countryCode: string | null;
  sortOrder: number;
}

export interface LeagueEntry {
  sportKey: string;
  sport: SportCode;
  category: LeagueCategory;
  competition: { slug: string; name: LeagueName; featured: boolean; sortOrder: number };
  /**
   * A knockout competition: a tie can go to extra time and penalties, which
   * the API's final score may include while 90-minute markets settle on
   * normal time, so licensed mode has staff confirm its results.
   */
  cup: boolean;
  /** 1: on by default; 2: well covered, off by default; 3: unknown key, off by default. */
  tier: 1 | 2 | 3;
}

const SPORT_GROUPS: Readonly<Record<string, SportCode>> = Object.freeze({
  Soccer: 'football',
  Basketball: 'basketball',
  Tennis: 'tennis',
});

const category = (
  slug: string,
  en: string,
  am: string | undefined,
  countryCode: string | null,
  sortOrder: number,
): LeagueCategory => ({
  slug,
  name: am === undefined ? { en } : { en, am },
  countryCode,
  sortOrder,
});

/** Football categories; the first eight are the seeded ones (same slugs and order). */
const FOOTBALL = {
  england: category('england', 'England', 'እንግሊዝ', 'GB-ENG', 10),
  ethiopia: category('ethiopia', 'Ethiopia', 'ኢትዮጵያ', 'ET', 20),
  spain: category('spain', 'Spain', 'ስፔን', 'ES', 30),
  italy: category('italy', 'Italy', 'ጣሊያን', 'IT', 40),
  germany: category('germany', 'Germany', 'ጀርመን', 'DE', 50),
  france: category('france', 'France', 'ፈረንሳይ', 'FR', 60),
  clubs: category('international-clubs', 'International clubs', 'ዓለም አቀፍ ክለቦች', null, 70),
  africa: category('africa', 'Africa', 'አፍሪካ', null, 80),
  international: category('international', 'International', 'ዓለም አቀፍ', null, 90),
  netherlands: category('netherlands', 'Netherlands', 'ኔዘርላንድ', 'NL', 100),
  portugal: category('portugal', 'Portugal', 'ፖርቹጋል', 'PT', 110),
  turkey: category('turkey', 'Turkey', 'ቱርክ', 'TR', 120),
  belgium: category('belgium', 'Belgium', 'ቤልጂየም', 'BE', 130),
  scotland: category('scotland', 'Scotland', 'ስኮትላንድ', 'GB-SCT', 140),
  saudi: category('saudi-arabia', 'Saudi Arabia', 'ሳዑዲ አረቢያ', 'SA', 150),
  usa: category('usa', 'USA', 'አሜሪካ', 'US', 160),
  brazil: category('brazil', 'Brazil', 'ብራዚል', 'BR', 170),
  argentina: category('argentina', 'Argentina', 'አርጀንቲና', 'AR', 180),
  southAmerica: category('south-america', 'South America', 'ደቡብ አሜሪካ', null, 190),
} as const;

const BASKETBALL = {
  usa: category('usa', 'USA', 'አሜሪካ', 'US', 10),
  europe: category('europe', 'Europe', 'አውሮፓ', null, 20),
  australia: category('australia', 'Australia', 'አውስትራሊያ', 'AU', 30),
} as const;

const TENNIS = {
  atp: category('atp', 'ATP', 'ኤቲፒ', null, 20),
  wta: category('wta', 'WTA', 'ደብሊውቲኤ', null, 30),
} as const;

type Known = [
  sportKey: string,
  sport: SportCode,
  category: LeagueCategory,
  slug: string,
  name: LeagueName,
  options: { featured?: boolean; cup?: boolean; tier: 1 | 2; sortOrder: number },
];

const KNOWN: readonly Known[] = [
  [
    'soccer_epl',
    'football',
    FOOTBALL.england,
    'premier-league',
    { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_efl_champ',
    'football',
    FOOTBALL.england,
    'championship',
    { en: 'Championship' },
    { tier: 1, sortOrder: 20 },
  ],
  [
    'soccer_england_league1',
    'football',
    FOOTBALL.england,
    'league-one',
    { en: 'League One' },
    { tier: 2, sortOrder: 30 },
  ],
  [
    'soccer_england_league2',
    'football',
    FOOTBALL.england,
    'league-two',
    { en: 'League Two' },
    { tier: 2, sortOrder: 40 },
  ],
  [
    'soccer_fa_cup',
    'football',
    FOOTBALL.england,
    'fa-cup',
    { en: 'FA Cup' },
    { cup: true, tier: 1, sortOrder: 50 },
  ],
  [
    'soccer_england_efl_cup',
    'football',
    FOOTBALL.england,
    'efl-cup',
    { en: 'EFL Cup' },
    { cup: true, tier: 2, sortOrder: 60 },
  ],
  [
    'soccer_spain_la_liga',
    'football',
    FOOTBALL.spain,
    'laliga',
    { en: 'LaLiga', am: 'ላሊጋ' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_spain_segunda_division',
    'football',
    FOOTBALL.spain,
    'laliga-2',
    { en: 'LaLiga 2' },
    { tier: 2, sortOrder: 20 },
  ],
  [
    'soccer_italy_serie_a',
    'football',
    FOOTBALL.italy,
    'serie-a',
    { en: 'Serie A', am: 'ሴሪ አ' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_italy_serie_b',
    'football',
    FOOTBALL.italy,
    'serie-b',
    { en: 'Serie B' },
    { tier: 2, sortOrder: 20 },
  ],
  [
    'soccer_germany_bundesliga',
    'football',
    FOOTBALL.germany,
    'bundesliga',
    { en: 'Bundesliga', am: 'ቡንደስሊጋ' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_germany_bundesliga2',
    'football',
    FOOTBALL.germany,
    'bundesliga-2',
    { en: '2. Bundesliga' },
    { tier: 2, sortOrder: 20 },
  ],
  [
    'soccer_france_ligue_one',
    'football',
    FOOTBALL.france,
    'ligue-1',
    { en: 'Ligue 1', am: 'ሊግ 1' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_france_ligue_two',
    'football',
    FOOTBALL.france,
    'ligue-2',
    { en: 'Ligue 2' },
    { tier: 2, sortOrder: 20 },
  ],
  [
    'soccer_uefa_champs_league',
    'football',
    FOOTBALL.clubs,
    'uefa-champions-league',
    { en: 'UEFA Champions League', am: 'የአውሮፓ ሻምፒዮንስ ሊግ' },
    { featured: true, cup: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_uefa_europa_league',
    'football',
    FOOTBALL.clubs,
    'uefa-europa-league',
    { en: 'UEFA Europa League' },
    { cup: true, tier: 1, sortOrder: 20 },
  ],
  [
    'soccer_uefa_europa_conference_league',
    'football',
    FOOTBALL.clubs,
    'uefa-conference-league',
    { en: 'UEFA Conference League' },
    { cup: true, tier: 1, sortOrder: 30 },
  ],
  [
    'soccer_conmebol_copa_libertadores',
    'football',
    FOOTBALL.southAmerica,
    'copa-libertadores',
    { en: 'Copa Libertadores' },
    { cup: true, tier: 2, sortOrder: 10 },
  ],
  [
    'soccer_africa_cup_of_nations',
    'football',
    FOOTBALL.africa,
    'africa-cup-of-nations',
    { en: 'Africa Cup of Nations', am: 'የአፍሪካ ዋንጫ' },
    { featured: true, cup: true, tier: 1, sortOrder: 5 },
  ],
  [
    'soccer_fifa_world_cup',
    'football',
    FOOTBALL.international,
    'fifa-world-cup',
    { en: 'FIFA World Cup', am: 'የዓለም ዋንጫ' },
    { featured: true, cup: true, tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_uefa_nations_league',
    'football',
    FOOTBALL.international,
    'uefa-nations-league',
    { en: 'UEFA Nations League' },
    { cup: true, tier: 2, sortOrder: 20 },
  ],
  [
    'soccer_netherlands_eredivisie',
    'football',
    FOOTBALL.netherlands,
    'eredivisie',
    { en: 'Eredivisie' },
    { tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_portugal_primeira_liga',
    'football',
    FOOTBALL.portugal,
    'primeira-liga',
    { en: 'Primeira Liga' },
    { tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_turkey_super_league',
    'football',
    FOOTBALL.turkey,
    'super-lig',
    { en: 'Süper Lig' },
    { tier: 1, sortOrder: 10 },
  ],
  [
    'soccer_belgium_first_div',
    'football',
    FOOTBALL.belgium,
    'belgian-pro-league',
    { en: 'Pro League' },
    { tier: 2, sortOrder: 10 },
  ],
  [
    'soccer_spl',
    'football',
    FOOTBALL.scotland,
    'premiership',
    { en: 'Premiership' },
    { tier: 2, sortOrder: 10 },
  ],
  [
    'soccer_saudi_arabia_pro_league',
    'football',
    FOOTBALL.saudi,
    'saudi-pro-league',
    { en: 'Saudi Pro League' },
    { tier: 2, sortOrder: 10 },
  ],
  ['soccer_usa_mls', 'football', FOOTBALL.usa, 'mls', { en: 'MLS' }, { tier: 2, sortOrder: 10 }],
  [
    'soccer_brazil_campeonato',
    'football',
    FOOTBALL.brazil,
    'brasileirao-serie-a',
    { en: 'Brasileirão Série A' },
    { tier: 2, sortOrder: 10 },
  ],
  [
    'soccer_argentina_primera_division',
    'football',
    FOOTBALL.argentina,
    'primera-division',
    { en: 'Primera División' },
    { tier: 2, sortOrder: 10 },
  ],
  [
    'basketball_nba',
    'basketball',
    BASKETBALL.usa,
    'nba',
    { en: 'NBA', am: 'ኤንቢኤ' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'basketball_wnba',
    'basketball',
    BASKETBALL.usa,
    'wnba',
    { en: 'WNBA' },
    { tier: 2, sortOrder: 20 },
  ],
  [
    'basketball_ncaab',
    'basketball',
    BASKETBALL.usa,
    'ncaab',
    { en: 'NCAA Basketball' },
    { tier: 2, sortOrder: 30 },
  ],
  [
    'basketball_euroleague',
    'basketball',
    BASKETBALL.europe,
    'euroleague',
    { en: 'EuroLeague' },
    { featured: true, tier: 1, sortOrder: 10 },
  ],
  [
    'basketball_nbl',
    'basketball',
    BASKETBALL.australia,
    'nbl',
    { en: 'NBL' },
    { tier: 2, sortOrder: 10 },
  ],
];

const REGISTRY: ReadonlyMap<string, LeagueEntry> = new Map(
  KNOWN.map(([sportKey, sport, cat, slug, name, options]) => [
    sportKey,
    {
      sportKey,
      sport,
      category: cat,
      competition: {
        slug,
        name,
        featured: options.featured ?? false,
        sortOrder: options.sortOrder,
      },
      cup: options.cup ?? false,
      tier: options.tier,
    },
  ]),
);

/** Grand slams are featured; every tennis tournament is on (it only exists while it runs). */
const GRAND_SLAMS = ['aus_open', 'french_open', 'wimbledon', 'us_open'];

/**
 * Our place for an Odds API sport, or null when it is not supported yet
 * (another sport group, or an outright key).
 */
export function leagueFor(sport: OddsApiSport): LeagueEntry | null {
  const ours = Object.hasOwn(SPORT_GROUPS, sport.group) ? SPORT_GROUPS[sport.group] : undefined;
  if (ours === undefined || sport.hasOutrights || sport.key.endsWith('_winner')) return null;
  const known = REGISTRY.get(sport.key);
  if (known !== undefined) return known;
  if (ours === 'tennis') return tennisLeague(sport);
  return derivedLeague(sport, ours);
}

/** Whether a league is switched on before staff choose: tier 1, or listed in ODDS_API_SPORTS. */
export function enabledByDefault(
  entry: LeagueEntry,
  extraSportKeys: readonly string[] = [],
): boolean {
  return entry.tier === 1 || extraSportKeys.includes(entry.sportKey);
}

/** The registry's known keys (for tests and the back office). */
export function knownSportKeys(): string[] {
  return [...REGISTRY.keys()];
}

function tennisLeague(sport: OddsApiSport): LeagueEntry {
  const tour = sport.key.startsWith('tennis_wta_') ? TENNIS.wta : TENNIS.atp;
  const event = sport.key.replace(/^tennis_(atp|wta)_/, '');
  return {
    sportKey: sport.key,
    sport: 'tennis',
    category: tour,
    competition: {
      slug: `${tour.slug}-${slugify(event)}`,
      name: { en: sport.title },
      featured: GRAND_SLAMS.some((slam) => event.startsWith(slam)),
      sortOrder: 100,
    },
    cup: false,
    tier: 1,
  };
}

/** "La Liga - Spain" → category Spain, competition "La Liga"; no suffix → the sport's region. */
function derivedLeague(sport: OddsApiSport, ours: SportCode): LeagueEntry {
  const match = /^(.*\S)\s+-\s+(\S.*)$/.exec(sport.title);
  const competitionName = match?.[1] ?? sport.title;
  const country = match?.[2];
  const fallback = ours === 'basketball' ? BASKETBALL.europe : FOOTBALL.international;
  const known = country === undefined ? undefined : knownCategory(ours, country);
  return {
    sportKey: sport.key,
    sport: ours,
    category:
      known ??
      (country === undefined
        ? fallback
        : category(slugify(country), country, undefined, null, 500)),
    competition: {
      slug: slugify(sport.key.replace(/^[a-z]+_/, '')),
      name: { en: competitionName },
      featured: false,
      sortOrder: 500,
    },
    cup: /\bcup\b|copa|pokal|coupe|coppa|trophy/i.test(sport.title),
    tier: 3,
  };
}

function knownCategory(sport: SportCode, country: string): LeagueCategory | undefined {
  const pool: readonly LeagueCategory[] = Object.values(
    sport === 'basketball' ? BASKETBALL : FOOTBALL,
  );
  const wanted = country.trim().toLowerCase();
  return pool.find((entry) => entry.name.en.toLowerCase() === wanted);
}

/** Lower-case kebab slug of letters and digits. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
