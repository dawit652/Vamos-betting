/**
 * Load test (task A7): how many stake postings per second one `house_stakes` ledger row allows.
 *
 *   pnpm --filter @vamos/load house-stakes [--processes 4] [--workers 8] [--seconds 20]
 *
 * Every bet posts its stake last in its transaction (player cash -stake, house_stakes +stake), so
 * the one house row is the only lock bets share. This script takes the bet away and keeps that
 * part: `--processes` Node processes, each with `--workers` concurrent loops, post stakes with the
 * real `postTransaction` against a scratch database (created and dropped here; the dev database is
 * never touched). Each loop has its own player, so the house row is the only contention.
 *
 * Reported: postings per second over the run, the latency percentiles of one posting, and the
 * ledger check (house_stakes equals the total staked, the ledger sums to zero). Run it for several
 * `--processes` values: if postings per second stop growing while the CPUs still have room, the
 * row is the limit; if they grow with the processes, the Node processes are.
 *
 * It sends no HTTP and needs no running API. Scratch database only, so no operating-mode guard.
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { createDb, postTransaction, type Database } from '@vamos/db';
import { users } from '@vamos/db/schema';
import { createTestDatabase } from '@vamos/db/testing';

const { values: args } = parseArgs({
  options: {
    processes: { type: 'string', default: '4' },
    workers: { type: 'string', default: '8' },
    seconds: { type: 'string', default: '20' },
    child: { type: 'boolean', default: false },
    url: { type: 'string' },
    first: { type: 'string', default: '0' },
    ids: { type: 'string', default: '' },
  },
});

const STAKE = 100n; // ETB 1, in santim

interface ChildReport {
  postings: number;
  failures: number;
  latenciesMs: number[];
  elapsedMs: number;
}

async function runChild(): Promise<void> {
  const url = args.url;
  if (url === undefined) throw new Error('--url is required for --child');
  const userIds = args.ids.split(',').filter((id) => id !== '');
  const handle = createDb(url, { max: Number(args.workers) + 2 });
  const deadline = performance.now() + Number(args.seconds) * 1000;
  const latenciesMs: number[] = [];
  let failures = 0;
  const started = performance.now();

  await Promise.all(
    userIds.map(async (userId, worker) => {
      for (let n = 0; performance.now() < deadline; n += 1) {
        const t0 = performance.now();
        try {
          await handle.db.transaction(async (tx) => {
            await postTransaction(tx, {
              type: 'bet_stake',
              idempotencyKey: `house-stakes-load:${args.first}:${worker}:${n}`,
              entries: [
                { account: { kind: 'player_cash', userId }, amount: -STAKE },
                { account: { kind: 'house_stakes' }, amount: STAKE },
              ],
            });
          });
          latenciesMs.push(performance.now() - t0);
        } catch {
          failures += 1;
        }
      }
    }),
  );

  const report: ChildReport = {
    postings: latenciesMs.length,
    failures,
    latenciesMs,
    elapsedMs: performance.now() - started,
  };
  await handle.close();
  process.stdout.write(`REPORT ${JSON.stringify(report)}\n`);
}

async function seedPlayers(db: Database, count: number): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .insert(users)
    .values(
      Array.from({ length: count }, (_, i) => ({
        phone: `+2519000${String(i).padStart(5, '0')}`,
        passwordHash: 'load-test:no-login',
        fullName: 'Load test player',
        dateOfBirth: '1990-01-01',
        locale: 'en',
        status: 'active' as const,
        phoneVerifiedAt: now,
        termsAcceptedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning({ id: users.id });
  return rows.map((r) => r.id);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const processes = Math.max(1, Number(args.processes));
  const workers = Math.max(1, Number(args.workers));
  const seconds = Math.max(1, Number(args.seconds));

  const scratch = await createTestDatabase(config.databaseUrl);
  try {
    const playerIds = await seedPlayers(scratch.db, processes * workers);
    // Funding: one posting per player so no stake is ever refused for lack of money.
    for (const userId of playerIds) {
      await scratch.db.transaction((tx) =>
        postTransaction(tx, {
          type: 'demo_topup',
          idempotencyKey: `house-stakes-load:fund:${userId}`,
          entries: [
            { account: { kind: 'house_demo_funding' }, amount: -10_000_000_000n },
            { account: { kind: 'player_cash', userId }, amount: 10_000_000_000n },
          ],
        }),
      );
    }

    const script = new URL(import.meta.url).pathname;
    const reports = await Promise.all(
      Array.from({ length: processes }, (_, p) => {
        const ids = playerIds.slice(p * workers, (p + 1) * workers);
        return new Promise<ChildReport>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              ...process.execArgv,
              script,
              '--child',
              '--url',
              scratch.url,
              '--workers',
              String(workers),
              '--seconds',
              String(seconds),
              '--first',
              String(p),
              '--ids',
              ids.join(','),
            ],
            { stdio: ['ignore', 'pipe', 'inherit'] },
          );
          let out = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.on('error', reject);
          child.on('close', (code) => {
            const line = out.split('\n').find((l) => l.startsWith('REPORT '));
            if (code !== 0 || line === undefined) reject(new Error(`child ${p} exited ${code}`));
            else resolve(JSON.parse(line.slice(7)) as ChildReport);
          });
        });
      }),
    );

    const postings = reports.reduce((n, r) => n + r.postings, 0);
    const failures = reports.reduce((n, r) => n + r.failures, 0);
    const elapsedS = Math.max(...reports.map((r) => r.elapsedMs)) / 1000;
    const latencies = reports.flatMap((r) => r.latenciesMs).sort((a, b) => a - b);

    const [{ stakes } = { stakes: 0n }] = (
      await scratch.pool.query<{ stakes: bigint }>(
        `select balance as stakes from ledger_accounts where key = 'house:stakes'`,
      )
    ).rows;
    const [{ total } = { total: 0n }] = (
      await scratch.pool.query<{ total: bigint }>(
        `select coalesce(sum(amount), 0)::bigint as total from ledger_entries`,
      )
    ).rows;
    const ok = stakes === BigInt(postings) * STAKE && total === 0n;

    console.log(
      JSON.stringify(
        {
          processes,
          workersPerProcess: workers,
          seconds: Number(elapsedS.toFixed(1)),
          postings,
          failures,
          postingsPerSecond: Math.round(postings / elapsedS),
          p50Ms: Number(percentile(latencies, 50).toFixed(1)),
          p95Ms: Number(percentile(latencies, 95).toFixed(1)),
          p99Ms: Number(percentile(latencies, 99).toFixed(1)),
          ledgerCheck: ok ? 'ok' : `FAILED (house_stakes ${stakes}, entries sum ${total})`,
        },
        null,
        2,
      ),
    );
    if (!ok || failures > 0) process.exitCode = 1;
  } finally {
    await scratch.drop();
  }
}

if (args.child) {
  runChild().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
