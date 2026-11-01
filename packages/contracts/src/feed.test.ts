import { describe, expect, it } from 'vitest';
import { hasPermission, STAFF_PERMISSIONS } from './admin';
import {
  AliasListQuery,
  CompetitionPolicyView,
  competitionPolicyPermission,
  CreateAliasRequest,
  FEED_ADAPTERS,
  FEED_DATA_CLASSES,
  FEED_FIXTURE_STATUSES,
  FEED_RESOLVE_DECISION_KINDS,
  FEED_RESOLVE_DECISIONS,
  FEED_REVIEW_KINDS,
  FEED_REVIEW_STATUSES,
  FEED_ROUTE_PERMISSIONS,
  FEED_RESULT_STATUSES,
  FEED_RUN_STATUSES,
  FEED_SCORE_BASES,
  FEED_SEVERITIES,
  FEED_SOURCE_STATES,
  FEED_SPORTS,
  FeedHealthResponse,
  RemoveAliasResponse,
  FEED_REPRICE_SUBJECT_SUFFIX,
  isRepriceItem,
  parseReviewPayload,
  REVIEW_PAYLOAD_SCHEMAS,
  ResolveReviewRequest,
  resolveReviewPermission,
  ReviewItemView,
  ReviewListQuery,
  SetSourceEnabledRequest,
  SourceHealthView,
  UpdateCompetitionPolicyRequest,
} from './feed';

const NOW = '2026-10-28T09:00:00.000Z';
const score = { home: 2, away: 1, htHome: 1, htAway: 0 };
const eventRef = {
  eventId: 'evt_1',
  gameId: '4821',
  home: 'Arsenal',
  away: 'Chelsea',
  kickoff: '2026-10-30T19:00:00.000Z',
};

