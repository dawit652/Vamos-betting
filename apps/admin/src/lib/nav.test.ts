import { PERMISSION_ROLES, STAFF_ROLES, permissionsOf } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, canView, homeFor, navFor, permissionForPath } from './nav';

const labels = (role: string) => navFor(permissionsOf(role)).map((i) => i.label);

describe('navigation by role', () => {
  it('every nav permission exists in the RBAC matrix', () => {
    for (const item of NAV_ITEMS) expect(Object.keys(PERMISSION_ROLES)).toContain(item.permission);
  });

  it('admin sees every page', () => {
    expect(labels('admin')).toHaveLength(NAV_ITEMS.length);
  });

  it('support does not see trading, risk, KYC, withdrawals or settings edit pages', () => {
    const support = labels('support');
    expect(support).toContain('Players');
    expect(support).toContain('Bets');
    for (const hidden of ['Trading', 'Risk', 'KYC queue', 'Withdrawals', 'Audit log']) {
      expect(support).not.toContain(hidden);
    }
  });

  it('trader sees trading and risk, finance sees withdrawals, kyc sees the queue', () => {
    expect(labels('trader')).toEqual(expect.arrayContaining(['Trading', 'Risk']));
    expect(labels('finance')).toContain('Withdrawals');
    expect(labels('kyc')).toContain('KYC queue');
    expect(labels('compliance')).toContain('Audit log');
  });

  it('compliance pages follow reports.view and aml.review', () => {
    expect(labels('compliance')).toEqual(expect.arrayContaining(['Reconciliation', 'AML flags']));
    expect(labels('finance')).toContain('Reconciliation');
    expect(labels('finance')).not.toContain('AML flags');
    expect(labels('support')).not.toContain('Reconciliation');
    expect(permissionForPath('/compliance/aml/abc')).toBe('aml.review');
    expect(permissionForPath('/compliance/reconciliation/abc')).toBe('reports.view');
  });

  it('the feed pages follow trading.view', () => {
    for (const role of ['trader', 'admin']) expect(labels(role)).toContain('Feed');
    for (const role of ['support', 'finance', 'compliance', 'kyc'])
      expect(labels(role)).not.toContain('Feed');
    expect(permissionForPath('/feed/review/abc')).toBe('trading.view');
  });

  it('the cashier pages follow cashier.desk and cashier.reports', () => {
    expect(labels('cashier')).toEqual(['Cashier desk']);
    expect(labels('finance')).toEqual(expect.arrayContaining(['Cashier desk', 'Cash shifts']));
    expect(permissionForPath('/cashier')).toBe('cashier.desk');
    expect(permissionForPath('/cashier/receipt/abc')).toBe('cashier.desk');
    expect(permissionForPath('/cashier/shifts')).toBe('cashier.reports');
    expect(permissionForPath('/cashier/shifts/abc/report')).toBe('cashier.reports');
  });

  it('the staff pages follow staff.manage, which only the admin holds', () => {
    expect(labels('admin')).toContain('Staff');
    for (const role of ['finance', 'support', 'cashier'])
      expect(labels(role)).not.toContain('Staff');
    expect(permissionForPath('/staff/abc')).toBe('staff.manage');
  });

  it('homeFor is the first visible page, else the account page', () => {
    expect(homeFor(['cashier.desk'])).toBe('/cashier');
    expect(homeFor(permissionsOf('admin'))).toBe('/');
    expect(homeFor(['dashboard.view', 'cashier.desk'])).toBe('/');
    expect(homeFor([])).toBe('/account');
  });

  it('every role but the cashier sees the dashboard, and an unknown role sees nothing', () => {
    for (const role of STAFF_ROLES.filter((r) => r !== 'cashier'))
      expect(labels(role)).toContain('Dashboard');
    expect(navFor([])).toEqual([]);
  });
});

describe('path permissions', () => {
  it('maps nested paths to the nav entry', () => {
    expect(permissionForPath('/')).toBe('dashboard.view');
    expect(permissionForPath('/trading/abc')).toBe('trading.view');
    expect(permissionForPath('/users/1')).toBe('users.view');
    expect(permissionForPath('/login')).toBeNull();
  });

  it('canView blocks a page the role has no permission for', () => {
    const support = permissionsOf('support');
    expect(canView(support, '/trading/abc')).toBe(false);
    expect(canView(support, '/users')).toBe(true);
    expect(canView(permissionsOf('trader'), '/trading')).toBe(true);
  });
});
