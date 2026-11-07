/**
 * Sports catalogue reference data: sports, categories, competitions and teams.
 *
 * NOTE: every Amharic (`am`) name in this file is a working translation that
 * must be reviewed by a native speaker before launch.
 *
 * Team ratings are pricing inputs for the demo MockFeedProvider only (a
 * licensed deployment takes its odds from a real feed). Scales:
 * - football `{ attack, defence }` and basketball `{ offence, defence }`:
 *   multipliers of the league-average scoring rate. 1 is average; strong
 *   sides score more (attack/offence > 1) and concede less (defence < 1).
 * - tennis and volleyball `{ rating }`: Elo-style strength, 1500 average,
 *   where a 400-point gap means 10:1 odds-on for the stronger side.
 *
 * The seed is idempotent and safe to run on every deploy and concurrently.
 * Rows are upserted by their natural keys (sport id, category and
 * competition slug, team short name). On a re-run only the fields the seed
 * owns are refreshed (names and country codes) and missing ratings are
 * filled in. What the back office controls (featured, active, sort order,
 * a competition's category, existing ratings) is never overwritten.
 */
import { SPORT_MARKETS, type SportCode } from '@vamos/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { categories, competitions, sports, teams, type LocalizedName } from '../schema/catalog';

export type TeamRatings = Record<string, number>;

export interface CatalogSport {
  id: SportCode;
  name: LocalizedName;
  sortOrder: number;
}

export interface CatalogCompetition {
  slug: string;
  name: LocalizedName;
  featured: boolean;
  sortOrder: number;
  /** Short names of the teams (of the same sport) the mock feed draws fixtures from. */
  teams: readonly string[];
}

export interface CatalogCategory {
  sport: SportCode;
  slug: string;
  name: LocalizedName;
  countryCode: string | null;
  sortOrder: number;
  competitions: readonly CatalogCompetition[];
}

export interface CatalogTeam {
  sport: SportCode;
  /** Unique per sport; the key the feed uses (FeedFixture.homeShortName). */
  shortName: string;
  name: LocalizedName;
  countryCode: string | null;
  ratings: TeamRatings;
}

/** Rows written (inserted or refreshed) by one seedCatalog run. */
export interface CatalogSeedSummary {
  sportsCreated: number;
  categoriesCreated: number;
  competitionsCreated: number;
  teamsCreated: number;
  /** Existing rows whose names or country codes changed, or whose missing ratings were filled. */
  rowsUpdated: number;
}

/**
 * The part of the MockFeedProvider constructor input (`MockFeedConfig` in
 * @vamos/feed) that comes from the catalogue. Structurally identical to it,
 * so the worker can pass it straight through (adding `rolling` and `seed`).
 */
export interface FeedTeamsConfig {
  competitions: Array<{ slug: string; sport: SportCode; featured: boolean }>;
  /** Team pool per competition slug. */
  teams: Record<string, Array<{ shortName: string; ratings: TeamRatings }>>;
}

/** Ratings for a team that has none (added in the back office without pricing inputs). */
export const DEFAULT_TEAM_RATINGS: Readonly<Record<SportCode, Readonly<TeamRatings>>> = {
  football: { attack: 1, defence: 1 },
  basketball: { offence: 1, defence: 1 },
  tennis: { rating: 1500 },
  volleyball: { rating: 1500 },
};

export const CATALOG_SPORTS: readonly CatalogSport[] = [
  { id: 'football', name: { en: 'Football', am: 'እግር ኳስ' }, sortOrder: 10 },
  { id: 'basketball', name: { en: 'Basketball', am: 'የቅርጫት ኳስ' }, sortOrder: 20 },
  { id: 'tennis', name: { en: 'Tennis', am: 'ቴኒስ' }, sortOrder: 30 },
  { id: 'volleyball', name: { en: 'Volleyball', am: 'የመረብ ኳስ' }, sortOrder: 40 },
];

type TeamRow = [shortName: string, name: LocalizedName | string, ...ratings: number[]];

function teamsOf(
  sport: SportCode,
  countryCode: string | null,
  keys: readonly string[],
  rows: readonly TeamRow[],
): CatalogTeam[] {
  return rows.map(([shortName, name, ...values]) => {
    const ratings: TeamRatings = {};
    keys.forEach((key, index) => {
      const value = values[index];
      if (value === undefined) throw new Error(`team ${shortName} is missing rating "${key}"`);
      ratings[key] = value;
    });
    return {
      sport,
      shortName,
      name: typeof name === 'string' ? { en: name } : name,
      countryCode,
      ratings,
    };
  });
}

const football = (countryCode: string | null, rows: readonly TeamRow[]) =>
  teamsOf('football', countryCode, ['attack', 'defence'], rows);

/** Teams whose country differs per row: [countryCode, shortName, name, ...ratings]. */
function mixedCountry(
  sport: SportCode,
  keys: readonly string[],
  rows: ReadonlyArray<[countryCode: string | null, ...row: TeamRow]>,
): CatalogTeam[] {
  return rows.flatMap(([countryCode, ...row]) => teamsOf(sport, countryCode, keys, [row]));
}

