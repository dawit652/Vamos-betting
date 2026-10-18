import { AuditLogQuery, AuditLogResponse } from '@vamos/contracts';
import { listAuditLog } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/errors';
import { optionalDate, wire } from './common';

/** The audit log viewer (audit.view): newest first, cursor paging. */
export default async function adminAuditRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/audit', { config: { staff: 'audit.view' } }, async (request) => {
    const query = parseInput(AuditLogQuery, request.query);
    const nonEmpty = (value: string | undefined) =>
      value === undefined || value === '' ? undefined : value;
    const page = await listAuditLog(deps.db, {
      ...(query.actorType === undefined ? {} : { actorType: query.actorType }),
      ...(nonEmpty(query.actorId) === undefined ? {} : { actorId: query.actorId }),
      ...(nonEmpty(query.action) === undefined ? {} : { action: query.action }),
      ...(nonEmpty(query.targetType) === undefined ? {} : { targetType: query.targetType }),
      ...(nonEmpty(query.targetId) === undefined ? {} : { targetId: query.targetId }),
      ...(query.from === undefined ? {} : { from: optionalDate(query.from) }),
      ...(query.to === undefined ? {} : { to: optionalDate(query.to) }),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return wire(AuditLogResponse, page);
  });
}
