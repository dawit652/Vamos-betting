# Nahubet – contributor notes

Oct 27, 2026 · @Which Version Of Claude Are U

## After a 5-hour limit or a restart: the token budget (owner's rule, read this first)

The first reply after a limit reset, a restart or a summarised conversation costs as little as
possible:

1. **At most three cheap commands before answering:** `git status --short`,
   `git log --oneline -3`, and the "Where we are" item below (or the first 15 lines of
   `docs/plans/remaining-tasks.md`). Nothing else: no reading of code, plans, long docs or old
   transcripts; trust the conversation summary and the handover.
2. **Do only what the owner's message asks.** No new work of your own, no re-checking of finished
   work (CI, tests, deploys already reported green), no restarting agents or background runs that
   stopped at the limit.
3. **No builds, e2e runs, full test suites, screenshots or agents** in that first reply. Later,
   only when the next commit needs them: test what you change, the full checks once before a push.
4. **Operations questions** (deploy, sign-in, server commands, settings): answer from
   `docs/deployment.md` and `docs/runbooks/` with a targeted `grep`, not by reading code.
5. **Short answers:** a few lines, no recap of earlier work, no long command output pasted back.
6. **Cheapest model that fits** (see "Working with Claude Code"): Haiku (`quick-task`) for checks,
   Sonnet (`routine-coder`) for routine edits, Opus only for money, security and design.
7. **Lose nothing at a cut-off:** after every push, update "Where we are" in one or two lines, so
   the next session starts from it.

## Start here (every session, to save tokens)

1. Read only `docs/plans/remaining-tasks.md` (short), then the plan doc of the task you take. Do
   not read the long handover, progress or architecture docs unless that task needs a section.
2. Read code with targeted `grep` and line ranges, not whole files. No screenshots and no full
   test suites unless the change needs them: test what you change; full checks before a push.
3. One build and one e2e run per batch of changes; reuse a running stack (`e2e/scripts/stack.sh`).
4. Short answers to the owner; never re-explain earlier work.
5. Near the end of the 5-hour window: stop new work, commit and push, and update
   `docs/plans/remaining-tasks.md` in a few lines. After a limit reset or a restart, follow "The
   token budget" above and do not resume on your own: wait for the owner's next message.
6. Always build on top of the server's branch: before every push,
   `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`
   must succeed (else merge it in first). Every plan in `docs/plans/` says so too.
7. Switch model and effort by task (see "Working with Claude Code" below): mechanical steps to
   `quick-task`, routine coding to `routine-coder`, the money path and design in the main session.
