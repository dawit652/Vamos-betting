import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeName } from '@vamos/scraper';
import { describe, expect, it } from 'vitest';
import { CATALOG_TEAMS } from '../../../packages/db/src/seed/catalog';

const DATA_DIR = resolve(__dirname, '../../../docs/scraper-plan/data');
const ALIAS_FILES = [
  'aliases-footballdata-top-leagues.csv',
  'aliases-footballdata-champions-league.csv',
  'aliases-theoddsapi.csv',
];

const FOOTBALL = CATALOG_TEAMS.filter((t) => t.sport === 'football');

/** Global (source-less) alias rows of the three CSVs: [alias, target, file]. */
function readAliases(file: string): Array<[alias: string, target: string]> {
  const lines = readFileSync(resolve(DATA_DIR, file), 'utf8').split(/\r?\n/).filter(Boolean);
  expect(lines[0]).toBe('kind,sport,alias,target,source');
  return lines.slice(1).map((line) => {
    const [kind, sport, alias, target, source] = line.split(',');
    expect([kind, sport, source]).toEqual(['team', 'football', '']);
    return [alias as string, target as string];
  });
}

/** Normal form -> set of catalogue shortNames: global aliases first, then catalogue names. */
function buildIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (raw: string, target: string) => {
    const key = normalizeName(raw);
    const set = index.get(key) ?? new Set<string>();
    set.add(target);
    index.set(key, set);
  };
  for (const file of ALIAS_FILES)
    for (const [alias, target] of readAliases(file)) add(alias, target);
  for (const team of FOOTBALL) {
    add(team.shortName, team.shortName);
    for (const name of Object.values(team.name) as string[]) add(name, team.shortName);
  }
  return index;
}

/** Spelling as The Odds API writes it -> catalogue shortName. */
const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  // Premier League
  ['Arsenal', 'Arsenal'],
  ['Aston Villa', 'Aston Villa'],
  ['Bournemouth', 'Bournemouth'],
  ['Brentford', 'Brentford'],
  ['Brighton and Hove Albion', 'Brighton'],
  ['Burnley', 'Burnley'],
  ['Chelsea', 'Chelsea'],
  ['Coventry City', 'Coventry'],
  ['Crystal Palace', 'Crystal Palace'],
  ['Everton', 'Everton'],
  ['Fulham', 'Fulham'],
  ['Hull City', 'Hull'],
  ['Ipswich Town', 'Ipswich'],
  ['Leeds United', 'Leeds'],
  ['Liverpool', 'Liverpool'],
  ['Manchester City', 'Man City'],
  ['Manchester United', 'Man Utd'],
  ['Newcastle United', 'Newcastle'],
  ['Nottingham Forest', "Nott'm Forest"],
  ['Sunderland', 'Sunderland'],
  ['Tottenham Hotspur', 'Tottenham'],
  ['West Ham United', 'West Ham'],
  ['Wolverhampton Wanderers', 'Wolves'],
  // Bundesliga
  ['Augsburg', 'Augsburg'],
  ['Bayer Leverkusen', 'Leverkusen'],
  ['Bayern Munich', 'Bayern'],
  ['Borussia Dortmund', 'Dortmund'],
  ['Borussia Monchengladbach', 'Gladbach'],
  ['Eintracht Frankfurt', 'Frankfurt'],
  ['Elversberg', 'Elversberg'],
  ['FSV Mainz 05', 'Mainz'],
  ['Hamburger SV', 'Hamburg'],
  ['RB Leipzig', 'RB Leipzig'],
  ['SC Freiburg', 'Freiburg'],
  ['SC Paderborn', 'Paderborn'],
  ['TSG Hoffenheim', 'Hoffenheim'],
  ['Union Berlin', 'Union Berlin'],
  ['VfB Stuttgart', 'Stuttgart'],
  ['VfL Wolfsburg', 'Wolfsburg'],
  ['Werder Bremen', 'Werder Bremen'],
  ['1. FC Köln', 'Koln'],
  ['FC Schalke 04', 'Schalke'],
  // La Liga
  ['Alavés', 'Alaves'],
  ['Athletic Bilbao', 'Athletic Club'],
  ['Atlético Madrid', 'Atletico Madrid'],
  ['Barcelona', 'Barcelona'],
  ['CA Osasuna', 'Osasuna'],
  ['Celta Vigo', 'Celta Vigo'],
  ['Deportivo La Coruña', 'Deportivo'],
  ['Elche CF', 'Elche'],
  ['Espanyol', 'Espanyol'],
  ['Getafe', 'Getafe'],
  ['Girona', 'Girona'],
  ['Levante', 'Levante'],
  ['Málaga', 'Malaga'],
  ['Rayo Vallecano', 'Rayo Vallecano'],
  ['Real Betis', 'Real Betis'],
  ['Real Madrid', 'Real Madrid'],
  ['Real Racing Club de Santander', 'Racing Santander'],
  ['Real Sociedad', 'Real Sociedad'],
  ['Sevilla', 'Sevilla'],
  ['Valencia', 'Valencia'],
  ['Villarreal', 'Villarreal'],
  // Serie A
  ['AC Milan', 'AC Milan'],
  ['AS Roma', 'Roma'],
  ['Atalanta BC', 'Atalanta'],
  ['Bologna', 'Bologna'],
  ['Cagliari', 'Cagliari'],
  ['Como', 'Como'],
  ['Fiorentina', 'Fiorentina'],
  ['Frosinone', 'Frosinone'],
  ['Genoa', 'Genoa'],
  ['Inter Milan', 'Inter'],
  ['Juventus', 'Juventus'],
  ['Lazio', 'Lazio'],
  ['Lecce', 'Lecce'],
  ['Monza', 'Monza'],
  ['Napoli', 'Napoli'],
  ['Parma', 'Parma'],
  ['Sassuolo', 'Sassuolo'],
  ['Torino', 'Torino'],
  ['Udinese', 'Udinese'],
  ['Venezia', 'Venezia'],
  // Ligue 1
  ['Angers', 'Angers'],
  ['AS Monaco', 'Monaco'],
  ['Auxerre', 'Auxerre'],
  ['Brest', 'Brest'],
  ['Le Havre', 'Le Havre'],
  ['Le Mans', 'Le Mans'],
  ['Lille', 'Lille'],
  ['Lorient', 'Lorient'],
  ['Lyon', 'Lyon'],
  ['Marseille', 'Marseille'],
  ['Nantes', 'Nantes'],
  ['Nice', 'Nice'],
  ['Paris FC', 'Paris FC'],
  ['Paris Saint Germain', 'PSG'],
  ['RC Lens', 'Lens'],
  ['Rennes', 'Rennes'],
  ['Strasbourg', 'Strasbourg'],
  ['Toulouse', 'Toulouse'],
  ['Troyes', 'Troyes'],
];

