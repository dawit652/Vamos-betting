# Vamos Betting build plan and handoff

This is the working plan for building Vamos Betting, a mobile-first sportsbook for Ethiopia modelled on
**Betika**. It holds the current status, what the next session does first, the conventions learned so far,
and the scope and acceptance checks for every remaining phase. Repo rules are in `CLAUDE.md`. Market
research is in `docs/research/`.

## Status

| Phase | Scope                                                         | State                  | Commits                             |
| ----- | ------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| 0     | Foundation: workspace, config guard, infra, CI                | Done                   | `f81d44e`                           |
| 1     | Domain core (`packages/core`)                                 | Done                   | `dccd213`, `4a8d03f`                |
| 2     | Database, accounts, ledger, auth, KYC, RG, wallet             | Done                   | `2131ee7`, `d26120d`                |
| 3     | Sports catalogue, odds feed, live simulator, trading services | **Needs verification** | `0c02e89`, `e381576`, WIP `f80ccf5` |
| 4     | Betslip, bet placement, booking codes, settlement             | Not started            |                                     |
| 5     | Player web app (Betika-style lite PWA), the demo MVP          | Not started            |                                     |
| 6     | Payments: deposits and withdrawals                            | Not started            |                                     |
| 7     | Live betting and cash-out                                     | Not started            |                                     |
| 8     | Jackpots and promotions                                       | Not started            |                                     |
| 9     | Back office (`apps/admin`)                                    | Not started            |                                     |
| 10    | Compliance and regulator reporting                            | Not started            |                                     |
| 11    | SMS/USSD channel (feature-flagged)                            | Not started            |                                     |
| 12    | Hardening and deployment                                      | Not started            |                                     |

Commit `f80ccf5` holds fixes for all 13 Phase 3 review findings. It has **not** been through lint,
typecheck or the full test run yet. The agent that wrote it reported these package test counts as passing:

| Package | Tests |
| ------- | ----- |
| db      | 99    |
| feed    | 143   |
| worker  | 37    |
| api     | 198   |

## Legal context (do not change)

- Ethiopia revoked all sports betting licences on 15 Dec 2025. Vamos Entertainment PLC was one of the
  22 suspended operators. The Ethiopian Lottery Service (ELS) is preparing a stricter relaunch with
  real-time transaction monitoring.
- So the platform runs as a **play-money demo**: `OPERATING_MODE=demo` is the default, with "Demo ETB",
  mock payment/KYC/SMS providers and a permanent "DEMO – no real money" banner.
- `OPERATING_MODE=licensed` refuses to start unless all of these hold: an ELS licence number, ELS
  reporting enabled, real payment and KYC providers, `TAX_CONFIG_CONFIRMED=true`, `NODE_ENV=production`
  and a non-default `SESSION_SECRET`. The guard is in `packages/config/src/config.ts`. Never weaken it.
- The `database_identity` table ties a database to one mode. API and worker both call
  `claimOperatingMode` at startup and refuse to run against a database of the other mode.
- Excluded by policy: casino, crash and virtual games; crypto; agent/cash channels; payouts to a
  third party's wallet.

## Start here in a new session

1. Check out the branch: `git checkout claude/quirky-ramanujan-xb7e2u && git pull`.
2. Install and start services:
   ```bash
   pnpm install
   bash infra/scripts/dev-services.sh start   # native Postgres 16 + Redis 7, no Docker
   pnpm db:migrate && pnpm db:seed
   ```
   Postgres refuses to run as root, so the script uses `runuser -u postgres`. If services stop
   (they do after container restarts), run the start command again.
3. **Finish Phase 3:**
   ```bash
   pnpm format && pnpm lint && pnpm typecheck && pnpm -r --if-present test
   ```
   Fix anything that fails, then commit "Phase 3: review fixes verified" (or amend nothing; add a new
   commit) and push.
4. Optional smoke test of the real stack:
   - `pnpm --filter @vamos/worker build && pnpm --filter @vamos/api build`
   - run the built worker and API. Expect fixtures to appear, an event to go live then finished and
     be resulted with an outbox event, `/health` and `/sports` to answer, and `/live/stream` to send
     heartbeats.
5. Build Phases 4 to 12 in order, as described below. After each phase: lint, typecheck and tests
   green, then commit and push, with a short progress note to the user.

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

## Lessons learned (avoid repeating these)

- drizzle-kit cannot serialise BigInt defaults. Write ``.default(sql`0`)``, not `.default(0n)`.
- Run `pnpm db:generate` after editing `packages/db/src/schema/*`. Hand-written SQL (triggers, CHECKs)
  goes in its own migration file next to the generated ones.
- tsup bundles the `@vamos/*` workspace packages (`noExternal`). Any third-party package those pull in
  at runtime (for example `pg`, `drizzle-orm`) must also be a dependency of the app that bundles them,
  or the ESM build crashes with "Dynamic require of 'events' is not supported".
- ESLint `@typescript-eslint/require-await` is disabled because Fastify handlers are async by contract.
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

## Business defaults

All of these become editable in admin (Phase 9) and are listed in `docs/compliance.md` as
"confirm with counsel". The constants live in `packages/core/src/rules.ts`.

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

