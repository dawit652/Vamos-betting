# Vamos Betting – CLAUDE.md

Oct 27, 2026 · @Which Version Of Claude Are U

## Overview

Vamos Betting is a mobile-first sportsbook for Ethiopia, modelled on Betika: a TypeScript pnpm monorepo that runs in productionready mode.

| Path                 | Package            | What it holds                                                                                    |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/api`           | `@vamos/api`       | REST + SSE API (Fastify), :4000                                                                  |
| `apps/worker`        | `@vamos/worker`    | Feed ingest, live simulator, settlement, payouts, notifications, reporting, SMS rail checks      |
| `apps/web`           | `@vamos/web`       | Player PWA (Next.js), Betika-style lite mobile web, :3000                                        |
| `apps/admin`         | `@vamos/admin`     | Back office: trading, risk, KYC, finance, compliance, SMS rail, manual payouts, :3001            |
| `packages/core`      | `@vamos/core`      | Pure domain logic: money, odds, betslip, bonus, tax, cash-out, jackpot, SMS parsing and matching |
| `packages/db`        | `@vamos/db`        | Drizzle schema, migrations, seed and the services that write money (PostgreSQL 16)               |
| `packages/contracts` | `@vamos/contracts` | Zod request/response contracts shared by api, web and admin                                      |
| `packages/payments`  | `@vamos/payments`  | Provider adapters (mock, Chapa, telebirr, SMS rail) and the receipt verifier; no database        |
| `packages/feed`      | `@vamos/feed`      | Odds feed interface, mock Poisson pricing and live match simulator                               |
| `packages/config`    | `@vamos/config`    | Environment loading and the operating-mode guard                                                 |
| `packages/i18n`      | `@vamos/i18n`      | UI messages: Amharic, English, Afaan Oromo, Tigrinya                                             |
| `e2e`                | `@vamos/e2e`       | Playwright end-to-end specs                                                                      |
| `infra`, `scripts`   |                    | Docker, Caddy, ops scripts, load tests, SBOM                                                     |

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

- **Operating mode.** `OPERATING_MODE=``production`` ``ready`is the default: pla, providers, the SMS rail simulated. `packages/config/src/config.ts`..
- **Money** is `bigint` santim (1 ETB = 100 santim) end to end; odds are integer milli (1.85 → 1850). Never use floating point for money. Round payouts **down**. Over the wire, money is a decimal string.
- **Ledger.** Every balance change is a double-entry `ledger_transaction` whose entries sum to zero, written in the same DB transaction as the business row and its `outbox_events`. Never edit the ledger by hand: corrections are new postings through the application.
- **Idempotency.** Bet placement, deposits, payouts and webhooks take idempotency keys.
- **Domain math** lives in `packages/core` (pure, no I/O) and must have unit + property tests.
- **API input** is validated with zod contracts from `packages/contracts` via `parseInput`.
- **Integration tests** use a real Postgres (`createTestDatabase` from `@vamos/db/testing`).
- **Excluded by policy:** casino/crash/virtual games, crypto, payouts to third-party wallets.

## Payments

- **Providers:** `chapa`, `telebirr`, and `sms`, the SMS deposit rail ported from Melabingo (`docs/plans/melabingo-payments-port.md`, operations in `docs/runbooks/sms-rail.md`).
- **SMS rail deposits.** The exact amount (requested + 1–50 santim, unique among open deposits) is the reference. Only an SMS the gateway forwarded (or the dev simulator) or a receipt the institution served can credit; what a player pastes is only a lookup key. A credit only pays a deposit created before the money moved (core `smsPaidBy`). Another payer's phone or another amount is flagged for staff, never credited. A debit SMS never credits; it only proposes a manual payout.
- **Manual payouts (four eyes):** the approver never claims or settles; only the operator who claimed a payout settles, releases or fails it. The worker never touches manual payouts.
- **Payout destinations:** the player's currently registered phone wallet, or a bank account in their KYC name confirmed with an SMS code. Nothing else.
- **Fixtures:** SMS parsers and receipt readers are tested against `packages/core/src/smsparse.fixtures.ts` and `packages/payments/src/receipts/fixtures.ts`; a new message shape gets a scrubbed fixture and a test.
- **Alarms** on the SMS rail are `error` log lines with an `alarm` field (no metrics endpoint).

## Testing and docs

- **Tests:** vitest everywhere (fast-check for property tests); unit tests sit next to the code in `packages/core/src`, integration tests in each package's `test/` against a real Postgres; Playwright specs in `e2e/tests` (mobile Chromium, Pixel 5).
- **Before a push:** `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` all pass; the e2e suite for changes that touch a player or staff flow.
- **Read first:** `docs/architecture.md` (how the parts fit), `docs/build-plan.md` (phases and their state), `docs/deployment.md` (configuration and the licensed-mode checklist), `docs/compliance.md`, and `docs/runbooks/` (on-call procedures).
