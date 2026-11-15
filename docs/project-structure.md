# Project structure

Vamos Betting is a pnpm monorepo (Node 22, pnpm 10, TypeScript). Apps sit in `apps/`, shared libraries in `packages/`.

```
vamos betting/
├── apps/
│   ├── api/                 @vamos/api      REST + SSE API (Fastify), :4000
│   │   ├── src/modules/     admin, auth, betting, catalog, channels, dev, jackpots,
│   │   │                    kyc, me, payments, rg, stream, wallet
│   │   └── test/
│   ├── worker/              @vamos/worker   background jobs
│   │   ├── src/tasks/       bet-acceptance, compliance, deposit-reconcile, feed-ingest,
│   │   │                    jackpots, live-sim, outbox-dispatch, payouts, prematch-drift,
│   │   │                    retention-prune, settlement, sms-notify, smsrail,
│   │   │                    user-notify, ussd-prune
│   │   └── test/
│   ├── web/                 @vamos/web      player PWA (Next.js), :3000
│   │   ├── src/             pages, components, lib
│   │   └── public/
│   └── admin/               @vamos/admin    back office (Next.js), :3001
│       └── src/             trading, risk, KYC, finance, compliance, SMS rail, manual payouts
│
├── packages/
│   ├── core/                @vamos/core       pure domain logic, no I/O: money, odds, betslip,
│   │                                          bonus, tax, cash-out, jackpot, AML, SMS parsing
│   ├── db/                  @vamos/db         Drizzle schema, migrations, seed, money-writing services
│   │   ├── src/schema/      accounts, betting, catalog, channels, compliance, enums,
│   │   │                    jackpots, ledger, payments, platform, smsrail
│   │   ├── migrations/      SQL migrations 0000-0034 + meta snapshots
│   │   └── test/            integration tests (real Postgres)
│   ├── contracts/           @vamos/contracts  zod request/response contracts (api, web, admin)
│   ├── payments/            @vamos/payments   provider adapters (mock, Chapa, telebirr, SMS rail),
│   │                                          receipt verifier; no database
│   ├── feed/                @vamos/feed       odds feed interface, mock Poisson pricing, live simulator
│   ├── config/              @vamos/config     env loading, operating-mode (demo / licensed) guard
│   └── i18n/                @vamos/i18n       Amharic, English, Afaan Oromo, Tigrinya
│
├── e2e/                     @vamos/e2e      Playwright (mobile Chromium)
│   ├── tests/               admin, bet-flow, budget, channels, compliance, jackpot,
│   │                        live-cashout, payments-flow, smoke, sms-rail
│   ├── scripts/stack.sh     production-like stack for e2e
│   └── deployment/
│
├── infra/
│   ├── docker/              Dockerfile
│   ├── caddy/               reverse proxy config
│   ├── scripts/             backup, restore-drill, init-env, dev-services
│   ├── docker-compose.yml        local Postgres + Redis
│   ├── docker-compose.prod.yml   production stack
│   └── env.prod.example          production env template (licensed mode)
│
├── docs/
│   ├── architecture.md, build-plan.md, deployment.md, channels.md,
│   │   backups.md, load-testing.md, project-structure.md
│   ├── runbooks/            sms-rail, payouts-stuck-or-flagged, aml-flag-review,
│   │                        reconciliation-mismatch, restore-from-backup,
│   │                        rotating-secrets, incident-basics
│   ├── plans/               design plans (e.g. Melabingo payments port)
│   └── research/            market research
│
├── scripts/                 load tests, SBOM generator, smoke.sh
├── .github/                 CI workflows
├── .env.example             local development environment
├── CLAUDE.md                project rules for Claude Code
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js,
│   .prettierrc.json, .editorconfig, .nvmrc
└── README.md
```

## How the pieces depend on each other

```
web, admin ──► contracts ◄── api ──► db ──► core
                              │       ▲
                              ▼       │
                          payments    worker ──► feed
                              ▲
                     config, i18n (used throughout)
```

- `core` is pure and depends on nothing; every other package may use it.
- Only `db` writes money (ledger, outbox) and only inside one DB transaction.
- `api` and `worker` are separate processes sharing the same database and Redis.
- `web` and `admin` talk to `api` only, using types from `contracts`.
