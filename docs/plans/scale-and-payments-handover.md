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
   written, and read sections 6 and 8 of the handover (what was half done, how to recover it; section 8 is
   newer and its order of tasks replaces the "Next" list of section 6). Do the setup in the handover's section 1, then take the first item of that
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

Later, when the load test asks for it: A7 (the `house_stakes` ceiling), A8 (database tuning, replica,
partitions) and A9 (worker queues, standby), all Opus, high; see the plan, section 4. B5 (a second
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
- **C2a, the pure double-proof rule: PARTIAL.** Saved as `docs/plans/wip/c2a-partial.patch` (about 1,900
  lines: `payoutproof.ts`, its tests, the masked-account matcher in core, `auto_settle` in
  `payoutflow.ts`); it is not reviewed and does not typecheck yet. `docs/plans/wip/README.md` says what is
  missing and how to continue (Opus, high; the design is the spec).

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
accounts** until B2b, B2c and every forwarder sending `account` are deployed (with one account nothing
changes). Not verified: `e2e/tests/sms-rail.spec.ts` with two accounts, the new deposit screen in a browser
and against the 160 KB budget, `caddy validate` of `Caddyfile.streams` (CI does it), and 2,000 streams on
`streams` processes while `pnpm load:bets` runs on the others.

**Still open, in this order** (model and effort in brackets):

1. ~~C10~~ done (progress file): ask the owner for the real `FLOAT_FORECAST_WITHDRAWN_PERCENT` (the default 20 is a guess) and
   whether each institution or the sum should be compared with the forecast; Opus may review it (read-only).
2. **C12 review and deploy** (Opus, read-only review, then the owner deploys) and **C2a** from
   `docs/plans/wip/c2a-partial.patch` (Opus, high): the other account's work, unchanged by this session.
3. **X2** end-to-end tests of the redesign (needs the e2e stack: `e2e/scripts/stack.sh build` then
   `start`; Sonnet, medium). Run `e2e/tests/sms-rail.spec.ts` with two simulated accounts at the same time.
4. **A6b, A7, A8, A9, B5, D1 to D8** per the progress file (A6b to B5 need no decision; D rows are owner
   tasks).
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