Phases 0 to 5 make the demo-ready MVP. Each phase ends with lint, typecheck and tests green, then a
commit and push.

### Phase 4: Betslip, bet placement, booking codes and settlement

**Build:**

- **Schema** (`packages/db/src/schema/betting.ts`, new migration): `bets` (user, stake, total odds,
  potential return, bonus, tax, status: `pending_acceptance` / `open` / `won` / `lost` / `void` /
  `cashed_out`, odds-change policy, channel, idempotency key unique per user, placed/accepted/settled
  timestamps), `bet_legs` (bet, event, market, selection, odds at placement, result), `booking_codes`
  (code, legs JSON, created by, expiry).
- **Ledger accounts** for open stakes, house, and `tax_payable`. Add any missing account kinds and
  transaction kinds: `bet_stake`, `bet_payout`, `bet_void_refund`, `tax_withheld`,
  `bet_resettle_reversal`.
- **Contracts** (`packages/contracts/src/betting.ts`): quote request/response, place request (legs,
  stake, odds-change policy `none` / `higher` / `any`), bet view, booking code create/load, my-bets list
  with cursor.
- **API** (`apps/api/src/modules/betting`):
  - `POST /betslip/quote`: priced with core `quoteBet`; returns total odds, potential win, bonus, tax,
    net, and per-leg errors.
  - `POST /bets` (idempotency key required): in **one** DB transaction, lock the user (`lockUser`),
    run `assertStakeAllowed` (RG loss limits, self-exclusion), check every leg with
    `isSelectionBettable(event, market, selection, now)` plus an active sport/competition, apply the
    odds-change policy, debit the stake with `postTransaction`, insert the bet and legs, and enqueue an
    outbox event `bet.placed`.
  - Live legs: the bet starts as `pending_acceptance`. A worker accepts it after the live delay (6 s)
    if the odds are unchanged within the policy and the markets are still open, otherwise rejects it
    and refunds the stake.
  - `POST /booking-codes` and `GET /booking-codes/:code`.
  - `GET /me/bets?status=open|settled` and `GET /me/bets/:id`.
- **Settlement worker:** consume the outbox events `event.resulted` and `event.result_corrected`.
  Resolve selections with core `resolveSelection`, settle each affected bet with core `settleBet`
  once `canSettle` allows, count void legs as 1.00, withhold tax into `tax_payable`, and credit the
  net payout.
  - Re-settlement after a result correction posts **reversal entries**, never edits ledger rows.
  - Void the open legs of fixtures the feed withdraws (feed-ingest already withdraws stale fixtures).
  - Make the consumer idempotent: settling the same bet twice must do nothing.

**Check:** integration tests on a real Postgres for every outcome path: won, lost, void leg, all
void, cashed out, result corrected, odds changed under each policy, pending acceptance accepted and
rejected, idempotent replay, and 50 concurrent bets that never overdraw. Balances and tax must
reconcile through the ledger.

### Phase 5: Player web app (Betika-style lite PWA): the MVP

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

**Check:** a Playwright flow (`pnpm e2e`, Chromium from `/opt/pw-browsers`; `@playwright/test`
1.56.1 matches it): register, read the OTP from the dev SMS inbox, demo top-up, build a 3-leg
accumulator, place it, let the fast simulator settle it, and see the balance and My Bets update. Add a
build-size budget check.

### Phase 6: Payments (deposits and withdrawals)

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

**Check:** webhook signature and idempotency tests; end to end: deposit through the simulator, request
a withdrawal, approve it in admin, and see it marked paid.

### Phase 7: Live betting and cash-out

**Build:**

- **Live page:** SSE odds, a score and minute tracker, suspended-market UI, delayed acceptance.
- **Cash-out:** an offer endpoint (core `cashOutOffer`, which discounts the _capped_ return) and an
  execute endpoint that re-quotes and checks the offer is still valid; a Cash out button in My Bets.

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

- login with TOTP; roles: admin, trader, finance, KYC, support, compliance
- dashboard: turnover, GGR, liabilities
- users, KYC queue, trading (odds, suspend, results, void), risk (liability per selection, big bets)
- the trader HTTP routes over the existing catalog services (`setManualOdds`, `setMarketStatus`,
  `suspendEvent` / `resumeEvent`, `resultEvent`): these services exist, the routes do not yet
- bets search, withdrawal approvals, jackpots, settings (limits, tax, ladder), audit log viewer

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
- **Docs:** `docs/compliance.md`, including data retention and the business defaults to confirm with
  counsel.

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
- **Operations:** pino logs with request IDs, OpenTelemetry hooks, production Dockerfiles and compose.
- **Docs:** a deployment guide (hosting in Ethiopia; PDPP data residency to be confirmed), backups,
  and runbooks.

**Check:** the full CI pipeline is green, and the compose stack boots and passes smoke tests.

## Out of scope / backlog

- casino, crash and virtual games, unless the new ELS rules allow them
- live video streaming (the match tracker replaces it)
- athletics outright markets
- a real feed adapter (Sportradar or BetConstruct, once there is a contract)
- real telebirr, CBE Birr and M-Pesa credentials
- an option to show times on the Ethiopian clock
- a native iOS app
