import { describe, expect, it } from 'vitest';
import {
  BARCODE_QUIET_MODULES,
  barcodeLayout,
  formatOddsMilli,
  legReasonText,
  newTicketKey,
  parsePickText,
  refusalText,
  ticketPath,
} from './tickets';

describe('parsePickText', () => {
  it('reads one Game ID and pick per line', () => {
    expect(parsePickText('81492 1\n69404 x\r\n5512  ov25\n')).toEqual({
      picks: [
        { gameId: 81492, pick: '1' },
        { gameId: 69404, pick: 'X' },
        { gameId: 5512, pick: 'OV25' },
      ],
      invalid: [],
    });
  });

  it('pairs several on one line and reports what it cannot read', () => {
    const result = parsePickText('1 1 2 X\nabc 1\n77\n0 1');
    expect(result.picks).toEqual([
      { gameId: 1, pick: '1' },
      { gameId: 2, pick: 'X' },
    ]);
    expect(result.invalid).toEqual(['abc 1', '77', '0 1']);
  });

  it('is empty for blank text', () => {
    expect(parsePickText('  \n ')).toEqual({ picks: [], invalid: [] });
  });
});

describe('formatOddsMilli', () => {
  it('shows two decimals, dropping the third', () => {
    expect(formatOddsMilli(1850)).toBe('1.85');
    expect(formatOddsMilli(1009)).toBe('1.00');
    expect(formatOddsMilli('12345678')).toBe('12345.67');
    expect(formatOddsMilli(null)).toBe('–');
    expect(formatOddsMilli('x')).toBe('–');
  });
});

describe('ticket keys and paths', () => {
  it('makes a key the API accepts', () => {
    expect(newTicketKey(() => '1b4e28ba-2fa1-11d2-883f-0016d3cca427')).toMatch(
      /^ticket-[A-Za-z0-9_-]{8,}$/,
    );
    expect(newTicketKey()).not.toBe(newTicketKey());
  });

  it('builds the ticket path', () => {
    expect(ticketPath('abc')).toBe('/ticket/abc');
    expect(ticketPath('abc', true)).toBe('/ticket/abc?print=1');
  });
});

describe('texts', () => {
  it('names a refusal and falls back to the code', () => {
    expect(refusalText('game_not_found')).toMatch(/Game ID/);
    expect(refusalText('odd_thing')).toBe('odd thing');
    expect(legReasonText(null)).toBe('');
    expect(legReasonText('event_started')).toMatch(/Started/);
  });
});

describe('barcodeLayout', () => {
  it('puts a quiet zone either side and keeps bars on the module grid', () => {
    const layout = barcodeLayout('ABC12345', 2);
    const quiet = BARCODE_QUIET_MODULES * 2;
    const first = layout.rects[0]!;
    const last = layout.rects[layout.rects.length - 1]!;
    expect(first.x).toBe(quiet);
    expect(layout.width).toBe(last.x + last.width + quiet);
    for (const rect of layout.rects) {
      expect((rect.x - quiet) % 2).toBe(0);
      expect(rect.width % 2).toBe(0);
    }
    for (let i = 1; i < layout.rects.length; i += 1) {
      const before = layout.rects[i - 1]!;
      expect(layout.rects[i]!.x).toBeGreaterThan(before.x + before.width);
    }
  });

  it('refuses text Code 128 set B cannot hold', () => {
    expect(() => barcodeLayout('')).toThrow();
  });
});
