/**
 * Load test: a burst of SMS-rail deposits and the forwarded-SMS storm, against
 * an API that is already up in demo mode with the simulated SMS rail
 * (OPERATING_MODE=demo, PAYMENT_PROVIDERS=mock,sms, SMS_RAIL_MODE=simulated).
 *
 *   pnpm load:deposits [players] [--players 500] [--amount 100] [--concurrency 25] [--waves 1]
 *
 * 1. Seeds `--players` active players straight into the database, each with a
 *    bearer session (no CSRF needed) and no money.
 * 2. Every player opens an SMS deposit of the same round amount (default ETB 100)
 *    through POST /payments/deposits, as the web app does. The rail gives each an
 *    exact amount (requested + 1..99 santim, unique among open deposits), so at
 *    most 99 can be open at once: the rest must be refused cleanly with
 *    409 `sms_amount_unavailable`. Anything else is a failure.
 * 3. The bank SMS of every opened deposit is sent through POST /dev/payments/sms
 *    (the dev simulator: it feeds ingestSms as the gateway would): the first
 *    third in the order the deposits were opened, the next third shuffled, the last
 *    third shuffled and each sent twice (half of those twice at the same moment, half
 *    again after the first was answered). A replay is a second SMS for the same
 *    amount (the simulator gives it a new reference), which must credit nothing.
 * 4. With `--waves` above 1, the players refused for lack of an amount try again
 *    once the amounts of the paid deposits are free (amounts are released on credit).
 * 5. Checks (exit 1 on any failure): every deposit that was paid is `succeeded`
 *    exactly once, its player's cash balance equals the exact amount and has exactly
 *    one ledger entry; nobody who did not pay has money; no deposit is flagged or
 *    left open; and a full reconciliation run finds nothing.
 *
 * Credit latency is the round trip of the SMS request that credited the deposit
 * (SMS sent to deposit credited: the simulator ingests and answers in one request).
 *
 * The simulator is rate limited per client address (60 a minute). So that 500
 * players do not share one address, the script sends a distinct X-Forwarded-For per
 * player, which the API honours only with TRUST_PROXY=127.0.0.1 (start the API with it).
 * The players stay in the database (ledger tables are append-only).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadConfig, loadDotEnv } from '@vamos/config';
import { createDb, runReconciliation, type Database } from '@vamos/db';
import { sessions, users } from '@vamos/db/schema';
import { sql } from 'drizzle-orm';

const LOAD_NAME = 'Load test player';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: process.env.LOAD_API_URL ?? 'http://localhost:4000' },
    players: { type: 'string' },
    amount: { type: 'string', default: '100' }, // ETB, a whole number
    concurrency: { type: 'string', default: '25' },
    waves: { type: 'string', default: '1' },
  },
});
const apiUrl = args.api.replace(/\/$/, '');
const playerCount = Math.min(
  Number(args.players ?? positionals[0] ?? process.env.LOAD_DEPOSIT_PLAYERS ?? '500'),
  9_999,
);
const amountEtb = Number(args.amount);
const concurrency = Math.max(1, Number(args.concurrency));
const waves = Math.max(1, Number(args.waves));
if (!Number.isInteger(playerCount) || playerCount < 1 || !Number.isInteger(amountEtb)) {
  console.error('players and --amount must be whole numbers');
  process.exit(2);
}
const REQUESTED = BigInt(amountEtb) * 100n; // santim

loadDotEnv();
const config = loadConfig();
if (config.mode !== 'demo' || config.nodeEnv === 'production') {
  console.error('The load test uses the dev SMS simulator: demo mode outside production only.');
  process.exit(2);
}

interface Player {
  userId: string;
  token: string;
  ip: string;
  /** The open deposit of the current wave, if any. */
  deposit?: { id: string; amount: bigint };
  /** The deposit whose SMS was sent and that must be credited exactly once. */
  paid?: { id: string; amount: bigint };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Creates the players with a session and no money, 50 per transaction. */
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
        const n = players.length;
        // 198.51.100.0/24 and 203.0.113.0/24 are documentation ranges: never a real client.
        players.push({
          userId: id,
          token,
          ip: `198.51.${100 + Math.floor(n / 250)}.${(n % 250) + 1}`,
        });
      }
    });
  }
  return players;
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((randomBytes(4).readUInt32BE(0) / 2 ** 32) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Nearest-rank percentile of a sorted list, in ms. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]! * 10) / 10;
}

const count = <K extends string>(record: Record<K, number>, key: K) => {
  record[key] = (record[key] ?? 0) + 1;
};

/** The parts of the API answers this script reads. */
interface ApiJson {
  id?: string;
  status?: string;
  amount?: string;
  outcome?: string;
  deposit?: { status?: string };
  error?: { code?: string };
}

