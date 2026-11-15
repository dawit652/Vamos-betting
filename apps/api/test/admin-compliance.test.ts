import {
  AmlFlagListResponse,
  ApiErrorSchema,
  COMPLIANCE_ROUTE_PERMISSIONS,
  ComplianceSettingsResponse,
  ImportPspStatementResponse,
  PERMISSION_ROLES,
  ReconciliationRequestResponse,
  ReconciliationRunDetailResponse,
  ReconciliationRunListResponse,
  ReviewAmlFlagResponse,
  STAFF_ROLES,
  type StaffRole,
} from '@vamos/contracts';
import { businessDateOf } from '@vamos/core';
import { runRequestedReconciliation, schema } from '@vamos/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAdminRoutes } from '../src/modules/admin/common';
import { PSP_STATEMENT_BODY_LIMIT } from '../src/modules/admin/compliance';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  createTestContext,
  registerAndLogin,
  type LoggedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let player: LoggedInUser;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  for (const role of STAFF_ROLES) staff.set(role, await staffLogin(ctx, role));
  player = await registerAndLogin(ctx);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const today = () => businessDateOf(ctx.clock.now);

async function auditActions(action: string, targetId?: string) {
  return ctx.db.db
    .select()
    .from(schema.auditLog)
    .where(
      targetId === undefined
        ? eq(schema.auditLog.action, action)
        : and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)),
    );
}

