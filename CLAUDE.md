# Nahubet – contributor notes

Oct 27, 2026 · @Which Version Of Claude Are U

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
- included by policy: casino/crash/virtual games, crypto, payouts to third-party wallets.

## Payments

- **Providers:** `chapa`, `telebirr`, and `sms`, the SMS deposit rail ported from Melabingo (`docs/plans/melabingo-payments-port.md`, operations in `docs/runbooks/sms-rail.md`).
- **SMS rail deposits.** The exact amount (requested + 1–99 santim, never a whole birr, unique among open deposits) is the reference. Only an SMS the gateway forwarded (or the dev simulator) or a receipt the institution served can credit; what a player pastes is only a lookup key. A credit only pays a deposit created before the money moved (core `smsPaidBy`). Another payer's phone or another amount is flagged for staff, never credited. A debit SMS never credits; it only proposes a manual payout.
- **Manual payouts (four eyes):** the approver never claims or settles; only the operator who claimed a payout settles, releases or fails it. The worker never touches manual payouts.
- **Payout destinations:** the player's currently registered phone wallet, or a bank account in their KYC name confirmed with an SMS code. Nothing else.
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
- **After a 5-hour limit reset (owner's rule, 18 Nov 2026): start cheap.** The first task after the
  limit must not burn tokens: no re-reading of the repository, the long plans or old transcripts;
  read only `git status`, `git log --oneline -5` and the latest handover section, then continue the
  one task in hand with the cheapest model that fits. Do not restart agents that stopped at the
  limit, rerun full test suites or rebuild unless the next commit needs it, and start no new work
  on your own: wait for the owner's next message.
