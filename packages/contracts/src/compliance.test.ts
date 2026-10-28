import { describe, expect, it } from 'vitest';
import { hasPermission, STAFF_PERMISSIONS } from './admin';
import {
  AmlFlagQuery,
  AmlRulesView,
  BusinessDate,
  COMPLIANCE_ROUTE_PERMISSIONS,
  COMPLIANCE_SETTING_VALUE_SCHEMAS,
  ImportPspStatementRequest,
  ReviewAmlFlagRequest,
} from './compliance';

describe('compliance routes', () => {
  it('guards every route with a known permission', () => {
    for (const [route, permission] of Object.entries(COMPLIANCE_ROUTE_PERMISSIONS)) {
      expect(STAFF_PERMISSIONS, route).toContain(permission);
      expect(route).toMatch(/^(GET|POST|PUT) \/admin\/compliance\//);
    }
  });

  it('lets compliance and admin do everything, finance report and reconcile, others nothing', () => {
    for (const [route, permission] of Object.entries(COMPLIANCE_ROUTE_PERMISSIONS)) {
      expect(hasPermission('admin', permission), route).toBe(true);
      expect(hasPermission('support', permission), route).toBe(false);
      expect(hasPermission('trader', permission), route).toBe(false);
      expect(hasPermission('kyc', permission), route).toBe(false);
      if (permission !== 'settings.edit') {
        expect(hasPermission('compliance', permission), route).toBe(true);
      }
    }
    expect(hasPermission('finance', 'reports.view')).toBe(true);
    expect(hasPermission('finance', 'reconciliation.run')).toBe(true);
    expect(hasPermission('finance', 'aml.review')).toBe(false);
  });
});

describe('compliance request contracts', () => {
  it('reads real business dates only', () => {
    expect(BusinessDate.safeParse('2026-10-18').success).toBe(true);
    expect(BusinessDate.safeParse('2028-02-29').success).toBe(true);
    for (const text of ['2026-02-30', '2026-13-01', '18-10-2026', '', '1969-12-31']) {
      expect(BusinessDate.safeParse(text).success, text).toBe(false);
    }
  });

  it('needs a note to review an AML flag, and reads status lists', () => {
    expect(ReviewAmlFlagRequest.safeParse({ decision: 'dismissed', note: 'Salary' }).success).toBe(
      true,
    );
    expect(ReviewAmlFlagRequest.safeParse({ decision: 'dismissed', note: '  ' }).success).toBe(
      false,
    );
    expect(ReviewAmlFlagRequest.safeParse({ decision: 'open', note: 'x' }).success).toBe(false);
    expect(AmlFlagQuery.parse({ status: 'open,escalated' }).status).toEqual(['open', 'escalated']);
    expect(AmlFlagQuery.safeParse({ status: 'open,bogus' }).success).toBe(false);
  });

  it('takes a statement as CSV text with an optional provider and period', () => {
    expect(
      ImportPspStatementRequest.safeParse({ csv: 'provider,reference,amount,date\n' }).success,
    ).toBe(true);
    expect(ImportPspStatementRequest.safeParse({ csv: '' }).success).toBe(false);
    expect(ImportPspStatementRequest.safeParse({ csv: 'x', provider: 'Chapa!' }).success).toBe(
      false,
    );
  });

  it('validates the compliance settings', () => {
    const rules = {
      enabled: true,
      holdWithdrawalsOnHighSeverity: true,
      depositVelocity: { enabled: true, severity: 'medium', maxPerHour: 5, maxPerDay: 10 },
      withdrawalVelocity: { enabled: true, severity: 'medium', maxPerHour: 3, maxPerDay: 5 },
      structuring: {
        enabled: true,
        severity: 'high',
        reportingThreshold: '10000000',
        nearThresholdBps: 9000,
        minNearCount: 2,
        windowHours: 24,
      },
      depositThenWithdraw: {
        enabled: true,
        severity: 'high',
        minStakeShareBps: 5000,
        minDeposit: '100000',
      },
      cashOutChurn: {
        enabled: true,
        severity: 'medium',
        windowHours: 24,
        minCount: 5,
        maxMinutesAfterPlacement: 10,
      },
    };
    expect(AmlRulesView.safeParse(rules).success).toBe(true);
    expect(
      AmlRulesView.safeParse({
        ...rules,
        depositVelocity: { ...rules.depositVelocity, maxPerHour: 11 },
      }).success,
    ).toBe(false);
    expect(
      AmlRulesView.safeParse({
        ...rules,
        structuring: { ...rules.structuring, reportingThreshold: '0' },
      }).success,
    ).toBe(false);
    expect(Object.keys(COMPLIANCE_SETTING_VALUE_SCHEMAS)).toEqual(['aml_rules']);
  });
});
