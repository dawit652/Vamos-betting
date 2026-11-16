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

## Deposit burst: `pnpm load:deposits`

A second script, `scripts/load/deposits.ts`, tests the SMS deposit rail under a burst. It needs an
API in demo mode with the simulated rail and one trusted proxy address (the script sends a
different `X-Forwarded-For` per player, so the 60-a-minute limit of the simulator is per player):

```bash
OPERATING_MODE=demo PAYMENT_PROVIDERS=mock,sms SMS_RAIL_MODE=simulated TRUST_PROXY=127.0.0.1 \
  pnpm --filter @vamos/api exec tsx src/server.ts      # or the built stack with these settings
pnpm load:deposits --players 500 --waves 6              # also: --amount, --concurrency, --api
```

It seeds the players, opens an SMS deposit of the same round amount for each (the rail gives
each an exact amount, requested + 1 to 99 santim, so at most 99 are open at once and the others
must be refused with `sms_amount_unavailable`), sends the bank SMS of every opened deposit (a third
in order, a third shuffled, a third shuffled and each sent twice, half of those at the same moment)
and, in later waves, lets the refused players try again as amounts are freed. It exits 1 unless:
every paid deposit is credited exactly once and for its exact amount, nobody who did not pay has
money, no deposit is flagged or left open, no response was unexpected, and a full reconciliation
run is clean.

## Results (16 Nov 2026): deposit burst

500 players, ETB 100 each, concurrency 25, 6 waves, one API process on the development container
(Postgres and Redis on the same machine, so read the latencies as relative):

| Measure                                                             | Result                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Players credited, each exactly once and for its exact amount        | 500 of 500                                                                        |
| Double credits, wrong amounts, money without paying, flagged, open  | 0                                                                                 |
| Refusals for lack of an amount (`sms_amount_unavailable`, expected) | 1,015 (across the waves)                                                          |
| Open a deposit, `POST /payments/deposits`                           | p50 87 ms, p95 260 ms                                                             |
| SMS sent to deposit credited                                        | p50 156 ms, p95 301 ms                                                            |
| Bank SMS sent, of which replays                                     | 666, of which 166                                                                 |
| Replays that credited nothing                                       | all (13 concurrent pairs: the second request won the race, still one credit each) |
| Reconciliation after the run                                        | clean                                                                             |

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

## Results (15 Nov 2026): fewer statements per bet

Task A6 removed 3 of the 23 statements of an accepted bet (the read-back of the bet). An alternating
A/B of the two builds on one 4-CPU container (API and worker only, log level warn, the script's
defaults) gave 4,119 and 4,162 bets in 30 s before (137 and 139 per second) and 3,726 and 4,399 after
(124 and 147 per second), the ledger reconciling cleanly every time. The difference between the means
(2%) is far below the spread between runs (about 19%): fewer reads did not move throughput. See
`docs/plans/scale-and-payments-progress.md`, section 2.

## Results (16 Nov 2026): the house_stakes ceiling (A7)

`pnpm --filter @vamos/load house-stakes [--processes N] [--workers 8] [--seconds 15]` posts stakes with
the real `postTransaction` (player cash -1 ETB, `house_stakes` +1 ETB, one transaction each) from N
Node processes with 8 loops each, against a scratch database (`scripts/load/house-stakes.ts`). There
is no bet, no HTTP: this is the one row all bets share, and nothing else. One 4-CPU container, the
same disk as above, 15 s per run, the ledger check passing every time (house_stakes equals the total
staked, the entries sum to zero, no failed posting):

| Processes | Concurrent postings | Postings/s | p50   | p95    | p99    |
| --------- | ------------------- | ---------- | ----- | ------ | ------ |
| 1         | 8                   | 775        | 8 ms  | 25 ms  | 38 ms  |
| 2         | 16                  | 534        | 20 ms | 91 ms  | 147 ms |
| 4         | 32                  | 495        | 42 ms | 204 ms | 323 ms |
| 6         | 48                  | 367        | 82 ms | 406 ms | 663 ms |

What it says:

- **The row, not the CPUs, is the limit.** During the 4-process run (load average 2.4 on 4 CPUs) 16 to
  29 of the busy connections were waiting in `Lock:transactionid` and 2 to 15 in `Lock:tuple`, behind
  the one row.
- **The ceiling is 500 to 800 postings/s, and it goes down, not up, with more concurrent writers**:
  waiters queue on the row and every hand-over costs a wake-up. Eight concurrent postings did best;
  48 gave less than half of that. A busy period with many API processes therefore cannot reach the
  single-process figure on the house row alone.
- **The plan's threshold (shard only if the row limits below 300 bets/s) is not reached.** The row
  allows about 370 to 500 stakes/s with 32 to 48 writers. In a real bet the posting is only the last
  part of the transaction, so fewer bets queue on the row at once than here. No shard, no change of
  the ledger layout: A7 stays measured-only.
