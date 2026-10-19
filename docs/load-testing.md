# Load testing

An autocannon load test of bet placement, with catalogue reads running alongside. It checks that the
ledger still balances afterwards. The script is `scripts/load/bet-placement.ts` (workspace package
`@vamos/load`). It runs only in demo mode outside production, because it mints play money.

## Running it

The API must already be running against a migrated and seeded database. The worker should run too,
so the outbox is drained as it would be in production.

```bash
pnpm db:migrate && pnpm db:seed
pnpm build && bash e2e/scripts/stack.sh start      # built API, worker, web, admin
pnpm load:bets                                      # 30 s, 50 connections, 1,000 players
pnpm load:bets --duration 60 --connections 20 --players 2000 --api http://localhost:4000
bash e2e/scripts/stack.sh stop
```

The script works in four steps:

1. **Seed players.** It creates `--players` players directly in the database. Each one is active,
   has a bearer session (bearer requests need no CSRF token) and gets 1,000 ETB through a
   `demo_topup` ledger posting.
2. **Pick selections.** From `GET /events`, it takes up to 30 open main-market selections of football
   events that kick off at least 10 minutes later, so no bet is settled during the run.
3. **Generate load.** Two autocannon instances run at the same time:
   - `POST /bets` gets 80% of the connections. It sends 10 ETB singles with `oddsChangePolicy: any`.
     Each request goes to the next player in turn and carries a fresh `Idempotency-Key`.
     There are enough players that none of them reaches the 30-bets-per-minute limit.
   - `GET /events?sport=football&filter=upcoming&limit=50` gets the other 20%.
4. **Check the result.** It reports p50/p95/p99/max latency (from every response time), throughput
   and the count for each status code. The run fails (exit 1) if any of these checks fails:
   - The number of stored bets is between the number of 201 responses and the number of requests
     sent. Requests still in flight when the run stops are stored but get no 201.
   - Every load player's cash balance is exactly 1,000 ETB minus their stakes.
   - No player ledger account is negative. This covers all players, not only the load players.
   - A full reconciliation run (`runReconciliation`, every check, full `balance_after` scan) finds
     no differences.
   - The error rate of either endpoint is above `--max-error-rate` (default 1%).

The seeded players stay in the database, because ledger tables are append-only. They are named
"Load test player" and have phones `+2517<run tag><index>`. Do not run the script against a shared
database.

## Results (19 Oct 2026)

**Setup.** One 4-CPU container, 16 GB of RAM. It ran everything: the built API (a single Node 22
process, pool of 10 connections, info-level logs), the worker with the fast simulator, the web and
admin servers, native PostgreSQL 16, Redis 7 and autocannon. All runs lasted 30 s.

| Run                                      | Endpoint    | Throughput | p50    | p95              | p99    | Errors |
| ---------------------------------------- | ----------- | ---------- | ------ | ---------------- | ------ | ------ |
| 50 connections, **before** the fix below | POST /bets  | 75.5/s     | 499 ms | 803 ms (p97.5)\* | 920 ms | 0      |
|                                          | GET /events | 16.3/s     | 610 ms | 791 ms (p97.5)\* | 873 ms | 0      |
| 50 connections, after                    | POST /bets  | 95.8/s     | 410 ms | 504 ms           | 565 ms | 0      |
|                                          | GET /events | 20.3/s     | 482 ms | 599 ms           | 632 ms | 0      |
| 10 connections, after                    | POST /bets  | 57.4/s     | 135 ms | 186 ms           | 216 ms | 0      |
|                                          | GET /events | 77.6/s     | 25 ms  | 37 ms            | 47 ms  | 0      |
| 2 connections, after                     | POST /bets  | 46.3/s     | 41 ms  | 60 ms            | 77 ms  | 0      |
|                                          | GET /events | 83.8/s     | 11 ms  | 17 ms            | 20 ms  | 0      |

\* The first version of the script printed autocannon's own percentiles, which have no p95.

Every run passed all the checks: stored bets matched the responses, balances added up, no account was
negative and reconciliation was clean.

## What was found and fixed

**The house_stakes lock (fixed).** Every stake posting updates the one `house_stakes` ledger account
row, and that row lock is held until commit. `placeBet` used to post the stake in the middle of the
transaction. It then still inserted the bet, its legs, the outbox event and the audit row, and
re-read the bet, so every bet in the system queued behind those 7 round trips of the bet before it.
Under load, `pg_stat_activity` showed nearly every busy connection in `Lock:transactionid` on
`update "ledger_accounts"`. The stake posting is now the last write. The lock is held only for the
posting itself (two balance updates, the entry insert, the savepoint release) and the commit.

Money semantics did not change. It is still one database transaction, and an `insufficient_funds`
refusal still rolls back everything. The test `posts the stake last, so the shared house_stakes lock
is held only until commit` in `packages/db/test/betting-place.test.ts` fails if a write or read is
added after the lock is taken.

**Checked and found fine:**

- **Database time.** With `log_min_duration_statement = 4ms`, the only statements over 4 ms were
  some commits. Indexes cover every lookup on the bet path.
- **Catalogue reads.** `GET /events` makes three queries per page, so there is no N+1 query.
- **Commit cost.** A commit with fsync takes about 0.3 ms on this disk.

**What limits throughput now.** The single API process is CPU-bound at about 95 bets/s (plus
catalogue reads) on this shared 4-CPU box. A CPU profile spreads the time across pg/drizzle query
building and parsing, Fastify, and logging; no single function stands out. One placement takes
about 23 queries in `placeBet`, about 20 ms of database round trips when timed alone, and about
40 ms end to end through the API. The p95 at 50 connections is mostly queueing: 40 bet connections
divided by 96 bets/s is about 0.42 s.

To go further:

- **Scale out.** Run several API replicas. They share nothing but Postgres and Redis. With the stake
  posting last, the lock-bound ceiling for one house account is about 1 / (posting + commit), which
  is several hundred bets/s. That figure is an estimate and was not measured here.
- **Cut queries.** Avoid re-reading the bet after inserting it (`getBetById`, 3 queries), and merge
  the two `users` reads.
- **Split the house account.** Only if that ceiling is ever reached, split `house_stakes` per channel
  or shard. That would change the ledger account structure and reconciliation, so it needs its own
  design review.
