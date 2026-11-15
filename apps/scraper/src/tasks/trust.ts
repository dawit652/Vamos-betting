import { newestSourceTrustMeasuredAt } from '@vamos/db';
import { HOUR_MS } from '@vamos/scraper';
import type { ScraperContext } from '../context';
import { runTruthCheck, seasonStart } from '../eval/truth-check';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { tryLock } from '../lib/lock';

/** How often the task looks at the clock; it measures only when the last measurement is old enough. */
export const TRUST_INTERVAL_MS = HOUR_MS;
/** Trust is measured again once the newest measurement is this old (once a day). */
export const TRUST_MIN_AGE_MS = 20 * HOUR_MS;
const TRUST_LOCK_TTL_MS = 10 * 60_000;

export interface TrustCheckSummary {
  /** False when the last measurement was recent, or another instance holds the lock. */
  ran: boolean;
  upstreams: number;
}

/**
 * The nightly truth-check (plan task 1.3, the trust part): `sources truth-check --write` for every
 * upstream, from 1 July of the current season, once a day without anyone typing it. Skipped while
 * the newest measurement is less than 20 hours old. Measurement only: it writes
 * `scrape_source_trust` and nothing else.
 */
export async function runTrustCheck(ctx: ScraperContext): Promise<TrustCheckSummary> {
  const now = ctx.clock();
  const newest = await newestSourceTrustMeasuredAt(ctx.db, 'football');
  if (newest !== null && now.getTime() - newest.getTime() < TRUST_MIN_AGE_MS) {
    return { ran: false, upstreams: 0 };
  }
  const lock = await tryLock(ctx.redis, 'scraper:trust', TRUST_LOCK_TTL_MS);
  if (lock === null) return { ran: false, upstreams: 0 };
  try {
    const rows = await runTruthCheck(ctx.db, {
      sport: 'football',
      since: seasonStart(now),
      now,
      write: true,
    });
    ctx.logger.info(
      {
        upstreams: rows.map((r) => ({
          upstream: r.upstream,
          compared: r.compared,
          agreed: r.agreed,
          trust: r.trust,
        })),
      },
      'source trust measured',
    );
    return { ran: true, upstreams: rows.length };
  } finally {
    await lock.release().catch(() => false);
  }
}

export function trustTask(ctx: ScraperContext): IntervalTask {
  return intervalTask({
    name: 'scraper-trust',
    intervalMs: TRUST_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runTrustCheck(ctx),
    runOnStart: false,
  });
}