- **Settlement shares the row.** Settling a lost or won bet posts to `house_stakes` too, so a
  settlement burst (the whole evening's final whistles) takes row time from bet placement. If the
  load test of the whole stack (A1) ever shows bet latency climbing while settlement runs, this
  table is the budget: about 500 postings/s shared. The remedy then is to batch settlement postings
  per event, before sharding the account.
- **Not measured**: a slower disk (commit is about 0.3 ms here; a network disk can be 5 to 10 times
  that and lowers the ceiling in proportion), and PgBouncer in front (the overlay of A4).

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
about 23 queries in `placeBet` (20 since task A6 on 15 Nov 2026: the bet is no longer read back after the insert; the rest sit in `rg/` and `ledger/`, see the plan's task A6b), about 20 ms of database round trips when timed alone, and about
40 ms end to end through the API. The p95 at 50 connections is mostly queueing: 40 bet connections
divided by 96 bets/s is about 0.42 s.

To go further:

- **Scale out.** Run several API replicas. They share nothing but Postgres and Redis. With the stake
  posting last, the lock-bound ceiling for one house account is several hundred postings/s. It was
  measured on 16 Nov 2026 (task A7, next section).
- **Cut queries.** Avoid re-reading the bet after inserting it (`getBetById`, 3 queries), and merge
  the two `users` reads.
- **Split the house account.** Only if that ceiling is ever reached, split `house_stakes` per channel
  or shard. That would change the ledger account structure and reconciliation, so it needs its own
  design review.

## Pages and live streams: `pnpm load:pages`

A third script, `scripts/load/pages.ts`, tests the read side: page and list requests through the web
app and the API, and open `GET /live/stream` connections that must each see a price change. It
needs an API and a web app that are up, a catalogue with fixtures (run the worker's feed ingest
once; stop it afterwards if you want quiet streams) and the Redis the API relays from. It writes
nothing to the database. It sends a distinct `X-Forwarded-For` per request, so start the API with
`TRUST_PROXY=127.0.0.1` as for the deposit burst.

```bash
OPERATING_MODE=demo PAYMENT_PROVIDERS=mock,sms SMS_RAIL_MODE=simulated TRUST_PROXY=127.0.0.1 \
  pnpm --filter @vamos/api exec tsx src/server.ts      # or the built stack, bash e2e/scripts/stack.sh start
pnpm load:pages                                         # 1/10 of the plan's load, 30 s
pnpm load:pages --scale 0.3 --duration 60               # also: --streams, --rate, --api, --web
```

The load is section 2 of `docs/plans/scale-and-payments-plan.md` times `--scale`: 700 page and list
requests a second and 6,000 open streams at scale 1. Requests go out at a fixed rate (a slow answer
does not slow the sending), in this mix: web home 15%, web sport page 10%, web event page 10%, web
live page 5%, API `/sports` 10%, API `/events` list 30% (four different queries), API `/events/:id`
20%. The mix is an assumption, to be replaced with real traffic. If the web app does not answer, its
kinds are skipped and a warning says so. Every 5 s the script publishes an `odds` change on the
live Redis channel, as the worker does, and times how long each open stream takes to see it.

It prints p50/p95/p99/max per kind of request (answers of 400 and above count as errors, not as
latencies) and for the stream delivery. It exits 1 if a stream could not be opened, a stream
missed a price change, the error rate is above `--max-error-rate` (default 0.5%) or the script
could not send as planned. The p95 targets (400 ms for requests, 2 s for a price change) are
printed, not enforced.

### Results (16 Nov 2026): baseline on one 4-CPU container

Everything shares the 4 CPUs: Postgres, Redis, one API process, one production web server
(`apps/web/server.mjs`, one Node process), the script, and no worker. Catalogue cache of the API at
its default. Scale 0.1 (63 to 70 requests a second, 600 streams), two runs of 30 s:

| Kind                   | p50 (ms) | p95 (ms) |
| ---------------------- | -------- | -------- |
| web `/`                | 34.6     | 88.6     |
| web `/sport/football`  | 11.6     | 33.2     |
| web `/event/:id`       | 28.2     | 63.2     |
| web `/live`            | 18.2     | 48.4     |
| API `/sports`          | 1.4      | 5.1      |
| API `/events`          | 2.4      | 8.4      |
| API `/events/:id`      | 5.1      | 9.0      |
| all requests           | 5.6      | 49.8     |
| price change to stream | 8.8      | 16.4     |

(First run: all requests p95 93.6 ms, delivery p95 24.7 ms.) No errors, every stream saw all 5
price changes. Larger scales on the same box:

| Scale | Requests/s asked | Streams | Result                                                                                               |
| ----- | ---------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| 0.3   | 210              | 1,800   | No errors, but web pages p50 2 to 5 s, p95 18 s; API kinds p95 16 to 28 ms; delivery p95 58 ms       |
| 0.5   | 350              | 3,000   | 8% of requests failed (all web); API p95 18 to 39 ms; delivery p95 96 ms                             |
| 1     | 700              | 6,000   | With the web app: 23% failed (all web, p95 32 s); API p95 60 to 173 ms; delivery p95 179 ms          |
| 1     | 700 (API only)   | 6,000   | No errors; API p50 22 to 73 ms, p95 219 to 1,411 ms; delivery p95 159 ms; the script sent 606/s only |

What this shows, on this box and with this mix:

- **The web server is what breaks first.** Server-rendered pages saturate one Node process at
  roughly 40 to 60 pages a second, long before the API (the API answered at p95 under 30 ms while
  the pages queued for seconds). Nothing in the web app reuses catalogue answers yet (task A3).
- **6,000 live streams open and deliver.** All of them were open within 2.5 s and saw every price
  change, with p95 delivery 96 to 179 ms (the time grows with the streams because one process
  writes every frame). The 2 s target holds with room to spare. The API-only run at scale 1
  does show list latency growing under 6,000 streams plus 700 requests a second (p95 0.2 to 1.4 s),
  which is what task A5 (streams on their own process) is meant to change.
- **Not measured:** more than 6,000 streams; the web app behind the proxy (Caddy, brotli is done
  by `server.mjs`); bet latency while the streams are open (run `pnpm load:bets` next to it); a
  machine other than a shared 4-CPU container. At scale 1 the script itself uses a large share of
  one CPU, so the API-only numbers understate what separate machines would show.
