import { PERMISSION_ROLES, STAFF_ROLES, permissionsOf } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, canView, navFor, permissionForPath } from './nav';

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
    for (const hidden of ['Trading', 'Feed', 'Risk', 'KYC queue', 'Withdrawals', 'Audit log']) {
      expect(support).not.toContain(hidden);
    }
  });

  it('trader sees trading and risk, finance sees withdrawals, kyc sees the queue', () => {
    expect(labels('trader')).toEqual(expect.arrayContaining(['Trading', 'Feed', 'Risk']));
    expect(labels('finance')).toContain('Withdrawals');
    expect(labels('kyc')).toContain('KYC queue');
    expect(labels('compliance')).toContain('Audit log');
  });

  it('compliance pages follow reports.view and aml.review', () => {
    expect(labels('compliance')).toEqual(
      expect.arrayContaining(['Daily summaries', 'Reconciliation', 'AML flags']),
    );
    expect(labels('finance')).toEqual(
      expect.arrayContaining(['Daily summaries', 'Reconciliation']),
    );
    expect(labels('finance')).not.toContain('AML flags');
    expect(labels('support')).not.toContain('Daily summaries');
    expect(permissionForPath('/compliance/aml/abc')).toBe('aml.review');
    expect(permissionForPath('/compliance/reconciliation/abc')).toBe('reports.view');
    expect(permissionForPath('/compliance/summaries/2026-10-01')).toBe('reports.view');
  });

  it('every role sees the dashboard, and an unknown role sees nothing', () => {
    for (const role of STAFF_ROLES) expect(labels(role)).toContain('Dashboard');
    expect(navFor([])).toEqual([]);
  });
});

describe('path permissions', () => {
  it('maps nested paths to the nav entry', () => {
    expect(permissionForPath('/')).toBe('dashboard.view');
    expect(permissionForPath('/trading/abc')).toBe('trading.view');
    expect(permissionForPath('/feed')).toBe('trading.view');
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
