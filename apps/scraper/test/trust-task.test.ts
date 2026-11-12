import { afterEach, describe, expect, it } from 'vitest';
import { createTasks } from '../src/tasks/index';
import { runTrustCheck, TRUST_MIN_AGE_MS } from '../src/tasks/trust';
import { createHarness, HOUR, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/** The nightly truth-check (plan task 1.3, the trust part): measurement only, once a day. */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const trustRows = async () =>
  (
    await h.pool.query<{ upstream: string; compared: number; agreed: number; measured_at: Date }>(
      `SELECT upstream, compared, agreed, measured_at FROM scrape_source_trust ORDER BY upstream`,
    )
  ).rows;

describe('the nightly trust task', () => {
  it(
    'measures every upstream once, then not again until the last measurement is 20 hours old',
    async () => {
      h = await createHarness();
      expect(await trustRows()).toEqual([]);

      expect(await runTrustCheck(h.ctx)).toEqual({ ran: true, upstreams: 2 });
      const first = await trustRows();
      // Nothing to compare yet: stored as 0 of 0, which the ladder reads as untrusted.
      expect(first.map((r) => [r.upstream, r.compared, r.agreed])).toEqual([
        ['example-api', 0, 0],
        ['openfootball', 0, 0],
      ]);
      const measuredAt = first[0]!.measured_at;

      h.advance(TRUST_MIN_AGE_MS - HOUR);
      expect(await runTrustCheck(h.ctx)).toEqual({ ran: false, upstreams: 0 });
      expect((await trustRows())[0]!.measured_at).toEqual(measuredAt);

      h.advance(HOUR);
      expect(await runTrustCheck(h.ctx)).toEqual({ ran: true, upstreams: 2 });
      expect((await trustRows())[0]!.measured_at.getTime()).toBe(
        measuredAt.getTime() + TRUST_MIN_AGE_MS,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'skips quietly while another instance holds the lock, and is one of the scraper tasks',
    async () => {
      h = await createHarness();
      await h.ctx.redis.set('scraper:trust', 'other', 'PX', 60_000);
      expect(await runTrustCheck(h.ctx)).toEqual({ ran: false, upstreams: 0 });
      expect(await trustRows()).toEqual([]);
      expect(createTasks(h.ctx).map((t) => t.name)).toContain('scraper-trust');
    },
    TEST_TIMEOUT,
  );
});
