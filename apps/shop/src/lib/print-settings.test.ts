import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_SETTINGS,
  parsePrintSettings,
  printSettingsVariables,
  type PrintThickness,
} from './print-settings';

describe('parsePrintSettings', () => {
  it('gives the defaults for nothing stored or something malformed', () => {
    expect(parsePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(parsePrintSettings('bold')).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(parsePrintSettings({ font: 'comic', paper: 72, thickness: 'max' })).toEqual(
      DEFAULT_PRINT_SETTINGS,
    );
  });

  it('keeps valid values and clamps sizes into range', () => {
    expect(
      parsePrintSettings({
        fontSize: 40,
        thickness: 'heavy',
        lineHeight: 'wide',
        font: 'sans',
        paper: '58',
        sideMarginMm: -3,
        barcode: 'large',
      }),
    ).toEqual({
      fontSize: 22,
      thickness: 'heavy',
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
      '--print-text-stroke': '0px',
      '--print-rule-width': '1px',
      '--print-line-height': 'normal',
      '--print-font-family': "ui-monospace, 'Courier New', monospace",
      '--print-side-margin': '0mm',
      '--print-barcode-height': '40px',
    });
  });

  it('reads a setting saved before the thickness levels: bold on is Bold', () => {
    expect(parsePrintSettings({ bold: true }).thickness).toBe('bold');
    expect(parsePrintSettings({ bold: false }).thickness).toBe('normal');
    expect(parsePrintSettings({ bold: true, thickness: 'thin' }).thickness).toBe('thin');
  });

  it('makes each thickness thicker than the one before', () => {
    const at = (thickness: PrintThickness) =>
      printSettingsVariables({ ...DEFAULT_PRINT_SETTINGS, thickness });
    expect(at('thin')['--print-font-weight']).toBe('300');
    expect(at('normal')['--print-font-weight']).toBe('400');
    expect(at('bold')['--print-font-weight']).toBe('700');
    expect(at('heavy')['--print-text-stroke']).toBe('0.3px');
    expect(at('heaviest')['--print-font-weight']).toBe('900');
    expect(at('heaviest')['--print-text-stroke']).toBe('0.6px');
    expect(at('heaviest')['--print-rule-width']).toBe('3px');
  });

  it('makes bold, large and wide settings', () => {
    const vars = printSettingsVariables({
      ...DEFAULT_PRINT_SETTINGS,
      fontSize: 16,
      thickness: 'bold',
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
