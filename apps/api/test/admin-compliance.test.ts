import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AmlFlagListResponse,
  ApiErrorSchema,
  COMPLIANCE_ROUTE_PERMISSIONS,
  ComplianceSettingsResponse,
  ElsReportStatusResponse,
  ImportPspStatementResponse,
  PERMISSION_ROLES,
  ReconciliationRunDetailResponse,
  ReconciliationRunListResponse,
  RecomputeDailySummaryResponse,
  ReviewAmlFlagResponse,
  STAFF_ROLES,
  type StaffRole,
} from '@vamos/contracts';
import { addBusinessDays, businessDateOf } from '@vamos/core';
import { schema } from '@vamos/db';
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
let dir: string;
let player: LoggedInUser;
const staff = new Map<StaffRole, StaffSession>();
const as = (role: StaffRole) => staff.get(role)!;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vamos-els-api-'));
  ctx = await createTestContext({ ELS_REPORT_DIR: dir });
  await seedStaff(ctx);
  for (const role of STAFF_ROLES) staff.set(role, await staffLogin(ctx, role));
  player = await registerAndLogin(ctx);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
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
      ['GET', '/admin/compliance/daily-summaries', ['admin', 'compliance', 'finance']],
      ['GET', '/admin/compliance/els', ['admin', 'compliance', 'finance']],
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

describe('daily summaries', () => {
  it('recomputes a day (audited) and downloads the CSV with download headers', async () => {
    const date = today();
    const support = await asStaff(
      ctx,
      as('support'),
      'POST',
      `/admin/compliance/daily-summaries/${date}/recompute`,
    );
    expect(support.statusCode).toBe(403);

    const recompute = await asStaff(
      ctx,
      as('finance'),
      'POST',
      `/admin/compliance/daily-summaries/${date}/recompute`,
    );
    expect(recompute.statusCode, recompute.body).toBe(200);
    const body = RecomputeDailySummaryResponse.parse(recompute.json());
    expect(body.summary).toMatchObject({ businessDate: date, status: 'provisional' });
    expect(['created', 'recomputed', 'unchanged']).toContain(body.outcome);
    const audits = await auditActions('compliance.daily_summary_recomputed', date);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'admin', actorId: as('finance').id });

    const detail = await asStaff(
      ctx,
      as('compliance'),
      'GET',
      `/admin/compliance/daily-summaries/${date}`,
    );
    expect(detail.statusCode).toBe(200);

    const csv = await asStaff(
      ctx,
      as('compliance'),
      'GET',
      `/admin/compliance/daily-summaries.csv?from=${addBusinessDays(date, -1)}&to=${date}`,
    );
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="vamos-daily-summaries-${addBusinessDays(date, -1)}-to-${date}.csv"`,
    );
    expect(csv.headers['cache-control']).toBe('no-store');
    const rows = csv.body.trim().split('\n');
    expect(rows).toHaveLength(2); // the header and today's row
    expect(rows[1]).toContain(date);
  });

  it('refuses bad ranges and unknown days', async () => {
    const date = today();
    const reversed = await asStaff(
      ctx,
      as('admin'),
      'GET',
      `/admin/compliance/daily-summaries.csv?from=${date}&to=${addBusinessDays(date, -1)}`,
    );
    expect(reversed.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(reversed.json()).error.code).toBe('invalid_range');
    const missing = await asStaff(ctx, as('admin'), 'GET', '/admin/compliance/daily-summaries.csv');
    expect(missing.statusCode).toBe(400);
    for (const url of [
      '/admin/compliance/daily-summaries/2026-02-30',
      '/admin/compliance/daily-summaries/not-a-date',
      '/admin/compliance/daily-summaries/1999-01-01',
    ]) {
      expect((await asStaff(ctx, as('admin'), 'GET', url)).statusCode, url).toBe(404);
    }
    const future = await asStaff(
      ctx,
      as('admin'),
      'POST',
      `/admin/compliance/daily-summaries/${addBusinessDays(date, 5)}/recompute`,
    );
    expect(future.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(future.json()).error.code).toBe('summary_not_started');
  });
});

describe('reconciliation', () => {
  it('runs now (manual, audited), lists and shows the run, one staff run at a time', async () => {
    const run = await asStaff(
      ctx,
      as('finance'),
      'POST',
      '/admin/compliance/reconciliation-runs',
      {},
    );
    expect(run.statusCode, run.body).toBe(201);
    const detail = ReconciliationRunDetailResponse.parse(run.json());
    expect(detail.run).toMatchObject({
      kind: 'manual',
      triggeredBy: as('finance').id,
      businessDate: today(),
    });
    expect(await auditActions('reconciliation.run', detail.run.id)).toHaveLength(1);

    const list = ReconciliationRunListResponse.parse(
      (await asStaff(ctx, as('compliance'), 'GET', '/admin/compliance/reconciliation-runs')).json(),
    );
    expect(list.items.map((item) => item.id)).toContain(detail.run.id);
    const shown = await asStaff(
      ctx,
      as('admin'),
      'GET',
      `/admin/compliance/reconciliation-runs/${detail.run.id}`,
    );
    expect(shown.statusCode).toBe(200);

    const key = 'vamos:lock:compliance:reconciliation-manual';
    await ctx.deps.redis.set(key, 'someone-else', 'PX', 60_000);
    try {
      const busy = await asStaff(
        ctx,
        as('admin'),
        'POST',
        '/admin/compliance/reconciliation-runs',
        {},
      );
      expect(busy.statusCode).toBe(409);
      expect(ApiErrorSchema.parse(busy.json()).error.code).toBe('reconciliation_running');
    } finally {
      await ctx.deps.redis.del(key);
    }
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

describe('ELS status and settings', () => {
  it('shows the configured reporter and the stream counts', async () => {
    const response = await asStaff(ctx, as('finance'), 'GET', '/admin/compliance/els');
    expect(response.statusCode).toBe(200);
    const body = ElsReportStatusResponse.parse(response.json());
    expect(body.reporter).toMatchObject({ mode: 'file', target: dir });
  });

  it('reads the compliance settings and lets only settings.edit change them (audited)', async () => {
    const read = await asStaff(ctx, as('finance'), 'GET', '/admin/compliance/settings');
    expect(ComplianceSettingsResponse.parse(read.json()).settings.elsCommission.rateBps).toBe(1500);
    const url = '/admin/compliance/settings/els_commission';
    expect(
      (await asStaff(ctx, as('compliance'), 'PUT', url, { value: { rateBps: 1000 } })).statusCode,
    ).toBe(403);
    const changed = await asStaff(ctx, as('admin'), 'PUT', url, { value: { rateBps: 1000 } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(ComplianceSettingsResponse.parse(changed.json()).settings.elsCommission.rateBps).toBe(
      1000,
    );
    const invalid = await asStaff(ctx, as('admin'), 'PUT', url, { value: { rateBps: 20_000 } });
    expect(invalid.statusCode).toBe(422);
    expect(
      (await asStaff(ctx, as('admin'), 'PUT', '/admin/compliance/settings/tax', { value: {} }))
        .statusCode,
    ).toBe(404);
  });
});
