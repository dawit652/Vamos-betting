import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countryCodeOfName } from './countrycodes';

// The same rule as apps/web/src/lib/flag.ts flagEmoji, which is not importable from core: a code is
// a real flag when it is two letters or one of the four UK nation codes.
const flagCode = /^([A-Z]{2}|GB-ENG|GB-SCT|GB-WLS|GB-NIR)$/;

describe('countryCodeOfName', () => {
  it.each([
    ['England', 'GB-ENG'],
    ['Scotland', 'GB-SCT'],
    ['Wales', 'GB-WLS'],
    ['Northern Ireland', 'GB-NIR'],
    ['Spain', 'ES'],
    ['Ethiopia', 'ET'],
    ['USA', 'US'],
    ['United States', 'US'],
    ['Korea Republic', 'KR'],
    ['South Korea', 'KR'],
    ['Korea DPR', 'KP'],
    ['North Korea', 'KP'],
    ['Côte d’Ivoire', 'CI'],
    ["Cote d'Ivoire", 'CI'],
    ['Ivory Coast', 'CI'],
    ['Czech Republic', 'CZ'],
    ['Czechia', 'CZ'],
    ['Bosnia & Herzegovina', 'BA'],
    ['Bosnia and Herzegovina', 'BA'],
    ['Republic of Ireland', 'IE'],
    ['Ireland', 'IE'],
    ['Türkiye', 'TR'],
    ['Turkey', 'TR'],
    ['Chinese Taipei', 'TW'],
    ['Hong Kong', 'HK'],
    ['Macau', 'MO'],
    ['Kosovo', 'XK'],
    ['Faroe Islands', 'FO'],
    ['Congo DR', 'CD'],
    ['DR Congo', 'CD'],
    ['Congo', 'CG'],
    ['Cape Verde', 'CV'],
    ['Eswatini', 'SZ'],
    ['Swaziland', 'SZ'],
    ['Russia', 'RU'],
    ['Iran', 'IR'],
    ['Vietnam', 'VN'],
    ['Moldova', 'MD'],
    ['Syria', 'SY'],
    ['Tanzania', 'TZ'],
    ['Bolivia', 'BO'],
    ['Venezuela', 'VE'],
    ['Palestine', 'PS'],
    ['Costa Rica', 'CR'],
    ['Europe', 'EU'],
    ['England Amateur', 'GB-ENG'],
    ['Germany Amateur', 'DE'],
    ['Austria Amateur', 'AT'],
    ['Poland U21', 'PL'],
    ['Spain Women', 'ES'],
    ['Brazil Youth', 'BR'],
    ['Italy Reserves Cup', 'IT'],
  ])('%s is %s', (name, code) => {
    expect(countryCodeOfName(name)).toBe(code);
  });

  it('ignores case, accents, punctuation and spacing', () => {
    expect(countryCodeOfName('  ENGLAND ')).toBe('GB-ENG');
    expect(countryCodeOfName('trinidad & tobago')).toBe('TT');
    expect(countryCodeOfName('Guinea-Bissau')).toBe('GW');
    expect(countryCodeOfName('Curaçao')).toBe('CW');
  });

  it('gives null for regions without a flag, and for anything else', () => {
    for (const name of [
      'International',
      'International Youth',
      'International Clubs',
      'World',
      'Youth',
      'Amateur',
      'Africa',
      'Asia',
      'South America',
      'Other',
      '',
      '  ',
    ]) {
      expect(countryCodeOfName(name)).toBeNull();
    }
  });

  it('only gives codes the web turns into a flag, and never throws', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const code = countryCodeOfName(text);
        if (code !== null) expect(code).toMatch(flagCode);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom('Spain', 'Ivory Coast', 'england'),
        fc.string(),
        (name, noise) => {
          // Names with surroundings are not the name: still no throw, null or a valid code.
          const code = countryCodeOfName(`${noise}${name}${noise}`);
          if (code !== null) expect(code).toMatch(flagCode);
        },
      ),
      { numRuns: 200 },
    );
  });
});
