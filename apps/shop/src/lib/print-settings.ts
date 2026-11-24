/**
 * How this device prints (owner, 24 Nov 2026: "the cashier should adjust print font, bold and
 * other parameters"): set on the Printer page and kept in this browser only, because each counter
 * PC or POS has its own printer. They apply to everything it prints (tickets, receipts, payout
 * slips, shift reports) through CSS variables on the page root; the defaults are the standard
 * receipt layout.
 */
export interface PrintSettings {
  /** Text size in px. */
  fontSize: number;
  /**
   * How thick the characters and lines print, thin to heaviest: thicker is darker on a light
   * thermal head. The two heaviest also outline every character, so a font without a black weight
   * (the receipt's monospace has only bold) still prints thicker.
   */
  thickness: PrintThickness;
  lineHeight: 'compact' | 'normal' | 'wide';
  font: 'mono' | 'sans' | 'serif';
  /** The paper roll: as set for the shop (back office), or this printer's own. */
  paper: 'shop' | '58' | '80';
  /** Extra white space left and right, mm (a printer that cuts the edges). */
  sideMarginMm: number;
  barcode: 'normal' | 'large';
}

export const PRINT_THICKNESSES = ['thin', 'normal', 'bold', 'heavy', 'heaviest'] as const;
export type PrintThickness = (typeof PRINT_THICKNESSES)[number];

export const PRINT_FONT_SIZE = { min: 10, max: 22 } as const;
export const PRINT_SIDE_MARGIN_MM = { min: 0, max: 6 } as const;

export const DEFAULT_PRINT_SETTINGS: Readonly<PrintSettings> = {
  fontSize: 13,
  thickness: 'normal',
  lineHeight: 'normal',
  font: 'mono',
  paper: 'shop',
  sideMarginMm: 0,
  barcode: 'normal',
};

export const PRINT_SETTINGS_KEY = 'nahubet:print-settings';
/** Sent on window when the settings change, so the open page applies them at once. */
export const PRINT_SETTINGS_EVENT = 'nahubet:print-settings';

const LINE_HEIGHTS: Readonly<Record<PrintSettings['lineHeight'], string>> = {
  compact: '1.05',
  normal: 'normal',
  wide: '1.5',
};

const FONTS: Readonly<Record<PrintSettings['font'], string>> = {
  mono: "ui-monospace, 'Courier New', monospace",
  sans: "Arial, 'Noto Sans Ethiopic', 'Nyala', sans-serif",
  serif: "'Times New Roman', 'Noto Serif Ethiopic', serif",
};

/** Per thickness: the font weight, the outline drawn round each character, the rule lines. */
const THICKNESS: Readonly<
  Record<PrintThickness, { weight: string; stroke: string; rule: string }>
> = {
  thin: { weight: '300', stroke: '0px', rule: '1px' },
  normal: { weight: '400', stroke: '0px', rule: '1px' },
  bold: { weight: '700', stroke: '0px', rule: '2px' },
  heavy: { weight: '700', stroke: '0.3px', rule: '2px' },
  heaviest: { weight: '900', stroke: '0.6px', rule: '3px' },
};

const BARCODE_HEIGHTS: Readonly<Record<PrintSettings['barcode'], string>> = {
  normal: '40px',
  large: '64px',
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function whole(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** Settings read back from storage: anything missing or malformed takes its default. */
export function parsePrintSettings(raw: unknown): PrintSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PRINT_SETTINGS;
  return {
    fontSize: whole(value.fontSize, PRINT_FONT_SIZE, d.fontSize),
    // Saved before the levels existed: bold on or off.
    thickness: oneOf(
      value.thickness,
      PRINT_THICKNESSES,
      value.bold === true ? 'bold' : d.thickness,
    ),
    lineHeight: oneOf(value.lineHeight, ['compact', 'normal', 'wide'], d.lineHeight),
    font: oneOf(value.font, ['mono', 'sans', 'serif'], d.font),
    paper: oneOf(value.paper, ['shop', '58', '80'], d.paper),
    sideMarginMm: whole(value.sideMarginMm, PRINT_SIDE_MARGIN_MM, d.sideMarginMm),
    barcode: oneOf(value.barcode, ['normal', 'large'], d.barcode),
  };
}

/** The CSS variables of these settings, set on the page root (globals.css reads them). */
export function printSettingsVariables(settings: PrintSettings): Record<string, string> {
  return {
    '--print-font-size': `${settings.fontSize}px`,
    '--print-font-weight': THICKNESS[settings.thickness].weight,
    '--print-text-stroke': THICKNESS[settings.thickness].stroke,
    '--print-rule-width': THICKNESS[settings.thickness].rule,
    '--print-line-height': LINE_HEIGHTS[settings.lineHeight],
    '--print-font-family': FONTS[settings.font],
    '--print-side-margin': `${settings.sideMarginMm}mm`,
    '--print-barcode-height': BARCODE_HEIGHTS[settings.barcode],
  };
}

/** The settings saved on this device (the defaults when none, or storage is blocked). */
export function loadPrintSettings(): PrintSettings {
  try {
    const text = window.localStorage.getItem(PRINT_SETTINGS_KEY);
    return parsePrintSettings(text === null ? null : (JSON.parse(text) as unknown));
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

/** Saves them on this device and applies them to the open page; false when storage is blocked. */
export function savePrintSettings(settings: PrintSettings): boolean {
  let saved = true;
  try {
    window.localStorage.setItem(PRINT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    saved = false;
  }
  applyPrintSettings(settings);
  window.dispatchEvent(new Event(PRINT_SETTINGS_EVENT));
  return saved;
}

/** Puts the settings on the page root: the variables, and the paper roll when it is overridden. */
export function applyPrintSettings(settings: PrintSettings): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(printSettingsVariables(settings))) {
    root.style.setProperty(name, value);
  }
  if (settings.paper === 'shop') root.removeAttribute('data-print-paper');
  else root.setAttribute('data-print-paper', settings.paper);
}