const PREMIER_LEAGUE = football('GB-ENG', [
  ['Arsenal', 'Arsenal', 1.5, 0.68],
  ['Aston Villa', 'Aston Villa', 1.22, 0.95],
  ['Bournemouth', 'AFC Bournemouth', 1.1, 1.02],
  ['Brentford', 'Brentford', 1.1, 1.08],
  ['Brighton', 'Brighton & Hove Albion', 1.15, 1.0],
  ['Burnley', 'Burnley', 0.82, 1.18],
  ['Chelsea', 'Chelsea', 1.35, 0.85],
  ['Coventry', 'Coventry City', 0.88, 1.12],
  ['Crystal Palace', 'Crystal Palace', 1.05, 0.95],
  ['Everton', 'Everton', 0.92, 1.0],
  ['Fulham', 'Fulham', 1.02, 1.02],
  ['Hull', 'Hull City', 0.82, 1.18],
  ['Ipswich', 'Ipswich Town', 0.86, 1.14],
  ['Leeds', 'Leeds United', 0.9, 1.12],
  ['Liverpool', 'Liverpool', 1.55, 0.75],
  ['Man City', 'Manchester City', 1.52, 0.78],
  ['Man Utd', 'Manchester United', 1.12, 1.0],
  ['Newcastle', 'Newcastle United', 1.25, 0.88],
  ["Nott'm Forest", 'Nottingham Forest', 1.05, 0.95],
  ['Sunderland', 'Sunderland', 0.85, 1.15],
  ['Tottenham', 'Tottenham Hotspur', 1.2, 1.02],
  ['West Ham', 'West Ham United', 0.98, 1.12],
  ['Wolves', 'Wolverhampton Wanderers', 0.92, 1.15],
]);

const LALIGA = football('ES', [
  ['Real Madrid', 'Real Madrid', 1.55, 0.72],
  ['Barcelona', 'FC Barcelona', 1.65, 0.85],
  ['Atletico Madrid', 'Atlético de Madrid', 1.3, 0.78],
  ['Athletic Club', 'Athletic Club', 1.12, 0.88],
  ['Villarreal', 'Villarreal CF', 1.18, 0.95],
  ['Real Betis', 'Real Betis', 1.1, 0.98],
  ['Real Sociedad', 'Real Sociedad', 1.02, 0.98],
  ['Sevilla', 'Sevilla FC', 0.98, 1.05],
  ['Valencia', 'Valencia CF', 0.95, 1.05],
  ['Girona', 'Girona FC', 0.98, 1.12],
  ['Celta Vigo', 'RC Celta', 1.02, 1.08],
  ['Osasuna', 'CA Osasuna', 0.92, 1.02],
  ['Rayo Vallecano', 'Rayo Vallecano', 0.92, 1.02],
  ['Getafe', 'Getafe CF', 0.82, 0.98],
  // 2026-27 clubs added for the football-data.org source (starting values; `ratings backfill` learns them).
  ['Alaves', 'Deportivo Alavés', 0.9, 1.05],
  ['Elche', 'Elche CF', 0.85, 1.12],
  ['Levante', 'Levante UD', 0.85, 1.12],
  ['Malaga', 'Málaga CF', 0.85, 1.12],
  ['Deportivo', 'Deportivo La Coruña', 0.85, 1.12],
  ['Espanyol', 'RCD Espanyol', 0.9, 1.05],
  ['Racing Santander', 'Racing Santander', 0.85, 1.12],
]);

const SERIE_A = football('IT', [
  ['Inter', 'Inter', 1.45, 0.75],
  ['Napoli', 'SSC Napoli', 1.3, 0.78],
  ['Juventus', 'Juventus', 1.2, 0.8],
  ['AC Milan', 'AC Milan', 1.25, 0.88],
  ['Atalanta', 'Atalanta', 1.35, 0.88],
  ['Roma', 'AS Roma', 1.15, 0.85],
  ['Lazio', 'SS Lazio', 1.12, 0.92],
  ['Fiorentina', 'ACF Fiorentina', 1.05, 0.95],
  ['Bologna', 'Bologna FC', 1.08, 0.92],
  ['Como', 'Como 1907', 1.05, 0.98],
  ['Torino', 'Torino FC', 0.92, 1.0],
  ['Udinese', 'Udinese Calcio', 0.9, 1.05],
  ['Genoa', 'Genoa CFC', 0.88, 1.05],
  // 2026-27 clubs added for the football-data.org source (starting values; `ratings backfill` learns them).
  ['Monza', 'AC Monza', 0.85, 1.12],
  ['Cagliari', 'Cagliari Calcio', 0.9, 1.08],
  ['Frosinone', 'Frosinone Calcio', 0.85, 1.15],
  ['Parma', 'Parma Calcio 1913', 0.92, 1.08],
  ['Lecce', 'US Lecce', 0.85, 1.12],
  ['Sassuolo', 'US Sassuolo Calcio', 0.92, 1.1],
  ['Venezia', 'Venezia FC', 0.85, 1.12],
]);

const BUNDESLIGA = football('DE', [
  ['Bayern', 'FC Bayern München', 1.75, 0.78],
  ['Leverkusen', 'Bayer 04 Leverkusen', 1.3, 0.88],
  ['Dortmund', 'Borussia Dortmund', 1.35, 0.92],
  ['RB Leipzig', 'RB Leipzig', 1.22, 0.95],
  ['Frankfurt', 'Eintracht Frankfurt', 1.25, 1.0],
  ['Stuttgart', 'VfB Stuttgart', 1.2, 0.98],
  ['Freiburg', 'SC Freiburg', 1.02, 1.0],
  ['Gladbach', 'Borussia Mönchengladbach', 1.0, 1.08],
  ['Wolfsburg', 'VfL Wolfsburg', 0.98, 1.08],
  ['Mainz', '1. FSV Mainz 05', 1.0, 1.0],
  ['Werder Bremen', 'SV Werder Bremen', 1.02, 1.1],
  ['Union Berlin', '1. FC Union Berlin', 0.9, 1.02],
  ['Hoffenheim', 'TSG Hoffenheim', 1.08, 1.1],
  // 2026-27 clubs added for the football-data.org source (starting values; `ratings backfill` learns them).
  ['Koln', '1. FC Köln', 0.95, 1.08],
  ['Augsburg', 'FC Augsburg', 0.95, 1.1],
  ['Schalke', 'FC Schalke 04', 0.92, 1.1],
  ['Hamburg', 'Hamburger SV', 0.95, 1.08],
  ['Paderborn', 'SC Paderborn 07', 0.85, 1.18],
  ['Elversberg', 'SV 07 Elversberg', 0.85, 1.18],
]);

