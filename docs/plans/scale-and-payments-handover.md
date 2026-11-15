# Scale and payments: handover for the next session

Written 15 November 2026 for the next Claude Code session (another account). Nothing of the plan is
built yet; this file is the to-do list, cut so that each line fits one short session.

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
   If several branches have the file, use the one whose scale-and-payments-progress.md has the
   newest "Last updated" line.
2. Read, in this order: CLAUDE.md, docs/plans/scale-and-payments-handover.md,
   docs/plans/scale-and-payments-progress.md, then only the parts of
   docs/plans/scale-and-payments-plan.md that your task names.
3. Do the setup in the handover's section 1, then take the first task of section 3 that the progress
   file does not mark done. One task at a time: tests with it, `pnpm lint`, `pnpm typecheck`, the test
   suites of the touched packages and `pnpm format:check` green, then update the progress file, commit
   and push. Never leave the branch failing.
4. Follow CLAUDE.md's model routing to save usage. Stop starting new tasks when the session is close
   to its limit; instead update the progress file and section 6 of the handover, commit and push.
5. Ask me before anything in the handover's section 4 (owner decisions), before any pull request,
   and before anything that touches the live server.
```

## 1. Before the first task

1. **Branch.** This work is on `claude/eager-cerf-ox9vkq`: the default branch
   (`claude/quirky-ramanujan-xb7e2u`, `b7dc17c`) plus the back-office theme, `E2E_CHROMIUM_PATH` and
   these documents. It reaches the default branch by pull request (README, "Branches"); the owner has
   not asked for one yet. If the default branch has moved, merge it in first.
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
| C5a | **Float forecast:** from open bets, their possible payouts and their matches' end times, the expected withdrawals of the next hours; an alarm when a collection account's last known balance (from its SMS) is below it                                                                                                                                                                                                              | Sonnet, medium; Opus reviews            | A pure function in `packages/core` with tests; the health panel shows the forecast; alarm `payout_float_low`                                                                                                                             |

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
| C5b    | Approval tiers (identity verified, account age, a destination paid before, amounts per tier) beside `autoApproveBelow`                                                                                                                                       | D6, D8                      | Opus, high     |
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

## 6. State at the end of the last session

- Branch `claude/eager-cerf-ox9vkq`, pushed. Checked on it: lint, typecheck and the 99 tests of
  `apps/admin`, formatting of the changed files, and the back office by eye in both themes against
  the e2e stack. The rest of the tree is the default branch's, which CI had passed.
- No task of sections 3 to 5 is started.
- Next: A1a.

When you stop, rewrite this section (what is finished, what is half done and on which commit, what
is next) and the progress file, commit and push, so the next account can start from the prompt in
section 0.
