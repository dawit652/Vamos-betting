import { normalizeEthiopianMsisdn } from '@vamos/core';
import { smsMessages } from '@vamos/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { badRequest, parseInput } from '../../lib/errors';

/** Dev-only query; there is no public contract for it. */
const DevSmsQuery = z.object({ phone: z.string().trim().min(1).max(32).optional() });

export interface DevSmsResponse {
  items: { to: string; body: string; template: string; createdAt: string }[];
}

/** The dev inbox exists only in demo mode with the mock SMS gateway. */
export function devInboxEnabled(deps: Pick<AppDeps, 'config' | 'sms'>): boolean {
  return deps.config.mode === 'demo' && deps.sms.name === 'mock';
}

/**
 * Demo-mode helpers. `GET /dev/sms?phone=…` lists the latest 20 messages the
 * mock SMS gateway "sent" (newest first), so OTPs can be read without a phone.
 */
export default async function devRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!devInboxEnabled(deps)) return;

  app.get('/dev/sms', async (request): Promise<DevSmsResponse> => {
    const query = parseInput(DevSmsQuery, request.query);
    let to: string | undefined;
    if (query.phone !== undefined) {
      const phone = normalizeEthiopianMsisdn(query.phone);
      if (phone === null) throw badRequest('invalid_phone', 'Not an Ethiopian mobile number.');
      to = phone;
    }
    const rows = await deps.db
      .select({
        to: smsMessages.to,
        body: smsMessages.body,
        template: smsMessages.template,
        createdAt: smsMessages.createdAt,
      })
      .from(smsMessages)
      .where(to === undefined ? undefined : eq(smsMessages.to, to))
      .orderBy(desc(smsMessages.createdAt))
      .limit(20);
    return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });
}
