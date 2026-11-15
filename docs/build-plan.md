# Nahubet build plan and handoff

This is the working plan for building Nahubet, a mobile-first sportsbook for Ethiopia modelled on
**Betika**. It holds the current status, what the next session does first, the conventions learned so far,
and the scope and acceptance checks for every remaining phase. Repo rules are in `CLAUDE.md`. Market
research is in `docs/research/`.

## Status

Last updated 12 Oct 2026.

| Phase | Scope                                                         | State                     | Commits                                    |
| ----- | ------------------------------------------------------------- | ------------------------- | ------------------------------------------ |
| 0     | Foundation: workspace, config guard, infra, CI                | Done                      | `f81d44e`                                  |
| 1     | Domain core (`packages/core`)                                 | Done                      | `dccd213`, `4a8d03f`                       |
| 2     | Database, accounts, ledger, auth, KYC, RG, wallet             | Done                      | `2131ee7`, `d26120d`                       |
| 3     | Sports catalogue, odds feed, live simulator, trading services | Done                      | `0c02e89`, `e381576`, `f80ccf5`, `d14a18e` |
| 4     | Betslip, bet placement, booking codes, settlement             | Done (reviewed, 21 fixes) | `a04beab` … `50c1e7e`                      |
| 5     | Player web app (Betika-style lite PWA), the demo MVP          | Done (reviewed, 19 fixes) | `8503bac`                                  |
| 6     | Payments: deposits and withdrawals                            | Done (reviewed, 15 fixes) | `e555ef6` … `3f1337d`                      |
| 7     | Live betting and cash-out                                     | Done (reviewed, 8 fixes)  | `25360ec` … `bd8b033`                      |
| 8     | Jackpots and promotions                                       | Done (reviewed, 8 fixes)  | `d35ae42` … `82bd130`                      |
| 9     | Back office (`apps/admin`)                                    | Done (reviewed, 11 fixes) | `176a4cc` … `7f9151c`                      |
| 10    | Compliance and regulator reporting                            | Done (reviewed, 12 fixes) | `560ee16` … `fd23540`                      |
| 11    | SMS/USSD channel (feature-flagged)                            | Done (reviewed, 9 fixes)  | `8efbe59` … `e684b54`                      |
| 12    | Hardening and deployment                                      | Done (reviewed, 12 fixes) | `edde9dc` … `4721eeb`                      |

**All phases (0–12) are done.** Format, lint, typecheck, build, every unit test and the Playwright e2e suite
pass. The e2e suite covers the bet flow (register, OTP, demo top-up, a 3-leg bet, settlement, My Bets)
and the payments flow (KYC, deposit approved on the simulated phone, wagering, withdrawal approved by
the dev stand-in, paid) a cash-out of a running accumulator through the confirm sheet, a jackpot entry settled with its prize, back-office flows (staff TOTP login, withdrawal approval, trading, RBAC 403s), compliance (reconciliation, an AML flag and hold) and SMS/USSD bets through the dev simulator. Run it with `bash e2e/scripts/stack.sh start && pnpm e2e`.

**Phase 6 review (13 Oct 2026).** Three adversarial reviews (money, security, reliability) confirmed 15
findings; all are fixed with regression tests. Highlights:

- telebirr notifications must be flat, carry our `merch_code` and `appid`, and successes are confirmed
  with `queryOrder`; `CHAPA_WEBHOOK_SECRET` needs at least 32 characters.
- **Payout invariant:** a hold goes back to the player only when the provider has definitely not paid.
  Ambiguous outcomes (unreadable 2xx, timeouts, 5xx, stale attempts) keep the hold and poll; the
  reference is stored before sending; retries query before re-sending; only unanswered attempts count
  (`payouts.unanswered_attempts`); payouts pending over 24 h are flagged; staff can flag and settle.
- Deposit limits count intents that may still be paid; expired intents with a reference are polled for
  24 h (`payment_intents.next_poll_at`, backoff, per-run deadline); withdrawals are refused while a
  deposit reversed at the provider awaits staff (`deposit_under_review`).
- `/dev/payments/phone` now needs a player session and shows only that player's pushes.
- Known limit: providers without a deterministic payout reference (telebirr, mock) re-send on a retry
  after a lost answer; the mock is idempotent, telebirr payouts are not implemented yet.

**Phase 7 (17 Oct 2026).** Cash-out (`packages/db/src/betting/cashout.ts`): offers from core
`cashOutOffer` with the bet's own terms; profit above the stake is taxed like a win and posted in the one
`bet_cashout` transaction; execute re-prices under the bet lock and refuses a lower gross or net than the
player confirmed (409 `cashout_offer_changed`). In play the request waits the live bet delay outside any
transaction and pays only if the live legs did not change meanwhile. Cashed-out bets do not count toward
deposit wagering. Early settlement: live-sim results markets whose outcome is already certain
(`certainMarketResult`, `resultMarket`, outbox `market.resulted`); those results stand when a match is
later abandoned, cancelled or corrected to void. Per-user pushes: `vamos:user:<id>` → authenticated SSE
`GET /me/stream` (ends at once on logout or session revocation, sends a resync after a Redis reconnect,
named heartbeats). Web: cash-out sheet in My Bets and bet detail, live score/minute tracker, suspended
markets, live acceptance state, toasts. Review: 8 findings fixed with regression tests.
The home page first load is at its 150 KB target (budget 160 KB): trim before adding to the shell.

**Phase 8 (18 Oct 2026).** Jackpots (`packages/db/src/jackpots/`, core `settleJackpotDraw` /
`settleJackpotEntry`): rounds freeze their template and tax terms; the worker keeps one round open per
enabled template, choosing events toward the template horizon (daily9 24 h, weekly13 7 days) under a
per-template advisory lock; rounds close at the first kick-off; entries lock the user, round, events and
1X2 markets and refuse suspended games; settlement records one round-level decision, then pays entries in
batches (`jackpot_prize:` / `jackpot_refund:` keys), voids a round when more than half its games are
cancelled, and flags (never re-pays) results corrected after settlement. Promotions: `GET /promotions`
and db services to update the multi-bonus ladder and jackpot templates (staff routes come in Phase 9).
Demo dev route `POST /dev/jackpots/rounds` (signed-in player) makes a small round for e2e. Reviews now
run three reviewers that verify their own findings (no separate verifier agents) to save usage.
The home page first load is 150.4 KB (target 150, budget 160).

