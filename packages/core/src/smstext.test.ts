import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cleanSmsText,
  fitLength,
  fitSms,
  isGsm7,
  MAX_SMS_SEGMENTS,
  smsEncoding,
  smsInfo,
  smsSegments,
  smsUnits,
  USSD_MAX_LENGTH,
} from './smstext';

const AMHARIC = 'ሀ';
const EMOJI = '😀';

/** True when the string holds a UTF-16 surrogate without its pair. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('SMS encoding', () => {
  it('sends the GSM 03.38 alphabet in 7 bits and anything else in UCS-2', () => {
    expect(isGsm7('Nahubet: Bet ABCD2345 placed. Odds 3.70, ETB 50.00!')).toBe(true);
    expect(isGsm7('@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà\n\r')).toBe(true);
    expect(isGsm7('€[]{}^~|\\')).toBe(true);
    expect(smsEncoding('ቀሪ ሂሳብ')).toBe('ucs2');
    expect(smsEncoding(`balance ${EMOJI}`)).toBe('ucs2');
    // Characters outside GSM-7 that look harmless: curly quotes, the ellipsis, accented capitals.
    for (const char of ['“', '’', '…', 'Á', 'ç', '\t', '`']) expect(isGsm7(char)).toBe(false);
  });

  it('counts extension characters as two septets and UCS-2 in code units', () => {
    expect(smsUnits('abc')).toBe(3);
    expect(smsUnits('€{}')).toBe(6);
    expect(smsUnits(`${AMHARIC}${AMHARIC}`)).toBe(2);
    expect(smsUnits(`a${EMOJI}`)).toBe(3);
    expect(smsInfo('ETB €5')).toEqual({ encoding: 'gsm7', units: 7, segments: 1 });
  });

  it('splits at 160 / 153 septets and 70 / 67 code units', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('a'.repeat(459))).toBe(3);
    expect(smsSegments('a'.repeat(460))).toBe(4);
    expect(smsSegments(AMHARIC.repeat(70))).toBe(1);
    expect(smsSegments(AMHARIC.repeat(71))).toBe(2);
    expect(smsSegments(AMHARIC.repeat(134))).toBe(2);
    expect(smsSegments(AMHARIC.repeat(135))).toBe(3);
    expect(smsSegments(AMHARIC.repeat(201))).toBe(3);
    expect(smsSegments(AMHARIC.repeat(202))).toBe(4);
    // One non-GSM character turns the whole message into UCS-2.
    expect(smsSegments(`${'a'.repeat(100)}${AMHARIC}`)).toBe(2);
    expect(smsSegments('€'.repeat(80))).toBe(1);
    expect(smsSegments('€'.repeat(81))).toBe(2);
  });

  it('never splits an escape sequence or a surrogate pair across parts', () => {
    // 152 + 2 + 152 = 306 septets: two parts by count, but the € cannot straddle the boundary.
    expect(smsSegments(`${'a'.repeat(152)}€${'a'.repeat(152)}`)).toBe(3);
    expect(smsSegments(`${'a'.repeat(151)}€${'a'.repeat(153)}`)).toBe(2);
    // 66 + 2 + 66 = 134 code units: two parts by count, but the emoji cannot straddle.
    expect(smsSegments(`${AMHARIC.repeat(66)}${EMOJI}${AMHARIC.repeat(66)}`)).toBe(3);
    expect(smsSegments(`${AMHARIC.repeat(65)}${EMOJI}${AMHARIC.repeat(67)}`)).toBe(2);
  });
});

describe('fitSms', () => {
  it('keeps a text that fits and cuts one that does not, with an ellipsis', () => {
    expect(fitSms('short')).toBe('short');
    const long = 'word '.repeat(200);
    const fitted = fitSms(long);
    expect(smsSegments(fitted)).toBeLessThanOrEqual(MAX_SMS_SEGMENTS);
    expect(fitted.endsWith('...')).toBe(true);
    expect(long.startsWith(fitted.slice(0, -3))).toBe(true);
    expect(smsSegments(fitSms(long, 1))).toBe(1);
    const amharic = `${AMHARIC} `.repeat(150);
    const fittedAm = fitSms(amharic);
    expect(fittedAm.endsWith('…')).toBe(true);
    expect(smsSegments(fittedAm)).toBeLessThanOrEqual(MAX_SMS_SEGMENTS);
    expect(() => fitSms('x', 0)).toThrow(RangeError);
  });

  it('fits any text in the parts allowed, as a prefix plus an ellipsis', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 700 }),
          fc.string({ unit: 'binary', maxLength: 400 }),
          fc.string({ unit: 'grapheme', maxLength: 400 }),
        ),
        fc.integer({ min: 1, max: 4 }),
        (text, parts) => {
          const fitted = fitSms(text, parts);
          expect(smsSegments(fitted)).toBeLessThanOrEqual(parts);
          expect(hasLoneSurrogate(fitted)).toBe(hasLoneSurrogate(text) && fitted === text);
          if (fitted !== text) {
            const marker = fitted.endsWith('...') ? '...' : '…';
            expect(fitted.endsWith(marker)).toBe(true);
            expect(text.startsWith(fitted.slice(0, -marker.length))).toBe(true);
          }
        },
      ),
    );
  });
});

describe('fitLength and cleanSmsText', () => {
  it('caps a text at a length in whole code points', () => {
    expect(fitLength('abc', 3)).toBe('abc');
    expect(fitLength('abcdef', 4)).toBe('abc…');
    expect(fitLength(`ab${EMOJI}cd`, 4)).toBe('ab…');
    expect(() => fitLength('x', 0)).toThrow(RangeError);
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 300 }),
        fc.integer({ min: 1, max: USSD_MAX_LENGTH }),
        (text, max) => {
          const out = fitLength(text, max);
          expect(out.length).toBeLessThanOrEqual(max);
          if (text.length <= max) expect(out).toBe(text);
          else expect(hasLoneSurrogate(out)).toBe(false);
        },
      ),
    );
  });

  it('removes control characters but keeps line feeds', () => {
    expect(cleanSmsText('\u0000 hi\tthere\u0007\nnext \u009f')).toBe('hi there \nnext');
  });
});
