import { pathToFileURL } from 'node:url';
import {
  loadCatalogIds,
  seedCatalog,
  upsertFixture,
  withTxRetry,
  type FixtureMarketInput,
} from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import { priceFactoryMarkets } from '@vamos/feed';
import { sql } from 'drizzle-orm';

/**
 * MEASUREMENT ONLY (plan task 2.3, handover task A14): what a re-price of every market of the
 * market factory costs on a busy day's volume, on a throwaway database.
 *
 *   pnpm --filter @vamos/scraper-app bench:factory-reprice [events]   (default 250)
 *
 * It creates a fresh test database (migrated, with the seeded catalogue), stores `events` football matches with
 * every factory market (today's nine types and the factory-only ones, every selection listed, as the
 * scraper stores them with SCRAPER_FACTORY_MARKETS=on), then re-prices each with expected goals moved
 * by 3% so nearly every price changes, through `upsertFixture(…, { factoryComplete, priceValidUntil })`
 * as `repriceOne` does, one transaction per event. It prints the time per event (median, 95th
 * percentile, worst), the total, the rows written and the WAL generated, then drops the database.
 */

const DEFAULT_EVENTS = 250;

function markets(lambdaHome: number, lambdaAway: number): FixtureMarketInput[] {
  return priceFactoryMarkets(lambdaHome, lambdaAway, { maxListedOddsMilli: null }).map((m) => ({
    type: m.type,
    line: m.line,
    selections: m.selections,
  }));
}

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

export async function benchFactoryReprice(events: number): Promise<Record<string, unknown>> {
  const handle = await createTestDatabase();
  try {
    const { db } = handle;
    await seedCatalog(db);
    const ids = await loadCatalogIds(db);
    const competitionId = [...ids.competitions].find(([k]) => k.startsWith('football/'))?.[1];
    const teams = [...ids.teams].filter(([k]) => k.startsWith('football/')).map(([, v]) => v);
    if (competitionId === undefined || teams.length < 2) throw new Error('no football catalogue');
    const now = new Date();
    const fixtures = Array.from({ length: events }, (_, i) => ({
      feedProvider: 'scraped',
      feedRef: `bench-${i}`,
      sport: 'football' as const,
      competitionId,
      homeTeamId: teams[(2 * i) % teams.length]!,
      awayTeamId: teams[(2 * i + 1) % teams.length]!,
      startTime: new Date(now.getTime() + (2 + (i % 48)) * 3_600_000),
      lambdaHome: 0.9 + ((i * 37) % 120) / 100,
      lambdaAway: 0.6 + ((i * 53) % 110) / 100,
    }));

    const insertStart = performance.now();
    let marketsPerEvent = 0;
    let selectionsPerEvent = 0;
    for (const f of fixtures) {
      const priced = markets(f.lambdaHome, f.lambdaAway);
      marketsPerEvent = priced.length;
      selectionsPerEvent = priced.reduce((n, m) => n + m.selections.length, 0);
      await withTxRetry(db, (tx) => upsertFixture(tx, f, priced, { source: 'scraper', now }));
    }
    const insertMs = performance.now() - insertStart;

    const stat = async () => {
      const { rows } = await handle.pool.query<{
        upd: string;
        ins: string;
        lsn: string;
      }>(
        `SELECT (SELECT COALESCE(sum(n_tup_upd), 0) FROM pg_stat_user_tables)::text AS upd,
                (SELECT COALESCE(sum(n_tup_ins), 0) FROM pg_stat_user_tables)::text AS ins,
                pg_current_wal_lsn()::text AS lsn`,
      );
      return rows[0]!;
    };
    await db.execute(sql`SELECT pg_stat_force_next_flush()`).catch(() => undefined);
    const before = await stat();
    const durations: number[] = [];
    let oddsChanged = 0;
    const repriceStart = performance.now();
    const validUntil = new Date(now.getTime() + 90 * 60_000);
    for (const f of fixtures) {
      const priced = markets(f.lambdaHome * 1.03, f.lambdaAway * 0.97);
      const t0 = performance.now();
      const r = await withTxRetry(db, (tx) =>
        upsertFixture(tx, f, priced, {
          source: 'scraper',
          now,
          factoryComplete: true,
          priceValidUntil: validUntil,
        }),
      );
      durations.push(performance.now() - t0);
      oddsChanged += r.oddsChanged;
    }
    const repriceMs = performance.now() - repriceStart;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await db.execute(sql`SELECT pg_stat_force_next_flush()`).catch(() => undefined);
    const after = await stat();
    const { rows: wal } = await handle.pool.query<{ bytes: string }>(
      `SELECT pg_wal_lsn_diff($1, $2)::text AS bytes`,
      [after.lsn, before.lsn],
    );
    durations.sort((a, b) => a - b);
    const round = (x: number) => Math.round(x * 10) / 10;
    return {
      events,
      marketsPerEvent,
      selectionsPerEvent,
      insertTotalMs: Math.round(insertMs),
      repriceTotalMs: Math.round(repriceMs),
      repricePerEventMs: {
        median: round(quantile(durations, 0.5)),
        p95: round(quantile(durations, 0.95)),
        max: round(durations[durations.length - 1] ?? 0),
      },
      oddsChanged,
      rowsUpdated: Number(after.upd) - Number(before.upd),
      rowsInserted: Number(after.ins) - Number(before.ins),
      walMegabytes: round(Number(wal[0]!.bytes) / 1_048_576),
    };
  } finally {
    await handle.drop();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const events = Number(process.argv[2] ?? DEFAULT_EVENTS);
  if (!Number.isSafeInteger(events) || events < 1 || events > 5000) {
    console.error('usage: bench:factory-reprice [events 1..5000]');
    process.exit(2);
  }
  benchFactoryReprice(events)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