**Phase 9 (18 Oct 2026).** Back office: staff auth in `packages/db/src/backoffice/` (argon2 outside
transactions, RFC 6238 TOTP via node:crypto with replay guard, AES-GCM secret box keyed by
`ADMIN_TOTP_KEY` which licensed/production mode refuses to default, per-(account, IP) lockout plus
per-account backoff, `pnpm admin:create` / `admin:unlock`, self-service password and TOTP change,
forced change for generated passwords). Staff sessions: `vamos_staff` cookie, `x-staff-csrf-token`,
30 min idle / 12 h absolute; `/admin/*` CORS allows only `ADMIN_WEB_URL`. RBAC matrix in
`packages/contracts/src/admin.ts` (`PERMISSION_ROLES`, `hasPermission`). Services: dashboard (window
figures from ledger postings), players, KYC queue, trading incl. void market / void selection, risk,
bets, withdrawals and flagged payouts, jackpot cancel, settings, audit viewer. Demo staff
(`<role>@demo.vamos.test`, password `vamos-demo-staff`, TOTP secret in `seedDemoStaff`) exist only in
demo mode. Admin UI in `apps/admin` (:3001); `e2e/scripts/stack.sh` starts it.

**Phase 10 (19 Oct 2026).** Compliance (`packages/db/src/compliance/`, core `businessday`,
`dailysummary`, `aml`, `els`, `pspstatement`; full definitions in `docs/compliance.md`): ELS stream
written exactly once per outbox id (JSONL per business day, pseudonymous player ref, files 0600/0700;
`ELS_REPORTING_MODE` file|http|off, licensed mode requires file with an absolute `ELS_REPORT_DIR`);
daily summaries per Addis Ababa business day from ledger postings (turnover, payouts, GGR, tax,
commission `els_commission` 15%), provisional then final and immutable; reconciliation (ledger
integrity, wallets, house_stakes, house_jackpot, pending withdrawals, PSP movements and imported
statements incl. direction) under an advisory lock with missed-day catch-up; AML rules (velocity,
structuring, deposits-then-withdraw over all deposits since the last withdrawal, cash-out churn) with
withdrawal holds that only `aml.review` staff can release; players only ever see `manual_review`.
Left for Phase 12: run manual reconciliation off the request path and make the balance continuity
scan incremental. **Later removed** (the ELS has no counterpart in the new target market): the ELS
stream, the daily summaries and the `els_commission` setting (migration 0032 drops their tables), and
`docs/compliance.md`.

**Phase 11 (19 Oct 2026).** SMS/USSD channel, off by default (`SMS_BETTING_ENABLED`, `USSD_ENABLED`;
licensed mode refuses the mock aggregators). Core `textcommand` (`GAMEID#PICK[#GAMEID#PICK…]#STAKE`,
BAL, BETS, JP, HELP, STOP/START), `smstext`, `channelreply`, `ussd` state machine; db
`packages/db/src/channels/` (`handleInboundSms`, `handleUssdCallback`, `placeChannelBet` → `placeBet`
with the same RG/limits/live delay; SMS takes the price at receipt, USSD the price on its confirm
screen). Inbound SMS is HMAC-signed and idempotent by message id (`inbound_messages`, append-only);
USSD sessions in `ussd_sessions` (pruned after 7 days unless they hold a bet). Per-number limits are
shared across SMS and USSD. Dev simulator at `/dev/channels`. Details in `docs/channels.md`.

**Phase 12 load test (19 Oct 2026).** `pnpm load:bets` (`scripts/load/bet-placement.ts`, autocannon,
demo mode only) seeds bearer-session players, hammers `POST /bets` and `GET /events`, then asserts
balances, no negative accounts and a clean full reconciliation; results in `docs/load-testing.md`.
Fix: `placeBet` now posts the stake last, so the shared `house_stakes` row lock is held only for the
posting and commit (bets 75 → 96/s at 50 connections, p95 504 ms; CPU-bound single API process).
Full CI pipeline and the 16-test e2e suite were green; home page first load 149.7 KB.

**Phase 12 security review (24 Oct 2026).** 12 findings fixed, each with a regression test:
withdrawals refused and unapprovable while a settlement correction is blocked (approved, unsent ones go back
to review); a daily budget of 10 wrong password-reset codes per number; OTP cooldown and hourly cap per
(number, address) under a per-number ceiling of 15/h, and a password reset lifts the per-number login lock;
new passwords need 8 characters and must not be among the 10,000 most common (server-side list); the staff
account-wide delay no longer refuses addresses without failures (the right password and code get in);
api/worker connect as the restricted role `vamos_app` (migration 0030; only the migrate job uses the owner,
`APP_DB_PASSWORD`); encrypted, checksummed WAL backups (`pnpm test:infra`); dependency upgrades (prod audit
clean); licensed mode refuses http provider/callback URLs; Caddy `STAFF_ALLOWLIST` covers the admin host
and `/admin*` on the api host; proxy and web/admin container hardening; dev compose on loopback. Checks green: format, typecheck, lint, 2,251 unit and
integration tests, `pnpm test:infra`, build, and the 16-test e2e suite run with the api and worker connected
as `vamos_app` (home page first load 150.5 KB). `pnpm audit --prod`: no known vulnerabilities.

**Phase 12 (24 Oct 2026).** Ops: request ids and secret redaction in logs, optional OpenTelemetry
(`OTEL_EXPORTER_OTLP_ENDPOINT`), worker `/health` and `/ready` (:4100), graceful shutdown, security
headers, `TRUST_PROXY` in the config schema, manual reconciliation via the worker queue. Deployment:
`infra/docker/Dockerfile`, `infra/docker-compose.prod.yml` (api/worker connect as the restricted
`vamos_app` role; only the migrate job owns the schema), Caddy with a staff allowlist,
`scripts/smoke.sh`, `docs/deployment.md`, `docs/backups.md` (age-encrypted dumps and WAL),
`docs/runbooks/`. Load test `pnpm load:bets` (`docs/load-testing.md`: ~96 bets/s, p95 504 ms on 4 CPUs).
Final security review fixed 12 findings: withdrawals blocked while a settlement correction is pending
(`settlement_correction_pending`), reset-code and staff/player lockout abuse limits, 8-char passwords
with a common-password list, https required for provider URLs in licensed mode, dependency upgrades
(`pnpm audit --prod` clean). `pnpm lint` runs ESLint with a 4 GB heap. Not exercised here: the full
production compose build (Docker Hub rate limit); the CI docker job runs it.