describe('feed routes', () => {
  it('guards every route with a known permission and a known method', () => {
    for (const [route, permission] of Object.entries(FEED_ROUTE_PERMISSIONS)) {
      expect(STAFF_PERMISSIONS, route).toContain(permission);
      expect(route).toMatch(/^(GET|POST|PUT|DELETE) \/admin\/feed\//);
    }
  });

  it('reads with trading.view and changes with trading.status or settings.edit', () => {
    for (const [route, permission] of Object.entries(FEED_ROUTE_PERMISSIONS)) {
      if (route.startsWith('GET ')) expect(permission, route).toBe('trading.view');
      else expect(['trading.status', 'settings.edit'], route).toContain(permission);
    }
    expect(FEED_ROUTE_PERMISSIONS['PUT /admin/feed/competitions/:id']).toBe('settings.edit');
    expect(FEED_ROUTE_PERMISSIONS['PUT /admin/feed/sources/:id']).toBe('trading.status');
  });

  it('lets admin and trader work the queue, nobody else; only admin edits policies', () => {
    for (const [route, permission] of Object.entries(FEED_ROUTE_PERMISSIONS)) {
      expect(hasPermission('admin', permission), route).toBe(true);
      for (const role of ['support', 'kyc', 'finance', 'compliance'] as const) {
        expect(hasPermission(role, permission), `${role} ${route}`).toBe(false);
      }
      expect(hasPermission('trader', permission), route).toBe(permission !== 'settings.edit');
    }
    expect(hasPermission('trader', 'trading.result')).toBe(true);
  });

  it('asks trading.result to apply a result, trading.odds to apply prices and trading.status for every other decision', () => {
    expect(resolveReviewPermission({ decision: 'apply_result' })).toBe('trading.result');
    expect(resolveReviewPermission({ decision: 'apply_reprice' })).toBe('trading.odds');
    for (const decision of FEED_RESOLVE_DECISIONS) {
      if (decision === 'apply_result' || decision === 'apply_reprice') continue;
      expect(resolveReviewPermission({ decision }), decision).toBe('trading.status');
    }
  });
});

describe('feed closed sets', () => {
  it('have no duplicates', () => {
    for (const [name, set] of Object.entries({
      FEED_SPORTS,
      FEED_ADAPTERS,
      FEED_DATA_CLASSES,
      FEED_FIXTURE_STATUSES,
      FEED_RESULT_STATUSES,
      FEED_SCORE_BASES,
      FEED_RUN_STATUSES,
      FEED_REVIEW_KINDS,
      FEED_REVIEW_STATUSES,
      FEED_SEVERITIES,
      FEED_SOURCE_STATES,
      FEED_RESOLVE_DECISIONS,
    })) {
      expect(new Set(set).size, name).toBe(set.length);
    }
  });

  it('give every review kind a payload schema, and every decision known kinds', () => {
    expect(Object.keys(REVIEW_PAYLOAD_SCHEMAS).sort()).toEqual([...FEED_REVIEW_KINDS].sort());
    expect(Object.keys(FEED_RESOLVE_DECISION_KINDS).sort()).toEqual(
      [...FEED_RESOLVE_DECISIONS].sort(),
    );
    for (const kinds of Object.values(FEED_RESOLVE_DECISION_KINDS)) {
      for (const kind of kinds) expect(FEED_REVIEW_KINDS).toContain(kind);
    }
  });

  it('keep regular time as the only score basis a result may be confirmed on', () => {
    expect(FEED_SCORE_BASES).toEqual(['regular_time', 'includes_extra_time', 'unknown']);
  });
});

describe('feed requests', () => {
  it('resolves with one decision and its own fields only', () => {
    for (const body of [
      { decision: 'dismiss', note: 'duplicate of another item' },
      { decision: 'map_alias', targetId: 'team_1' },
      { decision: 'map_alias', targetId: 'team_1', sourceId: 'openfootball-en1' },
      { decision: 'open_betting' },
      { decision: 'apply_result' },
      { decision: 'apply_result', note: 'checked on the league site' },
      { decision: 'apply_kickoff' },
      { decision: 'apply_reprice' },
    ]) {
      expect(ResolveReviewRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('rejects an unknown decision, missing fields, empty notes and over-long strings', () => {
    for (const body of [
      {},
      { decision: 'approve' },
      { decision: 'dismiss' },
      { decision: 'dismiss', note: '' },
      { decision: 'dismiss', note: '   ' },
      { decision: 'dismiss', note: 'x'.repeat(2001) },
      { decision: 'apply_result', note: ' ' },
      { decision: 'map_alias' },
      { decision: 'map_alias', targetId: '' },
      { decision: 'map_alias', targetId: 'x'.repeat(65) },
      { decision: 'map_alias', targetId: 'team_1', sourceId: '' },
      { decision: 'dismiss', note: 'x', targetId: 'team_1' },
      { decision: 'open_betting', note: 'extra field' },
      { decision: 'apply_kickoff', kickoff: NOW },
      { decision: 'apply_reprice', note: 'extra field' },
      { decision: 'apply_reprice', oddsMilli: 2000 },
      { decision: 'apply_reprice', markets: [] },
    ]) {
      expect(ResolveReviewRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('never takes a score from the client', () => {
    for (const extra of [
      { score },
      { score: { home: 9, away: 0 } },
      { home: 2, away: 1 },
      { htHome: 1, htAway: 0 },
      { finalScore: '2-1' },
    ]) {
      for (const decision of [
        'apply_result',
        'open_betting',
        'apply_kickoff',
        'apply_reprice',
      ] as const) {
        expect(
          ResolveReviewRequest.safeParse({ decision, ...extra }).success,
          `${decision} ${JSON.stringify(extra)}`,
        ).toBe(false);
      }
    }
  });

  it('reads review list filters as lists, with the default and maximum page sizes', () => {
    expect(ReviewListQuery.parse({}).limit).toBe(50);
    expect(ReviewListQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(ReviewListQuery.parse({ status: 'open,resolved' }).status).toEqual(['open', 'resolved']);
    expect(ReviewListQuery.parse({ kind: ['unknown_team', 'odds_approval'] }).kind).toEqual([
      'unknown_team',
      'odds_approval',
    ]);
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { status: 'open,pending' },
      { kind: 'nonsense' },
      { cursor: '' },
      { cursor: 'x'.repeat(201) },
    ]) {
      expect(ReviewListQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('creates aliases for a team or a competition, football by default', () => {
    expect(
      CreateAliasRequest.parse({ kind: 'team', raw: ' Man Utd ', targetId: 'team_1' }),
    ).toEqual({ kind: 'team', sport: 'football', raw: 'Man Utd', targetId: 'team_1' });
    expect(
      CreateAliasRequest.safeParse({
        kind: 'competition',
        sport: 'football',
        raw: 'Premier League',
        targetId: 'comp_1',
        sourceId: 'openfootball-en1',
      }).success,
    ).toBe(true);
    for (const body of [
      { kind: 'player', raw: 'x', targetId: 't' },
      { kind: 'team', sport: 'cricket', raw: 'x', targetId: 't' },
      { kind: 'team', raw: '', targetId: 't' },
      { kind: 'team', raw: '   ', targetId: 't' },
      { kind: 'team', raw: 'x'.repeat(121), targetId: 't' },
      { kind: 'team', raw: 'Bad\nName', targetId: 't' },
      { kind: 'team', raw: 'x' },
      { kind: 'team', raw: 'x', targetId: '' },
      { kind: 'team', raw: 'x', targetId: 't', extra: true },
    ]) {
      expect(CreateAliasRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(AliasListQuery.parse({}).limit).toBe(50);
    expect(AliasListQuery.safeParse({ q: '' }).success).toBe(false);
  });

  it('removes an alias by id: trading.status, and the response echoes the alias', () => {
    expect(FEED_ROUTE_PERMISSIONS['DELETE /admin/feed/aliases/:id']).toBe(
      FEED_ROUTE_PERMISSIONS['POST /admin/feed/aliases'],
    );
    expect(FEED_ROUTE_PERMISSIONS['DELETE /admin/feed/aliases/:id']).toBe('trading.status');
    const alias = {
      id: 'a1',
      kind: 'team',
      sport: 'football',
      raw: 'man utd',
      normalized: 'man utd',
      targetId: 't1',
      targetName: 'Manchester United',
      sourceId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'cli',
    };
    expect(RemoveAliasResponse.parse({ removed: alias }).removed.id).toBe('a1');
    expect(RemoveAliasResponse.safeParse({}).success).toBe(false);
    expect(RemoveAliasResponse.safeParse({ removed: { ...alias, kind: 'player' } }).success).toBe(
      false,
    );
  });

  it('switches a source on or off with a boolean and nothing else', () => {
    expect(SetSourceEnabledRequest.safeParse({ enabled: false }).success).toBe(true);
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: true, name: 'x' }]) {
      expect(SetSourceEnabledRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('updates a competition policy with some flags, at least one, no others', () => {
    expect(UpdateCompetitionPolicyRequest.safeParse({ enabled: true }).success).toBe(true);
    expect(
      UpdateCompetitionPolicyRequest.safeParse({ autoOpen: false, autoResults: false }).success,
    ).toBe(true);
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, name: 'x' }, { auto: true }]) {
      expect(UpdateCompetitionPolicyRequest.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('lets traders turn policy flags off but only settings.edit turn anything on', () => {
    const permission = (body: unknown) =>
      competitionPolicyPermission(UpdateCompetitionPolicyRequest.parse(body));
    expect(permission({ enabled: false })).toBe('trading.status');
    expect(permission({ enabled: false, autoOpen: false, autoResults: false })).toBe(
      'trading.status',
    );
    expect(permission({ autoResults: false })).toBe('trading.status');
    expect(permission({ enabled: true })).toBe('settings.edit');
    expect(permission({ enabled: false, autoOpen: true })).toBe('settings.edit');
    expect(permission({ extraTime: false })).toBe('settings.edit');
    expect(permission({ extraTime: true })).toBe('settings.edit');
    // The market feed is switched on with settings access; back to the model is a safety action.
    expect(permission({ pricingSource: 'market' })).toBe('settings.edit');
    expect(permission({ pricingSource: 'model' })).toBe('trading.status');
    expect(permission({ enabled: false, pricingSource: 'model' })).toBe('trading.status');
    expect(permission({ enabled: false, pricingSource: 'market' })).toBe('settings.edit');
  });

  it('accepts only the two pricing sources', () => {
    for (const pricingSource of ['model', 'market']) {
      expect(UpdateCompetitionPolicyRequest.safeParse({ pricingSource }).success).toBe(true);
    }
    for (const pricingSource of ['Market', 'crowd', '', true, null]) {
      expect(UpdateCompetitionPolicyRequest.safeParse({ pricingSource }).success).toBe(false);
    }
  });
});

describe('feed views', () => {
  const source = {
    id: 'openfootball-en1',
    name: 'openfootball England',
    adapter: 'openfootball',
    upstream: 'openfootball',
    enabled: true,
    lastRun: {
      status: 'ok',
      startedAt: NOW,
      finishedAt: NOW,
      recordsSeen: 380,
      recordsAccepted: 378,
    },
    lastOkAt: NOW,
    consecutiveFailures: 0,
    openReviewItems: 2,
    state: 'ok',
  };

  it('describes a source, with or without a run', () => {
    expect(SourceHealthView.safeParse(source).success).toBe(true);
    expect(
      SourceHealthView.safeParse({ ...source, lastRun: null, lastOkAt: null, state: 'learning' })
        .success,
    ).toBe(true);
    expect(SourceHealthView.safeParse({ ...source, state: 'healthy' }).success).toBe(false);
    expect(SourceHealthView.safeParse({ ...source, adapter: 'scrapy' }).success).toBe(false);
    expect(SourceHealthView.safeParse({ ...source, consecutiveFailures: -1 }).success).toBe(false);
  });

  it('counts the queue for every review kind', () => {
    const byKind = Object.fromEntries(FEED_REVIEW_KINDS.map((kind) => [kind, 0]));
    const health = {
      sources: [source],
      queue: { open: 0, byKind },
      competitions: { total: 3, enabled: 1, autoOpen: 0, autoResults: 0 },
      generatedAt: NOW,
    };
    expect(FeedHealthResponse.safeParse(health).success).toBe(true);
    const { unknown_team: _omit, ...partial } = byKind;
    expect(
      FeedHealthResponse.safeParse({ ...health, queue: { open: 0, byKind: partial } }).success,
    ).toBe(false);
  });

  it('describes a competition policy and a review item', () => {
    expect(
      CompetitionPolicyView.safeParse({
        competitionId: 'comp_1',
        name: 'Premier League',
        sport: 'football',
        enabled: true,
        autoOpen: false,
        autoResults: false,
        extraTime: false,
        pricingSource: 'model',
        updatedAt: null,
        updatedBy: null,
      }).success,
    ).toBe(true);
    const item = {
      id: 'rev_1',
      kind: 'unknown_team',
      subjectKey: 'openfootball-en1|man utd',
      status: 'open',
      severity: 'warning',
      title: 'Unknown team "Man Utd"',
      createdAt: NOW,
      updatedAt: NOW,
      payload: {},
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
    };
    expect(ReviewItemView.safeParse(item).success).toBe(true);
    expect(ReviewItemView.safeParse({ ...item, kind: 'other' }).success).toBe(false);
    expect(ReviewItemView.safeParse({ ...item, severity: 'fatal' }).success).toBe(false);
    expect(ReviewItemView.safeParse({ ...item, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('review payloads', () => {
  const sources = [
    { sourceId: 'a', upstream: 'upstream-a', changedAt: NOW },
    { sourceId: 'b', upstream: 'upstream-b', changedAt: NOW },
  ];
  const exposure = { openBets: 12, totalStake: '1250000' };

  it('reads the payload of an unknown team and defaults the sport', () => {
    const payload = {
      raw: 'Man Utd',
      competition: 'Premier League',
      sourceId: 'a',
      suggestions: [{ id: 'team_1', name: 'Manchester United', score: 0.67 }],
    };
    expect(parseReviewPayload('unknown_team', payload)).toEqual({ ...payload, sport: 'football' });
    expect(
      parseReviewPayload('unknown_team', { ...payload, suggestions: [{ id: 't' }] }),
    ).toBeNull();
    expect(
      parseReviewPayload('unknown_competition', {
        raw: 'EPL',
        sourceId: 'a',
        suggestions: [],
      }),
    ).toEqual({ sport: 'football', raw: 'EPL', sourceId: 'a', suggestions: [] });
  });

  it('reads the payload of a result decision with the score and the exposure', () => {
    const payload = { ...eventRef, score, sources, exposure };
    for (const kind of ['result_ready', 'result_unverified'] as const) {
      expect(parseReviewPayload(kind, payload), kind).toEqual(payload);
      expect(parseReviewPayload(kind, { ...payload, exposure: undefined }), kind).toBeNull();
      expect(
        parseReviewPayload(kind, { ...payload, exposure: { openBets: 1, totalStake: '12.5' } }),
        kind,
      ).toBeNull();
      expect(
        parseReviewPayload(kind, { ...payload, score: { ...score, home: -1 } }),
        kind,
      ).toBeNull();
    }
  });

  it('reads kickoff changes, odds proposals, disputes and broken sources', () => {
    expect(
      parseReviewPayload('kickoff_change', {
        eventId: 'evt_1',
        currentKickoff: '2026-10-30T19:00:00.000Z',
        proposedKickoff: '2026-10-30T17:00:00.000Z',
        sources,
        hasBets: true,
      }),
    ).not.toBeNull();
    expect(parseReviewPayload('kickoff_change', { eventId: 'evt_1' })).toBeNull();

    const odds = {
      ...eventRef,
      reason: 'Chelsea has 3 rated matches (8 needed)',
      markets: [
        {
          market: '1x2',
          selections: [
            { name: '1', oddsMilli: 1850 },
            { name: 'X', oddsMilli: 3400, previousOddsMilli: 3300 },
          ],
        },
      ],
    };
    // A re-price item also carries the exact book and the ratings fingerprint.
    const reprice = {
      ...odds,
      proposal: [
        {
          type: '1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: 1850 },
            { code: 'X', oddsMilli: 3400 },
          ],
        },
      ],
      ratingsKey: 'k',
    };
    expect(parseReviewPayload('odds_approval', reprice)).toEqual(reprice);
    expect(
      parseReviewPayload('odds_approval', {
        ...reprice,
        proposal: [{ type: '1x2', line: null, selections: [{ code: '1', oddsMilli: 900 }] }],
      }),
    ).toBeNull();
    // Where the prices come from (rule O5): optional, and only the two sources.
    for (const pricing of [
      { source: 'model' },
      { source: 'market', books: 6, residual: 0.012 },
      { source: 'model', fallback: 'poor_fit' },
    ]) {
      expect(parseReviewPayload('odds_approval', { ...reprice, pricing })).toEqual({
        ...reprice,
        pricing,
      });
    }
    for (const pricing of [{ source: 'crowd' }, { source: 'market', books: -1 }, {}]) {
      expect(parseReviewPayload('odds_approval', { ...reprice, pricing })).toBeNull();
    }
    expect(isRepriceItem({ kind: 'odds_approval', subjectKey: 'fx|a|reprice' })).toBe(true);
    expect(isRepriceItem({ kind: 'odds_approval', subjectKey: 'fx|a' })).toBe(false);
    expect(isRepriceItem({ kind: 'ratings_uncalibrated', subjectKey: 'fx|a|reprice' })).toBe(false);
    expect(FEED_REPRICE_SUBJECT_SUFFIX).toBe('|reprice');

    for (const kind of ['odds_approval', 'ratings_uncalibrated'] as const) {
      expect(parseReviewPayload(kind, odds), kind).toEqual(odds);
      expect(parseReviewPayload(kind, { ...odds, markets: [] }), kind).not.toBeNull();
      expect(
        parseReviewPayload(kind, {
          ...odds,
          markets: [{ market: '1x2', selections: [{ name: '1', oddsMilli: 500 }] }],
        }),
        kind,
      ).toBeNull();
    }

    const observations = [
      {
        sourceId: 'a',
        upstream: 'ua',
        status: 'finished',
        score,
        scoreBasis: 'regular_time',
        changedAt: NOW,
      },
      {
        sourceId: 'b',
        upstream: 'ub',
        status: 'abandoned',
        score: null,
        scoreBasis: 'unknown',
        changedAt: NOW,
      },
    ];
    expect(
      parseReviewPayload('result_conflict', { ...eventRef, appliedScore: null, observations }),
    ).not.toBeNull();
    expect(
      parseReviewPayload('result_correction', {
        ...eventRef,
        appliedScore: score,
        observations,
        exposure,
      }),
    ).not.toBeNull();
    expect(parseReviewPayload('result_conflict', { ...eventRef, observations })).toBeNull();

    expect(
      parseReviewPayload('source_broken', {
        sourceId: 'a',
        runId: 'run_1',
        reason: 'parse yield collapsed',
        recordsAccepted: 0,
        baseline: 378,
      }),
    ).not.toBeNull();
    expect(
      parseReviewPayload('source_broken', {
        sourceId: 'a',
        runId: 'run_1',
        reason: 'x',
        recordsAccepted: 0,
        baseline: null,
      }),
    ).not.toBeNull();
  });

  it('reads a generic detail for the other kinds and returns null for anything else', () => {
    for (const kind of [
      'fixture_conflict',
      'fixture_missing',
      'cancellation_proposed',
      'score_basis_unknown',
    ] as const) {
      expect(parseReviewPayload(kind, { detail: 'two events match' }), kind).toEqual({
        detail: 'two events match',
      });
      expect(parseReviewPayload(kind, {}), kind).toBeNull();
      expect(parseReviewPayload(kind, null), kind).toBeNull();
      expect(parseReviewPayload(kind, 'detail'), kind).toBeNull();
    }
  });
});