8. **Where we are** (update this item first after every limit, cheaply; see "The token budget").
   **Newest, 23 Nov (second account, `claude/happy-keller-i7cvrh`, pushed, not deployed):** the
   server ran `2b53c60` (everything below up to F4d is live). On top of it: a switched-off API is
   not read and its 15-minute "down" alert stops (mr-x with `hulusport_pricing` off); the player
   lists show only matches that can be bet on; efficient compose defaults (half time covered, no
   third scores read, cap at best price); feed report section 37; board matches with no result 3
   days after kickoff and no bet are cancelled (O-F1, owner yes); E2 built: API-Football odds as
   bookmaker prices (`apifootball` mode `odds`, 24 league source files), on trial behind the switch
   `apifootball_pricing` (Back office → Feed). Owner, 23 Nov: The Odds API stops when its bought
   credits end (about 27 Nov). **Next:** the owner deploys, runs E1 and the odds-sources command,
   enables them, and switches the prices on once the gap is small; then E3 (price expiry)
   (`docs/plans/feed-gaps-2026-11-23.md`, "E2 built"). Also on 23 Nov: guest slips and staff plan
   `docs/plans/guest-slips-and-staff.md` (GS1 Today default, GS2 no padlocked rows, GS11 agent
   owner password reset until changed, device page text, GS3 started with migration 0085;
   **next: GS3 betslip and shop part**, then GS4 onwards and 4a/4b). Next free migration 0086.
   **Deployed 22 Nov 19:02:** `7a15b27` (licensed mode, smoke test 13 passed; migrations up to
   0084: everything listed below is now live; switches `narobet_events`, `narobet_pricing` and
   `hulusport_pricing` off; BotFather `/setcommands` needs `deposit - Deposit problem`).
   **Deployed 22 Nov 22:36:** `b94684f` (live telebirr / CBE SMS read). **Pushed, not deployed:**
   `1f9f4ea`, `8ea2ab5`, `b2c231f` (Today / Upcoming lists, 30 days), `d1d25ee`
   (`scripts/review-study.sh`), `18d99c8`, `9b17600` (re-price rule A-2), `c53b4f2` (sweeper Q2c), the
   auto-open `held` counts, rule F4d (kickoff disagreements: the earliest fresh kickoff). **Next:**
   4a / 4b of the review queue plan once the owner deploys and reruns the study
   (`docs/plans/review-queue-automation.md`; steps 1-3 and 4-diagnostics built); handover of 23 Nov
   at the top of `docs/plans/remaining-tasks.md`. Newest branch `claude/happy-keller-i7cvrh`.
   Two branch names hold the same work: `claude/eager-cerf-ox9vkq` (first account) and
   `claude/happy-keller-i7cvrh` (second account); before starting, bring yours up to the other if
   it is ahead (`git fetch origin <other> && git merge --ff-only FETCH_HEAD`). Built: agent shops
   phases 0-5 (the shop app is deployed but not switched on: `docs/deployment.md`, "Shop app"),
   the desk PIN reset redesign (off until `CASHIER_PIN_RESET=on`), quieter owner alerts. Pushed,
   not deployed: owner's decisions O6 and O7 of 21 Nov (cashiers pay any amount alone; players
   withdraw winnings only; `docs/plans/counter-codes-and-deposit-recovery.md`), step 2 of that plan
   (6-digit booking codes, printed on the shop ticket; migration 0079), the unlocked odds of matches
   more than 72 hours away (owner, 22 Nov: kickoff rule C2 now 30 days; `docs/scraper.md`), owner
   reports for day, week, month and year that check themselves (migration 0080;
   `docs/plans/owner-reports.md`), and
   Narobet-only matches for more leagues with the ETB 20,000 cap
   per board match and results by API-Football fixture id (migration 0077, switch `narobet_events`
   off; `docs/plans/narobet-events.md`), and service-down alerts on Telegram every 15 minutes
   (migration 0078), the shop ticket payout code (migration 0081), the public ticket check and
   manual deposits by one admin (steps 3, 3b, 4, by the first account), and step 5 by the second
   account: "My deposit did not arrive" claims and Back office → Money not credited (migration 0082),
   the owner's daily "money not credited" Telegram line, Back office → Service health, the shop's
   printed shift report, the Telegram "Deposit problem" (step 6, migration 0083) and the G4
   withdrawal code (step 7, migration 0084; both branches equal at `7a15b27` on 22 Nov evening;
   next free migration 0085). **Work with one account at a time:** on 22 Nov both accounts built
   steps 5-7 at once and the first account dropped its copies. The owner deploys with the
   PowerShell line in `docs/plans/remaining-tasks.md`, "Deploy". The counter codes plan is built. The server runs `2b53c60`
   (23 Nov). `scripts/feed-report.sh` reads the whole Feed page on the server; its 23 Nov findings beyond the
   review queue plan: `docs/plans/feed-gaps-2026-11-23.md`. Next: the owner deploys (migrations 0077-0084) and
   `docs/plans/counter-codes-and-deposit-recovery.md` (owner,
   21 Nov: 6-digit booking, payout and withdrawal codes, deposit recovery, the health page, completing
   the shop app; decisions O1-O5 made), the owner deploys; phase 6 supports many POS devices (owner, 22 Nov: `docs/plans/agent-shops.md`,
   "Phase 6: many POS devices"), built after the owner buys a test unit or says go.

## Overview

Vamos Betting is a mobile-first sportsbook for Costa Rica, modelled on Betika: a TypeScript pnpm monorepo. Money stays in Ethiopian birr (ETB) and deposits and payouts go through telebirr, CBE (SMS rail) and Chapa.

| Path                 | Package               | What it holds                                                                                                                             |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | `@vamos/api`          | REST + SSE API (Fastify), :4000                                                                                                           |
| `apps/worker`        | `@vamos/worker`       | Feed ingest, live simulator, settlement, payouts, notifications, reporting, SMS rail checks                                               |
| `apps/web`           | `@vamos/web`          | Player PWA (Next.js), Betika-style lite mobile web, :3000                                                                                 |
| `apps/admin`         | `@vamos/admin`        | Back office: trading, risk, KYC, finance, compliance, SMS rail, manual payouts, :3001                                                     |
| `apps/payout-agent`  | `@vamos/payout-agent` | The payout sender's agent (types a wallet's USSD menu through a modem); simulator-tested, not wired: `docs/plans/payout-sender-design.md` |
| `packages/core`      | `@vamos/core`         | Pure domain logic: money, odds, betslip, bonus, tax, cash-out, jackpot, SMS parsing and matching                                          |
| `packages/db`        | `@vamos/db`           | Drizzle schema, migrations, seed and the services that write money (PostgreSQL 16)                                                        |
| `packages/contracts` | `@vamos/contracts`    | Zod request/response contracts shared by api, web and admin                                                                               |
| `packages/payments`  | `@vamos/payments`     | Provider adapters (mock, Chapa, telebirr, SMS rail) and the receipt verifier; no database                                                 |
| `packages/feed`      | `@vamos/feed`         | Odds feed interface, mock Poisson pricing and live match simulator                                                                        |
| `packages/config`    | `@vamos/config`       | Environment loading and the operating-mode guard                                                                                          |
| `packages/i18n`      | `@vamos/i18n`         | UI messages: Amharic, English, Afaan Oromo, Tigrinya                                                                                      |
| `e2e`                | `@vamos/e2e`          | Playwright end-to-end specs                                                                                                               |
| `infra`, `scripts`   |                       | Docker, Caddy, ops scripts, load tests, SBOM                                                                                              |