## Legal context (do not change)

- The platform runs as a **play-money demo**: `OPERATING_MODE=demo` is the default, with "Demo ETB",
  mock payment/KYC/SMS providers and a permanent "DEMO – no real money" banner.
- `OPERATING_MODE=licensed` refuses to start unless all of these hold: real payment and KYC
  providers, `TAX_CONFIG_CONFIRMED=true`, `NODE_ENV=production` and a non-default `SESSION_SECRET`. The guard is in `packages/config/src/config.ts`. Never weaken it.
- The `database_identity` table ties a database to one mode. API and worker both call
  `claimOperatingMode` at startup and refuse to run against a database of the other mode.
- Excluded by policy: casino, crash and virtual games; crypto; agent/cash channels; payouts to a
  third party's wallet.

## Start here in a new session

1. Check out the branch and pull: `git checkout claude/quirky-ramanujan-xb7e2u && git pull`.
2. Install and start services:
   ```bash
   pnpm install
   cp -n .env.example .env                    # optional; the defaults work in demo mode
   bash infra/scripts/dev-services.sh start   # native Postgres 16 + Redis 7, no Docker
   pnpm db:migrate && pnpm db:seed
   ```
   Postgres refuses to run as root, so the script uses `runuser -u postgres`. Services stop whenever
   the container restarts; run the start command again.
3. **Finish Phase 6** (see "Phase 6: remaining steps" below):
   1. verify the combined tree
   2. add the payments e2e test
   3. run the adversarial review and fix the confirmed findings
   4. commit "Phase 6: payments", push, and update the status table
4. Then build Phases 7 to 12 in order. After each phase: format, lint, typecheck, unit tests, build
   and the e2e suite all green; then commit and push, with a short progress note to the user.

## How to work

- **Branch:** develop and push only on `claude/quirky-ramanujan-xb7e2u`
  (`git push -u origin claude/quirky-ramanujan-xb7e2u`). Do not open a pull request unless asked.
- **Commit trailers:** every commit message ends with the attribution lines the session's system
  prompt gives. Never put a model name in commits, code or docs.
- **Per phase:** run it as a Workflow (implement → adversarial review → fix):
  1. implementer agents, with modules split so no two agents edit the same files
  2. adversarial reviewers: correctness, money and ledger safety, security, test quality
  3. one fix pass over the confirmed findings
  4. then run every check yourself before committing
- **Machine limits:** the container has 4 CPUs, so a workflow runs at most 2 agents at once. Subagents
  have hit their session limit several times. When that happens, resume the run with
  `resumeFromRunId` after the reset time, or do the remaining verification directly.
- **Progress notes:** the user wants them short.

### Working within usage limits

Long runs hit the subagent usage limit many times (it resets every few hours). What worked:

- **Save often.** Commit and push a `WIP: …` snapshot whenever agents have left uncommitted work,
  and always before ending a turn. The container can restart at any time, and anything not pushed is
  lost.
- **Guard each stage.** Make each workflow stage fail fast when the stage before it returned
  `null`: `if (!core) throw new Error(...)`. Otherwise later agents run on missing input.
- **Resume, don't restart.** In the same session, resume a stopped run with `resumeFromRunId`;
  finished agents replay from the cache. A new session cannot resume an old run. It continues from
  the WIP commits instead, and the first agent's prompt should say "inspect the existing work and
  finish it rather than starting over".
- **Keep workflows small.** Use at most about 6–8 agents per workflow (one implementation stage,
  then review). The machine runs only 2 agents at a time.
- **Use lighter models for routine work** (see the table below) so the limit lasts longer.

## Model and effort per task

The person building this approved this policy: choose the model and reasoning effort per task by how
much judgement it needs. Use the strongest settings where a mistake costs money or safety, and lighter
models where the work is routine, so usage limits stretch further.

| Task                                                                                                                            | Model  | Effort            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- |
| Money and safety logic: ledger, settlement, cash-out, payments, payouts, jackpot settlement, AML rules, the licensed-mode guard | Opus   | max               |
| Adversarial reviews and their verifiers; the fix pass after a review                                                            | Opus   | high (fix: xhigh) |
| API routes and worker tasks around that logic; integration tests                                                                | Opus   | high              |
| UI pages, components, i18n strings, admin screens, SMS/USSD menus (not their bet logic)                                         | Sonnet | medium            |
| E2E tests, CI config, docs, runbooks                                                                                            | Sonnet | high              |
| Mechanical work: renames, formatting, simple searches and inventories                                                           | Haiku  | low               |

In Workflow scripts set `model` and `effort` on each `agent()` call to match this table.

## Lessons learned (avoid repeating these)

- drizzle-kit cannot serialise BigInt defaults. Write ``.default(sql`0`)``, not `.default(0n)`.
- Run `pnpm db:generate` after editing `packages/db/src/schema/*`. Hand-written SQL (triggers, CHECKs)
  goes in its own migration file next to the generated ones.
- tsup bundles the `@vamos/*` workspace packages (`noExternal`). Any third-party package those pull in
  at runtime (for example `pg`, `drizzle-orm`) must also be a dependency of the app that bundles them,
  or the ESM build crashes with "Dynamic require of 'events' is not supported".
- ESLint `@typescript-eslint/require-await` is disabled because Fastify handlers are async by contract.
- Typed ESLint over the whole repo needs more than Node's default 2 GB heap on a 16 GB machine; `pnpm lint`
  runs it with `--max-old-space-size=4096`. Call `pnpm lint`, not a bare `eslint .`.
- Prettier was once non-idempotent on `apps/api/src/app.ts`. If `format:check` fails right after
  `format`, run `pnpm format` again.
- Live/SSE tests must publish on a unique Redis channel per test, or parallel test files see each
  other's messages.
- Property tests must assert true invariants. Two earlier tests locked in wrong behaviour (cash-out
  paying the full max payout; "strictly below potential return"). Derive the expected value from the
  formula, not from the current output.
- Ledger tables are protected by DB triggers: entries must sum to zero, `ledger_entries`,
  `ledger_transactions` and `audit_log` are append-only, `balance_after` must be continuous, and
  TRUNCATE is blocked. Tests must create a fresh database with `createTestDatabase()` rather than
  cleaning tables.
