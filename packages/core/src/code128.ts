/**
 * Code 128 (set B) barcodes for printed shop tickets (docs/plans/agent-shops.md, "Printing"): the
 * page draws the bars as SVG, so no barcode service or font is needed, and a USB scanner reads
 * the ticket number back like a keyboard. Pure.
 */

/** Bar and space widths (in modules) of the 107 Code 128 symbols; 106 is the stop. */
const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212',
  '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221',
  '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221',
  '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321',
  '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131',
  '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131',
  '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242',
  '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311',
  '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]; // prettier-ignore

const START_B = 104;
const STOP = 106;

/** The symbol widths table (exported for tests). */
export const CODE128_PATTERNS = PATTERNS;

/** Whether `text` can be drawn in Code 128 set B: 1 to 80 printable ASCII characters. */
export function isCode128Text(text: string): boolean {
  return text.length >= 1 && text.length <= 80 && /^[\x20-\x7e]+$/.test(text);
}

/** The symbol values of `text`: start B, the characters, the check symbol, the stop. */
export function code128Values(text: string): number[] {
  if (!isCode128Text(text)) {
    throw new RangeError('Code 128 set B takes 1 to 80 printable ASCII characters');
  }
  const values = [START_B, ...Array.from(text, (char) => char.charCodeAt(0) - 32)];
  let sum = START_B;
  for (let i = 1; i < values.length; i += 1) sum += values[i]! * i;
  return [...values, sum % 103, STOP];
}

/**
 * The barcode as modules, '1' a bar and '0' a space, without the quiet zones (draw at least 10
 * modules of white on each side).
 */
export function code128Modules(text: string): string {
  let out = '';
  for (const value of code128Values(text)) {
    const widths = PATTERNS[value]!;
    for (let i = 0; i < widths.length; i += 1) {
      out += (i % 2 === 0 ? '1' : '0').repeat(Number(widths[i]));
    }
  }
  return out;
}

/** The bars of `text` as [start, width] runs in modules (one SVG rect each). */
export function code128Bars(text: string): Array<[number, number]> {
  const modules = code128Modules(text);
  const bars: Array<[number, number]> = [];
  for (let i = 0; i < modules.length; ) {
    if (modules[i] === '1') {
      let j = i;
      while (j < modules.length && modules[j] === '1') j += 1;
      bars.push([i, j - i]);
      i = j;
    } else {
      i += 1;
    }
  }
  return bars;
}
