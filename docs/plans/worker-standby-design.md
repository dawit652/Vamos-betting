# The worker: what a failure costs, and a standby (design, task A9)

16 Nov 2026. Read against the code of that day. Nothing here is built except what section 1 says is
already there. It needs no owner decision until section 4 (a second server is decision D7).

## 1. What the worker does and what stops when it stops

One worker process runs everything that happens after a change is committed: the outbox dispatcher,
the queue consumers (settlement, jackpot settlement, live bet acceptance, provider payouts, SMS, push
messages, AML, reconciliation) and the timed tasks (sweeps, deposit reconciliation, the SMS rail's
checks, reports, pruning). The API keeps taking bets, deposits and withdrawal requests without it.

| While the worker is down                           | Effect for a player or for staff                          |
| -------------------------------------------------- | --------------------------------------------------------- |
| Live bets wait in `pending_acceptance`             | Stake taken, bet not confirmed. The first thing noticed   |
| Results are not settled                            | Winnings not paid                                         |
| SMS-rail deposits                                  | **Still credited** (the API credits on the forwarded SMS) |
| Manual payouts (claim, settle)                     | **Still work** (back office and API only)                 |
| Provider payouts, notifications, SMS texts, alarms | Wait. Alarms raised by the worker are not raised          |

Nothing is lost: every job comes from an outbox row written with the change itself, and rows stay
unpublished until a dispatcher hands them over. After a restart the dispatcher drains the backlog
(about 9,000 rows a second since 16 Nov), BullMQ gives a job whose worker died back to its queue when
its lock runs out (30 s), and the sweeps pick up what no job covers.

## 2. What protects it today, and the gaps

- **A crashed process is restarted** by Docker (`restart: unless-stopped`). SIGTERM is clean: `/ready`
  answers 503, jobs in hand finish (up to 60 s, `stop_grace_period: 75s`).
- **Gap 1: a hung worker is not restarted.** The container health check (`/health` every 15 s) marks it
  `unhealthy`, and nothing acts on that: Compose does not restart unhealthy containers.
- **Gap 2: nobody is told.** A worker that is down raises no alarm, because the worker raises the alarms.
  The only signs are the API's gauges (`manual_payout_oldest_approved_seconds`, open deposits) and,
  since 16 Nov, `outbox_oldest_unpublished_seconds`, which only the worker itself serves.
- **Gap 3: the server.** One host: when it is gone, so is everything. That is A11 and decision D7, not a
  worker question.

## 3. One server: close gaps 1 and 2 (recommended now, small)

1. **Outbox age on the API's `/metrics` too** (`readOutboxBacklog` exists in `@vamos/db`): the API
   outlives the worker, so the gauge keeps answering when the worker cannot. Alert on
   `outbox_oldest_unpublished_seconds > 60`. This is the one alarm that covers every way the worker can
   fail (down, hung, Redis refusing jobs, dispatcher stuck). Sonnet, medium.
2. **Restart an unhealthy worker from the host**: a systemd timer (or cron) every minute that runs
   `docker inspect` on the worker and, when it has been `unhealthy` for two checks, runs
   `docker compose restart worker` and writes one `error` line with `alarm: worker_restarted`. A script
   in `infra/scripts` with a stub-docker test like the backup script's. It needs no Docker socket inside
   any container. Installing it on the server is the owner's step. Sonnet, medium; Opus reviews.
3. **Owner alert from the API when the outbox is older than 5 minutes**: optional, once item 1 exists;
   the owner-alert path is itself an outbox row the worker sends, so it must go out another way (the
   API's own SMS sender) or it is not worth doing. Decide after item 1.

## 4. Two servers: a standby that cannot run beside the active worker (after D7)

A second worker on another host must never run its timed tasks beside the first: several of them take
no lock (only the compliance tasks and the live simulator do), and although money moves are idempotent, two
instances would double provider status calls, SMS texts and alarm lines. Rather than audit every task
for running twice, keep one active worker and make the rule something the database enforces:

- **Leader lock.** At startup the worker opens one dedicated database connection and takes
  `pg_try_advisory_lock(<worker key>)`. Without it, it starts no task, answers `/ready` 503 with
  `standby`, and tries again every few seconds. With it, it starts as today.
- **Why Postgres.** Both workers write to this database, so it is the one authority both must reach
  to do any harm. A lock in Redis can be held by a worker that has lost the database, or lost by one
  that still has it. The lock is tied to the connection: when the active worker or its host dies,
  Postgres frees the lock (TCP keepalives on that connection bound how soon: set them to about 30 s).
- **Losing the lock.** If the lock connection ends, the worker stops taking work at once and exits, and
  Docker restarts it as a standby. A job in hand may finish after the other worker has started: that is
  the same case as a BullMQ stalled job today, and every consumer is idempotent for it.
- **Direct connection.** The lock connection must not go through PgBouncer (transaction pooling has no
  session to hold a lock). The worker already connects directly (the scale overlay of A4).
- **Takeover time.** Lock freed (up to 30 s) plus a retry interval (5 s) plus start (seconds): under a
  minute, without a person. The standby is warm, not cold: the process runs and waits.
- **Tests.** Two workers on one database: only one starts tasks; kill the active one, the other takes
  over and drains; cut only the lock connection, the worker exits; a standby never dispatches.

This is Opus, high (startup and shutdown order of the worker), about a day with tests, and it is only
useful with a second host. Do it with A11.

## 5. Pace after the final whistles (measured 16 Nov)

- **The dispatcher** was the hard limit (100 rows a second for everything). Fixed: about 9,000 a second.
- **Settlement** settles one bet per transaction, the bets of one event one after another, two events
  in parallel: about 220 bets a second in one lane, 360 to 385 with two, no more with four (320 to 375:
  the lanes meet on the `house_stakes` row, the ceiling of task A7). 100,000 open bets on an evening's
  matches are settled in about 4.5 minutes. While that runs, settlement uses most of the row's 500
  postings a second, so bets placed in those minutes are slower.
- **If that is too slow:** post once per batch of bets, not once per bet (one `house_stakes` update for
  50 bets). It changes how settlement writes the ledger, so it needs its own design, golden tests and a
  review. Not started, and not needed below about 100,000 bets an evening. Raising the settlement
  concurrency does not help.
- **The worker's database pool** stays at 10: settlement holds 2 connections, the rest are short.
  Reproduce the numbers with
  `BENCH=1 pnpm --filter @vamos/worker exec vitest run test/settlement-pace.bench.test.ts --reporter=verbose`.
