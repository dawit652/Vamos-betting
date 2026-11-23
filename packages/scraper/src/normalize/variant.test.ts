import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeName } from './name';
import { suspiciousAlias, variantConflict, variantsOf } from './variant';

describe('L3 variant guard (docs/plans/name-learning.md)', () => {
  it("the reserve, women's and national links of 23 Nov (6 of the 11) are refused", () => {
    const wrong: Array<[string, string, string]> = [
      ['vfl bochum', 'VfL Bochum II', 'reserve'],
      ['pfc cska sofia', 'PFC CSKA SOFIA II', 'reserve'],
      ['sparta prague', 'Sparta Prague B', 'reserve'],
      ['lech poznan', 'Lech II Poznan', 'reserve'],
      ['salzburg', 'FC Salzburg Frauen', 'women'],
      ['ararat armenia', 'Armenia', 'national'],
    ];
    for (const [raw, target, variant] of wrong) {
      expect(variantConflict(raw, [target]), `${raw} -> ${target}`).toBe(variant);
    }
  });

  it('youth and women sides in their usual spellings', () => {
    expect(variantConflict('Leicester City', ['Leicester City U21'])).toBe('youth');
    expect(variantConflict('Santos', ['Santos Sub 20'])).toBe('youth');
    expect(variantConflict('Juventus', ['Juventus Primavera'])).toBe('youth');
    expect(variantConflict('Arsenal', ['Arsenal W', 'Arsenal Women'])).toBe('women');
    expect(variantConflict('Real Madrid', ['Real Madrid Femenino'])).toBe('women');
    expect(variantConflict('Ajax', ['Jong Ajax'])).toBe('reserve');
    expect(variantConflict('Dinamo Minsk', ['Dinamo Minsk 2'])).toBe('reserve');
  });

  it('a name that says it is that side may be linked to it', () => {
    expect(variantConflict('Sparta Prague B', ['Sparta Prague B'])).toBeNull();
    expect(variantConflict('Arsenal Women', ['Arsenal W'])).toBeNull();
    expect(variantConflict('Leicester U21', ['Leicester City U21'])).toBeNull();
    expect(variantConflict('Armenia', ['Armenia'])).toBeNull();
  });

  it('first teams, numbered club names and clubs named after a place are fine', () => {
    expect(variantConflict('salzburg', ['Red Bull Salzburg'])).toBeNull();
    expect(variantConflict('hannover', ['Hannover 96'])).toBeNull();
    expect(variantConflict('schalke', ['FC Schalke 04'])).toBeNull();
    expect(variantConflict('1860 munich', ['TSV 1860 Munich'])).toBeNull();
    expect(variantConflict('monaco', ['AS Monaco', 'Monaco'])).toBeNull();
    expect(variantConflict('dundee utd', ['Dundee United'])).toBeNull();
  });

  it('a single letter is a mark only at the end of a longer name', () => {
    expect([...variantsOf(normalizeName('B36 Torshavn'))]).toEqual([]);
    expect([...variantsOf(normalizeName('B'))]).toEqual([]);
    expect([...variantsOf(normalizeName('Real Madrid B'))]).toEqual(['reserve']);
  });

  it('property: adding the mark to the raw name always lifts the conflict', () => {
    const marks = ['II', 'B', 'U21', 'Women', 'Frauen'];
    fc.assert(
      fc.property(
        fc.constantFrom('Sparta Prague', 'Lech Poznan', 'VfL Bochum', 'Salzburg', 'Leicester City'),
        fc.constantFrom(...marks),
        (club, mark) => {
          const target = `${club} ${mark}`;
          expect(variantConflict(club, [target])).not.toBeNull();
          expect(variantConflict(target, [target])).toBeNull();
        },
      ),
    );
  });
});

describe('L3 daily alias check: suspiciousAlias', () => {
  it('flags the different clubs of 23 Nov that are not a side of the club', () => {
    expect(suspiciousAlias('viktoria plzen', ['FC Viktoria Cologne'])).toBe('other_club');
    expect(suspiciousAlias('red star belgrade', ['Red Star FC'])).toBe('other_club');
    expect(suspiciousAlias('fk borac banja luka', ['FK BSK Banja Luka'])).toBe('other_club');
    expect(suspiciousAlias('inter club descaldes', ["Atletic Club d'Escaldes"])).toBe('other_club');
    expect(suspiciousAlias('sheffield wednesday', ['Sheffield United'])).toBe('other_club');
    expect(suspiciousAlias('salzburg', ['FC Salzburg Frauen'])).toBe('women');
  });

  it('leaves the right links of the report alone', () => {
    const fine: Array<[string, string]> = [
      ['atletico paranaense', 'Athletico Paranaense'],
      ['pae aek', 'AEK Athens FC'],
      ['leuven', 'Oud-Heverlee Leuven'],
      ['cercle brugge ksv', 'Cercle Brugge'],
      ['dundee utd', 'Dundee United'],
      ['union st gilloise', 'Union Saint-Gilloise'],
      ['1899 hoffenheim', 'TSG Hoffenheim'],
      ['ferencvaros tc', 'Ferencvarosi TC'],
      ['olympiakos', 'Olympiacos'],
      ['fc lausanne sport', 'Lausanne'],
      ['nk celje', 'NK SAMPION CELJE'],
    ];
    for (const [alias, team] of fine) expect(suspiciousAlias(alias, [team]), alias).toBeNull();
  });
});
