import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { legalFormStripped, nameTokens, normalizeName } from './name';

describe('N1 normalizeName', () => {
  it.each([
    ['Manchester United FC', 'manchester united'],
    ['FC Barcelona', 'barcelona'],
    ['AFC Bournemouth', 'bournemouth'],
    ['Brighton & Hove Albion', 'brighton and hove albion'],
    ['  Real   Madrid  CF ', 'real madrid'],
    ['St. Pauli', 'st pauli'],
    ["Newell's Old Boys", 'newells old boys'],
    ['Stoke-on-Trent', 'stoke on trent'],
    ['Paris Saint-Germain', 'paris saint germain'],
    ['Atlético Madrid', 'atletico madrid'],
    ['1. FC Köln', '1 fc koln'],
    ['FC Bayern München', 'bayern munchen'],
  ])('N1 %s -> %s', (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  it('N1 folds letters that do not decompose', () => {
    expect(normalizeName('Ødegaard')).toBe('odegaard');
    expect(normalizeName('Hajduk Đ')).toBe('hajduk d');
    expect(normalizeName('Łódź')).toBe('lodz');
    expect(normalizeName('Straße')).toBe('strasse');
    expect(normalizeName('STRASSE')).toBe('strasse');
    expect(normalizeName('Æsir')).toBe('aesir');
  });

  it('N1 is locale independent for Turkish i', () => {
    expect(normalizeName('İstanbul')).toBe('istanbul');
    expect(normalizeName('ISTANBUL')).toBe('istanbul');
    expect(normalizeName('Kasımpaşa')).toBe('kasimpasa');
    expect(normalizeName('KASIMPAŞA')).toBe('kasimpasa');
    expect(normalizeName('Başakşehir FK')).toBe('basaksehir fk');
  });

  it('N1 keeps Amharic and other scripts', () => {
    expect(normalizeName('ኢትዮጵያ ቡና')).toBe('ኢትዮጵያ ቡና');
    expect(normalizeName('ቅዱስ ጊዮርጊስ፡ ስፖርት ክለብ')).toBe('ቅዱስ ጊዮርጊስ ስፖርት ክለብ');
    expect(normalizeName('Спартак Москва')).toBe('спартак москва');
    expect(normalizeName('浦和レッズ')).toBe('浦和レッズ');
    expect(normalizeName('सुदेवा एफसी')).toBe('सुदेवा एफसी');
  });

  it('N1 drops affix tokens only at the start or end', () => {
    expect(normalizeName('Sporting CF Madrid')).toBe('sporting cf madrid');
    expect(normalizeName('FC Sporting FC')).toBe('sporting');
    expect(normalizeName('SC Freiburg')).toBe('freiburg');
    expect(normalizeName('Eintracht BSC')).toBe('eintracht');
    expect(normalizeName('FC FC Porto CF')).toBe('porto');
    expect(normalizeName('Cfc London')).toBe('cfc london');
    expect(normalizeName('Fcb')).toBe('fcb');
  });

  it('N1 never reduces a name to nothing because of an affix', () => {
    expect(normalizeName('FC')).toBe('fc');
    expect(normalizeName('FC FC')).toBe('fc');
    expect(normalizeName('afc sc')).toBe('sc');
  });

  it('N1 empty and punctuation-only input is the empty string', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName('...---!!!')).toBe('');
    expect(normalizeName('​‍')).toBe('');
  });

  it('N1 compatibility forms and invisible characters', () => {
    expect(normalizeName('ＦＣ Ｂａｒｃｅｌｏｎａ')).toBe('barcelona');
    expect(normalizeName('Ma​n Utd')).toBe('man utd');
    expect(normalizeName('Café')).toBe('cafe');
  });

  it('N1 nameTokens', () => {
    expect(nameTokens('')).toEqual([]);
    expect(nameTokens('real madrid')).toEqual(['real', 'madrid']);
  });

  const tricky = fc
    .array(
      fc.constantFrom(
        'FC',
        'cf',
        'SC',
        'afc',
        'BSC',
        ' ',
        '  ',
        '&',
        '-',
        "'",
        '.',
        'İ',
        'ı',
        'I',
        'ß',
        'ẞ',
        'ø',
        'Ł',
        'é',
        'é',
        'ǅ',
        'ﬁ',
        'Σ',
        'ς',
        'ΐ',
        'ኢ',
        '፡',
        '​',
        '̇',
        'x',
        '9',
        '한',
        '한',
        '\ud800',
        '😀',
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join(''));

  it('N1 property: idempotent', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          tricky,
          fc.string({ unit: 'binary', maxLength: 40 }),
          fc.string({ unit: 'grapheme', maxLength: 30 }),
        ),
        (raw) => {
          const once = normalizeName(raw);
          expect(normalizeName(once)).toBe(once);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('N1 property: total, trimmed, single-spaced, lower-case, no punctuation', () => {
    fc.assert(
      fc.property(fc.oneof(tricky, fc.string({ unit: 'binary', maxLength: 40 })), (raw) => {
        const out = normalizeName(raw);
        expect(out).toBe(out.trim());
        expect(out).not.toContain('  ');
        expect(out).toBe(out.toLowerCase());
        expect(/[^\p{L}\p{N}\p{M} ]/u.test(out)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('N1 property: case, spacing and surrounding punctuation do not matter', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}( [a-z]{1,8}){0,3}$/), (name) => {
        const base = normalizeName(name);
        expect(normalizeName(name.toUpperCase())).toBe(base);
        expect(normalizeName(`  ${name.replace(/ /g, '   ')} . `)).toBe(base);
      }),
    );
  });
});

describe('N1b legalFormStripped', () => {
  it('takes the legal form off at either end, and a sponsor prefix at the start', () => {
    for (const [raw, stripped] of [
      ['Beşiktaş JK', 'besiktas'],
      ['Falkirk F.C.', 'falkirk'],
      ['A.S. Roma', 'roma'],
      ['1. FSV Mainz 05', 'mainz 05'],
      ['VfB Stuttgart', 'stuttgart'],
      ['Çorum FK', 'corum'],
      ['Erzurum BB', 'erzurum'],
      ['Torku Konyaspor', 'konyaspor'],
      ['Gazişehir Gaziantep', 'gaziantep'],
      // Nothing to take off, or only in the middle.
      ['Atletico Madrid', 'atletico madrid'],
      ['Sporting CP', 'sporting cp'],
      ['Real Sociedad B', 'real sociedad b'],
      // The last remaining token stays.
      ['FK', 'fk'],
      ['JK SK', 'sk'],
    ] as const) {
      expect(legalFormStripped(normalizeName(raw)), raw).toBe(stripped);
    }
    expect(legalFormStripped('')).toBe('');
  });

  it('is idempotent, keeps a token of a non-empty name, and only removes tokens (property)', () => {
    const token = fc.constantFrom(
      'a',
      'b',
      'c',
      'fk',
      'sk',
      'as',
      '1',
      'torku',
      'roma',
      'real',
      '05',
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 8 }), (tokens) => {
        const norm = normalizeName(tokens.join(' '));
        const once = legalFormStripped(norm);
        expect(legalFormStripped(once)).toBe(once);
        if (norm !== '') expect(once).not.toBe('');
        expect(once.replaceAll(' ', '').length).toBeLessThanOrEqual(
          norm.replaceAll(' ', '').length,
        );
      }),
    );
  });
});
