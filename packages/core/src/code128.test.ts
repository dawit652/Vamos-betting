import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CODE128_PATTERNS,
  code128Bars,
  code128Modules,
  code128Values,
  isCode128Text,
} from './code128';

/** Reads modules back to text (a scanner's job), checking start, check symbol and stop. */
function decode(modules: string): string {
  const widths: number[] = [];
  for (let i = 0; i < modules.length;) {
    let j = i;
    while (j < modules.length && modules[j] === modules[i]) j += 1;
    widths.push(j - i);
    i = j;
  }
  const symbols: number[] = [];
  let at = 0;
  while (at < widths.length) {
    const size = widths.length - at === 7 ? 7 : 6;
    const pattern = widths.slice(at, at + size).join('');
    const value = CODE128_PATTERNS.indexOf(pattern);
    if (value < 0) throw new Error(`unknown pattern ${pattern}`);
    symbols.push(value);
    at += size;
  }
  expect(symbols[0]).toBe(104);
  expect(symbols.at(-1)).toBe(106);
  const data = symbols.slice(1, -2);
  const check = symbols.at(-2)!;
  const sum = data.reduce((acc, value, i) => acc + value * (i + 1), 104);
  expect(sum % 103).toBe(check);
  return String.fromCharCode(...data.map((value) => value + 32));
}

describe('Code 128', () => {
  it('has the standard table: 107 distinct symbols of 11 modules, the stop of 13', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const modules = [...pattern].reduce((sum, w) => sum + Number(w), 0);
      expect(modules, String(value)).toBe(value === 106 ? 13 : 11);
    });
    // Spot checks against the published table.
    expect(CODE128_PATTERNS[0]).toBe('212222'); // space
    expect(CODE128_PATTERNS[33]).toBe('111323'); // 'A'
    expect(CODE128_PATTERNS[104]).toBe('211214'); // start B
    expect(CODE128_PATTERNS[106]).toBe('2331112'); // stop
  });

  it('encodes with start B, the weighted check symbol and the stop', () => {
    // "AB": 104 + 33·1 + 34·2 = 205 → 205 mod 103 = 102.
    expect(code128Values('AB')).toEqual([104, 33, 34, 102, 106]);
    const modules = code128Modules('AB');
    expect(modules.length).toBe(11 * 4 + 13);
    expect(modules.startsWith('11010010000')).toBe(true); // start B: 211214
    expect(modules.endsWith('1100011101011')).toBe(true); // stop: 2331112
    expect(code128Bars('AB').reduce((n, [, w]) => n + w, 0)).toBe(modules.split('1').length - 1);
  });

  it('refuses what set B cannot draw', () => {
    for (const bad of ['', 'é', 'a\nb', 'x'.repeat(81)]) {
      expect(isCode128Text(bad)).toBe(false);
      expect(() => code128Modules(bad)).toThrow(RangeError);
    }
  });

  it('a scanner reads back exactly the text drawn', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[\x20-\x7e]{1,40}$/), (text) => {
        expect(decode(code128Modules(text))).toBe(text);
      }),
    );
  });
});
