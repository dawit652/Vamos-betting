import { describe, expect, it } from 'vitest';
import {
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
    // The cashier (a shop's desk, 17 Nov 2026) sees no business totals.
    expect(holders('dashboard.view')).toEqual(
      [...STAFF_ROLES].filter((role) => role !== 'cashier').sort(),
    );
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
    // The cashier desk: supervisors may work a desk; reports for finance and compliance.
    expect(holders('cashier.desk')).toEqual(['admin', 'cashier', 'finance']);
    expect(holders('cashier.reports')).toEqual(['admin', 'compliance', 'finance']);
    expect(permissionsOf('cashier')).toEqual(['cashier.desk']);
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