## Commands

Node 22 and pnpm 10. Run these from the repository root.

| Command                                                   | What it does                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                            | Install everything                                                                                                                                   |
| `pnpm services:start`                                     | Native Postgres 16 + Redis 7, no Docker (`services:stop`, `services:status`). Docker alternative: `docker compose -f infra/docker-compose.yml up -d` |
| `pnpm db:generate`                                        | Generate a Drizzle migration after editing `packages/db/src/schema/*`                                                                                |
| `pnpm db:migrate` / `pnpm db:seed`                        | Apply migrations / seed house accounts, settings and demo staff                                                                                      |
| `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format` | The checks every change passes (`format:check` in CI)                                                                                                |
| `pnpm dev`                                                | api (:4000) + worker + web (:3000); `pnpm dev:all` also starts admin (:3001)                                                                         |
| `e2e/scripts/stack.sh build` then `start`                 | Production-like stack for e2e, with `PAYMENT_PROVIDERS=mock,sms` and a fast match simulator                                                          |
| `pnpm e2e`                                                | Playwright, against a running stack (see `e2e/README.md`)                                                                                            |
| `pnpm load:bets`                                          | Bet-placement load test                                                                                                                              |
| `pnpm admin:create` / `pnpm admin:unlock`                 | Create or unlock a staff account                                                                                                                     |

## Rules that matter

