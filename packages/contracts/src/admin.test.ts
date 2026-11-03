import { describe, expect, it } from 'vitest';
import {
  FeedResultActionRequest,
  FeedStatusResponse,
  hasPermission,
  KycReviewRequest,
  PERMISSION_ROLES,
  permissionsOf,
  ResultEventRequest,
  SettlePayoutRequest,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  STAFF_SETTING_VALUE_SCHEMAS,
  StaffBetQuery,
  StaffLoginRequest,
  StaffWithdrawalQuery,
  TradingEventQuery,
  UpdateFeedLeagueRequest,
  VoidRequest,
} from './admin';

describe('the staff permission matrix', () => {
  it('names only known roles, and gives admin every permission', () => {
    for (const permission of STAFF_PERMISSIONS) {
      const roles = PERMISSION_ROLES[permission];
      expect(roles.length, permission).toBeGreaterThan(0);
      for (const role of roles) expect(STAFF_ROLES).toContain(role);
      expect(roles, permission).toContain('admin');
    }
    expect(permissionsOf('admin')).toEqual([...STAFF_PERMISSIONS]);
  });

  it('matches the agreed role design', () => {
    const holders = (permission: (typeof STAFF_PERMISSIONS)[number]) =>
      [...PERMISSION_ROLES[permission]].sort();
    expect(holders('dashboard.view')).toEqual([...STAFF_ROLES].sort());
    expect(holders('kyc.review')).toEqual(['admin', 'kyc']);
    for (const permission of [
      'trading.view',
      'trading.odds',
      'trading.status',
      'trading.result',
      'trading.void',
      'jackpots.manage',
    ] as const) {
      expect(holders(permission), permission).toEqual(['admin', 'trader']);
    }
    expect(holders('feed.manage')).toEqual(['admin', 'trader']);
    expect(holders('risk.view')).toEqual(['admin', 'compliance', 'trader']);
    expect(holders('bets.view')).toEqual(['admin', 'compliance', 'finance', 'support', 'trader']);
    expect(holders('withdrawals.approve')).toEqual(['admin', 'finance']);
    expect(holders('settings.edit')).toEqual(['admin']);
    expect(holders('audit.view')).toEqual(['admin', 'compliance']);
    expect(holders('staff.manage')).toEqual(['admin']);
    expect(holders('users.view')).toContain('support');
    // Phase 10: compliance and admin; finance may view reports and run reconciliation.
    expect(holders('reports.view')).toEqual(['admin', 'compliance', 'finance']);
    expect(holders('reconciliation.run')).toEqual(['admin', 'compliance', 'finance']);
    expect(holders('aml.review')).toEqual(['admin', 'compliance']);
  });

  it('keeps support away from trading, money and settings changes', () => {
    const support = permissionsOf('support');
    expect(support.some((permission) => permission.startsWith('trading.'))).toBe(false);
    expect(support).not.toContain('withdrawals.approve');
    expect(support).not.toContain('settings.edit');
    expect(support).toContain('users.view');
    expect(support).toContain('bets.view');
  });

  it('answers false for unknown roles and permissions', () => {
    expect(hasPermission('root', 'dashboard.view')).toBe(false);
    expect(hasPermission('admin', 'everything')).toBe(false);
    expect(hasPermission('admin', 'constructor')).toBe(false);
    expect(hasPermission('admin', 'toString')).toBe(false);
    expect(permissionsOf('nobody')).toEqual([]);
  });
});

describe('admin request contracts', () => {
  it('needs a 6-digit code to sign in', () => {
    expect(
      StaffLoginRequest.safeParse({ email: 'a@b.et', password: 'x', code: ' 123456 ' }).success,
    ).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      expect(StaffLoginRequest.safeParse({ email: 'a@b.et', password: 'x', code }).success).toBe(
        false,
      );
    }
  });

  it('needs a reason to reject, void, fail a payout or correct', () => {
    expect(KycReviewRequest.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(KycReviewRequest.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(KycReviewRequest.safeParse({ decision: 'reject', reason: '  ' }).success).toBe(false);
    expect(VoidRequest.safeParse({ reason: 'Palpable error' }).success).toBe(true);
    expect(VoidRequest.safeParse({}).success).toBe(false);
    expect(SettlePayoutRequest.safeParse({ outcome: 'paid' }).success).toBe(true);
    expect(SettlePayoutRequest.safeParse({ outcome: 'failed' }).success).toBe(false);
    expect(
      ResultEventRequest.safeParse({ status: 'finished', score: { home: 2, away: 1 } }).success,
    ).toBe(true);
    expect(ResultEventRequest.safeParse({ status: 'finished' }).success).toBe(false);
    expect(ResultEventRequest.safeParse({ status: 'cancelled' }).success).toBe(true);
    expect(
      ResultEventRequest.safeParse({ status: 'finished', score: { home: -1, away: 0 } }).success,
    ).toBe(false);
  });

  it('reads list filters from query strings', () => {
    expect(TradingEventQuery.parse({ status: 'live,scheduled', limit: '10' })).toMatchObject({
      status: ['live', 'scheduled'],
      limit: 10,
    });
    expect(StaffBetQuery.parse({ status: ['open', 'won'] }).status).toEqual(['open', 'won']);
    expect(StaffBetQuery.safeParse({ status: 'open,bogus' }).success).toBe(false);
    expect(StaffBetQuery.safeParse({ minStake: '-5' }).success).toBe(false);
    expect(StaffWithdrawalQuery.parse({ flagged: 'true' })).toMatchObject({
      flagged: true,
      order: 'asc',
      limit: 50,
    });
  });

  it('refuses a minimum age below 21 and negative money in settings', () => {
    expect(STAFF_SETTING_VALUE_SCHEMAS.responsible_gambling.safeParse({ minAge: 18 }).success).toBe(
      false,
    );
    expect(STAFF_SETTING_VALUE_SCHEMAS.responsible_gambling.safeParse({ minAge: 21 }).success).toBe(
      true,
    );
    expect(
      STAFF_SETTING_VALUE_SCHEMAS.tax.safeParse({
        rateBps: 1500,
        base: 'net_winnings',
        exemptBelow: '-1',
      }).success,
    ).toBe(false);
  });
});

describe('the feed contracts', () => {
  it('accepts a league change with an enabled flag and/or a margin of 0..3000 (null: the default)', () => {
    for (const body of [
      { enabled: true },
      { marginBps: 0 },
      { marginBps: 3000 },
      { marginBps: null },
      { enabled: false, marginBps: 650 },
    ]) {
      expect(UpdateFeedLeagueRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('refuses an empty change, a margin out of range or fractional, and a non-boolean flag', () => {
    for (const body of [
      {},
      { marginBps: 3001 },
      { marginBps: -1 },
      { marginBps: 1.5 },
      { enabled: 'yes' },
    ]) {
      expect(UpdateFeedLeagueRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('trims the optional reason of accept / void and caps it at 500 characters', () => {
    expect(FeedResultActionRequest.parse({ reason: '  checked  ' })).toEqual({ reason: 'checked' });
    expect(FeedResultActionRequest.parse({})).toEqual({});
    expect(FeedResultActionRequest.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('parses a status with no quota yet', () => {
    expect(
      FeedStatusResponse.safeParse({
        provider: 'theoddsapi',
        quota: null,
        creditsLast24h: 0,
        creditsLast30d: 0,
        leagues: [],
      }).success,
    ).toBe(true);
  });
});
