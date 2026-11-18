import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { amharicName, transliterate } from './amharic-names';
import { AMHARIC_CLUB_NAMES, AMHARIC_NAMES } from './amharic-names.data';

describe('amharicName', () => {
  it('gives every dictionary spelling its Amharic', () => {
    for (const [amharic, ...spellings] of [...AMHARIC_NAMES, ...AMHARIC_CLUB_NAMES]) {
      for (const spelling of spellings) expect(amharicName(spelling), spelling).toBe(amharic);
    }
  });

  it('finds countries and competitions inside a longer name', () => {
    expect(amharicName('Premier League (England)')).toBe('ፕሪሚየር ሊግ (እንግሊዝ)');
    expect(amharicName('2. Bundesliga')).toBe('2. ቡንደስሊጋ');
    expect(amharicName('Manchester United U21')).toBe('ማንቸስተር ዩናይትድ ከ21 ዓመት በታች');
  });

  it('takes a one-word club name only as the whole name, or with a team suffix', () => {
    expect(amharicName('Inter')).toBe('ኢንተር ሚላን');
    expect(amharicName('Inter Miami')).toBe('ኢንተር ሚያሚ');
    expect(amharicName('Newcastle Jets')).toBe('ኒውካስል ጄትስ');
    expect(amharicName('Barcelona B')).toBe('ባርሴሎና ቢ');
    expect(amharicName('Arsenal Women')).toBe('አርሰናል ሴቶች');
    expect(amharicName('Al Ahly SC')).toBe('አል አህሊ');
  });

  it('translates football words and spells abbreviations', () => {
    expect(amharicName('U20 Friendly Games')).toBe('ከ20 ዓመት በታች የወዳጅነት ጨዋታዎች');
    expect(amharicName('International Youth')).toBe('ዓለም አቀፍ ወጣቶች');
    expect(amharicName('Group A')).toBe('ምድብ ኤ');
    expect(amharicName('VfL Bochum')).toBe('ቪኤፍኤል ቦቹም');
    expect(amharicName('Sporting Football Club')).toBe('ስፖርቲንግ ፉትባል ክለብ');
  });

  it('keeps a name that has no Latin letters, and an empty one', () => {
    expect(amharicName('ቅዱስ ጊዮርጊስ')).toBe('ቅዱስ ጊዮርጊስ');
    expect(amharicName('')).toBe('');
  });

  it('property: lower-case words come out in fidel only, the same every time', () => {
    const word = fc.stringMatching(/^[a-z]{1,10}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 4 }), (words) => {
        const name = words.join(' ');
        const amharic = amharicName(name);
        expect(amharic).not.toMatch(/[A-Za-z]/);
        expect(amharic).toMatch(/^[ሀ-፿ ()]*$/);
        expect(amharicName(name)).toBe(amharic);
      }),
    );
  });

  it('property: numbers in a name are kept', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{2,8}$/),
        fc.integer({ min: 1, max: 9999 }),
        (word, n) => {
          expect(amharicName(`${word} ${n}`)).toContain(String(n));
        },
      ),
    );
  });
});

describe('transliterate', () => {
  it('writes names by their sound the way Amharic writes them', () => {
    const cases: [string, string][] = [
      ['Liverpool', 'ሊቨርፑል'],
      ['Arsenal', 'አርሰናል'],
      ['Brighton', 'ብራይተን'],
      ['Everton', 'ኤቨርተን'],
      ['Tottenham', 'ቶተንሃም'],
      ['Fulham', 'ፉልሃም'],
      ['Bologna', 'ቦሎኛ'],
      ['Leipzig', 'ላይፕዚግ'],
      ['Leverkusen', 'ሌቨርኩሰን'],
      ['Fiorentina', 'ፊዮረንቲና'],
      ['Galatasaray', 'ጋላታሳራይ'],
      ['Hotspur', 'ሆትስፑር'],
      ['Newcastle', 'ኒውካስል'],
      ['Chelsea', 'ቼልሲ'],
      // Accented: not English, so no English-only rule (-don stays -ዶን).
      ['Zeledón', 'ዜለዶን'],
      ['Señor', 'ሴኞር'],
    ];
    for (const [english, amharic] of cases) expect(transliterate(english), english).toBe(amharic);
  });
});
