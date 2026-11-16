# Scale and payments: handover for the next session

Written 15 November 2026 for the next Claude Code session (another account), and refreshed at the end
of the second working session that day (section 6). The progress file is the truth about what is done;
this file is the to-do list, cut so that each line fits one short session.

- **The plan:** [scale-and-payments-plan.md](scale-and-payments-plan.md).
- **What is done, measured and decided, task by task:** [scale-and-payments-progress.md](scale-and-payments-progress.md).
  Read it before starting and update it in the same commit as every finished task.
- **Project rules:** `CLAUDE.md` (money is bigint santim, double-entry ledger, pure domain maths in
  `packages/core` with property tests, real-Postgres integration tests, the payments section). Its model
  routing applies: **Opus, high** for design, migrations, the money path and reviews; **Sonnet, medium**
  for well-specified code; **Haiku, low** for running checks. At most two agents at a time. The two
  agents it names, `routine-coder` and `quick-task`, are in `.claude/agents/` since 15 Nov, so every
  account has them.
- **The server and deploys** are a separate stream: root [`HANDOFF.md`](../../HANDOFF.md).

## 0. Paste this to start

Copy this as the first message of the new session (the repository `dawit652/Vamos-betting` selected):

```text
Continue the "scale and payments" work on Nahubet.

1. Find the handover: if docs/plans/scale-and-payments-handover.md exists in your checkout, use it.
   If not, run `git fetch origin claude/eager-cerf-ox9vkq` and start your branch from
   origin/claude/eager-cerf-ox9vkq (fast-forward or merge it into your session's branch).
   If several branches have the file, use the branch where scale-and-payments-progress.md was
   committed last (the handover's section 1 has the command).
2. Read, in this order: CLAUDE.md, docs/plans/scale-and-payments-handover.md,
   docs/plans/scale-and-payments-progress.md, then only the parts of
   docs/plans/scale-and-payments-plan.md that your task names.
3. Run `git log --oneline origin/claude/eager-cerf-ox9vkq -25` to see what landed since the handover was
   written, and read sections 6, 8 and 9 of the handover (what was half done, how to recover it; section 9 is
   the newest and its order of tasks replaces the lists of sections 6 and 8). Do the setup in the handover's section 1, then take the first item of that
   list that the progress file marks `open` (rows marked `in progress` belong to another session; its
   claim names it and the time; claim yours in the progress file and push that before you start). One
   task at a time: tests with it, `pnpm lint`, `pnpm typecheck`, the test suites of the touched packages
   and `pnpm format:check` green, then update the progress file, commit and push. Never leave the
   branch failing.
4. Follow CLAUDE.md's model routing to save usage. Stop starting new tasks when the session is close
   to its limit; instead update the progress file and section 6 of the handover, commit and push.
5. Ask me before anything in the handover's section 4 (owner decisions), before merging pull request 5
   or any other pull request, and before anything that touches the live server.
```

## 1. Before the first task

1. **Branch.** This work is on `claude/eager-cerf-ox9vkq`: the default branch
   (`claude/quirky-ramanujan-xb7e2u`, `b7dc17c`) plus the back-office theme, `E2E_CHROMIUM_PATH` and
   these documents. It reaches the default branch by pull request (README, "Branches"); the owner has
   not asked for one yet. If the default branch has moved, merge it in first. A later session may
   have continued on another branch; this lists every branch that has the progress file, newest
   first, and the first line is the one to continue from:

   ```bash
   git fetch origin && for b in $(git branch -r | grep -v HEAD); do d=$(git log -1 --format=%ci "$b" -- docs/plans/scale-and-payments-progress.md 2>/dev/null); [ -n "$d" ] && echo "$d $b"; done | sort -r
   ```

2. **Set up:** `pnpm install`, `cp .env.example .env`, `pnpm services:start`, then
   `OPERATING_MODE=demo pnpm db:migrate && OPERATING_MODE=demo pnpm db:seed`. The default mode is
   licensed and refuses the mock payment provider, so run tests and scripts with `OPERATING_MODE=demo`
   (the `.env` from the example already says demo).
3. **Things that cost the last session time:**
   - Postgres and Redis stop when the cloud container sits idle: `pnpm services:start` again.
   - After switching between branches with different migrations, recreate the local database:
     `PGPASSWORD=vamos psql -h localhost -U vamos -d postgres -c "DROP DATABASE IF EXISTS vamos" -c "CREATE DATABASE vamos"`,
     then migrate and seed.
   - End-to-end tests in a cloud container: `bash e2e/scripts/stack.sh build`, `start`, then
     `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm e2e` (the preinstalled Chromium is newer than
     the pinned one), then `stop`. Never rebuild the web app while that stack runs: it serves from the
     same `.next` folder. Build the web app without `NEXT_PUBLIC_OPERATING_MODE=licensed` for e2e.
   - The worker's health server uses port 4100. Node's `fetch` refuses some ports (4190 is one); use
     4500 or higher for helper servers.
   - A load test or e2e run needs the whole machine: do not run `pnpm test` beside it.
4. **Switches stay off.** Everything this work adds that changes how money moves (C2's automatic
   settle, new approval tiers, a wider amount range) ships behind a setting that is off or unchanged
   by default. Switching on is the owner's call.
5. **No real provider is reachable from a cloud session.** telebirr's receipt page refuses foreign
   addresses and no provider sandbox exists yet. Build against fixtures
   (`packages/core/src/smsparse.fixtures.ts`, `packages/payments/src/receipts/fixtures.ts`) and the dev
   SMS simulator (`POST /dev/payments/sms`, demo only).

## 2. What the last session found (15 Nov 2026)

- Its branch had started from an older base (`a577587`). The default branch had meanwhile gained
  release v0.3.0, the SMS deposit rail, manual payouts and the redesign with its own search, day
  chips and 1X2 / double chance switch. The branch was merged onto the default branch with the default
  branch's files; the duplicate work stays in history only.
- Carried over: the back-office dark and light theme (`apps/admin`, cookie `vamos_admin_theme`) and
  `E2E_CHROMIUM_PATH`. Not carried over yet: tasks X1 and X2 below.
- The first version of the plan described the old base and was replaced. The plan in this folder
  describes the live system.

## 3. Tasks that need no decision (start here, in this order)

