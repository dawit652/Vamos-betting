import { OwnerReportQuery, OwnerReportResponse } from '@vamos/contracts';
import { businessDateOf } from '@vamos/core';
import { getOwnerReport, type OwnerReport } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/errors';
import { wire } from './common';

/**
 * Owner reports (docs/plans/owner-reports.md): GET /admin/reports?period=day|week|month|year&date=
 * (reports.view). The report is recomputed from the ledger in one read-only snapshot (REPEATABLE
 * READ), so its figures and the balances it checks them against belong to the same instant.
 */
export default async function adminReportRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/reports', { config: { staff: 'reports.view' } }, async (request) => {
    const query = parseInput(OwnerReportQuery, request.query);
    const now = deps.clock();
    const report = await deps.db.transaction(
      (tx) =>
        getOwnerReport(tx, { period: query.period, date: query.date ?? businessDateOf(now), now }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return wire(OwnerReportResponse, reportView(report));
  });
}

function reportView(report: OwnerReport) {
  const keys = [...new Set([...report.opening.keys(), ...report.closing.keys()])].sort();
  return {
    period: report.window.period,
    firstDay: report.window.firstDay,
    lastDay: report.window.lastDay,
    start: report.window.start.toISOString(),
    end: report.window.end.toISOString(),
    open: report.open,
    asOf: report.asOf.toISOString(),
    figures: report.figures,
    balances: keys.map((key) => ({
      key,
      opening: report.opening.get(key) ?? 0n,
      closing: report.closing.get(key) ?? 0n,
    })),
    checks: report.checks,
    days: report.days,
    movements: report.totals,
  };
}