- Near-certain favourites priced between 1.001 and 1.01 keep almost no margin. That is expected.
- Production api/worker connect as the restricted role `vamos_app` (migration 0030), not the owner. A new
  table gets full DML through default privileges; a new append-only table must also `REVOKE UPDATE, DELETE`
  from `vamos_app` in its guard migration (`packages/db/test/app-role.test.ts` reads the triggers and fails
  otherwise). Never run app code that needs DDL, `TRUNCATE` or superuser settings.

## Conventions

- **Money:** `bigint` santim (1 ETB = 100 santim) end to end; decimal string over the wire. Payouts
  round **down**. No floating point for money.
- **Odds:** integer milli (1.85 → 1850), valid range 1001 to 1,000,000. Void legs count as 1000.
- **Ledger:** every balance change is a double-entry `ledger_transaction` whose entries sum to zero,
  written with `postTransaction` in the same DB transaction as the business row and its
  `outbox_events` row. Debits are guarded so a balance can never go negative.
- **Idempotency:** bet placement, deposits, payouts and webhooks take an idempotency key.
- **Pure domain math** lives in `packages/core` with unit and property tests (fast-check).
- **API input** is validated with zod contracts from `packages/contracts` via `parseInput`.
- **Integration tests** use a real Postgres via `createTestDatabase` from `@vamos/db/testing`.
- **Live updates:** SSE on the Redis channel `vamos:live` (`LIVE_CHANNEL`), with compact deltas typed
  by the `LiveMessage` union in `packages/contracts/src/catalog.ts` (odds, match, market).
- **Game ID:** every fixture has a numeric Game ID (100 to 999999, DB CHECK) used for SMS/USSD/shop
  betting.

## Codebase map and reuse points

These were checked against the code on 8 Oct 2026. Read the source before relying on a signature.

### Packages

- **`packages/core`** (pure, re-exported from `@vamos/core`):
  - **Bet slip.** `betslip.ts` has `validateSlip({stake, legs, rules})`, which returns `SlipError[]`.
    It checks only numbers, not bettability or odds changes. `quoteBet({stake, legs, rules,
multiBonus, tax})` returns a `BetQuote` with `totalOddsMilli`, `grossReturn`, `bonusAmount`,
    `grossPayout`, `cappedByMaxPayout`, `taxAmount`, `netPayout` and `errors`.
  - **Settlement.** `settlement.ts` has `canSettle(legs)` and `settleBet({stake, legs, maxPayout,
multiBonus, tax})`. A leg state is `open | won | lost | void`. `settleBet` throws `RangeError`
    when the bet is not settleable. An all-void bet refunds the stake with no tax.
  - **Cash-out.** `cashout.ts` has `cashOutOffer({stake, legs, config, maxPayout})`. Each leg is
    `{placedOddsMilli, state, currentOddsMilli | null}`; pass `null` when the selection is suspended.
  - **Booking codes.** `codes.ts` has `encodeCode(randomBytes, length)`, `normalizeCode`,
    `isValidCode`, `BOOKING_CODE_LENGTH = 6`, `BET_SHORT_ID_LENGTH = 8`, `formatGameId` and
    `parseGameId`. Get the random bytes from `deps.randomBytes(n)`.
  - **Rules and other modules.** `rules.ts` holds the `DEFAULT_*` constants and types. `jackpot.ts`
    has `validateJackpotEntry`, `correctDistribution`, `jackpotTierWinners`, `computeTierPayouts` and
    `entryPrize`. `markets.ts` has `resolveSelection` and `selectionLabel`. `money.ts` and `odds.ts`
    have `toWire`, `parseSantim`, `productOddsMilli` and `VOID_ODDS_MILLI`.
- **`packages/db`** (`@vamos/db`, plus `@vamos/db/testing`):
  - **Posting.** `postTransaction(tx, {type, idempotencyKey, refType?, refId?, actor?, entries:
[{account, amount}]})`. A positive amount is a credit. Entries must sum to zero. It returns
    `{transactionId, created, balances}`, with `created: false` on a replayed key. A player account
    that would go negative throws `InsufficientFundsError`.
  - **Accounts.** An `AccountRef` is `{kind: 'player_cash' | 'player_bonus', userId}`, a house kind,
    or `{kind: 'house_psp_clearing', provider}`. The house kinds are `house_stakes` (open-stake
    liability), `house_revenue`, `house_tax_payable`, `house_demo_funding`, `house_promotions` and
    `house_jackpot`.
  - **Ledger transaction types** (the enum already exists): `demo_topup`, `deposit`, `withdrawal`,
    `withdrawal_reversal`, `bet_stake`, `bet_payout`, `bet_refund`, `bet_cashout`, `tax_withholding`,
    `settlement_reversal`, `bonus`, `adjustment`, `jackpot_entry` and `jackpot_prize`.
  - **Queries.** `getPlayerBalances`, `netLossSince`, `depositTotalSince`, `sumPlayerFlows` and
    `withTransaction`. `BETTING_FLOW_TYPES` does **not** include `tax_withholding`.
  - **Outbox, audit and settings.** `enqueueOutbox(exec, {type, aggregateType, aggregateId,
payload})`, `claimOutboxBatch(tx, limit, {maxAttempts})` (FOR UPDATE SKIP LOCKED),
    `markOutboxPublished`, `markOutboxFailed`, `writeAudit(...)`, and `getSetting` / `setSetting`.
    `getSetting` returns raw JSON, so santim values come back as strings.
  - **Settings keys:** `bet_rules`, `multi_bonus`, `tax`, `cash_out`, `live_bet_delay_ms`,
    `responsible_gambling`, `jackpots`, `payments` and `risk_limits` (the house liability caps: the largest
    liability on one selection and on one match, each a positive amount or null for no cap; checked in
    `placeBet`, see `docs/therundown-plan/README.md` rule L1) and `market_families` (plan task 2.5:
    factory margins per class, main 600 / derivative 700 / long 1200 bps, and per family; the factory
    selections' share of the selection cap, 2500 bps; the weekly family job's stake floor, 100,000 ETB;
    see `docs/scraper.md` 6.5a).
  - **Catalogue.** `isSelectionBettable(event, marketStatus, selectionStatus, now)`.
    `resultEvent(tx, eventId, input)` sets `selections.result` and the market status, then writes the
    outbox event `event.resulted` or `event.result_corrected`. The payload is `{eventId, status,
score, previous?}`. It also returns `'unchanged'` when nothing changed. The services
    `setManualOdds`, `setMarketStatus`, `suspendEvent` / `resumeEvent` and `upsertFixture` exist.
  - **Admin tables already exist** (`schema/accounts.ts`): `admin_users` (role enum `admin`,
    `trader`, `finance`, `kyc`, `support`, `compliance`; `totp_secret_enc`) and `admin_sessions`.
  - **KYC** status lives in `kyc_profiles.status` (`unverified | pending | verified | rejected`), not
    on `users`.
