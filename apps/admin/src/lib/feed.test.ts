import { describe, expect, it } from 'vitest';
import {
  ageText,
  canApplyResult,
  confirmApplyText,
  decisionPermission,
  exposureText,
  flagPermission,
  payloadSummary,
  priceText,
  reviewQuery,
  scorePercent,
  scoreText,
  severityTone,
  sourceStateTone,
  validateAliasForm,
} from './feed';

const UUID = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';

describe('feed helpers', () => {
  it('formats scores with the half-time score when known', () => {
    expect(scoreText({ home: 2, away: 1, htHome: null, htAway: null })).toBe('2-1');
    expect(scoreText({ home: 2, away: 1, htHome: 1, htAway: 0 })).toBe('2-1 (HT 1-0)');
    expect(scoreText(null)).toBe('–');
  });

  it('formats ages', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    expect(ageText('2026-10-29T11:59:30Z', now)).toBe('just now');
    expect(ageText('2026-10-29T11:15:00Z', now)).toBe('45 min ago');
    expect(ageText('2026-10-29T07:00:00Z', now)).toBe('5 h ago');
    expect(ageText('2026-10-20T12:00:00Z', now)).toBe('9 d ago');
    expect(ageText('nope', now)).toBe('–');
    expect(ageText(null, now)).toBe('–');
  });

  it('offers "Apply this result" only for open result_ready and result_unverified items', () => {
    expect(canApplyResult({ kind: 'result_ready', status: 'open' })).toBe(true);
    expect(canApplyResult({ kind: 'result_unverified', status: 'open' })).toBe(true);
    expect(canApplyResult({ kind: 'result_ready', status: 'resolved' })).toBe(false);
    expect(canApplyResult({ kind: 'result_unverified', status: 'dismissed' })).toBe(false);
    for (const kind of ['result_conflict', 'result_correction', 'odds_approval'] as const) {
      expect(canApplyResult({ kind, status: 'open' })).toBe(false);
    }
  });

  it('maps flag changes to the permission the API wants', () => {
    expect(flagPermission('enabled', false)).toBe('trading.status');
    expect(flagPermission('autoOpen', false)).toBe('trading.status');
    expect(flagPermission('autoResults', false)).toBe('trading.status');
    expect(flagPermission('enabled', true)).toBe('settings.edit');
    expect(flagPermission('extraTime', false)).toBe('settings.edit');
    expect(flagPermission('extraTime', true)).toBe('settings.edit');
    expect(decisionPermission('apply_result')).toBe('trading.result');
    expect(decisionPermission('apply_reprice')).toBe('trading.odds');
    expect(decisionPermission('dismiss')).toBe('trading.status');
  });

  it('describes exposure, confirm text, prices and percentages', () => {
    expect(exposureText(0, 'ETB 0.00')).toBe('No open bets');
    expect(exposureText(1, 'ETB 5.00')).toBe('1 open bet, stake ETB 5.00');
    expect(exposureText(3, 'ETB 5.00')).toBe('3 open bets, stake ETB 5.00');
    expect(
      confirmApplyText({
        home: 'A',
        away: 'B',
        score: { home: 2, away: 1, htHome: null, htAway: null },
      }),
    ).toBe('Apply A 2-1 B?');
    expect(priceText('Home', 1850)).toBe('Home 1.85');
    expect(priceText('Home', 1850, 1700)).toBe('Home 1.70 to 1.85');
    expect(scorePercent(0.876)).toBe('88%');
    expect(scorePercent(2)).toBe('100%');
  });

  it('tones', () => {
    expect(sourceStateTone('ok')).toBe('good');
    expect(sourceStateTone('broken')).toBe('bad');
    expect(sourceStateTone('disabled')).toBe('muted');
    expect(severityTone('critical')).toBe('bad');
    expect(severityTone('info')).toBe('muted');
  });

  it('summarises payloads defensively', () => {
    expect(payloadSummary('unknown_team', { raw: 'Man Utd' })).toBe('Man Utd');
    expect(
      payloadSummary('result_ready', {
        home: 'A',
        away: 'B',
        score: { home: 1, away: 0, htHome: null, htAway: null },
      }),
    ).toBe('A v B: 1-0');
    expect(payloadSummary('fixture_missing', { detail: 'gone' })).toBe('gone');
    expect(payloadSummary('result_ready', {})).toBe('–: –');
    expect(payloadSummary('source_broken', {})).toBe('–');
  });

  it('builds the review query and validates the alias form', () => {
    expect(reviewQuery('open', '')).toEqual({ status: 'open' });
    expect(reviewQuery('', 'odds_approval')).toEqual({ kind: 'odds_approval' });
    expect(validateAliasForm({ raw: ' ', targetId: UUID })).not.toBeNull();
    expect(validateAliasForm({ raw: 'Man Utd', targetId: 'abc' })).not.toBeNull();
    expect(validateAliasForm({ raw: 'a\u0001b', targetId: UUID })).not.toBeNull();
    expect(validateAliasForm({ raw: 'Man Utd', targetId: UUID })).toBeNull();
  });
});