const LIGUE_1 = football('FR', [
  ['PSG', 'Paris Saint-Germain', 1.65, 0.75],
  ['Marseille', 'Olympique de Marseille', 1.3, 0.9],
  ['Monaco', 'AS Monaco', 1.3, 0.95],
  ['Lille', 'LOSC Lille', 1.15, 0.88],
  ['Lyon', 'Olympique Lyonnais', 1.2, 0.95],
  ['Nice', 'OGC Nice', 1.08, 0.95],
  ['Lens', 'RC Lens', 1.05, 0.92],
  ['Rennes', 'Stade Rennais', 1.05, 1.0],
  ['Strasbourg', 'RC Strasbourg Alsace', 1.08, 1.0],
  ['Nantes', 'FC Nantes', 0.88, 1.08],
  ['Toulouse', 'Toulouse FC', 0.95, 1.02],
  ['Brest', 'Stade Brestois 29', 0.98, 1.1],
  ['Auxerre', 'AJ Auxerre', 0.9, 1.1],
  // 2026-27 clubs added for the football-data.org source (starting values; `ratings backfill` learns them).
  ['Angers', 'Angers SCO', 0.85, 1.1],
  ['Troyes', 'ES Troyes AC', 0.85, 1.12],
  ['Lorient', 'FC Lorient', 0.9, 1.1],
  ['Le Havre', 'Le Havre AC', 0.85, 1.1],
  ['Le Mans', 'Le Mans FC', 0.82, 1.15],
  ['Paris FC', 'Paris FC', 0.9, 1.05],
]);

/**
 * EFL Championship, the 24 clubs of 2026-27 (openfootball en.2.json). Burnley, West Ham and
 * Wolves are relegated Premier League clubs and stay the teams of PREMIER_LEAGUE (a club is one
 * team that can appear in several competitions), so they are not repeated here. The Welsh clubs
 * carry GB-WLS. Starting values; `ratings backfill` learns them from finished matches.
 */
const CHAMPIONSHIP = mixedCountry(
  'football',
  ['attack', 'defence'],
  [
    ['GB-ENG', 'Southampton', 'Southampton', 1.0, 1.05],
    ['GB-ENG', 'Sheffield United', 'Sheffield United', 0.95, 1.08],
    ['GB-ENG', 'Norwich', 'Norwich City', 0.95, 1.08],
    ['GB-ENG', 'Watford', 'Watford', 0.9, 1.1],
    ['GB-ENG', 'Middlesbrough', 'Middlesbrough', 0.92, 1.05],
    ['GB-ENG', 'Stoke', 'Stoke City', 0.85, 1.05],
    ['GB-ENG', 'Millwall', 'Millwall', 0.82, 1.05],
    ['GB-ENG', 'West Brom', 'West Bromwich Albion', 0.88, 1.08],
    ['GB-ENG', 'Birmingham', 'Birmingham City', 0.88, 1.08],
    ['GB-ENG', 'Blackburn', 'Blackburn Rovers', 0.85, 1.1],
    ['GB-ENG', 'Bristol City', 'Bristol City', 0.88, 1.1],
    ['GB-ENG', 'Derby', 'Derby County', 0.85, 1.1],
    ['GB-ENG', 'Preston', 'Preston North End', 0.82, 1.08],
    ['GB-ENG', 'Portsmouth', 'Portsmouth', 0.85, 1.12],
    ['GB-ENG', 'QPR', 'Queens Park Rangers', 0.82, 1.12],
    ['GB-ENG', 'Charlton', 'Charlton Athletic', 0.82, 1.12],
    ['GB-ENG', 'Bolton', 'Bolton Wanderers', 0.8, 1.15],
    ['GB-ENG', 'Lincoln', 'Lincoln City', 0.8, 1.15],
    ['GB-WLS', 'Cardiff', 'Cardiff City', 0.8, 1.12],
    ['GB-WLS', 'Swansea', 'Swansea City', 0.85, 1.1],
    ['GB-WLS', 'Wrexham', 'Wrexham', 0.88, 1.12],
  ],
);

/** The Eredivisie, 18 clubs of 2026-27 (openfootball nl.1.json); PSV and Feyenoord are in EUROPEAN_CLUBS. */
const EREDIVISIE = football('NL', [
  ['Ajax', 'Ajax', 1.2, 0.95],
  ['AZ', 'AZ Alkmaar', 1.05, 1.0],
  ['Twente', 'FC Twente', 1.05, 1.0],
  ['Utrecht', 'FC Utrecht', 1.0, 1.02],
  ['Heerenveen', 'SC Heerenveen', 0.95, 1.08],
  ['Sparta Rotterdam', 'Sparta Rotterdam', 0.95, 1.08],
  ['Go Ahead Eagles', 'Go Ahead Eagles', 0.95, 1.08],
  ['NEC', 'NEC Nijmegen', 1.0, 1.05],
  ['Groningen', 'FC Groningen', 0.92, 1.1],
  ['Fortuna Sittard', 'Fortuna Sittard', 0.88, 1.12],
  ['PEC Zwolle', 'PEC Zwolle', 0.88, 1.12],
  ['Excelsior', 'Excelsior', 0.85, 1.12],
  ['Willem II', 'Willem II', 0.88, 1.12],
  ['Cambuur', 'SC Cambuur', 0.85, 1.15],
  ['ADO Den Haag', 'ADO Den Haag', 0.85, 1.15],
  ['Telstar', 'Telstar', 0.82, 1.15],
]);