- **`packages/contracts`:** `common`, `health`, `auth`, `account`, `wallet` and `catalog`. There are no
  betting, payment, cash-out, jackpot or admin contracts yet. `WalletTransactionType` already lists the
  bet and jackpot types.
- **`packages/feed`:** `MockFeedProvider`, the pricing models and the simulator. Pure, no I/O.
- **`packages/config`:** `loadConfig`, the licensed-mode guard and `loadDotEnv`. The environment
  variables are listed in `.env.example`. `TRUST_PROXY` is still read in `apps/api/src/server.ts`,
  outside the schema.
- **`packages/i18n`:** `LOCALES = ['am', 'en', 'om', 'ti']`, `messagesFor(locale)`. It has only a few
  keys so far, and `en.ts` defines the shape.

### API (`apps/api`, Fastify, :4000)

- **Modules.** A new module is a default-export `async function xRoutes(app)` in
  `src/modules/<x>/routes.ts`, added to `src/modules/index.ts`. Routes stay thin: auth, then
  `parseInput(Schema, body)`, then a service call. Services take `deps` and run
  `deps.db.transaction(...)`. Always use `deps.clock()`, never `new Date()`.
- **Auth.** Put `preHandler: app.requireAuth` on the route, then call `requireUser(request)`. Cookie
  auth on unsafe methods needs the `x-csrf-token` header; Bearer requests are exempt.
- **Errors.** `lib/errors.ts`: `AppError(status, code, message, details?)` plus helpers such as
  `badRequest`, `notFound`, `conflict` and `unprocessable`.
- **Idempotency.** `readIdempotencyKey(request)` reads the `idempotency-key` header (8 to 100
  printable characters). There is no generic idempotency table. Keys are scoped into the ledger key,
  for example `demo_topup:${userId}:${key}`. When the key is replayed, compare the payload (422
  `idempotency_key_reused` if it differs), write no second outbox or audit row, and set the
  `idempotent-replayed: true` header.
- **RG.** `src/modules/rg/service.ts` has `lockUser(tx, userId)` (FOR NO KEY UPDATE),
  `assertStakeAllowed(exec, userId, stake, now)` and `assertDepositAllowed(exec, userId, amount, now)`.
  Call `lockUser` first, inside the same transaction. These throw `AppError`, so the worker cannot
  reuse them yet.
- **Routes today:**
  - `/health`
  - `/auth/*`: register, verify-otp, otp/resend, login, logout, password forgot and reset
  - `/me`, `/me/kyc`, `/me/limits`, `/me/exclusions`
  - `/wallet`, `/wallet/transactions`, `/wallet/demo-topup`
  - `/sports`, `/sports/:sport/competitions`, `/events`, `/events/by-game-id/:gameId`, `/events/:id`
  - `/live/stream` (public SSE, no per-user channel)
  - `/dev/sms?phone=` (the dev OTP inbox; demo mode only)
- **Tests.** `test/helpers.ts` has `createTestContext()` (throwaway DB, prefixed Redis, a manual
  clock, mock providers, a unique live channel) and `registerAndLogin(ctx)`, which returns
  `sessionToken` among other things. The catalogue fixture inserters are local to
  `test/catalog.test.ts`.

### Worker (`apps/worker`)

- **Tasks.** A task is `WorkerTask {name, start, stop}`. Most are built with
  `intervalTask({name, intervalMs, run})`. They are registered in `src/tasks/index.ts`, where
  `createTasks` adds the feed tasks **only** when `FEED_PROVIDER=mock` and the mode is demo. Register
  new tasks (settlement, outbox) outside that `if`.
- **Existing tasks:**
  - `feed-ingest` (60 s) also withdraws stale fixtures through `resultEvent(..., {status:
'cancelled'})`.
  - `live-sim` (1 s) results finished matches.
  - `prematch-drift` (30 s).
- **Helpers.** `lib/lock.ts` has `tryLock(redis, key, ttlMs)`. `lib/publish.ts` has
  `publishAfterCommit`: collect `LiveMessage`s inside the transaction and publish only after commit.
- **BullMQ is installed but unused.** There is **no outbox consumer** yet.
- **Tests.** `test/helpers.ts` has `createWorkerTestContext()` (seeded test DB, fake clock, unique
  channel, `waitForMessages`). Tests call the `run*` functions directly, for example
  `runLiveSimTick(t.ctx, {simSpeed: 10, ...})`.
- **Speed knob.** `SIM_SPEED` (simulated minutes per real second). At 10, a football match takes about
  11 s. Rolling demo fixtures: `FEED_ROLLING_EVERY_MINUTES` (default 5) and
  `FEED_ROLLING_HORIZON_MINUTES` (default 120), read by `@vamos/config` (`config.feed.rolling`) and
  passed to `feedIngest.rolling` in `main.ts`. e2e uses 60 / 1 / 10.

### Front ends and e2e

- **`apps/web`** has the Phase 5 foundation: Tailwind v4 tokens, the app shell, i18n (`getT` /
  `useT`, `vamos_locale` cookie, namespaced messages in `packages/i18n`), the typed API client, the
  session context, the betslip store and the PWA files. Conventions are in `apps/web/README.md`.
- **`apps/admin`** is a Next.js 16 / React 19 scaffold: a layout, one page and the demo banner.
- **`e2e`** has `@playwright/test` 1.56.1 and a mobile Chromium project: smoke tests, the full bet
  flow (register → OTP → top-up → 3-leg multi → settled), the payments flow (KYC → deposit approved
  on the simulated phone → wagering → withdrawal approved by the dev back-office stand-in → paid) and
  the home page-weight budget. Helpers
  are in `e2e/support/`; `e2e/scripts/stack.sh` builds and starts the API, the worker with the fast
  simulator (`SIM_SPEED`, `FEED_ROLLING_EVERY_MINUTES`, `FEED_ROLLING_HORIZON_MINUTES`) and
  `apps/web/server.mjs` (`next start` plus brotli, the production server). CI runs it in the `e2e`
  job. See `e2e/README.md`.

## Business defaults

All of these become editable in admin (Phase 9) and are placeholders to "confirm with counsel". The constants live in `packages/core/src/rules.ts`.

