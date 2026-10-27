# Vamos Betting – contributor notes

Mobile-first sportsbook for Ethiopia, modelled on Betika. TypeScript pnpm monorepo.

## Commands

- `pnpm install`: install everything (Node 22, pnpm 10)
- `pnpm services:start`: native Postgres 16 + Redis 7 (no Docker). Docker alternative: `docker compose -f infra/docker-compose.yml up -d`
- `pnpm db:generate`: generate a Drizzle migration after editing `packages/db/src/schema/*`
- `pnpm db:migrate` / `pnpm db:seed`
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format`
- `pnpm dev`: api (:4000) + worker + web (:3000); `pnpm dev:all` also starts admin (:3001)
- `pnpm e2e`: Playwright (needs the stack running: `e2e/scripts/stack.sh build && e2e/scripts/stack.sh start`,
  which runs `PAYMENT_PROVIDERS=mock,sms`; see `e2e/README.md`)

## Rules that matter

- **Operating mode.** `OPERATING_MODE=demo` is the default (play money, mock providers, the SMS rail
  simulated). Never weaken the licensed-mode guard in `packages/config/src/config.ts`. Real money needs an
  ELS licence.
- **Money** is `bigint` santim (1 ETB = 100 santim) end to end; odds are integer milli (1.85 → 1850).
  Never use floating point for money. Round payouts **down**. Over the wire, money is a decimal string.
- **Ledger.** Every balance change is a double-entry `ledger_transaction` whose entries sum to zero,
  written in the same DB transaction as the business row and its `outbox_events`.
- **Idempotency.** Bet placement, deposits, payouts and webhooks take idempotency keys.
- Domain math lives in `packages/core` (pure, no I/O) and must have unit + property tests.
- API input is validated with zod contracts from `packages/contracts` via `parseInput`.
- Integration tests use a real Postgres (`createTestDatabase` from `@vamos/db/testing`).
- Excluded by policy: casino/crash/virtual games, crypto, payouts to third-party wallets.

## Payments

- Providers: `mock` (demo only), `chapa`, `telebirr`, and `sms`, the SMS deposit rail ported from
  Melabingo (`docs/plans/melabingo-payments-port.md`, operations in `docs/runbooks/sms-rail.md`).
- **SMS rail deposits.** The exact amount (requested + 1–50 santim, unique among open deposits) is the
  reference. Only an SMS the gateway forwarded (or the dev simulator, demo only) or a receipt the institution
  served can credit; what a player pastes is only a lookup key. A credit only pays a deposit created before
  the money moved (core `smsPaidBy`). Another payer's phone or another amount is flagged for staff, never
  credited. A debit SMS never credits; it only proposes a manual payout.
- **Manual payouts** (four eyes): the approver never claims or settles; only the operator who claimed a payout
  settles, releases or fails it. The worker never touches manual payouts.
- **Payout destinations:** the player's currently registered phone wallet, or a bank account in their KYC
  name confirmed with an SMS code. Nothing else.
- SMS parsers and receipt readers are tested against fixtures (`packages/core/src/smsparse.fixtures.ts`,
  `packages/payments/src/receipts/fixtures.ts`): a new message shape gets a scrubbed fixture and a test.
- SMS rail alarms are `error` log lines with an `alarm` field (no metrics endpoint).