/** The Primeira Liga, 18 clubs of 2026-27 (openfootball pt.1.json); Porto and Sporting CP are in EUROPEAN_CLUBS. */
const PRIMEIRA_LIGA = football('PT', [
  ['Benfica', 'Benfica', 1.2, 0.9],
  ['Braga', 'Braga', 1.08, 0.98],
  ['Vitoria Guimaraes', 'Vitória Guimarães', 0.98, 1.02],
  ['Famalicao', 'Famalicão', 0.95, 1.05],
  ['Gil Vicente', 'Gil Vicente', 0.92, 1.05],
  ['Estoril', 'Estoril Praia', 0.92, 1.08],
  ['Moreirense', 'Moreirense', 0.88, 1.08],
  ['Rio Ave', 'Rio Ave', 0.88, 1.1],
  ['Casa Pia', 'Casa Pia', 0.85, 1.1],
  ['Arouca', 'Arouca', 0.85, 1.1],
  ['Santa Clara', 'Santa Clara', 0.88, 1.08],
  ['Nacional', 'Nacional', 0.85, 1.1],
  ['Estrela Amadora', 'Estrela da Amadora', 0.82, 1.12],
  ['Alverca', 'Alverca', 0.8, 1.15],
  ['Maritimo', 'Marítimo', 0.82, 1.12],
  ['Academico Viseu', 'Académico de Viseu', 0.8, 1.15],
]);

/** The Brasileirão Série A, 20 clubs of 2026 (openfootball br.1.json). */
const BRASILEIRAO = football('BR', [
  ['Palmeiras', 'Palmeiras', 1.25, 0.85],
  ['Flamengo', 'Flamengo', 1.3, 0.88],
  ['Botafogo', 'Botafogo', 1.1, 0.95],
  ['Cruzeiro', 'Cruzeiro', 1.05, 0.95],
  ['Atletico Mineiro', 'Atlético Mineiro', 1.08, 0.98],
  ['Fluminense', 'Fluminense', 1.02, 1.0],
  ['Corinthians', 'Corinthians', 0.98, 0.98],
  ['Sao Paulo', 'São Paulo', 1.0, 0.98],
  ['Internacional', 'Internacional', 1.0, 0.98],
  ['Gremio', 'Grêmio', 1.0, 1.0],
  ['Bahia', 'Bahia', 1.0, 1.0],
  ['Vasco', 'Vasco da Gama', 0.98, 1.02],
  ['Santos', 'Santos', 0.95, 1.05],
  ['Athletico Paranaense', 'Athletico Paranaense', 0.95, 1.02],
  ['Bragantino', 'RB Bragantino', 0.95, 1.02],
  ['Vitoria', 'Vitória', 0.88, 1.08],
  ['Coritiba', 'Coritiba', 0.85, 1.08],
  ['Mirassol', 'Mirassol', 0.92, 1.05],
  ['Chapecoense', 'Chapecoense', 0.82, 1.12],
  ['Remo', 'Remo', 0.82, 1.12],
]);

/**
 * Liga de Fútbol de Primera División (Liga FPD), the 10 clubs of Apertura 2026
 * (docs/scraper-plan/sources-costa-rica.md). Ratings are deliberately neutral
 * and carry neither `matches` nor `manual`, so rule O1 treats every club as
 * NOT calibrated until a trader runs `ratings set` or `ratings backfill`.
 * Spanish names need no translation, hence English-only names.
 */
const COSTA_RICAN_PRIMERA = football('CR', [
  ['Alajuelense', 'Liga Deportiva Alajuelense', 1, 1],
  ['Saprissa', 'Deportivo Saprissa', 1, 1],
  ['Herediano', 'Club Sport Herediano', 1, 1],
  ['Cartaginés', 'Club Sport Cartaginés', 1, 1],
  ['Pérez Zeledón', 'Municipal Pérez Zeledón', 1, 1],
  ['Puntarenas', 'Puntarenas Fútbol Club', 1, 1],
  ['Sporting CR', 'Sporting Football Club', 1, 1],
  ['San Carlos', 'Asociación Deportiva San Carlos', 1, 1],
  ['Inter San Carlos', 'Inter San Carlos', 1, 1],
  ['Escorpiones', 'Escorpiones de Belén', 1, 1],
]);

const ETHIOPIAN_PREMIER_LEAGUE = football('ET', [
  ['St George', { en: 'Saint George', am: 'ቅዱስ ጊዮርጊስ' }, 1.3, 0.8],
  ['Fasil Kenema', { en: 'Fasil Kenema', am: 'ፋሲል ከነማ' }, 1.2, 0.85],
  ['Eth Coffee', { en: 'Ethiopian Coffee', am: 'ኢትዮጵያ ቡና' }, 1.15, 0.9],
  ['Bahir Dar', { en: 'Bahir Dar Kenema', am: 'ባሕር ዳር ከነማ' }, 1.15, 0.88],
  ['Mekelle 70', { en: 'Mekelle 70 Enderta', am: 'መቐለ 70 እንደርታ' }, 1.05, 0.95],
  ['Hawassa', { en: 'Hawassa City', am: 'ሀዋሳ ከተማ' }, 1.05, 1.0],
  ['Sidama Coffee', { en: 'Sidama Coffee', am: 'ሲዳማ ቡና' }, 1.0, 0.98],
  ['Adama', { en: 'Adama City', am: 'አዳማ ከተማ' }, 1.0, 1.02],
  ['Dire Dawa', { en: 'Dire Dawa City', am: 'ድሬዳዋ ከተማ' }, 0.95, 1.05],
  ['Wolaitta Dicha', { en: 'Wolaitta Dicha', am: 'ወላይታ ድቻ' }, 0.98, 0.98],
  ['Hadiya Hossana', { en: 'Hadiya Hossana', am: 'ሀዲያ ሆሳዕና' }, 1.02, 0.95],
  ['Arba Minch', { en: 'Arba Minch City', am: 'አርባ ምንጭ ከተማ' }, 0.92, 1.05],
  ['Wolkite', { en: 'Wolkite City', am: 'ወልቂጤ ከተማ' }, 0.88, 1.1],
  ['Ethio Electric', { en: 'Ethio Electric', am: 'ኢትዮ ኤሌክትሪክ' }, 0.9, 1.08],
  ['Mechal', { en: 'Mechal', am: 'መቻል' }, 1.08, 0.92],
  ['Shashemene', { en: 'Shashemene City', am: 'ሻሸመኔ ከተማ' }, 0.85, 1.12],
]);