- **Operating mode.** `OPERATING_MODE` is `licensed` (the default: real money) or `demo` (play money, mock providers, the SMS rail simulated). In licensed mode `licensedModeViolations` refuses only the mock payment provider; SMS-rail problems and non-https provider URLs are logged as warnings.
- **Money** is `bigint` santim (1 ETB = 100 santim) end to end; odds are integer milli (1.85 → 1850). Never use floating point for money. Round payouts **down**. Over the wire, money is a decimal string.
- **Ledger.** Every balance change is a double-entry `ledger_transaction` whose entries sum to zero, written in the same DB transaction as the business row and its `outbox_events`. Never edit the ledger by hand: corrections are new postings through the application.
- **Idempotency.** Bet placement, deposits, payouts and webhooks take idempotency keys.
- Domain math lives in `packages/core` (pure, no I/O) and must have unit + property tests.
- API input is validated with zod contracts from `packages/contracts` via `parseInput`.
- Integration tests use a real Postgres (`createTestDatabase` from `@vamos/db/testing`).
- **Scraper.** Scraped data and automated feeds may update results, void/cancel events, or adjust markets directly when configured
- **Hulusport prices** (owner's decision, 14 Nov 2026; `docs/plans/hulusport-feed.md`): the scraper reads Hulusport's board from the owner's mr-x service (`SCRAPER_HULUSPORT_URL`). Only while the back office switch `hulusport_pricing` is on (off by default) do markets we already price take Hulusport's fresh prices, with its margin replaced by ours. Stale prices or the switch off bring our own prices back. Hulusport matches in leagues we do not list become events of their own (feed_provider `hulusport`, priced from the board alone, suspended when stale; results from API-Football when SCRAPER_SECRET_API_FOOTBALL is set, else by hand), never in a league or with a team of our own catalogue.
- **Narobet-only matches** (owner's decisions, 21 Nov 2026; `docs/plans/narobet-events.md`): while the back office switch `narobet_events` is on (off by default), mr-z's matches in leagues we do not list become events of their own (feed_provider `narobet`), up to 30 days ahead (changeable), never in our league or with our team, never club friendlies; results from API-Football by fixture id, cross-checked with mr-z. Every board's own match (Hulusport's, Narobet's) pays out at most `board_risk_limits` (ETB 20,000 per match by default, Settings). Nahubet never contacts Narobet, and nothing may make mr-z read Narobet more (owner: Narobet must not be affected).
- included by policy: casino/crash/virtual games, crypto, payouts to third-party wallets.

## Payments

- **Providers:** `chapa`, `telebirr`, and `sms`, the SMS deposit rail ported from Melabingo (`docs/plans/melabingo-payments-port.md`, operations in `docs/runbooks/sms-rail.md`).
- **SMS rail deposits.** The exact amount (requested + 1–99 santim, never a whole birr, unique among open deposits) is the reference. Only an SMS the gateway forwarded (or the dev simulator) or a receipt the institution served can credit; what a player pastes is only a lookup key. A credit only pays a deposit created before the money moved (core `smsPaidBy`). Another payer's phone or another amount is flagged for staff, never credited. A debit SMS never credits; it only proposes a manual payout.
- **Manual payouts (four eyes):** the approver never claims or settles; only the operator who claimed a payout settles, releases or fails it. The worker never touches manual payouts.
- **Payout destinations:** the player's currently registered phone wallet, or a bank account in their KYC name confirmed with an SMS code. Nothing else.
- **Winnings only** (owner, 21 Nov 2026): a player may withdraw the cash balance less the deposits not yet played through (core `withdrawableAmount` over `remainingWagering`); deposited money is for betting. The server runs in licensed mode, where every real deposit (Chapa, telebirr, the SMS rail, a counter deposit) posts the ledger type `deposit`; a new way of crediting a deposit must post `deposit` too, or it would count as winnings.
- **Owner reports** (owner, 22 Nov 2026: "never make a mistake"; `docs/plans/owner-reports.md`): every figure comes from the ledger (core `summarizeReport`), periods in Ethiopian time are exact sums of their days, closed days are frozen in `report_days` (insert and read only), and every report runs five checks; a failed check alarms the owner. Never compute a report figure from anything but the ledger.
- **Manual deposits** (owner, 21 Nov 2026, O5): one admin (`deposits.credit`) credits a deposit that reached us but was not credited, with no second approval: once per provider transaction id, the player's own deposit as itself, ledger type `deposit`, audited, the owner alerted above ETB 5,000 (`packages/db/src/payments/manual-deposits.ts`).
- **Deposit claims** (G5.3, G6): a player's "My deposit did not arrive" never credits by itself; Back
  office → Money not credited suggests the player for money that arrived, and an admin credits it
  with the SMS credit or the manual deposit (`claimId` answers the claim in the same transaction)
  (`packages/db/src/payments/deposit-claims.ts`).
- **Withdrawal codes** (G4, O2): a player asks for cash at a shop in the app (the amount, held at
  once with every online rule); the 6-digit code alone, typed at any shop with player cash on, pays
  it. One use, keyed hash only, five wrong codes a day lock a shop's code entry, unused after 24
  hours the money goes back (`packages/db/src/cashier/withdrawal-codes.ts`).
- **Shop ticket payout code** (owner, 21 Nov 2026, O1): printed once on the customer's ticket at sale, stored only as a salted hash, never on a screen or a reprint; paying asks for it, five wrong ones lock the ticket until HQ unlocks or waives it (`packages/db/src/retail/payout-code.ts`).
- **Cashiers pay alone** (owner, 21 Nov 2026): a counter cash withdrawal or a winning shop ticket of any amount, with no supervisor, no HQ approval and no review for its size (exclusions, AML holds and settlement corrections still hold a withdrawal). Counter deposits keep the shop's supervisor threshold.
- **Fixtures:** SMS parsers and receipt readers are tested against `packages/core/src/smsparse.fixtures.ts` and `packages/payments/src/receipts/fixtures.ts`; a new message shape gets a scrubbed fixture and a test.
- **Alarms** on the SMS rail are `error` log lines with an `alarm` field (no metrics endpoint).

## Testing and docs

- **Tests:** vitest everywhere (fast-check for property tests); unit tests sit next to the code in `packages/core/src`, integration tests in each package's `test/` against a real Postgres; Playwright specs in `e2e/tests` (mobile Chromium, Pixel 5).
- **Before a push:** `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` all pass; the e2e suite for changes that touch a player or staff flow.
- **Read first:** `docs/architecture.md` (how the parts fit), `docs/build-plan.md` (phases and their state), `docs/deployment.md` (), `docs/compliance.md`, and `docs/runbooks/` (on-call procedures).

## Working with Claude Code (save tokens)

The account is on the Pro plan with a tight 5-hour limit, so always match the model and effort to the task:

- **Mechanical steps** (installs, running typecheck/lint/tests and reporting, listing or searching files,
  one-line edits): the `quick-task` agent (Haiku, low effort).
- **Routine, well-specified coding** (fixing reported type errors or failing tests, small features,
  straightforward refactors, docs): the `routine-coder` agent (Sonnet, medium effort).
- **Hard work** (design, migrations, the bet-placement / ledger / settlement money path, security, merge
  conflicts, reviewing agents' work): the main session on Opus, high effort.
- Run a single short command yourself when that is cheaper than starting an agent.
- At most two agents at a time; check usage between waves and stop starting new work near the 5-hour limit.
- Agents never commit; the main session verifies (typecheck, lint, tests) and commits only when asked.
- **After a 5-hour limit reset:** follow "After a 5-hour limit or a restart: the token budget" at
  the top of this file.