| Setting                     | Default                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Minimum stake               | 5 ETB                                                                                  |
| Max legs per bet            | 40                                                                                     |
| Max payout per bet          | 500,000 ETB                                                                            |
| Live bet delay              | 6 s                                                                                    |
| Cash-out margin             | 5%                                                                                     |
| Minimum age                 | 21                                                                                     |
| Winnings tax                | 20% of net winnings (rate, base and exemption configurable)                            |
| Multi-bonus ladder          | 3 legs 3% … 30 legs 200% of winnings; each leg ≥ 1.30 odds; bonus capped at 50,000 ETB |
| Daily jackpot (`daily9`)    | 9 games, 10 ETB per combination, max 1,024 combinations, 100k pool                     |
| Weekly jackpot (`weekly13`) | 13 games, 10 ETB per combination, max 4,096 combinations, 1M pool, consolation tiers   |

## Remaining phases

Each phase ends with format, lint, typecheck, unit tests, build and the e2e suite all green, then a
commit and a push.

**Per-phase workflow template** (models follow "Model and effort per task"):

1. **Core logic:** schema, `packages/db` services and pure helpers in `packages/core`, with unit and
   property tests. Opus, max effort for money logic, otherwise high.
2. **Surfaces**, as separate agents on separate folders:
   - API and worker: Opus, high
   - web or admin UI: Sonnet, medium
3. **E2E test:** Sonnet, high.
4. **Review:** 3 dimensions with one verifier each, all Opus, high.
5. **Fix:** Opus, xhigh. Then verify everything yourself, commit and push.

| Phase               | Highest-risk part (use Opus, max)                                                       | Routine parts (lighter models)         |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| 7 Live and cash-out | Cash-out execution, re-quote and the race with settlement; early market settlement      | Live page UI, cash-out button          |
| 8 Jackpots          | Combination pricing, prize-tier split, cancelled-game rule, jackpot ledger              | Jackpot UI, admin config forms         |
| 9 Back office       | Staff auth (TOTP, RBAC), audit trail, manual resulting and voiding, withdrawal approval | Dashboards, lists, search screens      |
| 10 Compliance       | Reconciliation, daily totals, AML rules                                                 | Report formats, `docs/compliance.md`   |
| 11 SMS/USSD         | Bet placement through text commands (reuses `placeBet`)                                 | Parser and menu text, simulator page   |
| 12 Hardening        | Security review, load test on bet placement                                             | Dockerfiles, runbooks, deployment docs |

### Phase 4: Betslip, bet placement, booking codes and settlement (done; kept as reference)

**Groundwork first** (small, separate commits):

- **Typed settings loader** in `@vamos/db`: zod with bigint coercion, built on `getSetting`. It
  returns `BetRules`, `MultiBonusConfig`, `TaxConfig`, `CashOutConfig`, the live bet delay and the
  jackpot templates, falling back to the core `DEFAULT_*` values. The API, worker and admin all use
  it.
- **Shared RG guard.** Move `lockUser`, `assertCanGamble` and `assertStakeAllowed` /
  `assertDepositAllowed` into `@vamos/db` (or a new shared package) so the worker can use them.
  Introduce a small domain error type that the API maps to `AppError`. Keep the API behaviour and
  tests unchanged.
- **Outbox dispatcher** (`apps/worker/src/tasks/outbox-dispatch.ts`): an `intervalTask` of about
  1 s that calls `claimOutboxBatch` and hands each row to a BullMQ queue by type, using
  `jobId = 'outbox-' + id` (BullMQ rejects most ids containing ':') so a row is never queued twice, then calls `markOutboxPublished`. The
  outbox has a single `published_at` column, so one dispatcher must fan out to every consumer. Do
  not let several consumers claim rows directly. Add a backoff and a dead-letter log for rows that
  reach `maxAttempts`.
- **Shared catalogue fixtures.** Move the inserters out of `apps/api/test/catalog.test.ts` into
  `apps/api/test/fixtures.ts`.

**Build:**

- **Schema:** a new file `packages/db/src/schema/betting.ts`, exported from `schema/index.ts`. Then
  run `pnpm db:generate`; never hand-edit `migrations/meta`.
  - `bets`: user, short ID (`BET_SHORT_ID_LENGTH`), stake, total odds, potential return, bonus,
    tax, net potential, status, odds-change policy, channel, `idempotency_key` with a UNIQUE
    `(user_id, idempotency_key)`, and placed / accepted / settled timestamps, plus a settlement
    version. Status is one of `pending_acceptance`, `open`, `won`, `lost`, `void`, `cashed_out`
    or `rejected`.
  - `bet_legs`: bet, event, market, selection, odds at placement, leg state and the result.
  - `booking_codes`: code (unique), legs JSON, creator (nullable), and creation and expiry times.
  - Add CHECK constraints: stake > 0, odds ≥ 1001.
- **Ledger postings** use the existing enum types and accounts; no new kinds are needed. Each row
  below is one `postTransaction`:

  | Event           | Type                                     | Entries                                                                                               |
  | --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | Stake           | `bet_stake`                              | `player_cash` −stake, `house_stakes` +stake                                                           |
  | Lost            | `bet_payout` or `adjustment` (see below) | `house_stakes` −stake, `house_revenue` +stake                                                         |
  | Won             | `bet_payout`                             | `player_cash` +net, `house_tax_payable` +tax, `house_stakes` −stake, `house_revenue` −(gross − stake) |
  | Void / rejected | `bet_refund`                             | `house_stakes` −stake, `player_cash` +stake                                                           |
  | Cash-out        | `bet_cashout`                            | `house_stakes` −stake, `player_cash` +amount, `house_revenue` ±(stake − amount)                       |
  | Correction      | `settlement_reversal`                    | the exact negation of the previous settlement, then settle again                                      |
  - Putting tax inside the single `bet_payout` keeps the responsible-gambling loss maths correct,
    because `BETTING_FLOW_TYPES` excludes `tax_withholding`.
  - For a lost bet, decide whether to post the `house_stakes` → `house_revenue` move as
    `bet_payout` or as `adjustment`. Document the choice.
  - Leave out entries whose amount is zero, for example tax under the exemption, because
    `postTransaction` rejects an account whose merged amount is 0.
  - Idempotency keys:
    - stake: `bet:${userId}:${clientKey}`
    - settlement: `settle:${betId}:${version}`
    - reversal: `reverse:${betId}:${version}`