const CAF_CLUBS = mixedCountry(
  'football',
  ['attack', 'defence'],
  [
    ['EG', 'Al Ahly', 'Al Ahly', 1.35, 0.75],
    ['EG', 'Zamalek', 'Zamalek SC', 1.15, 0.88],
    ['EG', 'Pyramids', 'Pyramids FC', 1.25, 0.82],
    ['MA', 'Wydad', 'Wydad AC', 1.15, 0.85],
    ['MA', 'Raja', 'Raja Casablanca', 1.12, 0.85],
    ['MA', 'RS Berkane', 'RS Berkane', 1.08, 0.85],
    ['TN', 'Esperance', 'Espérance de Tunis', 1.15, 0.8],
    ['ZA', 'Sundowns', 'Mamelodi Sundowns', 1.3, 0.78],
    ['ZA', 'Orlando Pirates', 'Orlando Pirates', 1.12, 0.88],
    ['CD', 'TP Mazembe', 'TP Mazembe', 1.05, 0.9],
    ['TZ', 'Simba SC', 'Simba SC', 1.05, 0.92],
    ['TZ', 'Young Africans', 'Young Africans SC', 1.1, 0.9],
    ['DZ', 'USM Alger', 'USM Alger', 1.0, 0.9],
    ['DZ', 'CR Belouizdad', 'CR Belouizdad', 1.02, 0.9],
  ],
);

const NBA = teamsOf(
  'basketball',
  'US',
  ['offence', 'defence'],
  [
    ['Thunder', 'Oklahoma City Thunder', 1.06, 0.92],
    ['Celtics', 'Boston Celtics', 1.05, 0.95],
    ['Cavaliers', 'Cleveland Cavaliers', 1.06, 0.95],
    ['Nuggets', 'Denver Nuggets', 1.06, 1.0],
    ['Knicks', 'New York Knicks', 1.04, 0.98],
    ['Timberwolves', 'Minnesota Timberwolves', 1.01, 0.95],
    ['Rockets', 'Houston Rockets', 1.01, 0.95],
    ['Lakers', 'Los Angeles Lakers', 1.02, 1.0],
    ['Warriors', 'Golden State Warriors', 1.01, 0.97],
    ['Pacers', 'Indiana Pacers', 1.03, 1.01],
    ['Bucks', 'Milwaukee Bucks', 1.01, 1.0],
    ['Clippers', 'LA Clippers', 1.0, 0.96],
    ['Mavericks', 'Dallas Mavericks', 1.0, 1.0],
    ['Magic', 'Orlando Magic', 0.96, 0.94],
    ['Heat', 'Miami Heat', 0.99, 1.0],
    ['76ers', 'Philadelphia 76ers', 0.97, 1.03],
  ],
);

/** Players compete as "teams" of one. Neutral athletes have no country code. */
const ATP_PLAYERS = mixedCountry(
  'tennis',
  ['rating'],
  [
    ['IT', 'Sinner', 'Jannik Sinner', 2250],
    ['ES', 'Alcaraz', 'Carlos Alcaraz', 2260],
    ['RS', 'Djokovic', 'Novak Djokovic', 2120],
    ['DE', 'Zverev', 'Alexander Zverev', 2050],
    ['US', 'Fritz', 'Taylor Fritz', 1990],
    ['GB', 'Draper', 'Jack Draper', 1990],
    ['IT', 'Musetti', 'Lorenzo Musetti', 1960],
    ['AU', 'De Minaur', 'Alex de Minaur', 1950],
    ['US', 'Shelton', 'Ben Shelton', 1950],
    ['DK', 'Rune', 'Holger Rune', 1930],
    [null, 'Medvedev', 'Daniil Medvedev', 1960],
    ['NO', 'Ruud', 'Casper Ruud', 1920],
    [null, 'Rublev', 'Andrey Rublev', 1920],
    ['US', 'T. Paul', 'Tommy Paul', 1920],
    ['CA', 'Auger-Aliassime', 'Félix Auger-Aliassime', 1940],
    ['GR', 'Tsitsipas', 'Stefanos Tsitsipas', 1900],
  ],
);

const VOLLEYBALL_NATIONS = mixedCountry(
  'volleyball',
  ['rating'],
  [
    ['PL', 'Poland', { en: 'Poland', am: 'ፖላንድ' }, 1900],
    ['IT', 'Italy', { en: 'Italy', am: 'ጣሊያን' }, 1880],
    ['FR', 'France', { en: 'France', am: 'ፈረንሳይ' }, 1850],
    ['US', 'USA', { en: 'USA', am: 'አሜሪካ' }, 1830],
    ['BR', 'Brazil', { en: 'Brazil', am: 'ብራዚል' }, 1820],
    ['JP', 'Japan', { en: 'Japan', am: 'ጃፓን' }, 1820],
    ['SI', 'Slovenia', { en: 'Slovenia', am: 'ስሎቬኒያ' }, 1790],
    ['DE', 'Germany', { en: 'Germany', am: 'ጀርመን' }, 1760],
    ['RS', 'Serbia', { en: 'Serbia', am: 'ሰርቢያ' }, 1740],
    ['AR', 'Argentina', { en: 'Argentina', am: 'አርጀንቲና' }, 1740],
    ['CA', 'Canada', { en: 'Canada', am: 'ካናዳ' }, 1720],
    ['CU', 'Cuba', { en: 'Cuba', am: 'ኩባ' }, 1700],
  ],
);

/**
 * 2026-27 UEFA Champions League clubs from leagues the catalogue does not offer. Their ratings
 * are hand-set on the scale of the five top leagues (a club's ratings elsewhere are relative to
 * its own league's average, so a dominant club of a weaker league would look too strong);
 * infra/scripts/add-champions-league.sh marks them as reviewed (manual).
 */
