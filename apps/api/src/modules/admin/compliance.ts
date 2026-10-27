import {
  AmlFlagDetailResponse,
  AmlFlagListResponse,
  AmlFlagQuery,
  ComplianceSettingKeySchema,
  ComplianceSettingsResponse,
  ImportPspStatementRequest,
  ImportPspStatementResponse,
  PspStatementDetailResponse,
  PspStatementListResponse,
  PspStatementQuery,
  ReconciliationRunDetailResponse,
  ReconciliationRunListResponse,
  ReconciliationRequestResponse,
  ReconciliationRunQuery,
  ReviewAmlFlagRequest,
  ReviewAmlFlagResponse,
  RunReconciliationRequest,
  UpdateSettingRequest,
} from '@vamos/contracts';
import {
  getAmlFlag,
  getComplianceSettings,
  getPspStatement,
  getReconciliationRequest,
  getReconciliationRun,
  importPspStatement,
  listAmlFlags,
  listPspStatements,
  listReconciliationRuns,
  reviewAmlFlag,
  requestReconciliation,
  updateComplianceSetting,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

type IdParams = { Params: { id: string } };

/**
 * Body limit of a PSP statement upload: the contract's 5,000,000 characters
 * of CSV, JSON-escaped (quotes and line breaks double) and UTF-8 encoded,
 * with room to spare. Larger bodies are refused with 413 before parsing;
 * the contract then refuses a CSV over 5,000,000 characters (400) and the
 * service one over 20,000 lines (422 invalid_statement).
 */
export const PSP_STATEMENT_BODY_LIMIT = 12 * 1024 * 1024;

/** A query field's value only when it is set (exactOptionalPropertyTypes). */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * The compliance back office (/admin/compliance/*, Phase 10):
 * reconciliation runs (list, detail, run now), PSP statements (list,
 * detail, upload), AML flags (list, detail, review) and the compliance
 * settings. Each route's permission is COMPLIANCE_ROUTE_PERMISSIONS of
 * @vamos/contracts (reports.view: admin, compliance, finance;
 * reconciliation.run: the same; aml.review: admin, compliance). Every
 * change is audited with the staff actor (the services write the audit
 * records).
 */
export default async function adminComplianceRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  // -------------------------------------------------------------------------
  // Reconciliation.

  app.get(
    '/admin/compliance/reconciliation-runs',
    { config: { staff: 'reports.view' } },
    async (request) => {
      const query = parseInput(ReconciliationRunQuery, request.query);
      const page = await listReconciliationRuns(deps.db, {
        ...opt('kind', query.kind),
        ...opt('status', query.status),
        ...opt('cursor', query.cursor),
        limit: query.limit,
      });
      return wire(ReconciliationRunListResponse, page);
    },
  );

  app.get<IdParams>(
    '/admin/compliance/reconciliation-runs/:id',
    { config: { staff: 'reports.view' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Reconciliation run');
      return wire(ReconciliationRunDetailResponse, await getReconciliationRun(deps.db, id));
    },
  );

  /**
   * Runs the reconciliation now, off the request path (kind manual; the
   * payment checks' day defaults to today): queues a request (outbox → the
   * worker's `reconciliation` queue) and answers 202 with it and a Location
   * header; the back office polls GET …/reconciliation-requests/:id, and
   * the run gets the request's id. One request at a time: 409
   * `reconciliation_running` while another is queued or running.
   */
  app.post(
    '/admin/compliance/reconciliation-runs',
    { config: { staff: 'reconciliation.run' } },
    async (request, reply) => {
      const input = parseInput(RunReconciliationRequest, request.body ?? {});
      const actor = staffActor(request);
      const queued = await requestReconciliation(deps.db, {
        now: deps.clock(),
        ...opt('businessDate', input.businessDate),
        actor: { adminId: actor.adminId, ip: actor.ip ?? null },
      });
      return reply
        .code(202)
        .header('location', `/admin/compliance/reconciliation-requests/${queued.id}`)
        .send(wire(ReconciliationRequestResponse, { request: queued }));
    },
  );

  app.get<IdParams>(
    '/admin/compliance/reconciliation-requests/:id',
    { config: { staff: 'reports.view' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Reconciliation request');
      return wire(ReconciliationRequestResponse, {
        request: await getReconciliationRequest(deps.db, id),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PSP statements.

  app.get(
    '/admin/compliance/psp-statements',
    { config: { staff: 'reports.view' } },
    async (request) => {
      const query = parseInput(PspStatementQuery, request.query);
      const page = await listPspStatements(deps.db, {
        ...opt('provider', query.provider),
        ...opt('cursor', query.cursor),
        limit: query.limit,
      });
      return wire(PspStatementListResponse, page);
    },
  );

  app.get<IdParams>(
    '/admin/compliance/psp-statements/:id',
    { config: { staff: 'reports.view' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'PSP statement');
      const { statement, lines } = await getPspStatement(deps.db, id);
      return wire(PspStatementDetailResponse, { statement, lines });
    },
  );

  /**
   * Uploads a PSP statement (JSON { csv, fileName?, provider?, periodFrom?,
   * periodTo? }) and matches it against our deposits and payouts (a
   * reconciliation run of kind psp_statement). 413 above
   * PSP_STATEMENT_BODY_LIMIT; 400 for a CSV over 5,000,000 characters; 422
   * `invalid_statement` for a file that does not parse or has more than
   * 20,000 lines; 409 `statement_already_imported` for the same file twice.
   */
  app.post(
    '/admin/compliance/psp-statements',
    { config: { staff: 'reconciliation.run' }, bodyLimit: PSP_STATEMENT_BODY_LIMIT },
    async (request, reply) => {
      const input = parseInput(ImportPspStatementRequest, request.body);
      const actor = staffActor(request);
      const result = await importPspStatement(deps.db, {
        csv: input.csv,
        fileName: input.fileName ?? null,
        provider: input.provider ?? null,
        periodFrom: input.periodFrom ?? null,
        periodTo: input.periodTo ?? null,
        actor: { adminId: actor.adminId, ip: actor.ip ?? null },
        now: deps.clock(),
      });
      const body = wire(ImportPspStatementResponse, {
        statement: {
          ...result.statement,
          runId: result.run.id,
          status: result.run.status,
          mismatchCount: result.run.mismatchCount,
        },
        lines: result.lines,
        run: result.run,
        mismatches: result.mismatches,
      });
      return reply.code(201).send(body);
    },
  );

  // -------------------------------------------------------------------------
  // AML flags.

  app.get('/admin/compliance/aml-flags', { config: { staff: 'aml.review' } }, async (request) => {
    const query = parseInput(AmlFlagQuery, request.query);
    const page = await listAmlFlags(deps.db, {
      ...opt('status', query.status),
      ...opt('rule', query.rule),
      ...opt('severity', query.severity),
      ...opt('userId', query.userId),
      ...opt('cursor', query.cursor),
      limit: query.limit,
    });
    return wire(AmlFlagListResponse, page);
  });

  app.get<IdParams>(
    '/admin/compliance/aml-flags/:id',
    { config: { staff: 'aml.review' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'AML flag');
      return wire(AmlFlagDetailResponse, await getAmlFlag(deps.db, id));
    },
  );

  /** A compliance review of a flag (audited with the note by the service). */
  app.post<IdParams>(
    '/admin/compliance/aml-flags/:id/review',
    { config: { staff: 'aml.review' } },
    async (request) => {
      const flagId = parseUuid(request.params.id, 'AML flag');
      const input = parseInput(ReviewAmlFlagRequest, request.body);
      const actor = staffActor(request);
      const now = deps.clock();
      const result = await inTx(deps, (tx) =>
        reviewAmlFlag(tx, {
          flagId,
          decision: input.decision,
          note: input.note,
          actor: { adminId: actor.adminId, ip: actor.ip ?? null },
          now,
        }),
      );
      return wire(ReviewAmlFlagResponse, result);
    },
  );

  // -------------------------------------------------------------------------
  // Settings (aml_rules).

  app.get('/admin/compliance/settings', { config: { staff: 'reports.view' } }, async () =>
    wire(ComplianceSettingsResponse, await getComplianceSettings(deps.db)),
  );

  /** The service validates the value (422 `invalid_setting`, details { key, issues }) and audits it. */
  app.put<{ Params: { key: string } }>(
    '/admin/compliance/settings/:key',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const key = ComplianceSettingKeySchema.safeParse(request.params.key);
      if (!key.success) throw notFound('Setting');
      const input = parseInput(UpdateSettingRequest, request.body);
      const actor = staffActor(request);
      const view = await inTx(deps, async (tx) => {
        await updateComplianceSetting(tx, {
          key: key.data,
          value: input.value,
          actor: { adminId: actor.adminId, ip: actor.ip ?? null },
        });
        return getComplianceSettings(tx);
      });
      return wire(ComplianceSettingsResponse, view);
    },
  );
}
