# Nahubet

A mobile-first sportsbook for the Ethiopian market, modelled on **Betika**. It is lightweight on data, pays through mobile money, uses low stakes, and offers football accumulators, daily and weekly jackpots, live betting and cash-out. It adds Nahubet's own accumulator bonus ladder, Amharic and other Ethiopian languages, and compliance built into the core.

> **Demo mode by default.** Nahubet runs as a **play-money demo** (`OPERATING_MODE=demo`):
>
> - only simulated odds and mock payment, KYC and SMS providers
> - a permanent "DEMO" banner on the site
>
> `OPERATING_MODE=licensed` refuses to start unless all of these are configured: real payment, KYC, SMS and odds providers, and confirmed tax settings.
>
> See [`docs/research`](docs/research) for the market analysis behind these decisions.

## Branches: which one is the latest

- **The default branch (`claude/quirky-ramanujan-xb7e2u`) is the latest safe version.** Work is merged
  into it only through a pull request, and only once CI (lint, typecheck, unit and integration tests, the
  end-to-end suite and the Docker build) has passed on it. Start new work from it.
- Work happens on `claude/*` branches. The one being merged next has an open pull request into the
  default branch; GitHub merges it by itself when CI passes (auto-merge), so nothing unsafe lands.
- What runs on the server, and how to deploy or roll back, is in [`HANDOFF.md`](HANDOFF.md).
- Older `claude/*` branches are history: their work is either in the default branch or superseded.

## Repository layout

| Path                 | What it is                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/api`           | Fastify REST + SSE API (port 4000)                                                             |
| `apps/worker`        | Background workers: feed ingest, live simulator, settlement, payouts, notifications, reporting |
| `apps/scraper`       | Data scraper process (port 4200): fetch, parse, safety gates, promotion; onboarding CLI        |
| `packages/scraper`   | Pure scraper toolkit, no database: adapters, name matching, polite fetcher, gates              |
| `apps/web`           | Player PWA (port 3000): Betika-style lite UI, Amharic/English                                  |
| `apps/admin`         | Back office (port 3001): trading, risk, KYC, finance, compliance                               |
| `packages/core`      | Pure domain logic: money, odds, betslip, multi-bonus, tax, cash-out, jackpots                  |
| `packages/db`        | Drizzle ORM schema, migrations, seed                                                           |
| `packages/contracts` | Zod request/response contracts shared by API and front ends                                    |
| `packages/feed`      | Odds feed interface + mock Poisson pricing / live match simulator                              |
| `packages/i18n`      | UI messages: am, en, om, ti                                                                    |
| `packages/config`    | Runtime configuration and the operating-mode guard                                             |
| `e2e`                | Playwright end-to-end tests                                                                    |
| `infra`              | dev + production docker-compose, Dockerfile, env template, backup and dev services scripts     |
| `scripts`            | `smoke.sh`: smoke test for any deployment URL                                                  |

See [`docs/architecture.md`](docs/architecture.md) for the design, and [`docs/scraper-operations.md`](docs/scraper-operations.md) for the data scraper.

## Getting started

Requirements: Node 22.13+, pnpm 10, plus either Docker or local PostgreSQL 16 and Redis 7.

```bash
pnpm install
cp .env.example .env

# Services: native (no Docker)…
pnpm services:start
# …or with Docker (it publishes Postgres on 5433: set DATABASE_URL in .env to localhost:5433)
docker compose -f infra/docker-compose.yml up -d

pnpm db:migrate
pnpm db:seed
pnpm dev          # api :4000, worker, web :3000
```

To try the data scraper with real Premier League data (games, odds, a trader opening betting), follow
[`docs/scraper-local-test.md`](docs/scraper-local-test.md).

To test on your laptop and on several phones on the same Wi-Fi, follow
[`docs/testing-with-phones.md`](docs/testing-with-phones.md).

## Quality checks

```bash
pnpm lint
pnpm typecheck
pnpm test         # unit + integration (needs Postgres and Redis running)
pnpm build
pnpm e2e          # Playwright, against a running dev stack
```

CI (`.github/workflows/ci.yml`) runs the same checks with Postgres and Redis service containers on every push
(not for changes to documentation only). The slow jobs, end-to-end and `docker` (builds the production images,
boots the compose stack and runs `scripts/smoke.sh`), run on pushes to the default branch and on demand
(Actions → CI → Run workflow), to stay within the free runner minutes.

## Deployment

Production images and the compose stack are described in [`docs/deployment.md`](docs/deployment.md);
backups in [`docs/backups.md`](docs/backups.md); incident procedures in [`docs/runbooks/`](docs/runbooks/README.md).

```bash
infra/scripts/init-env.sh && $EDITOR infra/.env.prod      # secrets are generated for you
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
docker compose build && docker compose up -d --wait
scripts/smoke.sh --production --worker http://localhost:4100
```

## Build phases

1. **Phase 0:** foundation (this scaffold)
2. **Phase 1:** domain core
3. **Phase 2:** accounts, KYC, responsible gambling, wallet ledger
4. **Phase 3:** sports catalogue, odds feed, trading
5. **Phase 4:** betslip, bet placement, settlement
6. **Phase 5:** player web app (MVP)
7. **Phase 6:** payments (deposits and withdrawals)
8. **Phase 7:** live betting and cash-out
9. **Phase 8:** jackpots and promotions
10. **Phase 9:** back office
11. **Phase 10:** regulator reporting and AML
12. **Phase 11:** SMS/USSD channel
13. **Phase 12:** hardening and deployment