describe('The Odds API club spellings', () => {
  const index = buildIndex();

  it.each(SPELLINGS)('%s resolves to exactly one team, %s', (spelling, target) => {
    const found = index.get(normalizeName(spelling));
    expect(found ? [...found] : []).toEqual([target]);
  });

  it('covers every football club of the five leagues', () => {
    const covered = new Set(SPELLINGS.map(([, target]) => target));
    const fiveLeagues = FOOTBALL.filter((t) =>
      ['GB-ENG', 'ES', 'IT', 'DE', 'FR'].includes(t.countryCode ?? ''),
    );
    expect(fiveLeagues.map((t) => t.shortName).filter((s) => !covered.has(s))).toEqual([]);
  });

  it('resolves the spot checks', () => {
    const one = (name: string) => [...(index.get(normalizeName(name)) ?? [])];
    expect(one('Bayern Munich')).toEqual(['Bayern']);
    expect(one('Inter Milan')).toEqual(['Inter']);
    expect(one('Athletic Bilbao')).toEqual(['Athletic Club']);
    expect(one('FSV Mainz 05')).toEqual(['Mainz']);
    expect(one('Paris Saint Germain')).toEqual(['PSG']);
  });

  it('only aliases to existing football shortNames', () => {
    const shortNames = new Set(FOOTBALL.map((t) => t.shortName));
    const targets = ALIAS_FILES.flatMap(readAliases).map(([, target]) => target);
    expect(targets.filter((t) => !shortNames.has(t))).toEqual([]);
  });

  it('has no duplicate aliases in the Odds API file', () => {
    const keys = readAliases('aliases-theoddsapi.csv').map(([alias]) => normalizeName(alias));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives no two catalogue football teams the same normal form', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const team of FOOTBALL) {
      for (const raw of [team.shortName, ...(Object.values(team.name) as string[])]) {
        const key = normalizeName(raw);
        const prior = owner.get(key);
        if (prior !== undefined && prior !== team.shortName)
          clashes.push(`${key}: ${prior}/${team.shortName}`);
        owner.set(key, team.shortName);
      }
    }
    expect(clashes).toEqual([]);
  });
});
