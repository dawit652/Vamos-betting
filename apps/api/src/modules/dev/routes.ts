import { normalizeEthiopianMsisdn } from '@vamos/core';
import { smsMessages } from '@vamos/db/schema';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { badRequest, parseInput } from '../../lib/errors';

/** Dev-only query; there is no public contract for it. */
const DevSmsQuery = z.object({ phone: z.string().trim().min(1).max(32) });

export interface DevSmsResponse {
  items: { to: string; body: string; template: string; createdAt: string }[];
}

/**
 * The dev inbox exists only for local development and tests: demo mode, the
 * mock SMS gateway and NODE_ENV other than production. It shows every code
 * (password resets included) to anyone who asks, so a public deployment, which
 * runs with NODE_ENV=production, never has it.
 */
export function devInboxEnabled(deps: Pick<AppDeps, 'config' | 'sms'>): boolean {
  return (
    deps.config.mode === 'demo' && deps.sms.name === 'mock' && deps.config.nodeEnv !== 'production'
  );
}

/**
 * Local-development helpers. `GET /dev/sms?phone=…` lists the latest 20
 * messages the mock SMS gateway "sent" to that number (newest first), so OTPs
 * can be read without a phone. The phone is required.
 */
export default async function devRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!devInboxEnabled(deps)) return;

  app.get('/dev/sms', async (request): Promise<DevSmsResponse> => {
    const query = parseInput(DevSmsQuery, request.query);
    const to = normalizeEthiopianMsisdn(query.phone);
    if (to === null) throw badRequest('invalid_phone', 'Not an Ethiopian mobile number.');
    const rows = await deps.db
      .select({
        to: smsMessages.to,
        body: smsMessages.body,
        template: smsMessages.template,
        createdAt: smsMessages.createdAt,
      })
      .from(smsMessages)
      .where(eq(smsMessages.to, to))
      .orderBy(desc(smsMessages.createdAt))
      .limit(20);
    return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  });
}
