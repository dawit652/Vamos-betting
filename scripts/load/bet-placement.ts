/**
 * Load test: bet placement (POST /bets) with catalogue reads (GET /events)
 * running alongside, against an API that is already up (demo mode only).
 *
 *   pnpm --filter @vamos/load bet-placement -- [--duration 30] [--connections 50] [--players 1000]
 *
 * 1. Seeds `--players` load-test players straight into the database: active
 *    users with a bearer session each (no CSRF needed for bearer auth) and a
 *    1,000 ETB play-money balance, credited by a `demo_topup` ledger posting.
 * 2. Picks open main-market selections of scheduled events from GET /events.
 * 3. Runs two autocannon instances at once for `--duration` seconds:
 *    POST /bets (80% of the connections; every request a fresh player in
 *    round-robin order and a fresh Idempotency-Key) and GET /events (20%).
 * 4. Checks the outcome: every 201 is a bet in the database (and no bet exists
 *    that was not requested), each load player's
 *    balance is exactly 1,000 ETB minus their stakes, no player account is
 *    negative, and a full reconciliation run (every check, full balance_after
 *    scan) finds nothing.
 *
 * Prints p50/p95/p99 latency, throughput and status counts, and exits 1 when
 * a check fails or the error rate is above `--max-error-rate` (default 1%).
 * The players stay in the database (ledger tables are append-only); they are
 * named "Load test player" with phones +2517<run tag><index>.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { createDb, postTransaction, runReconciliation, type Database } from '@vamos/db';
import { sessions, users } from '@vamos/db/schema';
import { sql } from 'drizzle-orm';

const STARTING_BALANCE = 100_000n; // santim: 1,000 ETB
const STAKE = 1_000n; // santim (10 ETB); santim on the wire too
const LOAD_NAME = 'Load test player';

const { values: args } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.LOAD_API_URL ?? 'http://localhost:4000' },
    duration: { type: 'string', default: '30' },
    connections: { type: 'string', default: '50' },
    players: { type: 'string', default: '1000' },
    'max-error-rate': { type: 'string', default: '0.01' },
  },
});
const apiUrl = args.api.replace(/\/$/, '');
const duration = Number(args.duration);
const connections = Number(args.connections);
const playerCount = Math.min(Number(args.players), 9_999);
const maxErrorRate = Number(args['max-error-rate']);

loadDotEnv();
const config = loadConfig();
if (config.mode !== 'demo' || config.nodeEnv === 'production') {
  console.error('The load test mints play money: it runs only in demo mode outside production.');
  process.exit(2);
}

interface Player {
  userId: string;
  token: string;
}

interface Pick {
  selectionId: string;
  oddsMilli: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Creates the players with a session and a funded cash account, 50 per transaction. */
async function seedPlayers(db: Database, count: number, phonePrefix: string): Promise<Player[]> {
  const players: Player[] = [];
  const now = new Date();
  for (let start = 0; start < count; start += 50) {
    const batch = Math.min(50, count - start);
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(users)
        .values(
          Array.from({ length: batch }, (_, i) => ({
            phone: `${phonePrefix}${String(start + i).padStart(4, '0')}`,
            passwordHash: 'load-test:no-login',
            fullName: LOAD_NAME,
            dateOfBirth: '1990-01-01',
            locale: 'en',
            status: 'active' as const,
            phoneVerifiedAt: now,
            termsAcceptedAt: now,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: users.phone })
        .returning({ id: users.id });
      for (const { id } of rows) {
        const token = randomBytes(32).toString('base64url');
        await tx.insert(sessions).values({
          userId: id,
          tokenHash: sha256(token),
          csrfHash: sha256(randomBytes(32).toString('base64url')),
          userAgent: 'vamos-load-test',
          expiresAt: new Date(now.getTime() + 24 * 3600_000),
        });
        await postTransaction(tx, {
          type: 'demo_topup',
          idempotencyKey: `demo_topup:${id}:load-test`,
          description: 'Demo top-up (load test)',
          actor: { type: 'system', id: 'load-test' },
          entries: [
            { account: { kind: 'house_demo_funding' }, amount: -STARTING_BALANCE },
            { account: { kind: 'player_cash', userId: id }, amount: STARTING_BALANCE },
          ],
        });
        players.push({ userId: id, token });
      }
    });
  }
  return players;
}

interface EventSummaryLite {
  status: string;
  startTime: string;
  mainMarket: {
    status: string;
    selections: { id: string; oddsMilli: number; open: boolean }[];
  } | null;
}