Each line is one commit (or one pull request when the owner asks for them) with its tests. Paths are
where to start reading, not the full list of files.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                 | Model, effort                           | Done when                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1a | **Deposit burst in the load test** (`scripts/load`, package `@vamos/load`, today only `bet-placement.ts`). 500 SMS deposits of one round amount from 500 players, then the forwarded SMS through `POST /dev/payments/sms`, in and out of order, some twice. This is the open item of `docs/plans/melabingo-payments-port.md` §3.10                                                                                                   | Sonnet, medium; Opus reviews the checks | `pnpm load:deposits` prints how many deposits were refused for lack of an amount, credit latency p50/p95, and fails unless every paid deposit is credited exactly once and reconciliation is clean. The numbers are in the progress file |
| A1b | **Pages and live streams in the load test:** list and event requests through the web app and the API, and N open `GET /live/stream` connections that must each see a price change                                                                                                                                                                                                                                                    | Sonnet, medium                          | `pnpm load:mix` runs the mix of the plan's section 2 at a chosen scale and prints p50/p95 per kind of request. Baseline at 1/10 scale recorded in the progress file                                                                      |
| B4  | **Offsets 1 to 99.** `MAX_SANTIM_OFFSET` in `packages/core/src/smsmatch.ts`, the range read in `createSmsDepositIntent` (`packages/db/src/payments/smsrail.ts`), every text that says "50" (web deposit screen, i18n, runbook). The hold on cancelled deposits waits for decision D5                                                                                                                                                 | Opus, high (money path)                 | Property tests pass with 99; A1a refuses about half as many deposits as before; docs and texts say 99                                                                                                                                    |
| B2a | **Amount space per collection account, pure part.** In `packages/core/src/smsmatch.ts`: allocation and matching take the collection account; an SMS only matches deposits of the account it arrived on; a deposit without an account (older rows) matches as today. Property tests: no collision within an account, the same amount on two accounts never cross-credits                                                              | Opus, high                              | Core tests and properties pass; nothing outside `packages/core` changed                                                                                                                                                                  |
| B2b | **The same in the database and the gateway:** a migration (next free number) adding the collection account to `payment_intents` and `received_sms` and scoping the unique index and the taken-amount query to it; each handset is tied to its account (an id per handset in `SMS_COLLECTION_ACCOUNTS`, sent by the forwarder); `createSmsDepositIntent` offers the account with the most free amounts                                | Opus, high (migration, money path)      | Integration tests: two accounts give twice the open deposits of one; an SMS on account A never credits a deposit of account B; replays still credit once; `app-role.test.ts` passes                                                      |
| B2c | **Screens:** the deposit screen shows the account the server chose; the back office's SMS page shows the account of each message                                                                                                                                                                                                                                                                                                     | Sonnet, medium                          | `e2e/tests/sms-rail.spec.ts` passes with two simulated accounts                                                                                                                                                                          |
| C1  | **Faster hands for manual payouts** (`apps/admin/src/app/manual-payouts`, `apps/api/src/modules/admin/smsrail.ts`, `packages/db/src/payments/manualpayouts.ts`, rules in `packages/core/src/payoutflow.ts`): claim up to N approved payouts in one step (same refusals as a single claim, per row), a pick list grouped by institution with copy buttons for number and exact amount, an alarm for a claim left open over 30 minutes | Sonnet, medium; Opus reviews four eyes  | The four-eyes tests still pass (approver never claims, only the claimer settles); a batch claim of 20 with 2 refused rows claims 18; the page works at phone width                                                                       |
| A2  | **Catalogue cache in the API** (`apps/api/src/modules/catalog/routes.ts`, `queries.ts`; Redis is in `apps/api/src/deps.ts`): `/sports`, competitions and `/events` list pages kept 2 s per normalised query, one refresh at a time per key, off with a setting. Not the event page, never bet placement                                                                                                                              | Sonnet, medium                          | Tests: two different queries never share an answer; one refresh under 100 concurrent requests; A1b shows list latency flat as connections grow                                                                                           |
| A3  | **The web server reuses catalogue answers for 2 s** (`apps/web/src/lib/api/server.ts`, `catalog.ts`): only the public catalogue calls, never anything per player                                                                                                                                                                                                                                                                     | Sonnet, medium                          | Unit test of the reuse; the page-weight budget and the e2e suite pass                                                                                                                                                                    |
| B6  | **`received_sms` in the daily reconciliation and the retention job, and a re-parse action** for unparsed messages (`packages/db/src/compliance/reconciliation.ts`, the SMS page). Open gaps of the payments port                                                                                                                                                                                                                     | Opus, high (reconciliation)             | A missing or doubled SMS credit shows as a reconciliation difference in a test; re-parse credits a message once after its parser is fixed                                                                                                |
| A4  | **Several API processes and PgBouncer** in `infra/docker-compose.prod.yml` and `infra/caddy/Caddyfile`: N `api` replicas behind the proxy, PgBouncer in transaction mode for the API, the worker and the migrate job direct. The code uses only transaction-level advisory locks and no `LISTEN` (checked 15 Nov), so pooling is safe; check again before merging                                                                    | Opus, high                              | The compose stack boots with 4 replicas through the pooler; `scripts/smoke.sh`, the e2e suite and A1's tests pass against it; `docs/deployment.md` scaling section updated                                                               |
| A5  | **Live streams on their own processes:** a role switch for the API (streams only, or everything but streams) and proxy routes for `/live/stream` and `/me/stream`                                                                                                                                                                                                                                                                    | Sonnet, medium; Opus reviews            | A1b with 2,000 streams does not change bet latency                                                                                                                                                                                       |
| A6  | **A leaner bet** (`packages/db/src/betting/place.ts`): the query cuts listed in `docs/load-testing.md`. The test that keeps the stake posting last must stay                                                                                                                                                                                                                                                                         | Opus, high (money path)                 | `pnpm load:bets` shows fewer queries per bet and no worse latency; every betting test passes                                                                                                                                             |
| A10 | **A metrics endpoint** for the plan's targets (latency, errors, queue age, open streams, open deposits per round amount, oldest approved payout). The log alarms stay                                                                                                                                                                                                                                                                | Sonnet, medium                          | `/metrics` on the API and the worker, not published by the proxy; documented in `docs/deployment.md`                                                                                                                                     |
| C10 | **Float forecast:** from open bets, their possible payouts and their matches' end times, the expected withdrawals of the next hours; an alarm when a collection account's last known balance (from its SMS) is below it                                                                                                                                                                                                              | Sonnet, medium; Opus reviews            | A pure function in `packages/core` with tests; the health panel shows the forecast; alarm `payout_float_low`                                                                                                                             |