- **Contracts** (`packages/contracts/src/betting.ts`, re-exported from `index.ts`):
  - quote request and response
  - place request: legs `{selectionId, oddsMilli}`, stake, and the odds-change policy
    `none | higher | any`
  - `BetView` with legs
  - booking code create, response and load
  - the my-bets list, with cursor (`PageQuery`)
- **API** (`apps/api/src/modules/betting`):
  - **`POST /betslip/quote`** (public): loads current prices and runs `quoteBet` with the loaded
    settings. It returns the totals and errors per leg, including legs that are not bettable.
  - **`POST /bets`** (auth, idempotency key required). Use per-user rate limiting. Everything runs in
    **one** transaction, in this order:
    1. `lockUser`
    2. `assertStakeAllowed`
    3. load the legs, locking selections `FOR SHARE`
    4. check `isSelectionBettable(event, market.status, selection.status, now)` and that the sport
       and competition are active
    5. apply the odds-change policy, comparing `selections.oddsMilli` with the client's odds (there
       is no odds version column)
    6. `validateSlip` / `quoteBet`
    7. `postTransaction(bet_stake)`
    8. insert the bet and its legs
    9. `enqueueOutbox('bet.placed')` and `writeAudit`
    - On a replay, return the existing bet with `idempotent-replayed: true`.
  - **Live legs:** the bet starts as `pending_acceptance` and a delayed BullMQ job runs after
    `live_bet_delay_ms` (6 s). It accepts the bet if the markets are still open and the odds are
    within the policy; otherwise it rejects the bet and refunds the stake (`bet_refund`).
  - **Booking codes:** `POST /booking-codes` returns a 6-character code and
    `GET /booking-codes/:code` returns its legs with current odds.
  - **My bets:** `GET /me/bets?status=open|settled&cursor=` and `GET /me/bets/:id`.
- **Settlement consumer** (BullMQ worker on the `settlement` queue, fed by the dispatcher):
  - On `event.resulted` / `event.result_corrected`, read `selections.result`, which `resultEvent` has
    already set, for every open leg on that event, and update the leg states.
  - For each affected bet, lock the bet row. Once `canSettle` allows, run `settleBet`, post the
    ledger entries and set the status. Then enqueue `bet.settled`; SMS consumes it later.
  - A `cancelled` result (feed withdrawal, postponement) voids the legs. A void leg counts as 1.00.
  - A correction reverses the old settlement with `settlement_reversal` and settles again with the
    next version. Never edit ledger rows.
  - Replaying the same outbox row or job must change nothing.

**Check:** integration tests on a real Postgres (`createTestContext` / `createWorkerTestContext`) for
every outcome path:

- won, lost, a void leg, all legs void, the max-payout cap, the multi bonus, and tax
- a corrected result, from won to lost and from lost to won
- odds changed under each policy
- live pending acceptance, both accepted and rejected
- an idempotent replay of placement and of settlement
- a self-excluded user is refused, and a loss limit is enforced
- 50 concurrent bets never overdraw

Balances, `house_stakes`, `house_revenue` and `house_tax_payable` must reconcile through the ledger.
Add core property tests for any new pure helpers.

### Phase 5: Player web app (Betika-style lite PWA): the MVP (done; kept as reference)

**Build (`apps/web`, Next.js + next-intl + Tailwind):**

- **Home:** sport chips; Highlights / Today / Upcoming / Leagues tabs; match rows with Game ID,
  kick-off, 1X2 odds buttons and a "+N markets" link.
- **Pages:** Live, competition, event (market accordions), My Bets, Wallet (demo top-up), Account
  (KYC, limits, self-exclusion, language), Help, Terms, Responsible Gambling, and the auth pages
  (register with OTP, login, password reset).
- **Betslip drawer:** floating; quick stakes 10/50/100/500; shows potential win, bonus, tax and net;
  share and load booking codes; odds-change policy setting.
- **Language:** Amharic and English at launch (`packages/i18n`), with Afaan Oromo and Tigrinya message
  files prepared. Use an Ethiopic system font stack.
- **Lightweight:** server-rendered lists, small client islands, PWA manifest and service worker,
  ≤ 150 KB transferred on the first home-page load.
- A permanent "DEMO – no real money" banner in demo mode.
- In dev, the OTP can be read from the dev SMS inbox (mock SMS provider).
- **Groundwork:**
  - add Tailwind and next-intl (or wire `messagesFor` into a locale cookie)
  - add the many missing i18n keys in all four locales
  - add `public/` icons, a typed API client that sends credentials and the CSRF header, and `lint`
    and `test` scripts
  - add `@vamos/core` as a real dependency
- **Fast simulation for e2e:** add an env knob for the rolling-fixture interval, or a dev-only
  "kick off now" endpoint, and run the worker with `SIM_SPEED>=10`.
- **E2e plumbing:** create `e2e/support/` with an OTP-inbox helper, and add an e2e job to CI.

**Check:** a Playwright flow (`pnpm e2e`, Chromium from `/opt/pw-browsers`; `@playwright/test`
1.56.1 matches it): register, read the OTP from the dev SMS inbox, demo top-up, build a 3-leg
accumulator, place it, let the fast simulator settle it, and see the balance and My Bets update. Add a
build-size budget check.

### Phase 6: Payments (deposits and withdrawals): original scope

**Build:**

- **Schema:** `payment_intents`, `payouts`, `payment_events`.
- **`PaymentProvider` interface:** initiate a deposit (push / redirect / USSD instructions), verify a
  webhook, query status, initiate a payout.
- **Providers:**
  - `mock`: a dev "phone" simulator page to approve or decline with a PIN
  - `chapa`: initialize, verify, HMAC webhook, transfers
  - `telebirr`: Fabric token → create order → `notify_url` flow
  - `cbebirr` and `mpesa-et`: skeletons that report "not configured" until merchant documents and
    credentials exist
- **Withdrawal checks:** KYC verified; payout only to the registered phone number in the user's own
  name; deposits wagered once before withdrawal; daily caps; auto-approval below a threshold,
  manual review above it. Use the existing `assertDepositAllowed` for deposit RG checks.
- **Payout worker** with retries, and a payout status tracker (pending → approved → paid).
- **SMS notifications** through the mock outbox.
- **Wiring:**
  - add `payments` to `AppDeps`, using the existing `createXProvider(config)` pattern
  - post through the `house_psp_clearing` account for each provider
  - add the provider environment variables to the `@vamos/config` schema and `.env.example`, without
    changing `licensedModeViolations`
  - webhook routes have no session, so CSRF does not apply. Each one needs its own signature check and
    an idempotency key from the provider's event ID.