/** Open main-market selections of events kicking off at least 10 minutes from now. */
async function pickSelections(): Promise<Pick[]> {
  const response = await fetch(`${apiUrl}/events?sport=football&filter=upcoming&limit=50`);
  if (!response.ok) throw new Error(`GET /events: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { items: EventSummaryLite[] };
  const earliest = Date.now() + 10 * 60_000;
  const picks: Pick[] = [];
  for (const event of body.items) {
    const market = event.mainMarket;
    if (event.status !== 'scheduled' || Date.parse(event.startTime) < earliest) continue;
    if (market === null || market.status !== 'open') continue;
    for (const selection of market.selections) {
      if (selection.open) picks.push({ selectionId: selection.id, oddsMilli: selection.oddsMilli });
    }
  }
  if (picks.length === 0) throw new Error('no open selection kicks off in 10+ minutes; seed first');
  return picks.slice(0, 30);
}

/** Runs one autocannon instance and records every response time (autocannon reports no p95). */
function runCannon(
  opts: autocannon.Options,
): Promise<{ result: autocannon.Result; times: number[] }> {
  const times: number[] = [];
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (error, result) =>
      error
        ? reject(error instanceof Error ? error : new Error(String(error)))
        : resolve({ result, times }),
    );
    instance.on('response', (_client, _status, _bytes, responseTime: number) => {
      times.push(responseTime);
    });
    // Keep the process alive and quiet: one summary at the end.
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false });
  });
}

/** Nearest-rank percentile of response times in ms. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]! * 10) / 10;
}

function summarise(
  name: string,
  { result, times }: { result: autocannon.Result; times: number[] },
) {
  const total = result.requests.total;
  const statuses: Record<string, number> = {};
  for (const [code, stats] of Object.entries(result.statusCodeStats ?? {})) {
    statuses[code] = (stats as { count: number }).count;
  }
  const failed = result.non2xx + result.errors + result.timeouts;
  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, t) => sum + t, 0) / Math.max(1, sorted.length);
  return {
    name,
    requests: total,
    throughputPerSec: Math.round((total / result.duration) * 10) / 10,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: percentile(sorted, 100),
      mean: Math.round(mean * 10) / 10,
    },
    statuses,
    errors: result.errors,
    timeouts: result.timeouts,
    errorRate: total === 0 ? 0 : Math.round((failed / Math.max(total, 1)) * 10_000) / 10_000,
  };
}

async function main(): Promise<void> {
  const handle = createDb(config.databaseUrl, { max: 4 });
  const { db } = handle;
  try {
    const started = Date.now();
    // +2517 numbers are not issued to subscribers; a random run tag keeps each run's players apart.
    const phonePrefix = `+2517${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0')}`;
    const players = await seedPlayers(db, playerCount, phonePrefix);
    console.log(`seeded ${players.length} players in ${Date.now() - started} ms`);
    const picks = await pickSelections();
    console.log(`betting on ${picks.length} selections`);

    let next = 0;
    const betConnections = Math.max(1, Math.round(connections * 0.8));
    const readConnections = Math.max(1, connections - betConnections);
    const common = { duration, timeout: 10 };
    const [bets, reads] = await Promise.all([
      runCannon({
        ...common,
        url: apiUrl,
        connections: betConnections,
        requests: [
          {
            method: 'POST',
            path: '/bets',
            setupRequest: (request) => {
              const n = next++;
              const player = players[n % players.length]!;
              const pick = picks[n % picks.length]!;
              return {
                ...request,
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${player.token}`,
                  'idempotency-key': randomUUID(),
                },
                body: JSON.stringify({
                  legs: [pick],
                  stake: STAKE.toString(),
                  oddsChangePolicy: 'any',
                }),
              };
            },
          },
        ],
      }),
      runCannon({
        ...common,
        url: `${apiUrl}/events?sport=football&filter=upcoming&limit=50`,
        connections: readConnections,
      }),
    ]);

    const betSummary = summarise('POST /bets', bets);
    const readSummary = summarise('GET /events', reads);

    // Checks: every 201 is a stored bet, balances add up, nothing negative, the ledger reconciles.
    const placed = await db.execute<{ bets: string; stakes: string; mismatched: string }>(sql`
      with stakes as (
        select u.id, coalesce(sum(b.stake), 0) as staked, count(b.id) as bets
        from users u left join bets b on b.user_id = u.id
        where u.phone like ${`${phonePrefix}%`}
        group by u.id
      )
      select sum(s.bets)::text as bets, sum(s.staked)::text as stakes,
        count(*) filter (where a.balance + s.staked <> ${STARTING_BALANCE})::text as mismatched
      from stakes s join ledger_accounts a on a.user_id = s.id and a.kind = 'player_cash'`);
    const negative = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ledger_accounts where owner_type = 'user' and balance < 0`,
    );
    const recon = await runReconciliation(db, {
      now: new Date(),
      kind: 'scheduled',
      fullBalanceAfterScan: true,
      balanceAfterGraceMs: 0,
    });

    const row = placed.rows[0]!;
    const created = bets.result.statusCodeStats?.['201']?.count ?? 0;
    const checks = {
      betsStored: Number(row.bets),
      created201: created,
      // Requests still in flight when the run stops are stored but not counted as 201s.
      betsSent: bets.result.requests.sent,
      betsMatch201: Number(row.bets) >= created && Number(row.bets) <= bets.result.requests.sent,
      balanceMismatches: Number(row.mismatched),
      negativePlayerAccounts: Number(negative.rows[0]!.n),
      reconciliation: {
        status: recon.run.status,
        mismatches: recon.run.mismatchCount,
        failedChecks: (recon.run.checks as { check: string; ok: boolean }[])
          .filter((c) => !c.ok)
          .map((c) => c.check),
      },
    };
    console.log(
      JSON.stringify(
        {
          config: {
            duration,
            connections,
            betConnections,
            readConnections,
            players: players.length,
          },
          results: [betSummary, readSummary],
          checks,
        },
        null,
        2,
      ),
    );

    const failures: string[] = [];
    if (!checks.betsMatch201) failures.push('stored bets do not match the 201 responses');
    if (checks.balanceMismatches > 0) failures.push('player balances do not add up');
    if (checks.negativePlayerAccounts > 0) failures.push('negative player balance');
    if (recon.run.mismatchCount > 0 || recon.run.status === 'failed') {
      failures.push('reconciliation found differences');
    }
    for (const summary of [betSummary, readSummary]) {
      if (summary.errorRate > maxErrorRate) failures.push(`${summary.name} error rate`);
    }
    if (failures.length > 0) {
      console.error(`FAILED: ${failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log('OK: ledger reconciles, no negative balances, error rates within budget');
    }
  } finally {
    await handle.close();
  }
}

await main();