const EUROPEAN_CLUBS = mixedCountry(
  'football',
  ['attack', 'defence'],
  [
    ['NL', 'PSV', 'PSV Eindhoven', 1.15, 0.95],
    ['NL', 'Feyenoord', 'Feyenoord Rotterdam', 1.08, 0.98],
    ['PT', 'Porto', 'FC Porto', 1.12, 0.92],
    ['PT', 'Sporting CP', 'Sporting Clube de Portugal', 1.15, 0.92],
    ['NO', 'Bodo/Glimt', 'FK Bodø/Glimt', 0.95, 1.08],
    ['NO', 'Viking', 'Viking FK', 0.82, 1.18],
    ['TR', 'Fenerbahce', 'Fenerbahçe SK', 1.02, 1.0],
    ['TR', 'Galatasaray', 'Galatasaray SK', 1.05, 1.0],
    ['BE', 'Club Brugge', 'Club Brugge KV', 1.0, 1.0],
    ['CZ', 'Slavia Prague', 'SK Slavia Praha', 0.92, 1.05],
    ['GR', 'AEK Athens', 'AEK Athens FC', 0.88, 1.08],
    ['UA', 'Shakhtar Donetsk', 'FC Shakhtar Donetsk', 0.92, 1.08],
    ['AT', 'LASK', 'LASK', 0.82, 1.15],
    ['SK', 'Slovan Bratislava', 'ŠK Slovan Bratislava', 0.8, 1.2],
    ['AZ', 'Sabah', 'Sabah FK', 0.75, 1.25],
  ],
);

export const CATALOG_TEAMS: readonly CatalogTeam[] = [
  ...PREMIER_LEAGUE,
  ...LALIGA,
  ...SERIE_A,
  ...BUNDESLIGA,
  ...LIGUE_1,
  ...COSTA_RICAN_PRIMERA,
  ...ETHIOPIAN_PREMIER_LEAGUE,
  ...CAF_CLUBS,
  ...EUROPEAN_CLUBS,
  ...CHAMPIONSHIP,
  ...EREDIVISIE,
  ...PRIMEIRA_LIGA,
  ...BRASILEIRAO,
  ...NBA,
  ...ATP_PLAYERS,
  ...VOLLEYBALL_NATIONS,
];

const shortNames = (list: readonly CatalogTeam[]) => list.map((team) => team.shortName);

