import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_SETTINGS,
  parsePrintSettings,
  printSettingsVariables,
} from './print-settings';

describe('parsePrintSettings', () => {
  it('gives the defaults for nothing stored or something malformed', () => {
    expect(parsePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(parsePrintSettings('bold')).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(parsePrintSettings({ font: 'comic', paper: 72, bold: 'yes' })).toEqual(
      DEFAULT_PRINT_SETTINGS,
    );
  });

  it('keeps valid values and clamps sizes into range', () => {
    expect(
      parsePrintSettings({
        fontSize: 40,
        bold: true,
        lineHeight: 'wide',
        font: 'sans',
        paper: '58',
        sideMarginMm: -3,
        barcode: 'large',
      }),
    ).toEqual({
      fontSize: 22,
      bold: true,
      lineHeight: 'wide',
      font: 'sans',
      paper: '58',
      sideMarginMm: 0,
      barcode: 'large',
    });
    expect(parsePrintSettings({ fontSize: 8.6 }).fontSize).toBe(10);
    expect(parsePrintSettings({ fontSize: 15.4 }).fontSize).toBe(15);
    expect(parsePrintSettings({ sideMarginMm: 9 }).sideMarginMm).toBe(6);
  });
});

describe('printSettingsVariables', () => {
  it('maps the defaults to the standard receipt', () => {
    expect(printSettingsVariables(DEFAULT_PRINT_SETTINGS)).toEqual({
      '--print-font-size': '13px',
      '--print-font-weight': '400',
      '--print-line-height': 'normal',
      '--print-font-family': "ui-monospace, 'Courier New', monospace",
      '--print-side-margin': '0mm',
      '--print-barcode-height': '40px',
    });
  });

  it('makes bold, large and wide settings', () => {
    const vars = printSettingsVariables({
      ...DEFAULT_PRINT_SETTINGS,
      fontSize: 16,
      bold: true,
      lineHeight: 'wide',
      sideMarginMm: 3,
      barcode: 'large',
    });
    expect(vars['--print-font-size']).toBe('16px');
    expect(vars['--print-font-weight']).toBe('700');
    expect(vars['--print-line-height']).toBe('1.5');
    expect(vars['--print-side-margin']).toBe('3mm');
    expect(vars['--print-barcode-height']).toBe('64px');
  });
});