## 4. Tasks that wait for the owner

The decisions (D1 to D8) and their recommended answers are in the plan, section 8, and their state
is in the progress file.

| #      | Task                                                                                                                                                                                                                                                         | Waits for                   | Model, effort  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------- |
| B1     | Real SMS and receipt fixtures per institution (payer details replaced), and the answer whether telebirr's SMS carries the payer's full number                                                                                                                | The owner's test payments   | Sonnet, low    |
| B3     | Match by the payer's phone first                                                                                                                                                                                                                             | B1                          | Opus, high     |
| B4b    | A shorter hold on amounts of cancelled deposits                                                                                                                                                                                                              | D5                          | Opus, high     |
| C2     | Settle on double proof: the outgoing SMS and telebirr's receipt page both confirm the claimed payout. Needs a debit mode in `packages/payments/src/receipts`, a decision on who the settlement is recorded under, a cap, and a written security review first | D4, D8                      | Opus, high     |
| C3     | Payout batch files and result import                                                                                                                                                                                                                         | D1 or D2 (the file formats) | Opus, high     |
| C4     | telebirr business payouts by API (`packages/payments/src/providers/telebirr.ts` is deposit-only today)                                                                                                                                                       | D1 (contract, API document) | Opus, high     |
| C9     | Approval tiers (identity verified, account age, a destination paid before, amounts per tier) beside `autoApproveBelow`                                                                                                                                       | D6, D8                      | Opus, high     |
| C5     | Bank host-to-host transfers for bank-account payouts and large amounts                                                                                                                                                                                       | D2                          | Opus, high     |
| B7     | telebirr merchant checkout switched on as a second door                                                                                                                                                                                                      | D1                          | Sonnet, medium |
| B8, C6 | EthioPay-IPS through a bank (payment requests, QR, bulk payments)                                                                                                                                                                                            | D2                          | Opus, high     |
| A11    | More than one server                                                                                                                                                                                                                                         | D7, after A1's baseline     | Opus, high     |

