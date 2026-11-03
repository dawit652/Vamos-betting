import { describe, expect, it } from 'vitest';
import realSports from './fixtures/real/sports.json';
import { leagueFor, type LeagueEntry } from './leagues';
import { parseSports } from './schema';

const sports = parseSports(realSports).items;
const entries = sports.flatMap((s) => {
  const entry = leagueFor(s);
  return entry === null ? [] : [entry];
});
const byKey = (key: string): LeagueEntry => {
  const entry = entries.find((e) => e.sportKey === key);
  if (entry === undefined) throw new Error(`no entry for ${key}`);
  return entry;
};

describe('leagueFor on the real sports list', () => {
  it('places every non-outright football, basketball and tennis sport', () => {
    const wanted = sports.filter(
      (s) =>
        ['Soccer', 'Basketball', 'Tennis'].includes(s.group) &&
        !s.hasOutrights &&
        !s.key.endsWith('_winner'),
    );
    expect(wanted.length).toBeGreaterThan(50);
    for (const s of wanted) expect(leagueFor(s), s.key).not.toBeNull();
  });

  it.each([
    ['soccer_austria_bundesliga', 'austria', 'AT'],
    ['soccer_brazil_serie_b', 'brazil', 'BR'],
    ['soccer_denmark_superliga', 'denmark', 'DK'],
    ['soccer_japan_j_league', 'japan', 'JP'],
    ['soccer_korea_kleague1', 'south-korea', 'KR'],
    ['soccer_mexico_ligamx', 'mexico', 'MX'],
    ['soccer_australia_aleague', 'australia', 'AU'],
    ['soccer_switzerland_superleague', 'switzerland', 'CH'],
    ['soccer_league_of_ireland', 'ireland', 'IE'],
    ['soccer_china_superleague', 'china', 'CN'],
    ['soccer_russia_premier_league', 'russia', 'RU'],
    ['soccer_germany_dfb_pokal', 'germany', 'DE'],
    ['soccer_spain_copa_del_rey', 'spain', 'ES'],
    ['soccer_france_coupe_de_france', 'france', 'FR'],
    ['soccer_italy_coppa_italia', 'italy', 'IT'],
    ['soccer_spl', 'scotland', 'GB-SCT'],
    ['soccer_england_efl_cup', 'england', 'GB-ENG'],
    ['soccer_uefa_champs_league_women', 'international-clubs', null],
    ['soccer_uefa_european_championship', 'international', null],
    ['soccer_fifa_world_cup_qualifiers_europe', 'international', null],
    ['soccer_conmebol_copa_sudamericana', 'south-america', null],
    ['soccer_conmebol_copa_america', 'international', null],
    ['soccer_concacaf_gold_cup', 'north-central-america', null],
    ['soccer_concacaf_leagues_cup', 'north-central-america', null],
    ['basketball_nba_summer_league', 'usa', 'US'],
    ['basketball_wncaab', 'usa', 'US'],
  ])('%s → %s', (key, slug, countryCode) => {
    expect(byKey(key).category).toMatchObject({ slug, countryCode });
  });

  it('gives every country in the table a flag and an Amharic name', () => {
    const countries = entries.filter(
      (e) => e.sport === 'football' && e.category.countryCode !== null,
    );
    expect(countries.length).toBeGreaterThan(40);
    for (const e of countries) expect(e.category.name.am, e.sportKey).toBeTruthy();
    for (const key of [
      'soccer_austria_bundesliga',
      'soccer_chile_campeonato',
      'soccer_finland_veikkausliiga',
      'soccer_greece_super_league',
      'soccer_sweden_superettan',
      'soccer_poland_ekstraklasa',
    ]) {
      expect(byKey(key).category.countryCode, key).not.toBeNull();
    }
  });

  it('never gives two different categories one slug within a sport', () => {
    const seen = new Map<string, unknown>();
    for (const e of entries) {
      const id = `${e.sport}/${e.category.slug}`;
      const prior = seen.get(id);
      if (prior !== undefined) expect(e.category, e.sportKey).toEqual(prior);
      seen.set(id, e.category);
    }
  });

  it('flags knockout cups only', () => {
    for (const key of [
      'soccer_germany_dfb_pokal',
      'soccer_spain_copa_del_rey',
      'soccer_conmebol_copa_libertadores',
      'soccer_concacaf_gold_cup',
    ]) {
      expect(byKey(key).cup, key).toBe(true);
    }
    for (const key of ['soccer_epl', 'soccer_japan_j_league', 'soccer_mexico_ligamx']) {
      expect(byKey(key).cup, key).toBe(false);
    }
  });
});