**Check:** webhook signature and idempotency tests; end to end: deposit through the simulator, request
a withdrawal, approve it in admin, and see it marked paid.

### Phase 6: remaining steps

Do these in order. Use the model and effort from the table above.

1. **Verify the combined tree** (no agent needed):
   `pnpm db:migrate && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
   Then run the existing e2e suite: `bash e2e/scripts/stack.sh build && bash e2e/scripts/stack.sh
start && pnpm e2e; bash e2e/scripts/stack.sh stop`. Fix whatever fails (Opus, high).
2. **Payments e2e** (Sonnet, high): add `e2e/tests/payments-flow.spec.ts`. The flow:
   1. register and verify
   2. submit KYC (mock)
   3. deposit on `/wallet/deposit`, then approve on `/dev/phone` with PIN 1234; the balance updates
   4. place bets that meet the wagering requirement
   5. request a withdrawal
   6. approve it through `/dev/payments/withdrawals/:id/approve`
   7. the tracker shows paid and the balance went down

   If the worker needs new environment variables, update `e2e/scripts/stack.sh`.

3. **Adversarial review** (Opus, high; one verifier per dimension). Dimensions:
   - money and ledger: double credit on webhook replay, holds, wagering, daily caps, reversals
   - security: webhook signatures and raw body, spoofing via `:provider`, dev routes unreachable in
     production or licensed mode, IDOR, CSRF, payouts only to the player's own phone, secrets in
     logs
   - reliability: no double payout if the worker crashes between the provider call and the DB
     update, retries and polling, intent expiry, SMS failure never blocking money
4. **Fix** the confirmed findings (Opus, xhigh), re-run step 1 plus the whole e2e suite, commit, push,
   and mark Phase 6 done.

### Phase 7: Live betting and cash-out

**Build:**

- **Live page:** SSE odds, a score and minute tracker, suspended-market UI, delayed acceptance.
- **Cash-out:** an offer endpoint (core `cashOutOffer`, which discounts the _capped_ return) and an
  execute endpoint that re-quotes and checks the offer is still valid; a Cash out button in My Bets.
  Post a `bet_cashout`.
- **Per-user push channel:** an authenticated SSE stream, or a Redis channel `vamos:user:<id>`, for
  bet settled, bet accepted or rejected, and cash-out offer updates. Today `/live/stream` is public
  only.
- **Early settlement:** settle markets that live-sim closes mid-match before full time, so that
  cash-out and settlement see legs that are already decided.

**Check:** tests on a simulated live match and an end-to-end cash-out.

### Phase 8: Jackpots and promotions

**Build:**

- jackpot rounds, games and entries (several picks per game, combination pricing via core `jackpot`),
  closing at the first kick-off
- settlement with prize tiers and the cancelled-game rule
- jackpot UI and a jackpot tab in My Bets
- the multi-bonus ladder and jackpot settings exposed through the admin API

**Check:** settlement and prize-split tests, and an end-to-end jackpot entry.

### Phase 9: Back office (`apps/admin`, port 3001)

**Build:**

- login with TOTP; roles: admin, trader, finance, KYC, support, compliance. Build on the existing
  `admin_users` and `admin_sessions` tables and the `admin_role` enum; do not create new ones. Add a
  separate staff session plugin with an RBAC guard.
- dashboard: turnover, GGR, liabilities
- users, KYC queue, trading (odds, suspend, results, void), risk (liability per selection, big bets)
- the trader HTTP routes over the existing catalog services (`setManualOdds`, `setMarketStatus`,
  `suspendEvent` / `resumeEvent`, `resultEvent`): these services exist, the routes do not yet.
  Add a way to void a single market or selection (today only a whole event can be voided, through
  `resultEvent`).
- bets search, withdrawal approvals, jackpots, settings (limits, tax, ladder), audit log viewer
- withdrawal approval replaces the demo-only stand-in `/dev/payments/withdrawals/:id/approve|reject`.
  Keep the stand-in for the e2e suite, but only in demo mode.

Every admin action writes to the audit log (`writeAudit`).

**Check:** Playwright admin flows, and a role without permission gets 403 on API calls.

### Phase 10: Compliance and regulator reporting

**Build:**

- **`ElsReporter`** interface fed from the outbox: a JSONL/CSV file reporter now, and an HTTP
  placeholder until ELS publishes its spec.
- **Daily summary:** turnover, payouts, GGR, tax withheld, commission due.
- **Reconciliation job:** ledger vs wallet balances vs PSP statements.
- **AML rules:** transaction velocity, structuring, deposit then withdraw without betting. These
  flag users for review.
- **Docs:** create `docs/compliance.md` (it does not exist yet), including data retention and the
  business defaults to confirm with counsel.
- **Outbox consumer:** ELS reporting gets its own queue from the Phase 4 outbox dispatcher.

**Check:** report fixtures match the ledger totals, and reconciliation detects an injected mismatch.

### Phase 11: SMS/USSD channel (feature-flagged, off by default)

**Build:**

- **Text commands:** `GAMEID#PICK#STAKE`, `BAL`, `JP` and similar.
- **USSD menus:** a state machine for the usual aggregator callback (`sessionId`, `phoneNumber`,
  `text`).
- **Dev simulator page** for trying both without a phone.
- It stays off until the regulator approves it.

**Check:** parser and state-machine tests, and an end-to-end bet placed through the simulator.

### Phase 12: Hardening and deployment

**Build:**

- **Load and security:** an autocannon load test on bet placement and a security review pass.
- **Operations:** pino logs with request IDs, OpenTelemetry hooks, a worker health endpoint, and
  production Dockerfiles and compose. Move `TRUST_PROXY` into the `@vamos/config` schema.
- **Docs:** a deployment guide (hosting in Ethiopia; PDPP data residency to be confirmed), backups,
  and runbooks.

**Check:** the full CI pipeline is green, and the compose stack boots and passes smoke tests.

## Out of scope / backlog

- casino, crash and virtual games
- live video streaming (the match tracker replaces it)
- athletics outright markets
- a real feed adapter (Sportradar or BetConstruct, once there is a contract)
- real telebirr, CBE Birr and M-Pesa credentials
- an option to show times on the Ethiopian clock
- a native iOS app