A7 (the `house_stakes` ceiling) and A9 (the outbox dispatcher, the pace of settlement, the standby
design) were done on 16 Nov: `docs/load-testing.md` and `docs/plans/worker-standby-design.md`. Later,
when the load test asks for it: A8 (database tuning, replica, partitions), Opus, high; see the plan,
section 4. A9b (outbox age on the API's metrics, a host script that restarts an unhealthy worker) is
small and open. B5 (a second
handset and a heartbeat alarm) needs a spare phone on site. B9 (a statement feed for CBE) waits for D2.

## 5. Left over from the last session (not part of the plan)

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Model, effort                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| X1  | **Top-match flag** (optional; ask the owner if it is still wanted now that the live home has featured leagues): a trader marks a match, the home poster shows the soonest one. Built on the old base in `136f469` (API, `events.top_match`, back-office action) and `4df33b1` (web); port it with a new migration number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Opus (migration), Sonnet            |
| X2  | **End-to-end tests of the redesign:** `e2e/tests/redesign.spec.ts` as of `4df33b1` (theme switch, market filter chips, slip bar and drawer, docked betslip, day chips, double chance, search). Selectors must be adapted to the live screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Sonnet, medium                      |
| X3  | **Rename the inside from Vamos to Nahubet.** The owner chose a full rename on 15 Nov; the visible brand is already Nahubet. Do it in stages, each green: (1) docs and comments; (2) the package scope `@vamos/*`, in one pull request while no other branch is open (it touches every import); (3) names the browser sees (cookies `vamos_locale`, `vamos_theme`, `vamos_admin_theme`, the `x-vamos-mode` header, storage keys): read the old name as well for 30 days so nobody loses a session, language or betslip. **(4) Names on the server (compose project `vamos`, volumes, network, database and role `vamos_app`, image names, backup folders): do not start without the owner at the server.** A renamed compose project makes Docker create new, empty volumes, so the stack would start on an empty database; the deploy scripts and the backups use these names too. The recommendation given to the owner is to leave stage 4 alone | Opus, high for 2 to 4; Sonnet for 1 |
| X4  | Licensed texts for Help, Terms and Responsible gambling (also in root `HANDOFF.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Sonnet, medium, then the owner      |

## 6. State at the end of the second working session (15 Nov 2026, evening)

**Branch** `claude/eager-cerf-ox9vkq` is the default branch (`b7dc17c`, the deployed line) plus this
work; **pull request 5** (into `claude/quirky-ramanujan-xb7e2u`) is open and mergeable. The progress file
records the owner's answer as "pull requests merged once CI is green"; that line was written by the other
account's session after the owner said "use your recommendation" about opening the pull request, and the
first account never heard the merge rule from the owner: **ask the owner before merging.** CI runs on every code push (docs-only pushes skip it) and cancels
the older run of the branch, so only the newest push is checked; look at the run of the newest code commit
(`mcp__github__actions_list`, or the Actions tab). The `e2e` and `docker` jobs run only on the default
branch or by hand (Actions, CI, Run workflow); run them once by hand before merging, because the
scale-out overlay (A4) is validated only by the `docker` job.

**Done and pushed** (details and numbers in the progress file):

- **A6** a leaner bet (23 to 20 statements), golden and budget tests. Measured: **no throughput gain**
  (section 7). **A3** web server reuses catalogue answers for 2 s. **A10** protected `/metrics` on the
  API. **A4** opt-in scale-out overlay (PgBouncer, API replicas, `Caddyfile.scale`), `DB_POOL_MAX`, a
  pooling-safety test. **C1** manual payouts: batch claim, pick list, idle-claim alarm, reviewed by Opus
  (no four-eyes bypass; the starvation finding fixed).
- **Back office** dark and light theme; **E2E_CHROMIUM_PATH**; the two agents named by CLAUDE.md are in
  `.claude/agents/`; **the C2 design** (`docs/plans/c2-double-proof-design.md`, Opus).

**Half done when this was written** (the first account's two Opus agents hit the 5-hour limit, which
resets at 01:00 UTC; their partial work was saved, nothing was lost):

- **C12, settle evidence hardening: LANDED (`8c58c5d`), verified, but not yet reviewed by Opus.** It was
  the most urgent code task: the typed-reference settle in `packages/db/src/payments/manualpayouts.ts`
  accepted any same-amount debit SMS (`ignored_debit`) without checking it went to the player's number or
  came after the claim, so a claiming operator could pay themselves and settle the player's payout with
  that debit. Now a wallet proof must name the payout's number (409 `settlement_destination_mismatch`; an
  SMS with no number counts only as the matcher's own proposal for this payout), every proof must be of a
  transfer after the claim minus 5 minutes (409 `settlement_proof_too_old`, core `latestClaimForSms`),
  and proposals only attach to claimed payouts. Verified here: typecheck clean; core 909, db 812, api 523,
  worker 123, admin 105 tests pass; the source was read line by line. **To do: a read-only Opus review**
  (the scenarios: an honest operator blocked by a phone-format difference or a bank SMS without a
  counterparty; an operator who sends the money before claiming is refused by design; races) **and a
  deploy** (`infra/scripts/deploy-full.sh`, the owner at the server, root `HANDOFF.md`): until it is
  deployed the hole is open. The runbook also lost a wrong sentence: the debit-SMS proof is required
  only when `PAYOUT_REQUIRE_PROOF=true`, not "in licensed mode".
- **C2a, the pure double-proof rule: DONE (16 Nov, first account).** `packages/core/src/payoutproof.ts`
  (`decideDoubleProof`), `auto_settle` in `assessManualPayout`, the masked-account matcher in core
  (`receiptaccount.ts`), 991 core tests (every row of the design's decision table plus fast-check
  properties: any single changed or removed field never settles). The review inside the work found and
  fixed an unsafe payer check (a number ending in the same three digits as ours passed). It is wired into
  nothing: C2b to C2f remain, see the design's sections 9 and 11.

**The other account's claims** (A1a, A2, B4, claimed about 15:40 UTC by its own report): nothing was pushed
by 21:00 UTC. Claims older than 6 hours without a commit are free (after 21:40 UTC): take them, in the
order of section 3.

**Findings the design made** (not yet fixed; each is a task or a note): `judgeReceipt`
(`packages/payments/src/receipts/`) is lenient (accepts a missing reference or status and the amount
"anywhere on the page", which includes totals with fees): C2c tightens it for debits, and the deposit
audit deserves the same look (an audit only, it never reverses); payouts do not record which collection
account sent them; `received_sms.receipt_payer` holds a name, not an account; "the worker never touches
manual payouts" stops being true if C2 goes to `on`.

**Next, in this order** (model and effort in brackets):

1. Review C12 with Opus (read-only) and deploy it with the owner; finish C2a from the patch (Opus, high).
2. **B4** offsets 1 to 99, then **B2a, B2b, B2c** amount space per collection account: deposits run out of
   amounts first at 10,000 players (plan, section 3). B2b and C2b both need **migration 0053**: only one
   session creates a migration at a time; whoever merges second renumbers.
3. **A1a, A1b** the load tests (deposit burst, pages and streams) and, on a server with real cores, measure
   the overlay: `pnpm load:bets --api <url>` against one replica and against three (A4 is unmeasured).
4. **A2** catalogue cache in the API, **A5** live streams apart (Sonnet, medium; Opus reviews).
5. **B6** `received_sms` in the reconciliation and retention, with a re-parse action (Opus, high).
6. **C10** float forecast (Sonnet, medium; Opus reviews), **A10b** worker metrics (Sonnet, medium).
7. **C2b to C2f** per the design's section 9: they need real fixtures (a real debit SMS and a real
   telebirr transfer receipt page, listed in the design's section 8, the owner captures them), the owner's
   answers D4 and D8, and the shadow period before `on`. Until then C2 stays off.
8. **X2** end-to-end tests of the redesign, **X4** licensed texts, then **X3** the rename stages 1 to 3 (not
   the server's own names), last, in one pull request while no other branch is open.
9. Ask the owner whether to merge pull request 5 (CI green first, see above); after a merge continue on this branch
   (a merge commit needs no restart) and open a new pull request for what follows.

**For the owner** (not code): the two calls (`docs/plans/provider-calls-brief.md`, the bank first, telebirr
only if accepted), real fixtures (B1), D3 to D8 in the progress file, and whether the steer "outside
government platforms" means more than dropping EthioPay-IPS and pausing telebirr's APIs.

When you stop, rewrite this section (what is finished, what is half done and on which commit, what is
next) and the progress file, commit and push, so the next account can start from the prompt in section 0.

## 7. Recipes and facts from the second working session

- **A/B of bet throughput** (what A6 used): build the API and worker of the current tip
  (`pnpm --filter @vamos/api --filter @vamos/worker build`) and of the older commit in a `git worktree`
  (copy `.env`, `pnpm install --frozen-lockfile`, same build); start only the API and the worker of one
  build (`OPERATING_MODE=demo SIM_SPEED=60 LOG_LEVEL=warn node dist/server.js` in `apps/api`,
  `node dist/main.js` in `apps/worker`), run `pnpm load:bets`, stop them, then the other build, and
  alternate at least twice: the spread between runs was about 19%, so a smaller difference is noise.
- **Running the suites through PgBouncer** (A4's evidence): `apt-get update && apt-get install -y
pgbouncer`; a config with `* = host=127.0.0.1 port=5432`, `pool_mode = transaction`,
  `auth_type = trust`, `default_pool_size = 10`, user `vamos`; start it as the `postgres` user; then
  `DATABASE_URL=postgres://vamos:vamos@127.0.0.1:6432/vamos OPERATING_MODE=demo pnpm exec vitest run` in
  `packages/db` and `apps/api`. Only `app-role.test.ts` fails (the `vamos_app` login is not in that user list).
- **Metrics**: `GET /metrics` needs `METRICS_TOKEN` (32+ characters); without it the route is a 404.
- **GitHub**: CI does not run for docs-only pushes; a push cancels the older run of the branch.
- **Agents**: `routine-coder` (Sonnet, medium) and `quick-task` (Haiku, low) are in `.claude/agents/`; for
  hard work spawn a `general-purpose` agent with model `opus` and effort `high`. They share one working tree:
  tell them which files are theirs, ask for `Edit` not `Write` on existing files, commit only after you
  verified, and add files by path (never `git add -A` while an agent is running).

## 8. State at the end of the 16 Nov 2026 session (second account, replaces section 6's "Next" list)

**Finished and pushed to this branch** (one commit each, rows `done` in the progress file): A2 catalogue
cache (`CATALOG_CACHE_SECONDS`, default 2); A1a `pnpm load:deposits` (500 players credited exactly once);
A1b `pnpm load:pages` (numbers in `docs/load-testing.md`: one web server saturates at about 40 to 60
pages/s, the API holds the planned load alone); A10b worker `/metrics`; **B2a, B2b, B2c** an amount space
per collection account (migration **0053**; account `id` in `SMS_COLLECTION_ACCOUNTS`; the forwarder sends
`account`; the deposit screen shows the assigned account; the back office shows each message's account);
A5 `API_ROLE` and the opt-in `infra/docker-compose.streams.yml` overlay (no volumes, ports or names
changed); **B6** the `sms_credits` reconciliation check, `reparseSmsByStaff`, `POST /admin/sms/:id/reparse`,
the "Read again" button (migration **0054**). The next free migration is **0055**.

**Before any deploy of this work** (the owner at the server, `infra/scripts/deploy-full.sh`, root
`HANDOFF.md`): migrations 0053 and 0054 are in it; the rollback images keep working on the migrated
database (the index of 0053 treats a null account as before). **Do not run two or more live collection
accounts** until B2b, B2c, **B2d** (16 Nov: the player chooses the institution, the server picks an
account only within it) and every forwarder sending `account` are deployed (with one account nothing
changes). Verified on 16 Nov: `e2e/tests/sms-rail.spec.ts` passes against the built stack with the two demo
institutions (telebirr and CBE), and the page-weight budget spec passes. Not verified: `caddy validate` of `Caddyfile.streams` (CI does it), and 2,000 streams on
`streams` processes while `pnpm load:bets` runs on the others.

**Added on 16 Nov, 05:30 to 06:26 UTC (first account, session `01BG4x`), all pushed:** A7 measured (no
shard); A9: **the outbox dispatcher handed over only 100 rows a second and now drains about 9,000**
(worker code: deploy it with the rest), settlement pace measured (about 370 bets a second),
`docs/plans/worker-standby-design.md`; A9b part 1 (outbox age on the API's metrics); an independent
review of C2a that fixed one more weakness in the masked-account count (design section 12). **Deploy
note for the owner:** the dispatcher change is in `apps/worker` only, has no migration and changes no
job id or retry rule; after the deploy, `outbox_oldest_unpublished_seconds` on the api's `/metrics`
should read 0 or a few seconds.

**Owner, 16 Nov: "there is no way I can call the bank, solve it by the code."** So C3 and C5 are out
and C8 (a machine that types the wallet's menu) is reopened: `docs/plans/payout-sender-design.md`.
C8a (the pure judgement, `packages/core/src/payoutmenu.ts`) and **C8b part 1** (`apps/payout-agent`:
the driver on a modem's AT port, tested against a simulated modem and wallet) are built, and so is **part 2a** (a script made from one recorded session: core's `deriveMenuScript`
and the agent's `recordSession`). **Next is C8b part 2b**: the command line around what exists
(`probe`, `record`, `rehearse`), the serial port, the SIM's SMS in PDU mode (design, section 8; the
app's README). It needs no decision and no migration. Then C8c (the server
side, with a migration: coordinate the number). The owner still owes D10, D11, a payout SIM and a USB
modem before anything real can be sent, and an explicit yes at C8f. Do not weaken the design's
section 3 to make something work, and do not report the agent as working on a real modem: it has only
met the simulated one.

**Still open, in this order** (model and effort in brackets):

1. ~~C10~~ done (progress file): ask the owner for the real `FLOAT_FORECAST_WITHDRAWN_PERCENT` (the default 20 is a guess) and
   whether each institution or the sum should be compared with the forecast; Opus may review it (read-only).
2. **C12 is reviewed** (16 Nov: one more hole closed for bank payouts, see its progress row) and **needs a
   deploy by the owner**: until then the hole is open on the server. **C2a**
   is done (core only, wired into nothing): next in that chain is C2c (the receipt verifier's debit mode,
   Sonnet medium) and C2b (database, **migration 0055**, Opus high), both need real fixtures and the
   owner's D4 and D8 before anything can go to `shadow`.
3. ~~X2~~ done (`e2e/tests/redesign.spec.ts`, 11 tests; its caveats are in the progress file). The SMS rail
   spec passes with the two demo institutions (B2d fixed the choice); no e2e step yet picks the second
   institution on the deposit form (add one if you touch that form again). In the cloud container run the
   suite with `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium`, and run `pnpm install` after pulling (new
   workspace `apps/payout-agent`, otherwise typecheck and lint fail on `@vamos/core`).
4. **A8, A6b, B5, D1 to D8** per the progress file (A8 to B5 need no decision; D rows are owner
   tasks). A7, A9 and A9b are done; the owner still has to install A9b's watchdog timer on the server
   (`docs/deployment.md`, "A worker that hangs"), and the script has only run against a stub docker. If settlement must be faster than about 370 bets a second, that is a
   new money-path design (one ledger posting per batch of bets): ask the owner before starting it.
5. **X4** licensed texts for Help, Terms and Responsible gambling: needs the licence details from the
   owner; do not invent legal text. **X3** the rename stages 1 to 3 last, in one pull request while no
   other branch or agent is editing (it touches every import); never rename the compose project, volumes
   or database (the owner does not want Docker to start on an empty volume).
6. Pull request 5 (this branch to the default branch): CI must be green; ask the owner before merging.
   One CI run (403) failed only at `actions/checkout` (a GitHub-side error), not in our code.

**Facts that cost time** (more in section 7): a database test that credits through `ingestSms` needs the
account of the SMS to equal the deposit's (a null-account SMS pays only no-account deposits); the demo
simulator (`POST /dev/payments/sms`) sends the deposit's own account; a live-gateway API test must call
`goLive()` before opening the deposit; `KEYS` in ioredis does not add the key prefix to its pattern (list
`*` and filter); for the load tests start the API with
`OPERATING_MODE=demo PAYMENT_PROVIDERS=mock,sms SMS_RAIL_MODE=simulated TRUST_PROXY=127.0.0.1`.
Agents hit the 5-hour limit twice: give each agent one task and a list of files it may touch, never let
two agents edit the same file, and commit only after your own typecheck, lint and tests.

## 9. State at the end of the 16 Nov 2026 evening session (second account; replaces the lists of sections 6 and 8)

**Done today in this session, all pushed to `claude/eager-cerf-ox9vkq`** (rows in the progress file):
B2d (the player chooses the institution; the deposit gets an account of that institution only), the
C12 review fix (a debit SMS that names a mobile number never proves a bank payout), B5's alarm part
(`sms_account_silent`), C10, B6, A5, and three owner requests of 16 Nov:

- **About 500 options per match: built, switched off.** The market factory (v0.3.0) prices 587 to 635
  options per football match (156 to 176 markets; `packages/feed/src/pricing/factory.test.ts` asserts
  at least 500), on top of today's 67. They appear only with `SCRAPER_FACTORY_MARKETS=on` and
  `FEATURE_FACTORY_MARKETS=true` in `/opt/nahubet-new/infra/.env.prod` **and** the "Market factory
  markets" switch per league in the back office (Feed, league policy), and only for events the
  scraper prices from the market. Their Amharic names are still the English ones (parity plan task 2.4).
- **Flags and easier league finding:** the Leagues tab lists the top leagues first, then Ethiopia, then
  international competitions, then the countries A to Z, with a flag on every league
  (`orderLeagueCategories` in `apps/web/src/components/sportsbook/leagues.ts`). The top-leagues rail,
  the country chips and the league headers already had flags.
- **Left column like Hulusport** (wide screens): search box, Top Matches and Upcoming, a collapsible Top
  Leagues panel with flags and match counts, then Sports and More leagues (X7). Phones unchanged.
- **Match rows count options** like Hulusport's "503+": `optionCount` in the list rows (X8); 64+ per
  football match today, about 650+ with the market factory switched on. The scraper's factory test
  asserts at least 500 options for a market-priced match with the switches on.
- **Registration without a birth date** (already so since 15 Nov; KYC still asks for the verified date).
- **4-digit PIN and staying signed in:** new player passwords are 4-digit PINs (easy ones refused:
  repeats, straight runs, about 28 common PINs, the phone's last 4 digits), login limits per number
  are 6 per 15 minutes and 15 per day (lifted by the SMS reset), and a player session lasts
  `PLAYER_SESSION_HOURS` (default a year) with no idle limit. Older long passwords keep working. The
  trade-offs are written in `docs/deployment.md`, "Player sign-in". Staff sign-in is unchanged.

**Owner (not code), in this order:**

1. **Put the server's own changes on GitHub**, so the deploy is built on top of what runs. They are in
   `/opt/nahubet-live-save` (branch `live/nahubet-new-2026-11-15`, commit `ce7761b`) and were never
   pushed (the server's GitHub key is read-only). On the server:
   `git -C /opt/nahubet-live-save show --stat ce7761b` (check that no `.env*` file or key is in it), then
   `git -C /opt/nahubet-live-save bundle create /root/nahubet-live.bundle live/nahubet-new-2026-11-15`.
   On the PC (PowerShell): `scp root@<server>:/root/nahubet-live.bundle "$HOME\Desktop\nahubet-live.bundle"`,
   then in the PC's clone: `git fetch "$HOME\Desktop\nahubet-live.bundle" live/nahubet-new-2026-11-15:live/nahubet-new-2026-11-15`
   and `git push origin live/nahubet-new-2026-11-15`.
2. After the merge (code task 1 below) and a green CI: deploy the whole stack with
   `infra/scripts/deploy-full.sh` from `/opt/nahubet` (root `HANDOFF.md` has the command; it keeps the
   licensed env file and the volumes, dumps the database first, and rolls back by itself on failure).
   Migrations 0053 and 0054 are in it. For the ~500 options add the two settings above to the env file
   before the deploy, then switch the leagues on in the back office.
3. Decisions and things only the owner has: the real `FLOAT_FORECAST_WITHDRAWN_PERCENT` (20 is a guess),
   D1 to D8, D10, D11, a payout SIM and a USB modem (C8), the licence details (X4), a native speaker for
   the Amharic texts (the new PIN texts in `packages/i18n/src/messages/am/account.ts`, the factory
   market names), and whether to merge pull request 5.

**Code, in this order** (model and effort in brackets; claim each row in the progress file first):

1. **Merge the server's branch: DONE 16 Nov 2026 (session `01BG4x`, commit `31ba705`; see `docs/deployment.md`, "First deploy after the server's branch was merged").** Original brief, kept for the record (Opus or Fable, high): `git fetch origin
live/nahubet-new-2026-11-15` and merge it into this branch. Review it first: no secrets or env files,
   no large files, its migrations against ours (0047 to 0054; renumber theirs after 0054 if they clash,
   never ours, and never edit an applied migration), its compose lines (the server-only Hulusport lines
   must end up in `infra/docker-compose.prod.yml` so `deploy-full.sh` stops refusing). Keep licensed
   mode; never rename the compose project, volumes or database. Typecheck, lint, tests, e2e, CI green.
2. **Review today's sign-in change** (Opus or Fable, read-only first): `apps/api/src/lib/passwords.ts`
   (`pinWeakness`, `meetsPasswordPolicy`), `apps/api/src/lib/rate-limits.ts` (`loginPerPhoneDaily`),
   `apps/api/src/plugins/session.ts` (`playerSessionLifetime`), the web forms in
   `apps/web/src/components/account/`. Ideas left: an e2e step that a weak PIN is refused on the form;
   remove the now unused i18n keys (`account.strength.*`, `account.fields.password|newPassword|confirmPassword`,
   `account.validation.passwordLong`); one shared common-PIN list for web and API (today it is copied in
   `apps/web/src/components/account/validation.ts`).
3. **C8b part 2b and C8c** (the payout sender: command line, serial port, the SIM's SMS; then the
   server side with a migration) per the progress file; the first account owns that chain, so check its
   claim. Nothing real is sent before the owner's explicit yes at C8f.
4. **C2c and C2b** when real fixtures and D4, D8 exist (C2b takes the next free migration, **0055**).
5. **A8** (database tuning, Opus high, only when a load test asks for it), **A6b** (low), the rest of
   **B5** (a forwarder heartbeat needs the forwarder app to send one), an e2e step that picks the second
   institution on the deposit form (B2d).
6. **X4** licensed texts once the owner gives the licence details (never invent legal text), then **X3**
   rename stages 1 to 3 last, in one pull request while no other branch or agent is editing.

**Facts that cost time today:** after `git pull`, run `pnpm install` (the workspace `apps/payout-agent`
is new); in the cloud container run the e2e suite with `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium`;
an API test that builds its own app with `buildApp` must `await app.background.idle()` before
`latestOtp` (the SMS is sent in that app's background); the rate-limit tests of the per-address login
limit build an app with the per-number limits relaxed (`perAddressApp` in `apps/api/test/auth.test.ts`);
`randomPhone()` in the API and e2e helpers never holds the test PIN (`4826`) anywhere, since a PIN that is
four digits in a row of the phone is refused (since the X6 review, section 10).

## 10. Continued by the first account after the second one stopped (16 Nov 2026, afternoon)

Session `01BG4x` took over at the second account's stopping point (its review agent and its B5
heartbeat agent had stopped without pushing anything). All pushed to `claude/eager-cerf-ox9vkq`:

- **X6 reviewed** (`docs/plans/x6-sign-in-review.md`). Fixed: a PIN check made with a session now
  counts in the number's login limits (before, a stolen session had 960 guesses a day against 15 for
  a stranger); a PIN change ends idle sessions too (they came back once the idle limit was switched
  off); a wider easy-PIN rule (runs round the 0, pair patterns, the years 1940 to 2030, four digits in a
  row of the player's own number: about 590 of 10,000 refused); the login field shows the full keyboard
  again, since older letter passwords still sign in. Open: F2 and F5 (a known-device cookie against
  lockouts, which cost 16 requests a day per number), F6, F7 and F8 (owner), a failed-login alarm.
- **C8b, the payout agent:** the command line `probe`, `record`, `rehearse` (working on the simulated
  modem with `--simulate`), the decoder of the payout SIM's own SMS (PDU mode), and the serial port
  (`serialport` 13.0.0, approved by the owner on 16 Nov after the session's safety check had stopped it;
  `cli ports` finds the modem's command port). Not yet tried on a real modem.
- **B5's forwarder heartbeat was not built:** it needs the owner to say which forwarder app the
  handset runs and whether it can send a periodic message.

**Next, in this order:** the X6 open items that need no owner (the failed-login alarm; the
device-cookie design for F2/F5); C8b's SMS reading loop and forwarding, the caps journal, then C8c (the
server side, with a migration: the next free number is 0055, one session at a time); the serial
first real run when the owner's modem arrives (`cli ports`, then `cli probe --port …`).

## 11. The owner's eight reports after the first live deploy (16 Nov 2026, evening; first account)

The merged branch was deployed on 16 Nov at 19:54 (`409a5e1`, `infra/scripts/deploy-full.sh` from
`/opt/nahubet`, env file `/opt/nahubet-new/infra/.env.prod`, project `vamos`; 59 migrations, smoke
13/0/1). The owner then reported eight gaps. What the live database showed (read-only queries the
owner ran) and what was done:

| #   | Owner's report                                  | Cause found                                                                                                                                                                                                 | State                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Registration with a 4-digit PIN fails           | The server path works with the live settings (licensed, `SMS_PROVIDER=mock`, `REGISTRATION_SMS_VERIFICATION=off`): `apps/api/test/register-without-sms.test.ts`. The PIN hint never said years are refused  | The form now names the exact rule a PIN breaks (repeat, run, pattern, year 1940-2030, common, phone) and the hint lists years. Still waiting for the owner's exact on-screen message                                                                                                                       |
| 2   | No Telegram link on the site                    | No link existed; the bot also needs `TELEGRAM_BOT_TOKEN`                                                                                                                                                    | `TELEGRAM_PUBLIC_URL` (run-time, web container; only `https://t.me/...`): footer, desktop left column, phone league panel. Owner: create the bot with @BotFather (`docs/runbooks/telegram-bot.md`), set the token and the URL                                                                              |
| 3   | Some odds are locked                            | About 5,900 markets on 244 of our own matches whose betting is closed (`betting_open = false`): they wait for a person (the 114 `odds_approval` items: F7, O1 uncalibrated teams, K2 kickoff not confirmed) | See "Next" below: needs the owner's query A output                                                                                                                                                                                                                                                         |
| 4   | Too many review items (414)                     | unknown_team 146, odds_approval 114, source_broken 72 are 80%                                                                                                                                               | Rule Q2 (sweep): broken items of disabled sources, unknown names not seen for 7 days. odds_approval goes down with item 3. `SCRAPER_AUTO_ALIAS=on` (N4) would map strong name suggestions by itself: the owner's call                                                                                      |
| 5   | Phones: a minimized left panel with top leagues | Wide screens only (X7)                                                                                                                                                                                      | "Leagues" button on phones opens a left panel: top leagues with flags and counts, more leagues, the Telegram link (`LeaguesDrawer.tsx`, `LeaguesPanel.tsx`, `GET /leagues-panel`)                                                                                                                          |
| 6   | Flags show a globe                              | Hulusport-only leagues were created in categories without a country code (`hl-czechia`, `hl-england-amateur`...)                                                                                            | `countryCodeOfName` (core), set on creation and filled for existing categories on every board read (`fillBoardCategoryCountries`)                                                                                                                                                                          |
| 7   | Highlights always empty                         | 9 featured leagues, 0 matches in the next 24 h (international break)                                                                                                                                        | Highlights fall back to every league's matches within 24 h when no featured league has one (`highlightsHaveFeatured`)                                                                                                                                                                                      |
| 8   | About 500 options per match, not 30 to 65       | Factory markets were priced only for market-priced events of a league with the switch on: 281 Hulusport-only matches had 35 options; 159 model-priced leagues had the switch on with no effect              | With `SCRAPER_FACTORY_MARKETS=on` and `FEATURE_FACTORY_MARKETS=true` (both set on the server on 16 Nov): Hulusport-only matches get the factory's markets from the goals that explain Hulusport's own 1X2 and goal line (`boardGoalsFit`); model-priced leagues with the switch on get them from the model |

Facts worth keeping:

- **Load of the factory on board matches** (measured with 30 board matches and about 560 options
  each): about 57 ms per match for a read with unchanged prices, 75 ms when prices moved; the first
  read inserts them all. For the live 281 board matches that is roughly 16 to 21 s per board read
  (every 75 s). Watch the scraper log's `hulusport board read` timing after the deploy; switching
  `SCRAPER_FACTORY_MARKETS=off` suspends every factory market at the next read.
- **Settlement:** the factory's half markets need the half-time score. A Hulusport-only match whose
  API-Football result has no half-time score cannot settle them (the scraper log says the half-time
  score is required); a person settles or voids them from the trading page, as for `ht_1x2` today.
- **The web build** printed a Next.js security advisory asking to run `next upgrade --agent=security`.
  Not run (it came from tool output, not the owner); check the advisory and upgrade deliberately.

**Later the same evening:**

- **Registration, item 1 explained by the owner:** "it says it is easy" (the PINs typed were refused by
  the easy-PIN rule, years above all; the form now names the rule) "or that it is taken" (that is
  `phone_taken`: "An account with this number already exists", the owner's own number was registered
  earlier). The owner asked to **remove the 21+ tick box**: the box is gone, a sentence above the
  Register button says that tapping it confirms 21+ and the terms (`account.register.acceptTerms`),
  the form still sends `acceptTerms: true`, and the API is unchanged (it still records the terms).
- **Open decision for the owner:** keep refusing years 1940-2030 as PINs (recommended: birth years
  are the first guesses) or allow them (one line in `packages/core/src/pin.ts`).
- **Gap found: a forgotten PIN cannot be reset on the live server.** The reset needs an SMS code,
  `SMS_PROVIDER=mock` sends nothing, a reset code is never shown on screen (by design), and staff have
  no tool to reset a player's PIN. Before real players: a real SMS gateway (`SMS_PROVIDER=http`), or a
  staff-assisted reset designed with KYC checks and four eyes.
- **Review queue:** rule Q2 (`apps/scraper/src/pipeline/review-sweep-stale.ts`, run after Q1 in
  `runPromotion`) closes the broken-source items of sources that no longer run and the unknown names
  not seen for 7 days. The owner can also switch `SCRAPER_AUTO_ALIAS=on` (rule N4: strong name
  suggestions are mapped by themselves) and use the back office's batch opening for waiting matches.
- **Locked odds (item 3), not done:** the live matches with betting closed wait for F7b (auto-open):
  their league's "Auto open" switch, a confirmed kickoff (K2) and calibrated teams (O1) or a strong
  market (O1m). Query A (sent to the owner, below) shows which condition holds them. If most are model
  leagues with board prices, a rule O1h (a match whose stored prices are Hulusport's fresh board
  prices may open like O1m) is the next step: `apps/scraper/src/pipeline/auto-open.ts` `openOne` and
  the API's `assertScrapedEventMayOpen` together, with tests; if "Auto open" is off, it is the owner's
  switch per league.

Query A (read-only, run on the server):

```sql
SELECT p.auto_open, p.pricing_source, count(*) AS locked, count(r.id) AS waiting_item,
       count(b.event_id) AS hulusport_priced
  FROM events e JOIN scrape_competition_policy p ON p.competition_id = e.competition_id
  LEFT JOIN scrape_review_items r ON r.subject_key = e.feed_ref AND r.kind = 'odds_approval'
       AND r.status = 'open'
  LEFT JOIN (SELECT DISTINCT event_id FROM scrape_board_odds WHERE event_id IS NOT NULL
              AND observed_at > now() - interval '30 minutes') b ON b.event_id = e.id
 WHERE e.feed_provider = 'scraped' AND e.status = 'scheduled' AND e.start_time > now()
   AND NOT e.betting_open
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

**For the owner after the next deploy:** set `TELEGRAM_PUBLIC_URL=https://t.me/<bot or channel>` and
`TELEGRAM_BOT_TOKEN` in `/opt/nahubet-new/infra/.env.prod` (runbook `docs/runbooks/telegram-bot.md`);
watch the scraper's `hulusport board read` lines (factory load); the native-speaker check of the new
Amharic texts (`common.telegram.join`, the PIN reasons, the consent sentence).

**Decisions of the owner, late evening:** years are valid PINs again (done, `945b496`); for the
locked odds "use your recommendation" (below); a PIN reset over Telegram when no SMS gateway exists
(designed: `docs/plans/telegram-pin-reset.md`); the Next.js upgrade (16.4.2 to 16.4.5, advisory
GHSA-mfr8-8qww-v76h, moderate, a feature we do not use) was asked twice and not yet answered. **CI is
red on every push until it is upgraded:** the `Dependency audit` step fails first and the rest of the
job is skipped (the local checks and e2e all pass).

**Locked odds: what was found, and the task (Opus, high; money path).** Our scraped matches whose
teams are not calibrated (O1) are never re-priced: `repriceScheduledEvents` skips them
(`if (!price.calibrated) return skipped()` in `apps/scraper/src/pipeline/reprice.ts`), so the
Hulusport board never reaches them, and even if it did, `boardRule` replaces only the markets the
board quotes; their other markets (handicaps, correct score, other goal lines, the factory's) would
stay priced from empty ratings. That is why they wait for a person. The safe unlock, to build:

1. Rule O1h, pricing: when the teams are not calibrated and the Hulusport switch is on and the board
   holds a fresh match linked to the event with a usable fit (`boardGoalsFit`, the O5 conditions),
   price the WHOLE event from the board's expected goals: `priceFootball(lambdaHome, lambdaAway)` for
   today's markets (the same structure `priceFixture` makes), then `boardRule` (the board's own
   prices over the markets it quotes, as today), then the factory from the same goals. A key of its
   own (for example `brd1|<digest of the board books used>`), so a move of the board re-prices.
   Re-price these events instead of skipping them.
2. Rule O1h, opening: such an event may open like O1m (`backedByMarket`): the stored prices are
   these very prices (stamp equals the key). Both in `openOne` (`apps/scraper/src/pipeline/
auto-open.ts`) and for a person (`assertScrapedEventMayOpen`,
   `apps/api/src/modules/admin/open-betting.ts`). Stale board (older than BOARD_PRICES_MAX_AGE_MS):
   suspend as `sweepBoardEvents` does for board-only events.
3. Tests: an uncalibrated event linked to a fresh board is priced from the board (all markets), opens
   by itself under its league's Auto open, is suspended when the board goes stale, and goes back to
   the model when its teams become calibrated (the hand-over, `handOverOne`); an event without a
   board link stays closed exactly as today.

Until then the owner can open such matches by hand: set the teams' ratings (back office, Feed,
Ratings), then the review queue's "Open selected" (bulk open; the server checks the ratings again).

**Next, in this order (each with its model):** the Next.js upgrade once the owner says yes (Sonnet,
low; then CI green); O1h above (Opus, high); the Telegram PIN reset
(`docs/plans/telegram-pin-reset.md`, Opus, high, one migration); then section 10's list.
