import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format';
import {
  CREDIT_MODE_LABELS,
  creditModeTone,
  creditsText,
  ageText,
  canApplyResult,
  confirmApplyText,
  decisionPermission,
  exposureText,
  fixtureDisagreement,
  percentVersus,
  priceCompareRows,
  pricingFacts,
  uncalibratedTeamRows,
  flagPermission,
  payloadSummary,
  dismissalsText,
  readDismissals,
  pricingSourcePermission,
  closedByText,
  priceText,
  resolutionText,
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
    expect(pricingSourcePermission('model')).toBe('trading.status');
    expect(pricingSourcePermission('market')).toBe('settings.edit');
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
    expect(payloadSummary('result_overdue', { home: 'A', away: 'B', hoursSinceKickoff: 9 })).toBe(
      'A v B: 9 h after kickoff',
    );
    expect(payloadSummary('result_overdue', {})).toBe('–: no result');
    expect(
      payloadSummary('ratings_uncalibrated', {
        home: 'York City',
        away: 'Rochdale',
        uncalibratedTeams: [
          { name: 'York City', matches: 3, needed: 8 },
          { name: 'Rochdale', matches: 0, needed: 8 },
          'junk',
        ],
      }),
    ).toBe('York City v Rochdale: unrated York City 3/8, Rochdale 0/8');
    expect(payloadSummary('ratings_uncalibrated', { home: 'A', away: 'B' })).toBe('A v B');
    expect(
      payloadSummary('source_stale', {
        sourceName: 'Volunteer data',
        hoursUnchanged: 60,
        dueMatches: 2,
      }),
    ).toBe('Volunteer data: 60 h unchanged, 2 matches waiting');
    expect(payloadSummary('source_stale', { sourceId: 's1', dueMatches: 1 })).toBe(
      's1: unchanged, 1 match waiting',
    );
    expect(payloadSummary('source_stale', {})).toBe('–: unchanged');
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

describe('resolution and closer text', () => {
  it('reads a resolution as a sentence', () => {
    expect(resolutionText({ decision: 'dismiss', note: 'seen, not ours', by: UUID })).toBe(
      'dismiss: seen, not ours',
    );
    expect(resolutionText({ decision: 'apply_result', by: UUID })).toBe('apply result');
    expect(resolutionText({})).toBe('closed');
    expect(resolutionText(null)).toBe('–');
  });
  it('shortens a staff id and keeps system actors', () => {
    expect(closedByText(UUID)).toBe('staff 3f2b8c1e');
    expect(closedByText('system:scraper')).toBe('system:scraper');
    expect(closedByText(null)).toBe('–');
  });
  it('shows kickoff changes as local dates, not ISO text', () => {
    const text = payloadSummary('kickoff_change', {
      currentKickoff: '2026-10-29T19:49:07.680Z',
      proposedKickoff: 'bad',
    });
    expect(text).not.toContain('T19');
    expect(text.endsWith('to –')).toBe(true);
  });
});

describe('credit guard display', () => {
  it('labels and colours each mode, and shows credits with the share left', () => {
    expect(creditModeTone('normal')).toBe('good');
    expect(creditModeTone('economy')).toBe('warn');
    expect(creditModeTone('minimal')).toBe('warn');
    expect(creditModeTone('stop')).toBe('bad');
    expect(CREDIT_MODE_LABELS.stop).toBe('Stopped');
    expect(creditsText(1_234, 20_000)).toBe('1,234 of 20,000 (6%)');
    expect(creditsText(485, null)).toBe('485');
    expect(creditsText(null, null)).toBe('–');
  });
});

describe('fixtureDisagreement', () => {
  it('reads a status disagreement', () => {
    const d = fixtureDisagreement({
      rules: ['F6'],
      reasons: ['status_disagreement'],
      details: { status_disagreement: ['a:postponed', 'b:scheduled'] },
      observations: [
        {
          sourceId: 'a',
          upstream: 'u1',
          status: 'postponed',
          kickoff: '2026-11-10T15:00:00.000Z',
          changedAt: null,
        },
        { sourceId: 'b', status: 'scheduled', kickoff: '2026-11-10T15:00:00.000Z' },
      ],
    });
    expect(d.reasons).toEqual([
      {
        code: 'status_disagreement',
        rule: 'F6',
        label: 'Sources disagree on the status',
        text: 'a: postponed; b: scheduled',
      },
    ]);
    expect(d.observations.map((o) => [o.source, o.status])).toEqual([
      ['a (upstream u1)', 'postponed'],
      ['b', 'scheduled'],
    ]);
    expect(d.observations[0]!.kickoff).toBe(formatDateTime('2026-11-10T15:00:00.000Z'));
    expect(d.observations[0]!.since).toBe('–');
  });

  it('reads a kickoff disagreement and the groups of sources', () => {
    const d = fixtureDisagreement({
      rules: ['F2'],
      reasons: ['kickoff_disagreement'],
      details: {
        kickoff_disagreement: { earliest: '2026-11-10T15:00:00Z', latest: '2026-11-10T17:00:00Z' },
      },
      clusters: [
        {
          earliest: '2026-11-10T15:00:00Z',
          latest: '2026-11-10T15:00:00Z',
          sources: ['a'],
          statuses: ['scheduled'],
        },
        {
          earliest: '2026-11-10T17:00:00Z',
          latest: '2026-11-10T17:30:00Z',
          sources: ['b', 'c'],
          statuses: ['scheduled'],
        },
      ],
    });
    expect(d.reasons[0]!.text).toBe(
      `earliest ${formatDateTime('2026-11-10T15:00:00Z')}, latest ${formatDateTime('2026-11-10T17:00:00Z')}`,
    );
    expect(d.clusters).toEqual([
      { sources: 'a', kickoffs: formatDateTime('2026-11-10T15:00:00Z'), statuses: 'scheduled' },
      {
        sources: 'b, c',
        kickoffs: `${formatDateTime('2026-11-10T17:00:00Z')} to ${formatDateTime('2026-11-10T17:30:00Z')}`,
        statuses: 'scheduled',
      },
    ]);
  });

  it('reads feed_ref_exists facts', () => {
    const d = fixtureDisagreement({
      rules: ['F3'],
      reasons: ['feed_ref_exists'],
      details: {},
      eventId: 'e1',
      eventStatus: 'postponed',
      eventStart: '2026-11-10T15:00:00Z',
      observedKickoff: '2026-11-11T15:00:00Z',
      sources: ['a', 'b'],
    });
    expect(d.facts).toEqual([
      ['Event status', 'postponed'],
      ['Event kickoff', formatDateTime('2026-11-10T15:00:00Z')],
      ['Kickoff the sources show', formatDateTime('2026-11-11T15:00:00Z')],
      ['Sources', 'a, b'],
      ['Event id', 'e1'],
    ]);
    expect(d.reasons[0]!.text).toBeNull();
  });

  it('never throws on unknown shapes', () => {
    for (const bad of [
      null,
      undefined,
      3,
      'x',
      [],
      { reasons: 4, details: 'x', clusters: [null, 1], observations: [{}, null] },
    ]) {
      const d = fixtureDisagreement(bad);
      expect(d.reasons).toEqual([]);
      expect(d.observations).toEqual([]);
      expect(d.clusters).toEqual([]);
    }
    expect(
      fixtureDisagreement({ reasons: ['x_y'], rules: ['A', 'B'], details: { x_y: 5 } }).reasons,
    ).toEqual([{ code: 'x_y', rule: null, label: 'x y', text: null }]);
  });
});

describe('pricing facts and price comparison', () => {
  it('lists the pricing facts the payload has, and none when it has none', () => {
    expect(pricingFacts({})).toEqual([]);
    expect(pricingFacts(null)).toEqual([]);
    expect(
      pricingFacts({
        pricing: { source: 'market', books: 5, residual: 0.0123 },
        calibrated: true,
        pricesSane: false,
        kickoffConfirmed: true,
        autoOpen: false,
      }),
    ).toEqual([
      ['Pricing source', 'Bookmaker market'],
      ['Books used', '5'],
      ['Fit residual', '0.012'],
      ['Ratings calibrated', 'yes'],
      ['Prices pass the sanity checks', 'no'],
      ['Kickoff confirmed by sources', 'yes'],
      ['Competition opens automatically', 'no'],
    ]);
    expect(pricingFacts({ pricing: { source: 'model', fallback: 'poor_fit' } })).toEqual([
      ['Pricing source', 'Team-rating model'],
      ['Market not used', 'the goals model fits the market poorly'],
    ]);
    expect(pricingFacts({ ratingsKey: 'mkt1|abc' })).toEqual([
      ['Pricing source', 'Bookmaker market'],
    ]);
    expect(pricingFacts({ ratingsKey: '[1,2]' })).toEqual([
      ['Pricing source', 'Team-rating model'],
    ]);
  });

  it('puts our price beside the consensus and Pinnacle', () => {
    const markets = [
      {
        market: '1x2',
        selections: [
          { name: '1', oddsMilli: 2060, previousOddsMilli: 2000 },
          { name: 'X', oddsMilli: 3300 },
        ],
      },
      { market: 'ou:2.5', selections: [{ name: 'over', oddsMilli: 1900 }] },
    ];
    const rows = priceCompareRows(markets, {
      prices: [
        { market: '1x2', selection: '1', consensusOddsMilli: 2000, pinnacleOddsMilli: 1950 },
        { market: '1x2', selection: 'X', consensusOddsMilli: 3400, pinnacleOddsMilli: null },
      ],
    });
    expect(rows).toEqual([
      {
        market: '1x2',
        selection: '1',
        ours: '2.06',
        previous: '2.00',
        consensus: '2.00',
        pinnacle: '1.95',
        versus: '+3.0%',
      },
      {
        market: '1x2',
        selection: 'X',
        ours: '3.30',
        previous: '–',
        consensus: '3.40',
        pinnacle: '–',
        versus: '-2.9%',
      },
      {
        market: 'ou:2.5',
        selection: 'over',
        ours: '1.90',
        previous: '–',
        consensus: '–',
        pinnacle: '–',
        versus: '–',
      },
    ]);
    expect(priceCompareRows(markets, null).every((r) => r.consensus === '–')).toBe(true);
    expect(priceCompareRows('nope', null)).toEqual([]);
    expect(
      priceCompareRows([{ market: 1 }, null, { market: 'x', selections: [{}] }], null),
    ).toEqual([]);
    expect(percentVersus(2000, 2000)).toBe('0.0%');
    expect(percentVersus(2000, 0)).toBe('–');
  });

  it('reads the unrated teams defensively', () => {
    expect(uncalibratedTeamRows({})).toEqual([]);
    expect(uncalibratedTeamRows({ uncalibratedTeams: 'x' })).toEqual([]);
    expect(
      uncalibratedTeamRows({
        uncalibratedTeams: [
          { teamId: 't', name: 'Lions', matches: 3, needed: 8 },
          { name: 'Bears' },
          null,
          { matches: 1 },
        ],
      }),
    ).toEqual([
      { name: 'Lions', matches: 3, needed: 8 },
      { name: 'Bears', matches: null, needed: null },
    ]);
  });
});

describe('re-raised dismissals (Q-3)', () => {
  const dismissals = { count: 2, lastNote: 'not ours', lastAt: '2031-01-04T00:00:00.000Z' };
  it('reads defensively', () => {
    expect(readDismissals(undefined)).toBeNull();
    expect(readDismissals({})).toBeNull();
    expect(readDismissals({ dismissals: 'x' })).toBeNull();
    expect(readDismissals({ dismissals: { count: 0 } })).toBeNull();
    expect(readDismissals({ dismissals: { count: 'a' } })).toBeNull();
    expect(readDismissals({ dismissals: { count: 1 } })).toEqual({
      count: 1,
      lastNote: null,
      lastAt: null,
    });
  });
  it('words the count and the last note', () => {
    expect(dismissalsText({})).toBeNull();
    expect(dismissalsText({ dismissals })).toBe(
      `dismissed 2 times (last ${formatDateTime(dismissals.lastAt)}), last note: not ours`,
    );
    expect(dismissalsText({ dismissals: { count: 1 } })).toBe('dismissed 1 time');
  });
  it('is appended to the list summary', () => {
    expect(payloadSummary('unknown_team', { raw: 'Man Utd', dismissals })).toBe(
      `Man Utd [${dismissalsText({ dismissals })}]`,
    );
    expect(payloadSummary('unknown_team', { raw: 'Man Utd' })).toBe('Man Utd');
  });
});