export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [
  {
    // Home market, listed first. Sort order 5 sits before the existing 10..80 so
    // databases seeded earlier (whose sort orders the seed never rewrites) agree.
    sport: 'football',
    slug: 'costa-rica',
    name: { en: 'Costa Rica' },
    countryCode: 'CR',
    sortOrder: 5,
    competitions: [
      {
        slug: 'primera-division',
        name: { en: 'Primera División' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(COSTA_RICAN_PRIMERA),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'england',
    name: { en: 'England', am: 'እንግሊዝ' },
    countryCode: 'GB-ENG',
    sortOrder: 10,
    competitions: [
      {
        slug: 'premier-league',
        name: { en: 'Premier League', am: 'ፕሪሚየር ሊግ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(PREMIER_LEAGUE),
      },
      {
        slug: 'championship',
        name: { en: 'EFL Championship', am: 'ኢኤፍኤል ቻምፒዮንሺፕ' },
        featured: false,
        sortOrder: 20,
        // Relegated Premier League clubs are the same teams as in the Premier League above.
        teams: ['Burnley', 'West Ham', 'Wolves', ...shortNames(CHAMPIONSHIP)],
      },
    ],
  },
  {
    sport: 'football',
    slug: 'ethiopia',
    name: { en: 'Ethiopia', am: 'ኢትዮጵያ' },
    countryCode: 'ET',
    sortOrder: 20,
    competitions: [
      {
        slug: 'ethiopian-premier-league',
        name: { en: 'Ethiopian Premier League', am: 'የኢትዮጵያ ፕሪምየር ሊግ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(ETHIOPIAN_PREMIER_LEAGUE),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'spain',
    name: { en: 'Spain', am: 'ስፔን' },
    countryCode: 'ES',
    sortOrder: 30,
    competitions: [
      {
        slug: 'laliga',
        name: { en: 'LaLiga', am: 'ላ ሊጋ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(LALIGA),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'italy',
    name: { en: 'Italy', am: 'ጣሊያን' },
    countryCode: 'IT',
    sortOrder: 40,
    competitions: [
      {
        slug: 'serie-a',
        name: { en: 'Serie A', am: 'ሴሪ አ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(SERIE_A),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'germany',
    name: { en: 'Germany', am: 'ጀርመን' },
    countryCode: 'DE',
    sortOrder: 50,
    competitions: [
      {
        slug: 'bundesliga',
        name: { en: 'Bundesliga', am: 'ቡንደስሊጋ' },
        featured: false,
        sortOrder: 10,
        teams: shortNames(BUNDESLIGA),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'france',
    name: { en: 'France', am: 'ፈረንሳይ' },
    countryCode: 'FR',
    sortOrder: 60,
    competitions: [
      {
        slug: 'ligue-1',
        name: { en: 'Ligue 1', am: 'ሊግ 1' },
        featured: false,
        sortOrder: 10,
        teams: shortNames(LIGUE_1),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'netherlands',
    name: { en: 'Netherlands', am: 'ኔዘርላንድስ' },
    countryCode: 'NL',
    sortOrder: 62,
    competitions: [
      {
        slug: 'eredivisie',
        name: { en: 'Eredivisie', am: 'ኤርዴቪዚ' },
        featured: false,
        sortOrder: 10,
        teams: ['PSV', 'Feyenoord', ...shortNames(EREDIVISIE)],
      },
    ],
  },
  {
    sport: 'football',
    slug: 'portugal',
    name: { en: 'Portugal', am: 'ፖርቱጋል' },
    countryCode: 'PT',
    sortOrder: 64,
    competitions: [
      {
        slug: 'primeira-liga',
        name: { en: 'Primeira Liga', am: 'ፕሪሜይራ ሊጋ' },
        featured: false,
        sortOrder: 10,
        teams: ['Porto', 'Sporting CP', ...shortNames(PRIMEIRA_LIGA)],
      },
    ],
  },
  {
    sport: 'football',
    slug: 'brazil',
    name: { en: 'Brazil', am: 'ብራዚል' },
    countryCode: 'BR',
    sortOrder: 66,
    competitions: [
      {
        slug: 'brasileirao-serie-a',
        name: { en: 'Brasileirão Série A', am: 'ብራዚሌይራኦ ሴሪ አ' },
        featured: false,
        sortOrder: 10,
        teams: shortNames(BRASILEIRAO),
      },
    ],
  },
  {
    sport: 'football',
    slug: 'international-clubs',
    name: { en: 'International clubs', am: 'ዓለም አቀፍ ክለቦች' },
    countryCode: null,
    sortOrder: 70,
    competitions: [
      {
        slug: 'uefa-champions-league',
        name: { en: 'UEFA Champions League', am: 'የአውሮፓ ሻምፒዮንስ ሊግ' },
        featured: true,
        sortOrder: 10,
        teams: [
          'Real Madrid',
          'Barcelona',
          'Atletico Madrid',
          'Man City',
          'Liverpool',
          'Arsenal',
          'Chelsea',
          'Bayern',
          'Dortmund',
          'Leverkusen',
          'Inter',
          'Napoli',
          'Juventus',
          'Atalanta',
          'PSG',
          'Monaco',
        ],
      },
    ],
  },
  {
    sport: 'football',
    slug: 'africa',
    name: { en: 'Africa', am: 'አፍሪካ' },
    countryCode: null,
    sortOrder: 80,
    competitions: [
      {
        slug: 'caf-champions-league',
        name: { en: 'CAF Champions League', am: 'የካፍ ሻምፒዮንስ ሊግ' },
        featured: false,
        sortOrder: 10,
        teams: [
          'Al Ahly',
          'Pyramids',
          'Wydad',
          'Esperance',
          'Sundowns',
          'TP Mazembe',
          'Young Africans',
          'Simba SC',
          'St George',
        ],
      },
      {
        slug: 'caf-confederation-cup',
        name: { en: 'CAF Confederation Cup', am: 'የካፍ ኮንፌዴሬሽን ዋንጫ' },
        featured: false,
        sortOrder: 20,
        teams: [
          'Zamalek',
          'Raja',
          'RS Berkane',
          'Orlando Pirates',
          'USM Alger',
          'CR Belouizdad',
          'Fasil Kenema',
          'Eth Coffee',
        ],
      },
    ],
  },
  {
    sport: 'basketball',
    slug: 'usa',
    name: { en: 'USA', am: 'አሜሪካ' },
    countryCode: 'US',
    sortOrder: 10,
    competitions: [
      {
        slug: 'nba',
        name: { en: 'NBA', am: 'ኤንቢኤ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(NBA),
      },
    ],
  },
  {
    sport: 'tennis',
    slug: 'international',
    name: { en: 'International', am: 'ዓለም አቀፍ' },
    countryCode: null,
    sortOrder: 10,
    competitions: [
      {
        slug: 'atp-tour',
        name: { en: 'ATP Tour', am: 'ኤቲፒ ቱር' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(ATP_PLAYERS),
      },
    ],
  },
  {
    sport: 'volleyball',
    slug: 'international',
    name: { en: 'International', am: 'ዓለም አቀፍ' },
    countryCode: null,
    sortOrder: 10,
    competitions: [
      {
        slug: 'volleyball-nations-league',
        name: { en: 'Volleyball Nations League', am: 'የቮሊቦል ኔሽንስ ሊግ' },
        featured: true,
        sortOrder: 10,
        teams: shortNames(VOLLEYBALL_NATIONS),
      },
    ],
  },
];

/** `RETURNING` column that is true for an inserted row and false for an updated one. */
const inserted = sql<boolean>`(xmax = 0)`;

function countInserted(rows: ReadonlyArray<{ inserted: boolean }>): [number, number] {
  const created = rows.filter((row) => row.inserted).length;
  return [created, rows.length - created];
}

/**
 * Upserts the reference catalogue (see the file comment for what a re-run
 * changes). Runs in one transaction, or a savepoint when `db` is already a
 * transaction. Returns how many rows it created and updated.
 */
export async function seedCatalog(db: DbExecutor): Promise<CatalogSeedSummary> {
  return db.transaction(async (tx) => {
    const sportRows = await tx
      .insert(sports)
      .values(CATALOG_SPORTS.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })))
      .onConflictDoUpdate({
        target: sports.id,
        set: { name: sql`excluded.name` },
        setWhere: sql`${sports.name} IS DISTINCT FROM excluded.name`,
      })
      .returning({ inserted });
    const [sportsCreated, sportsUpdated] = countInserted(sportRows);

    const categoryRows = await tx
      .insert(categories)
      .values(
        CATALOG_CATEGORIES.map(({ sport, slug, name, countryCode, sortOrder }) => ({
          sportId: sport,
          slug,
          name,
          countryCode,
          sortOrder,
        })),
      )
      .onConflictDoUpdate({
        target: [categories.sportId, categories.slug],
        set: { name: sql`excluded.name`, countryCode: sql`excluded.country_code` },
        setWhere: sql`${categories.name} IS DISTINCT FROM excluded.name
          OR ${categories.countryCode} IS DISTINCT FROM excluded.country_code`,
      })
      .returning({ inserted });
    const [categoriesCreated, categoriesUpdated] = countInserted(categoryRows);

    const categoryIds = new Map(
      (
        await tx
          .select({ id: categories.id, sportId: categories.sportId, slug: categories.slug })
          .from(categories)
          .where(
            inArray(
              categories.sportId,
              CATALOG_SPORTS.map((sport) => sport.id),
            ),
          )
      ).map((row) => [`${row.sportId}/${row.slug}`, row.id]),
    );
    const competitionValues = CATALOG_CATEGORIES.flatMap((category) => {
      const categoryId = categoryIds.get(`${category.sport}/${category.slug}`);
      if (categoryId === undefined) {
        throw new Error(`category ${category.sport}/${category.slug} was not seeded`);
      }
      return category.competitions.map(({ slug, name, featured, sortOrder }) => ({
        sportId: category.sport,
        categoryId,
        slug,
        name,
        featured,
        sortOrder,
      }));
    });
    const competitionRows = await tx
      .insert(competitions)
      .values(competitionValues)
      .onConflictDoUpdate({
        target: [competitions.sportId, competitions.slug],
        set: { name: sql`excluded.name` },
        setWhere: sql`${competitions.name} IS DISTINCT FROM excluded.name`,
      })
      .returning({ inserted });
    const [competitionsCreated, competitionsUpdated] = countInserted(competitionRows);

    const teamRows = await tx
      .insert(teams)
      .values(
        CATALOG_TEAMS.map(({ sport, shortName, name, countryCode, ratings }) => ({
          sportId: sport,
          shortName,
          name,
          countryCode,
          ratings,
        })),
      )
      .onConflictDoUpdate({
        target: [teams.sportId, teams.shortName],
        set: {
          name: sql`excluded.name`,
          countryCode: sql`excluded.country_code`,
          ratings: sql`COALESCE(${teams.ratings}, excluded.ratings)`,
        },
        setWhere: sql`${teams.name} IS DISTINCT FROM excluded.name
          OR ${teams.countryCode} IS DISTINCT FROM excluded.country_code
          OR ${teams.ratings} IS NULL`,
      })
      .returning({ inserted });
    const [teamsCreated, teamsUpdated] = countInserted(teamRows);

    return {
      sportsCreated,
      categoriesCreated,
      competitionsCreated,
      teamsCreated,
      rowsUpdated: sportsUpdated + categoriesUpdated + competitionsUpdated + teamsUpdated,
    };
  });
}

/** Seeded team pools by `<sport>/<competition slug>`. */
const SEEDED_POOLS: ReadonlyMap<string, readonly string[]> = new Map(
  CATALOG_CATEGORIES.flatMap((category) =>
    category.competitions.map((competition) => [
      `${category.sport}/${competition.slug}`,
      competition.teams,
    ]),
  ),
);

const SPORT_CODES = new Set<string>(Object.keys(SPORT_MARKETS));

function isSportCode(value: string): value is SportCode {
  return SPORT_CODES.has(value);
}

function usableRatings(value: unknown): TeamRatings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const ratings: TeamRatings = {};
  for (const [key, rating] of Object.entries(value)) {
    if (typeof rating !== 'number' || !Number.isFinite(rating)) return null;
    ratings[key] = rating;
  }
  return Object.keys(ratings).length === 0 ? null : ratings;
}

/**
 * Builds the MockFeedProvider's competitions and team pools from the
 * catalogue: active competitions of active sports, each with its teams and
 * their current ratings (as edited in the back office).
 *
 * A competition's pool is the seeded team list (teams missing from the
 * database are skipped). A competition added later in the back office gets
 * the teams of its sport whose country matches its category's. Teams without
 * usable ratings get DEFAULT_TEAM_RATINGS. Competitions with fewer than two
 * teams are left out, as is a competition whose slug another sport already
 * uses (pools are keyed by slug alone).
 */
export async function loadFeedTeams(db: DbExecutor): Promise<FeedTeamsConfig> {
  const competitionRows = await db
    .select({
      sportId: competitions.sportId,
      slug: competitions.slug,
      featured: competitions.featured,
      countryCode: categories.countryCode,
    })
    .from(competitions)
    .innerJoin(categories, eq(categories.id, competitions.categoryId))
    .innerJoin(sports, eq(sports.id, competitions.sportId))
    .where(and(eq(competitions.active, true), eq(sports.active, true)))
    .orderBy(
      asc(sports.sortOrder),
      asc(categories.sortOrder),
      asc(competitions.sortOrder),
      asc(competitions.slug),
    );
  const teamRows = await db
    .select({
      sportId: teams.sportId,
      shortName: teams.shortName,
      countryCode: teams.countryCode,
      ratings: teams.ratings,
    })
    .from(teams)
    .orderBy(asc(teams.sportId), asc(teams.shortName));

  const teamsBySport = new Map<string, Map<string, (typeof teamRows)[number]>>();
  for (const team of teamRows) {
    let bySport = teamsBySport.get(team.sportId);
    if (bySport === undefined) {
      bySport = new Map();
      teamsBySport.set(team.sportId, bySport);
    }
    bySport.set(team.shortName, team);
  }

  const config: FeedTeamsConfig = { competitions: [], teams: {} };
  for (const competition of competitionRows) {
    const sport = competition.sportId;
    if (!isSportCode(sport) || Object.hasOwn(config.teams, competition.slug)) continue;
    const sportTeams = teamsBySport.get(sport) ?? new Map<string, (typeof teamRows)[number]>();
    const seeded = SEEDED_POOLS.get(`${sport}/${competition.slug}`);
    const members =
      seeded === undefined
        ? competition.countryCode === null
          ? []
          : [...sportTeams.values()].filter((team) => team.countryCode === competition.countryCode)
        : seeded.flatMap((shortName) => {
            const team = sportTeams.get(shortName);
            return team === undefined ? [] : [team];
          });
    if (members.length < 2) continue;
    config.competitions.push({ slug: competition.slug, sport, featured: competition.featured });
    config.teams[competition.slug] = members.map((team) => ({
      shortName: team.shortName,
      ratings: usableRatings(team.ratings) ?? { ...DEFAULT_TEAM_RATINGS[sport] },
    }));
  }
  return config;
}
