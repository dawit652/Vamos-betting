# Vamos Betting – contributor notes

Mobile-first sportsbook for Costa Rica, modelled on Betika. TypeScript pnpm monorepo.

## Commands

- `pnpm install`: install everything (Node 22, pnpm 10)
- `pnpm services:start`: native Postgres 16 + Redis 7 (no Docker). Docker alternative: `docker compose -f infra/docker-compose.yml up -d`
- `pnpm db:generate`: generate a Drizzle migration after editing `packages/db/src/schema/*`
- `pnpm db:migrate` / `pnpm db:seed`
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format`
- `pnpm dev`: api (:4000) + worker + web (:3000); `pnpm dev:all` also starts admin (:3001)
- `pnpm e2e`: Playwright (needs the dev stack running)

## Rules that matter

- **Operating mode.** `OPERATING_MODE=demo` is the default (play money, mock providers). Never weaken the
  licensed-mode guard in `packages/config/src/config.ts`.
- **Money** is `bigint` santim (1 ETB = 100 santim) end to end; odds are integer milli (1.85 → 1850).
  Never use floating point for money. Round payouts **down**. Over the wire, money is a decimal string.
- **Ledger.** Every balance change is a double-entry `ledger_transaction` whose entries sum to zero,
  written in the same DB transaction as the business row and its `outbox_events`.
- **Idempotency.** Bet placement, deposits, payouts and webhooks take idempotency keys.
- Domain math lives in `packages/core` (pure, no I/O) and must have unit + property tests.
- API input is validated with zod contracts from `packages/contracts` via `parseInput`.
- Integration tests use a real Postgres (`createTestDatabase` from `@vamos/db/testing`).
- **Scraper.** Scraped results reach `resultEvent` only through the gates (`applyConfirmedResult` in
  `apps/scraper`); no code path may cancel, void or abandon an event from scraped data. See `docs/scraper.md`.
- Excluded by policy: casino/crash/virtual games, crypto, payouts to third-party wallets.
