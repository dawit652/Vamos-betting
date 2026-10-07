# Vamos Betting – architecture

## Model and product scope

Vamos is modelled on **Betika**, the East African sportsbook that operated in Ethiopia through Addis Telco. It was designed for mobile-money markets and low-bandwidth phones.

**What we take from Betika:**

- lite mobile layout: sport chips, highlights list with 1X2 buttons, "+N markets"
- floating betslip
- push-to-phone deposits
- a numeric **Game ID** per fixture, for SMS/USSD betting
- daily and weekly jackpots
- cash-out
- shareable booking codes

**What Vamos adds:**

- its accumulator bonus ladder, with transparent terms
- Amharic and English, with Afaan Oromo and Tigrinya prepared
- a payout status tracker
- Ethiopian Premier League and CAF coverage
- regulator-ready compliance

**Excluded by policy:**

- casino, crash and virtual games (not licensable under the current ELS stance)
- crypto
- agent/cash channels
- payouts to third-party wallets

## Operating modes

|                       | `demo` (default)      | `licensed`                                          |
| --------------------- | --------------------- | --------------------------------------------------- |
| Money                 | Demo ETB (play money) | Real ETB                                            |
| Payments              | `mock` only           | Real providers (telebirr, CBE Birr, M-Pesa, Chapa…) |
| KYC / SMS / odds feed | mock                  | Real providers                                      |
| Startup               | Always allowed        | Refused unless all the conditions below are met     |

**Licensed-mode startup conditions:**

- an ELS licence number is set
- regulator reporting is enabled
- real payment, KYC, SMS and feed providers are configured
- the tax configuration is confirmed

The guard is `licensedModeViolations()` in `packages/config/src/config.ts`. Both the API and the worker call `loadConfig()` at startup.

## Runtime topology

```
          ┌───────────────┐      ┌────────────────┐
 phones → │ apps/web (PWA)│      │ apps/admin     │ ← staff (RBAC + TOTP)
          └──────┬────────┘      └──────┬─────────┘
                 │ HTTPS (REST + SSE)    │
                 ▼                       ▼
          ┌─────────────────────────────────────┐
          │ apps/api (Fastify)                  │
          │ auth · wallet · catalog · betting · │
          │ payments · jackpots · admin · ussd  │
          └──────┬───────────────┬──────────────┘
                 │ SQL           │ pub/sub, queues, rate limits
                 ▼               ▼
          ┌────────────┐   ┌──────────┐
          │ PostgreSQL │   │  Redis   │
          └─────▲──────┘   └────▲─────┘
                │               │
          ┌─────┴───────────────┴──────────────┐
          │ apps/worker (BullMQ)               │
          │ feed ingest · live simulator ·     │
          │ settlement · payouts · SMS ·       │
          │ ELS reporting · reconciliation     │
          └────────────────────────────────────┘
```

## Core conventions

- **Money:** `bigint` **santim** (1 ETB = 100 santim) in code and `BIGINT` in SQL. The `pg` driver parses `int8` as `BigInt`. On the wire, amounts are decimal strings. Payouts are always rounded down.
- **Odds:** integer **milli** (1.85 → `1850`). The product of leg odds is computed in integer arithmetic.
- **Ledger:** double-entry.
  - Every money movement is one `ledger_transaction`, and its `ledger_entries` sum to zero.
  - Balances are cached on `ledger_accounts.balance` and changed only in the same database transaction as the entries, using a guarded `UPDATE … WHERE balance >= amount`.
  - A reconciliation job checks cached balances against the entry sums.
- **Outbox:** business events (bet placed or settled, deposit, payout, tax withheld) are written to `outbox_events` in the same transaction. The worker turns them into regulator reports, SMS and audit records.
- **Idempotency:** bet placement, deposits, payouts and provider webhooks each require an idempotency key, enforced by unique constraints.
- **Validation:** all API input is parsed with zod contracts from `packages/contracts` using `parseInput()`. Failures return `400 validation_error`.
- **Errors:** handlers throw `AppError` (`apps/api/src/lib/errors.ts`). Clients always receive `{ error: { code, message, details? } }`.
- **Real-time:** odds and score changes go over Server-Sent Events with compact deltas, which keeps traffic low on mobile networks.

## Business defaults

All of these are editable in the back office and must be confirmed with counsel before a licensed launch.

| Setting            | Default                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Minimum stake      | 5 ETB                                                                 |
| Max legs per bet   | 40                                                                    |
| Max payout per bet | 500,000 ETB                                                           |
| Live bet delay     | 6 s                                                                   |
| Cash-out margin    | 5%                                                                    |
| Minimum age        | 21                                                                    |
| Winnings tax       | 20% of gross payout (rate, base and exemption threshold configurable) |
| Multi-bonus ladder | 3 legs 3% … 30 legs 200% on winnings; each leg ≥ 1.30; bonus capped   |
| Daily jackpot      | 9 games, 10 ETB per combination                                       |
| Weekly jackpot     | 13 games, 10 ETB per combination                                      |

## Testing

- `packages/core`: unit tests plus fast-check property tests (money invariants).
- `apps/api`, `apps/worker`: integration tests against a real PostgreSQL. `createTestDatabase()` creates a throwaway migrated database per test file.
- `e2e`: Playwright on a Pixel 5 profile against the running stack.