describe('/admin/compliance RBAC', () => {
  it('registers exactly the contract routes, each with its permission', () => {
    const registered = Object.fromEntries(
      listAdminRoutes(ctx.deps)
        .filter((route) => route.url.startsWith('/admin/compliance'))
        .map((route) => [`${route.method} ${route.url}`, route.access]),
    );
    expect(registered).toEqual(COMPLIANCE_ROUTE_PERMISSIONS);
  });

  it('grants the decided roles: reports and reconciliation to admin, compliance, finance; AML to admin, compliance', () => {
    const sorted = (roles: readonly string[]) => [...roles].sort();
    expect(sorted(PERMISSION_ROLES['reports.view'])).toEqual(['admin', 'compliance', 'finance']);
    expect(sorted(PERMISSION_ROLES['reconciliation.run'])).toEqual([
      'admin',
      'compliance',
      'finance',
    ]);
    expect(sorted(PERMISSION_ROLES['aml.review'])).toEqual(['admin', 'compliance']);
  });

  it('answers 401 without a staff session (or with a player one) and 403 to roles without the permission', async () => {
    const table: Array<[method: 'GET' | 'POST', url: string, allowed: StaffRole[]]> = [
      ['GET', '/admin/compliance/reconciliation-runs', ['admin', 'compliance', 'finance']],
      ['GET', '/admin/compliance/psp-statements', ['admin', 'compliance', 'finance']],
      ['GET', '/admin/compliance/settings', ['admin', 'compliance', 'finance']],
      ['GET', '/admin/compliance/aml-flags', ['admin', 'compliance']],
    ];
    for (const [method, url, allowed] of table) {
      expect((await ctx.app.inject({ method, url })).statusCode, url).toBe(401);
      const asPlayer = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${player.sessionToken}` },
      });
      expect(asPlayer.statusCode, url).toBe(401);
      for (const role of STAFF_ROLES) {
        const response = await asStaff(ctx, as(role), method, url);
        const label = `${role} ${method} ${url}`;
        if (allowed.includes(role)) {
          expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
        } else {
          expect(response.statusCode, label).toBe(403);
          expect(ApiErrorSchema.parse(response.json()).error.code).toBe('forbidden');
        }
      }
    }
  });
});

describe('reconciliation', () => {
  it('queues "Run now" (202), the worker runs it under the request id, one at a time', async () => {
    const accepted = await asStaff(
      ctx,
      as('finance'),
      'POST',
      '/admin/compliance/reconciliation-runs',
      {},
    );
    expect(accepted.statusCode, accepted.body).toBe(202);
    const { request } = ReconciliationRequestResponse.parse(accepted.json());
    expect(request).toMatchObject({
      status: 'queued',
      businessDate: today(),
      requestedBy: as('finance').id,
      runId: null,
    });
    expect(accepted.headers.location).toBe(
      `/admin/compliance/reconciliation-requests/${request.id}`,
    );
    expect(await auditActions('reconciliation.requested', request.id)).toHaveLength(1);
    // The request handler did not run the checks: no run exists yet.
    const notYet = await asStaff(
      ctx,
      as('admin'),
      'GET',
      `/admin/compliance/reconciliation-runs/${request.id}`,
    );
    expect(notYet.statusCode).toBe(404);

    // Another "Run now" while it is queued: 409.
    const busy = await asStaff(
      ctx,
      as('admin'),
      'POST',
      '/admin/compliance/reconciliation-runs',
      {},
    );
    expect(busy.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(busy.json()).error.code).toBe('reconciliation_running');

    // What the worker's `reconciliation` job does.
    await runRequestedReconciliation(ctx.deps.db, { requestId: request.id, now: ctx.clock.now });
    const polled = await asStaff(
      ctx,
      as('compliance'),
      'GET',
      `/admin/compliance/reconciliation-requests/${request.id}`,
    );
    expect(polled.statusCode).toBe(200);
    expect(ReconciliationRequestResponse.parse(polled.json()).request).toMatchObject({
      status: 'done',
      runId: request.id,
      attempts: 1,
    });
    const shown = await asStaff(
      ctx,
      as('admin'),
      'GET',
      `/admin/compliance/reconciliation-runs/${request.id}`,
    );
    expect(shown.statusCode).toBe(200);
    const detail = ReconciliationRunDetailResponse.parse(shown.json());
    expect(detail.run).toMatchObject({
      id: request.id,
      kind: 'manual',
      triggeredBy: as('finance').id,
      businessDate: today(),
    });
    expect(await auditActions('reconciliation.run', request.id)).toHaveLength(1);
    const list = ReconciliationRunListResponse.parse(
      (await asStaff(ctx, as('compliance'), 'GET', '/admin/compliance/reconciliation-runs')).json(),
    );
    expect(list.items.map((item) => item.id)).toContain(request.id);

    const unknown = await asStaff(
      ctx,
      as('admin'),
      'GET',
      '/admin/compliance/reconciliation-requests/00000000-0000-4000-8000-000000000000',
    );
    expect(unknown.statusCode).toBe(404);
    const badDate = await asStaff(
      ctx,
      as('admin'),
      'POST',
      '/admin/compliance/reconciliation-runs',
      {
        businessDate: '2026-13-01',
      },
    );
    expect(badDate.statusCode).toBe(400);
  });
});

describe('PSP statement upload', () => {
  const header = 'provider,reference,amount,date';

  it('imports a statement and reports a line matching nothing; the same file twice is a 409', async () => {
    const csv = `${header}\nmock,unknown-ref-${Date.now()},12.50,${today()}\n`;
    const upload = await asStaff(ctx, as('finance'), 'POST', '/admin/compliance/psp-statements', {
      csv,
      fileName: 'mock.csv',
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const body = ImportPspStatementResponse.parse(upload.json());
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ matchStatus: 'unmatched', amount: '1250' });
    expect(body.run.status).toBe('mismatches');
    expect(body.statement).toMatchObject({ runId: body.run.id, status: 'mismatches' });

    const again = await asStaff(ctx, as('finance'), 'POST', '/admin/compliance/psp-statements', {
      csv,
    });
    expect(again.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(again.json()).error.code).toBe('statement_already_imported');

    const shown = await asStaff(
      ctx,
      as('compliance'),
      'GET',
      `/admin/compliance/psp-statements/${body.statement.id}`,
    );
    expect(shown.statusCode).toBe(200);
    const support = await asStaff(ctx, as('support'), 'POST', '/admin/compliance/psp-statements', {
      csv,
    });
    expect(support.statusCode).toBe(403);
  });

  it('refuses bodies over the size limit, CSVs over 5,000,000 characters or 20,000 lines, and unreadable files', async () => {
    const tooBig = await asStaff(
      ctx,
      as('admin'),
      'POST',
      '/admin/compliance/psp-statements',
      JSON.stringify({ csv: 'x'.repeat(PSP_STATEMENT_BODY_LIMIT) }),
      { 'content-type': 'application/json' },
    );
    expect(tooBig.statusCode).toBe(413);

    const long = await asStaff(ctx, as('admin'), 'POST', '/admin/compliance/psp-statements', {
      csv: `${header}\n${'x'.repeat(5_000_001)}`,
    });
    expect(long.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(long.json()).error.code).toBe('validation_error');

    const lines = Array.from({ length: 20_001 }, (_, i) => `mock,many-${i},1.00,${today()}`);
    const many = await asStaff(ctx, as('admin'), 'POST', '/admin/compliance/psp-statements', {
      csv: `${header}\n${lines.join('\n')}\n`,
    });
    expect(many.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(many.json()).error.code).toBe('invalid_statement');

    for (const csv of ['', 'no,header,here\n1,2,3\n', `${header}\nmock,ref,-x,${today()}\n`]) {
      const response = await asStaff(ctx, as('admin'), 'POST', '/admin/compliance/psp-statements', {
        csv,
      });
      expect([400, 422], csv).toContain(response.statusCode);
    }
    const bad = await asStaff(ctx, as('admin'), 'POST', '/admin/compliance/psp-statements', {
      csv: `${header}\nmock,ref-bad,abc,${today()}\n`,
    });
    expect(bad.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(bad.json()).error).toMatchObject({
      code: 'invalid_statement',
      details: { errors: [{ lineNo: 2 }] },
    });
  });
});

describe('AML flags', () => {
  it('lists flags to compliance only and records a review (audited) once', async () => {
    const [flag] = await ctx.db.db
      .insert(schema.amlFlags)
      .values({
        userId: player.userId,
        rule: 'deposit_velocity',
        severity: 'medium',
        windowKey: today(),
        details: { count: 6 },
        triggeredAt: ctx.clock.now,
        source: 'event',
        createdAt: ctx.clock.now,
        updatedAt: ctx.clock.now,
      })
      .returning();
    const list = await asStaff(
      ctx,
      as('compliance'),
      'GET',
      `/admin/compliance/aml-flags?status=open&userId=${player.userId}`,
    );
    expect(list.statusCode).toBe(200);
    expect(AmlFlagListResponse.parse(list.json()).items.map((item) => item.id)).toEqual([flag!.id]);
    expect(
      (await asStaff(ctx, as('finance'), 'GET', `/admin/compliance/aml-flags/${flag!.id}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await asStaff(ctx, as('compliance'), 'GET', `/admin/compliance/aml-flags/${flag!.id}`))
        .statusCode,
    ).toBe(200);

    const url = `/admin/compliance/aml-flags/${flag!.id}/review`;
    const noNote = await asStaff(ctx, as('compliance'), 'POST', url, { decision: 'dismissed' });
    expect(noNote.statusCode).toBe(400);
    const review = await asStaff(ctx, as('compliance'), 'POST', url, {
      decision: 'dismissed',
      note: 'Salary deposits, documented.',
    });
    expect(review.statusCode, review.body).toBe(200);
    expect(ReviewAmlFlagResponse.parse(review.json())).toMatchObject({
      changed: true,
      flag: { status: 'dismissed', reviewedBy: as('compliance').id },
    });
    const same = await asStaff(ctx, as('compliance'), 'POST', url, {
      decision: 'dismissed',
      note: 'again',
    });
    expect(ReviewAmlFlagResponse.parse(same.json()).changed).toBe(false);
    const closed = await asStaff(ctx, as('admin'), 'POST', url, {
      decision: 'escalated',
      note: 'too late',
    });
    expect(closed.statusCode).toBe(409);
    expect(await auditActions('aml.flag_reviewed', flag!.id)).toHaveLength(1);
    expect(
      (await asStaff(ctx, as('compliance'), 'GET', '/admin/compliance/aml-flags/nope')).statusCode,
    ).toBe(404);
  });
});

