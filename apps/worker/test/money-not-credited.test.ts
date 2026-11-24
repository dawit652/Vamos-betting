import { createHash, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { schema } from '@vamos/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMoneyNotCreditedLine } from '../src/tasks/money-not-credited';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

/** The owner's daily "money not credited" line (counter codes plan, G6). */

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
});

describe('the daily money-not-credited line', () => {
  it(
    'goes once a day from 09:00 in Addis Ababa, only while money waits',
    async () => {
      const real = t.clock.now;
      const alerts = {
        ...t.ctx,
        ownerAlerts: { phones: ['+251911000001'], minIntervalMinutes: 30 },
      };
      try {
        // Nothing waits: nothing is said.
        t.clock.set(new Date('2026-11-23T07:00:00Z')); // 10:00 in Addis Ababa
        expect(await runMoneyNotCreditedLine(alerts)).toEqual({ raised: false, count: 0 });

        const text = `credit ${randomUUID()}`;
        const at = new Date('2026-11-21T08:00:00Z');
        await t.db.db.insert(schema.receivedSms).values({
          source: 'gateway',
          sender: 'telebirr',
          rawText: text,
          textHash: createHash('sha256').update(text).digest('hex'),
          institution: 'telebirr',
          direction: 'credit',
          amount: birr(250),
          reference: `R${randomUUID().slice(0, 10)}`,
          occurredAt: at,
          receivedAt: at,
          status: 'unmatched',
          createdAt: at,
          updatedAt: at,
        });
        // Before 09:00 in Addis Ababa: not yet.
        t.clock.set(new Date('2026-11-23T05:30:00Z'));
        expect((await runMoneyNotCreditedLine(alerts)).raised).toBe(false);
        t.clock.set(new Date('2026-11-23T07:00:00Z'));
        expect(await runMoneyNotCreditedLine(alerts)).toEqual({ raised: true, count: 1 });
        // Once a day.
        t.clock.set(new Date('2026-11-23T12:00:00Z'));
        expect((await runMoneyNotCreditedLine(alerts)).raised).toBe(false);
        const outbox = await t.db.db
          .select()
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.type, 'owner.alert'));
        const line = outbox
          .map((row) => row.payload as { key: string; message: string })
          .find((p) => p.key === 'money_not_credited|2026-11-23');
        expect(line?.message).toContain('ETB 250.00');
        expect(line?.message).toContain('the oldest from 2026-11-21');
      } finally {
        t.clock.set(real);
      }
    },
    TEST_TIMEOUT,
  );
});