async function call(player: Player, path: string, body: unknown, key?: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${player.token}`,
      'x-forwarded-for': player.ip,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as ApiJson | null;
  return { status: response.status, json };
}

async function main(): Promise<void> {
  const handle = createDb(config.databaseUrl, { max: 4 });
  const { db } = handle;
  const failures: string[] = [];
  try {
    const phonePrefix = `+2517${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0')}`;
    const seeded = Date.now();
    const players = await seedPlayers(db, playerCount, phonePrefix);
    console.log(`seeded ${players.length} players in ${Date.now() - seeded} ms`);

    const refusals: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    const latencies: number[] = [];
    const openLatencies: number[] = [];
    let opened = 0;
    let smsSent = 0;
    let replaysSent = 0;
    const unexpected: string[] = [];

    for (let wave = 1; wave <= waves; wave++) {
      const waiting = players.filter((p) => p.paid === undefined);
      if (waiting.length === 0) break;

      // 2. Open the deposits.
      const openedThisWave: Player[] = [];
      let refusedThisWave = 0;
      const openStarted = performance.now();
      await pool(waiting, concurrency, async (player) => {
        const t0 = performance.now();
        const r = await call(
          player,
          '/payments/deposits',
          { amount: REQUESTED.toString(), provider: 'sms' },
          randomUUID(),
        );
        openLatencies.push(performance.now() - t0);
        if (r.status === 201 && r.json?.status === 'pending') {
          player.deposit = { id: r.json.id ?? '', amount: BigInt(r.json.amount ?? '0') };
          openedThisWave.push(player);
        } else if (r.status === 409 && r.json?.error?.code === 'sms_amount_unavailable') {
          refusedThisWave++;
          count(refusals, 'sms_amount_unavailable');
        } else {
          unexpected.push(`open deposit: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
        }
      });
      opened += openedThisWave.length;
      console.log(
        `wave ${wave}: ${waiting.length} players asked; ${openedThisWave.length} opened, ` +
          `${refusedThisWave} refused (sms_amount_unavailable), ${Math.round(performance.now() - openStarted)} ms`,
      );
      if (openedThisWave.length === 0) break;

      // 3. The SMS storm: in order, shuffled, shuffled with replays.
      const third = Math.ceil(openedThisWave.length / 3);
      const inOrder = openedThisWave.slice(0, third);
      const shuffled = shuffle(openedThisWave.slice(third, 2 * third));
      const replayed = shuffle(openedThisWave.slice(2 * third));
      for (const p of openedThisWave) p.paid = p.deposit;

      const sendSms = async (player: Player, first: boolean): Promise<void> => {
        const t0 = performance.now();
        const r = await call(player, '/dev/payments/sms', {
          depositId: player.deposit!.id,
          variant: 'exact',
        });
        const ms = performance.now() - t0;
        smsSent++;
        if (!first) replaysSent++;
        if (r.status !== 200) {
          unexpected.push(`dev sms: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
          return;
        }
        count(outcomes, `${first ? 'sms' : 'replay'}:${String(r.json?.outcome)}`);
        if (first && r.json?.deposit?.status === 'succeeded') latencies.push(ms);
      };
      const replayedList = replayed.map((player, i) => ({ player, concurrent: i % 2 === 0 }));

      const smsStarted = performance.now();
      await pool(inOrder, concurrency, (p) => sendSms(p, true));
      await pool(shuffled, concurrency, (p) => sendSms(p, true));
      await pool(replayedList, concurrency, async ({ player, concurrent }) => {
        if (concurrent) {
          await Promise.all([sendSms(player, true), sendSms(player, false)]);
        } else {
          await sendSms(player, true);
          await sendSms(player, false);
        }
      });
      console.log(
        `wave ${wave}: ${openedThisWave.length} deposits paid (${inOrder.length} in order, ` +
          `${shuffled.length} shuffled, ${replayed.length} with replays) in ` +
          `${Math.round(performance.now() - smsStarted)} ms`,
      );
      for (const p of openedThisWave) p.deposit = undefined;
    }

    // 5. Checks against the database.
    const paidPlayers = players.filter((p) => p.paid !== undefined);
    const expected = new Map(paidPlayers.map((p) => [p.userId, p.paid!]));
    const rows = await db.execute<{
      user_id: string;
      intents: string;
      succeeded: string;
      succeeded_ids: string;
      flagged: string;
      open: string;
      balance: string | null;
      entries: string;
    }>(sql`
      select u.id as user_id,
        (select count(*) from payment_intents i where i.user_id = u.id and i.provider = 'sms')::text as intents,
        (select count(*) from payment_intents i where i.user_id = u.id and i.status = 'succeeded')::text as succeeded,
        (select coalesce(string_agg(i.id::text || ':' || i.amount::text, ','), '') from payment_intents i
           where i.user_id = u.id and i.status = 'succeeded') as succeeded_ids,
        (select count(*) from payment_intents i where i.user_id = u.id and i.flagged_at is not null)::text as flagged,
        (select count(*) from payment_intents i where i.user_id = u.id and i.status in ('created','pending'))::text as open,
        a.balance::text as balance,
        (select count(*) from ledger_entries e where e.account_id = a.id)::text as entries
      from users u
      left join ledger_accounts a on a.user_id = u.id and a.kind = 'player_cash'
      where u.phone like ${`${phonePrefix}%`}`);

    let credited = 0;
    let doubleCredits = 0;
    let missing = 0;
    let wrongAmount = 0;
    let moneyWithoutPaying = 0;
    let flagged = 0;
    let stillOpen = 0;
    for (const row of rows.rows) {
      const paid = expected.get(row.user_id);
      const balance = BigInt(row.balance ?? '0');
      flagged += Number(row.flagged);
      stillOpen += Number(row.open);
      if (paid === undefined) {
        if (balance !== 0n || Number(row.entries) > 0 || Number(row.succeeded) > 0) {
          moneyWithoutPaying++;
        }
        continue;
      }
      if (Number(row.succeeded) === 0) missing++;
      else credited++;
      if (Number(row.succeeded) > 1 || Number(row.entries) > 1 || balance > paid.amount) {
        doubleCredits++;
      } else if (Number(row.succeeded) === 1 && balance !== paid.amount) {
        wrongAmount++;
      }
      if (row.succeeded_ids !== '' && row.succeeded_ids !== `${paid.id}:${paid.amount}`) {
        wrongAmount++;
      }
    }

    const recon = await runReconciliation(db, {
      now: new Date(),
      kind: 'scheduled',
      fullBalanceAfterScan: true,
      balanceAfterGraceMs: 0,
    });

    const sortedLatency = [...latencies].sort((a, b) => a - b);
    const sortedOpen = [...openLatencies].sort((a, b) => a - b);
    const refused = Object.values(refusals).reduce((sum, n) => sum + n, 0);
    const result = {
      config: { api: apiUrl, players: players.length, amountEtb, concurrency, waves },
      deposits: {
        opened,
        refusedForLackOfAmount: refused,
        refusalCodes: refusals,
        playersNeverPaid: players.length - paidPlayers.length,
        paid: paidPlayers.length,
        openLatencyMs: { p50: percentile(sortedOpen, 50), p95: percentile(sortedOpen, 95) },
      },
      sms: {
        sent: smsSent,
        replays: replaysSent,
        outcomes,
        creditLatencyMs: {
          samples: sortedLatency.length,
          p50: percentile(sortedLatency, 50),
          p95: percentile(sortedLatency, 95),
          max: percentile(sortedLatency, 100),
        },
      },
      checks: {
        creditedExactlyOnce: credited,
        missingCredits: missing,
        doubleCredits,
        wrongAmounts: wrongAmount,
        moneyWithoutPaying,
        flaggedDeposits: flagged,
        depositsLeftOpen: stillOpen,
        reconciliation: {
          status: recon.run.status,
          mismatches: recon.run.mismatchCount,
          failedChecks: (recon.run.checks as { check: string; ok: boolean }[])
            .filter((c) => !c.ok)
            .map((c) => c.check),
        },
      },
      unexpectedResponses: unexpected.slice(0, 10),
    };
    console.log(JSON.stringify(result, null, 2));

    if (unexpected.length > 0) failures.push(`${unexpected.length} unexpected responses`);
    if (paidPlayers.length === 0) failures.push('no deposit was opened');
    if (missing > 0) failures.push(`${missing} paid deposits were not credited`);
    if (doubleCredits > 0) failures.push(`${doubleCredits} deposits were credited more than once`);
    if (wrongAmount > 0) failures.push(`${wrongAmount} credits of the wrong amount`);
    if (moneyWithoutPaying > 0) failures.push(`${moneyWithoutPaying} players got money unpaid`);
    if (flagged > 0) failures.push(`${flagged} deposits were flagged`);
    if (stillOpen > 0) failures.push(`${stillOpen} deposits were left open`);
    if (credited !== paidPlayers.length) failures.push('credited count differs from paid count');
    if (recon.run.mismatchCount > 0 || recon.run.status === 'failed') {
      failures.push('reconciliation found differences');
    }
    if (failures.length > 0) {
      console.error(`FAILED: ${failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      console.log(
        `OK: ${credited} paid deposits credited exactly once, ${refused} refused for lack of an amount, reconciliation clean`,
      );
    }
  } finally {
    await handle.close();
  }
}

await main();
