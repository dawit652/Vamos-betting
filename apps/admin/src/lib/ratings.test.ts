import { describe, expect, it } from 'vitest';
import {
  backfillCommand,
  confirmRatingsText,
  parseDecimal,
  ratingsQuery,
  ratingsText,
  validateRatingsForm,
} from './ratings';

const band = { min: 0.2, max: 3 };

describe('parseDecimal', () => {
  it('accepts plain decimals only', () => {
    expect(parseDecimal('1.25')).toBe(1.25);
    expect(parseDecimal(' .5 ')).toBe(0.5);
    expect(parseDecimal('-1')).toBe(-1);
    for (const bad of ['', ' ', '1abc', 'NaN', 'Infinity', '1e3', '1,5', '--1']) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
  });
});

describe('validateRatingsForm', () => {
  it('builds the body, with matches only when given', () => {
    expect(validateRatingsForm({ attack: '1.2', defence: '0.9', matches: '' }, band)).toEqual({
      ok: true,
      body: { attack: 1.2, defence: 0.9 },
    });
    expect(validateRatingsForm({ attack: '1', defence: '1', matches: '12' }, band)).toEqual({
      ok: true,
      body: { attack: 1, defence: 1, matches: 12 },
    });
  });

  it('refuses numbers outside the band, text, and bad match counts', () => {
    const bad = (attack: string, defence: string, matches = '') =>
      validateRatingsForm({ attack, defence, matches }, band);
    expect(bad('0.1', '1')).toMatchObject({ ok: false, error: expect.stringContaining('Attack') });
    expect(bad('1', '3.5')).toMatchObject({ ok: false, error: expect.stringContaining('Defence') });
    expect(bad('x', '1')).toMatchObject({ ok: false });
    expect(bad('1', '')).toMatchObject({ ok: false });
    expect(bad('1', '1', '1.5')).toMatchObject({ ok: false });
    expect(bad('1', '1', '-1')).toMatchObject({ ok: false });
    expect(bad('1', '1', '10001')).toMatchObject({ ok: false });
    expect(bad('0.2', '3', '0')).toMatchObject({ ok: true });
  });
});

describe('texts', () => {
  it('describes ratings and the confirmation', () => {
    expect(ratingsText({ attack: null, defence: null, matches: 0 })).toBe('no ratings');
    expect(ratingsText({ attack: 1.2, defence: 0.9, matches: 12 })).toBe(
      'attack 1.200, defence 0.900, 12 matches',
    );
    const text = confirmRatingsText(
      { team: 'AAA', attack: 1, defence: 1, matches: 5, manual: false },
      { attack: 1.4, defence: 0.8 },
    );
    expect(text).toContain('Set AAA by hand?');
    expect(text).toContain('Now: attack 1.000, defence 1.000, 5 matches.');
    expect(text).toContain('After: attack 1.400, defence 0.800, 5 matches (manual)');
  });
});

describe('ratingsQuery and backfillCommand', () => {
  it('sends only the filled filters', () => {
    expect(ratingsQuery('', false)).toEqual({});
    expect(ratingsQuery(' besiktas ', true)).toEqual({ team: 'besiktas', unrated: 'true' });
  });

  it('shows the server CLI command, with a placeholder slug until one is typed', () => {
    expect(backfillCommand('')).toContain('--competition <competition-slug> --dry-run');
    const cmd = backfillCommand(' costa-rica-primera-division ');
    expect(cmd).toContain('node dist/cli.js ratings backfill --file /in/results.json');
    expect(cmd).toContain('--competition costa-rica-primera-division --dry-run');
  });
});
