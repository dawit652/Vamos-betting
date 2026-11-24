'use client';

import { useEffect, useState } from 'react';
import {
  applyPrintSettings,
  DEFAULT_PRINT_SETTINGS,
  loadPrintSettings,
  PRINT_FONT_SIZE,
  PRINT_SETTINGS_KEY,
  PRINT_SIDE_MARGIN_MM,
  savePrintSettings,
  type PrintSettings,
} from '@/lib/print-settings';
import { TEXT } from '@/lib/text';

/** Puts this device's print settings on every page, and again when another tab saves them. */
export function PrintSettingsApplier() {
  useEffect(() => {
    applyPrintSettings(loadPrintSettings());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PRINT_SETTINGS_KEY) {
        applyPrintSettings(loadPrintSettings());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/**
 * The Printer page's settings: the preview below shows them as they are changed (and the test
 * print uses them); Save keeps them on this device. Leaving without saving restores the saved ones.
 */
export function PrintSettingsForm({ shopWidthMm }: { shopWidthMm: 58 | 80 }) {
  const [settings, setSettings] = useState<PrintSettings>(() => loadPrintSettings());
  const [saved, setSaved] = useState<'saved' | 'blocked' | null>(null);

  useEffect(() => {
    applyPrintSettings(settings);
  }, [settings]);
  useEffect(() => () => applyPrintSettings(loadPrintSettings()), []);

  function change(patch: Partial<PrintSettings>) {
    setSettings((now) => ({ ...now, ...patch }));
    setSaved(null);
  }

  function save(next: PrintSettings) {
    setSettings(next);
    setSaved(savePrintSettings(next) ? 'saved' : 'blocked');
  }

  return (
    <section
      className="card no-print"
      aria-labelledby="print-settings"
      data-testid="print-settings"
    >
      <h2 id="print-settings">{TEXT.printSettingsTitle}</h2>
      <p className="muted small">{TEXT.printSettingsNote}</p>
      <div className="row">
        <label htmlFor="print-font-size">
          {TEXT.printFontSize}
          <select
            id="print-font-size"
            data-testid="print-font-size"
            value={settings.fontSize}
            onChange={(e) => change({ fontSize: Number(e.target.value) })}
          >
            {range(PRINT_FONT_SIZE.min, PRINT_FONT_SIZE.max).map((size) => (
              <option key={size} value={size}>
                {size} px
                {size === DEFAULT_PRINT_SETTINGS.fontSize ? ` (${TEXT.printStandard})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="print-line-height">
          {TEXT.printLineHeight}
          <select
            id="print-line-height"
            data-testid="print-line-height"
            value={settings.lineHeight}
            onChange={(e) => change({ lineHeight: e.target.value as PrintSettings['lineHeight'] })}
          >
            {(['compact', 'normal', 'wide'] as const).map((value) => (
              <option key={value} value={value}>
                {TEXT.printLineHeights[value]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="print-font">
          {TEXT.printFont}
          <select
            id="print-font"
            data-testid="print-font"
            value={settings.font}
            onChange={(e) => change({ font: e.target.value as PrintSettings['font'] })}
          >
            {(['mono', 'sans', 'serif'] as const).map((value) => (
              <option key={value} value={value}>
                {TEXT.printFonts[value]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="print-paper">
          {TEXT.printPaper}
          <select
            id="print-paper"
            data-testid="print-paper"
            value={settings.paper}
            onChange={(e) => change({ paper: e.target.value as PrintSettings['paper'] })}
          >
            <option value="shop">
              {TEXT.printPaperShop} ({shopWidthMm} mm)
            </option>
            <option value="58">58 mm</option>
            <option value="80">80 mm</option>
          </select>
        </label>
        <label htmlFor="print-side-margin">
          {TEXT.printSideMargin}
          <select
            id="print-side-margin"
            data-testid="print-side-margin"
            value={settings.sideMarginMm}
            onChange={(e) => change({ sideMarginMm: Number(e.target.value) })}
          >
            {range(PRINT_SIDE_MARGIN_MM.min, PRINT_SIDE_MARGIN_MM.max).map((mm) => (
              <option key={mm} value={mm}>
                {mm} mm
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="print-barcode">
          {TEXT.printBarcode}
          <select
            id="print-barcode"
            data-testid="print-barcode"
            value={settings.barcode}
            onChange={(e) => change({ barcode: e.target.value as PrintSettings['barcode'] })}
          >
            {(['normal', 'large'] as const).map((value) => (
              <option key={value} value={value}>
                {TEXT.printBarcodes[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check" htmlFor="print-bold">
        <input
          id="print-bold"
          type="checkbox"
          data-testid="print-bold"
          checked={settings.bold}
          onChange={(e) => change({ bold: e.target.checked })}
        />
        {TEXT.printBold}
      </label>
      <p className="actions">
        <button
          type="button"
          className="primary"
          data-testid="print-save"
          onClick={() => save(settings)}
        >
          {TEXT.printSave}
        </button>{' '}
        <button
          type="button"
          data-testid="print-reset"
          onClick={() => save({ ...DEFAULT_PRINT_SETTINGS })}
        >
          {TEXT.printReset}
        </button>
      </p>
      {saved === 'saved' && (
        <p className="notice" role="status" data-testid="print-saved">
          {TEXT.printSaved}
        </p>
      )}
      {saved === 'blocked' && (
        <p className="error" role="alert">
          {TEXT.printSaveBlocked}
        </p>
      )}
    </section>
  );
}