describe('compliance settings', () => {
  it('reads the compliance settings and lets only settings.edit change them (audited)', async () => {
    const read = await asStaff(ctx, as('finance'), 'GET', '/admin/compliance/settings');
    const { amlRules } = ComplianceSettingsResponse.parse(read.json()).settings;
    expect(amlRules.enabled).toBe(true);
    const url = '/admin/compliance/settings/aml_rules';
    const value = { ...amlRules, enabled: false };
    expect((await asStaff(ctx, as('compliance'), 'PUT', url, { value })).statusCode).toBe(403);
    const changed = await asStaff(ctx, as('admin'), 'PUT', url, { value });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(ComplianceSettingsResponse.parse(changed.json()).settings.amlRules.enabled).toBe(false);
    expect(await auditActions('settings.updated', 'aml_rules')).toHaveLength(1);
    const invalid = await asStaff(ctx, as('admin'), 'PUT', url, {
      value: { ...amlRules, depositVelocity: { ...amlRules.depositVelocity, maxPerHour: -1 } },
    });
    expect(invalid.statusCode).toBe(422);
    for (const key of ['els_commission', 'tax']) {
      expect(
        (await asStaff(ctx, as('admin'), 'PUT', `/admin/compliance/settings/${key}`, { value: {} }))
          .statusCode,
      ).toBe(404);
    }
  });
});
