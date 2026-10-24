# Deployment guide

How to run Vamos Betting in production: the images, the compose stack, configuration, the licensed-mode
checklist and operations. Day-to-day procedures are in [`runbooks/`](runbooks/README.md), backups in
[`backups.md`](backups.md). Nothing here is legal advice; items marked **to confirm** need counsel or the
regulator.

> **Operating mode.** `OPERATING_MODE=demo` (play money, mock providers) is the default and the only mode
> that can run today: all Ethiopian betting licences were revoked on 15 Dec 2025 and real money needs an
> Ethiopian Lottery Service (ELS) licence. `licensed` mode refuses to start unless every prerequisite below
> holds. Never weaken that guard (`packages/config/src/config.ts`).

## 1. Architecture

```
 players ──► reverse proxy / load balancer (TLS) ──► web   :3000  (Next.js + brotli, apps/web/server.mjs)
 staff   ──►        (Caddy profile or your own)  ──► admin :3001  (Next.js back office)
 browsers, providers' webhooks ───────────────────► api   :4000  (Fastify: REST + SSE)
                                                       │  │
                              ┌────────────────────────┘  └──────────────┐
                         PostgreSQL 16 (system of record)           Redis 7 (pub/sub, BullMQ queues,
                              ▲                                      rate limits)
                              └────────────── worker :4100 (health only) ┘
                                  feed, live simulator, settlement, payouts, SMS, ELS reporting,
                                  reconciliation, AML; writes the ELS reports to a volume
```

| Service    | Image target | Port   | State                                | Notes                                                                           |
| ---------- | ------------ | ------ | ------------------------------------ | ------------------------------------------------------------------------------- |
| `postgres` | postgres:16  | 5432   | volume `pgdata`, WAL archive `pgwal` | Never published. The ledger, audit log and all business rows.                   |
| `redis`    | redis:7      | 6379   | volume `redisdata` (AOF)             | Never published. Password, `noeviction` (BullMQ needs it).                      |
| `migrate`  | `api`        | none   | none                                 | One-shot job: `node dist/ops/migrate.js`, runs before the api and worker start. |
| `api`      | `api`        | 4000   | none (stateless)                     | `/health`. Reads the ELS volume read-only for the compliance status page.       |
| `worker`   | `worker`     | 4100   | volume `els` (writer)                | `/health`, `/ready`. Run **one** instance (the ELS writer owns the directory).  |
| `web`      | `web`        | 3000   | none                                 | Player PWA. `NEXT_PUBLIC_API_URL` is baked in at build time.                    |
| `admin`    | `admin`      | 3001   | none                                 | Back office. Must be on a different origin from the web app.                    |
| `proxy`    | caddy:2      | 80/443 | volumes `caddy_*`                    | Optional (`--profile proxy`): automatic TLS for three host names.               |

The images are built from one Dockerfile (`infra/docker/Dockerfile`): multi-stage, `pnpm fetch` for a cached
dependency layer, production-only `pnpm install --prod` per service, `node:22-alpine`, non-root user
`node`, a `HEALTHCHECK` in every image. The api and worker are bundled by tsup (workspace packages inlined),
so their images hold only `dist/` and the external npm packages (about 320 MB). The `api` image also carries
the operations scripts (`dist/ops/{migrate,seed,admin-create,admin-unlock}.js`) and the SQL migrations.

## 2. Environments

| Environment       | Mode / `NODE_ENV`         | Use                                                                                                                                                                                                        |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local development | `demo` / `development`    | `pnpm services:start && pnpm dev` (README). Dev OTP inbox, demo staff, fast simulator knobs.                                                                                                               |
| CI / e2e          | `demo` / `development`    | `.github/workflows/ci.yml`: checks, e2e, and the `docker` job (compose build, boot, `scripts/smoke.sh`).                                                                                                   |
| Demo / staging    | `demo` / `production`     | The compose stack below. Play money, mock providers. Needs unique secrets and https URLs, **no OTP inbox**: sign-ups cannot receive their code unless you set `NODE_ENV=development` (private demos only). |
| Production        | `licensed` / `production` | Only with an ELS licence and every item of section 4.                                                                                                                                                      |

A database belongs to one mode for life: both the api and the worker `claimOperatingMode` at startup and
refuse to run a demo database as licensed (or the reverse). Never point a licensed deployment at a demo
database, and never copy production data into a lower environment.

## 3. Deploying the compose stack

Requirements: a Linux host with Docker Engine 25+ and the compose plugin (v2.20+, for `up --wait`), 2 vCPU / 4 GB RAM minimum for the demo, a disk with room for the
database, WAL archive, ELS reports and backups.

```bash
# 1. Configuration. Review every value; the generator only fills the secrets.
infra/scripts/init-env.sh                      # creates infra/.env.prod (mode 600, git-ignored)
$EDITOR infra/.env.prod                        # public URLs, mode, providers (section 5)

# 2. One shell variable pair makes every later command shorter.
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod

# 3. Build, start, check.
docker compose build                           # api, worker, web, admin (web/admin bake in PUBLIC_API_URL)
docker compose up -d --wait                    # postgres + redis -> migrate -> api + worker -> web + admin
scripts/smoke.sh --production --worker http://localhost:4100

# 4. First data.
docker compose run --rm migrate node dist/ops/seed.js        # demo catalogue/settings (idempotent)
docker compose run --rm -e ADMIN_PASSWORD='<12+ chars>' migrate \
  node dist/ops/admin-create.js --email you@example.et --name "Your Name" --role admin
```

Validated on 2026-10-19 with Docker Engine 29.8 (all four images built, stack booted, `scripts/smoke.sh
--production --worker http://localhost:4100` passed 13 checks, `/ready` on the API skipped as 404 at that
time). The Caddy proxy profile and a restore from the dumps were not exercised in that run.

`admin-create` prints the TOTP enrolment (scan the `otpauth://` URI); without `ADMIN_PASSWORD` it generates a
password that must be changed at first sign-in. The demo staff accounts (`<role>@demo.vamos.test`) exist only
in demo mode and only when `NODE_ENV` is not `production`.

**Upgrades.** `git pull`, `docker compose build`, `docker compose up -d --wait`. The `migrate` job reruns
first (migrations are forward-only and idempotent). Take a [dump](backups.md) before any release that adds
migrations. Rolling back code is safe only while no new migration was applied; otherwise restore
(runbook: [restore from backup](runbooks/restore-from-backup.md)). Keep image tags per release:
`VAMOS_VERSION=2026.10.1 docker compose build`.

**Reverse proxy and TLS.** Production URLs must be `https` (the config refuses plain http outside
loopback: session cookies are `Secure`). Either:

- `docker compose --profile proxy up -d` with `WEB_DOMAIN`, `API_DOMAIN`, `ADMIN_DOMAIN`, `ACME_EMAIL` set
  and `TRUST_PROXY=<VAMOS_SUBNET>` (default `172.30.77.0/24`): Caddy obtains certificates automatically
  (needs ports 80/443 and DNS for the three names), flushes SSE responses, and the api then reads the real
  client address from `X-Forwarded-For`; or
- your own load balancer / CDN: point it at the loopback-published ports (`BIND_ADDRESS`), terminate TLS
  there, forward `X-Forwarded-For`, disable response buffering for `/live/stream` and `/me/stream` (SSE), and
  set `TRUST_PROXY` to its addresses/CIDRs. `TRUST_PROXY=true` and hop counts are refused on purpose: a
  client could otherwise pick its own address and escape every per-address rate limit.

Use separate host names for web, admin and api (`ADMIN_WEB_URL` must differ from `PUBLIC_WEB_URL`; CORS for
`/admin/*` allows only `ADMIN_WEB_URL`). Restrict the admin host to a VPN or an IP allowlist if you can.

**Scaling.**

- `api` is stateless (sessions in Postgres, rate limits and live fan-out in Redis): run more replicas behind
  the balancer (drop the host port mapping and give each replica its own service entry or use an
  orchestrator).
- `web` and `admin` are stateless Next.js servers; scale the same way.
- `worker`: keep **one** instance. Its tasks take advisory/Redis locks, but the ELS reporter writes plain files
  into one directory. Scale vertically; a second worker needs a design review first.
- `postgres`: a single primary. Size `max_connections` (set to 200 in the compose file) against
  api replicas x pool + worker pool (10). Read replicas are not used. Move to a managed or HA Postgres
  (streaming replication + failover) when the licence requires higher availability.
- Redis holds queues (BullMQ), pub/sub and rate-limit counters. Losing it loses queued jobs, not money:
  jobs are recreated from the outbox by sweeps. Use AOF (default here) anyway.

**Observability.** Logs are JSON (pino) with a request id (`x-request-id`, echoed in error bodies) and
redacted secrets; compose rotates them (20 MB x 5). Ship them with your agent of choice. Traces are exported
over OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Probes: api `GET /health`, worker `GET
:4100/health` and `/ready` (database, Redis, queues). Alert on: any container unhealthy or restarting,
`/ready` failing, payouts pending > 24 h (flagged in the back office), a reconciliation run with status
`mismatches` or `failed`, ELS pending records growing, disk below 20%, a failed backup.

## 4. Licensed-mode checklist

`OPERATING_MODE=licensed` is refused unless **all** of these hold (the exact messages come from
`licensedModeViolations` in `packages/config/src/config.ts` plus the api's own checks):

- [ ] An ELS licence exists and `ELS_LICENSE_NUMBER` is set.
- [ ] `NODE_ENV=production`; `PUBLIC_WEB_URL`, `ADMIN_WEB_URL`, `PUBLIC_API_URL` are https and the admin
      origin differs from the web origin.
- [ ] Unique `SESSION_SECRET` (32+ chars), `ADMIN_TOTP_KEY` (32 bytes), and no development default left in any
      secret of a feature that is on.
- [ ] `ELS_REPORTING_MODE=file` with an absolute `ELS_REPORT_DIR` on a durable, **backed-up** volume (the
      compose file mounts the `els` volume at `/var/lib/vamos/els`). `off` and the `http` placeholder are
      refused until ELS publishes its interface. Reports are kept 7 years.
- [ ] `PAYMENT_PROVIDERS` lists only real providers (`chapa`, `telebirr`), each with its credentials; no
      `mock`. Webhook URLs registered with the providers point at `PAYMENT_CALLBACK_BASE_URL` (default
      `PUBLIC_API_URL`). `CHAPA_WEBHOOK_SECRET` is at least 32 characters. `PAYMENT_CALLBACK_BASE_URL`,
      `CHAPA_BASE_URL`, `TELEBIRR_BASE_URL`, `TELEBIRR_CHECKOUT_URL` and `ELS_REPORT_URL` are https whenever set
      (plain http is refused, even on loopback).
- [ ] `KYC_PROVIDER` is a real identity provider (`fayda`), `SMS_PROVIDER` a real gateway (`http`).
- [ ] `FEED_PROVIDER=manual` (traders only) or a licensed real feed once an adapter exists; `mock` is refused.
- [ ] `TAX_CONFIG_CONFIRMED=true`, set only after counsel confirmed the winnings-tax rate, base and exemption
      (and the `els_commission` rate in the back-office settings).
- [ ] `FEATURE_CASINO=false`, `FEATURE_VIRTUALS=false` (not licensable). SMS/USSD betting stays off until the
      regulator approves the channel and a real aggregator is contracted (the mock aggregators are refused).
- [ ] Operational readiness (not enforced by code): backups running and a restore drill passed in the last
      30 days; the runbooks reviewed by the on-call staff; the admin host restricted; staff accounts created
      with TOTP; responsible-gambling limits and age rule (21) reviewed; data residency decided (below);
      secrets in a secret manager (below); alerts wired.

## 5. Configuration reference

Variables are read by `@vamos/config` (`loadConfig`) in the api, worker and the ops scripts, unless noted.
The compose file passes them from `infra/.env.prod`; the template with comments is
[`infra/env.prod.example`](../infra/env.prod.example) (derived from `.env.example`). "Secret" values belong
in a secret manager, not in git.

**Core**

| Variable                                           | Default                        | Meaning                                                                                                   |
| -------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                         | `development`                  | `production` enables Secure cookies, hides dev routes and the OTP inbox, and refuses development secrets. |
| `OPERATING_MODE`                                   | `demo`                         | `demo` or `licensed` (section 4).                                                                         |
| `LOG_LEVEL`                                        | `info`                         | pino level: fatal, error, warn, info, debug, trace, silent.                                               |
| `API_HOST` / `API_PORT`                            | `0.0.0.0` / `4000`             | api listen address (the image fixes 4000).                                                                |
| `PUBLIC_API_URL`                                   | `http://localhost:4000`        | Public api URL. Also baked into web/admin at build time (`NEXT_PUBLIC_API_URL`). https in production.     |
| `PUBLIC_WEB_URL` / `ADMIN_WEB_URL`                 | `:3000` / `:3001` on localhost | Public origins (CORS, cookies, redirects). Must differ; https in production.                              |
| `PAYMENT_CALLBACK_BASE_URL`                        | `PUBLIC_API_URL`               | Base URL providers call for webhooks. Leave **unset** (not empty) to use the default.                     |
| `TRUST_PROXY`                                      | empty (nobody)                 | Proxy addresses/CIDRs whose `X-Forwarded-For` sets the client IP. `true` and hop counts are refused.      |
| `WORKER_HEALTH_HOST` / `WORKER_HEALTH_PORT`        | `0.0.0.0` / `4100`             | Worker `/health` and `/ready` server (`0` turns it off).                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | unset                          | Tracing is on only when the endpoint is set; the name defaults to `vamos-api` / `vamos-worker`.           |

**Data stores and secrets**

| Variable                               | Default                                                   | Meaning                                                                                                           |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | local dev URL                                             | Postgres URL. Compose builds it from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.                         |
| `REDIS_URL`                            | local dev URL                                             | Redis URL. Compose builds it from `REDIS_PASSWORD`.                                                               |
| `QUEUE_PREFIX`                         | `vamos`                                                   | Key prefix of the BullMQ queues. Change only with an empty queue.                                                 |
| `SESSION_SECRET` (secret)              | dev value (refused in production)                         | 32+ chars. Keys OTP hashes and the national-ID hash that stops one ID opening two accounts. See rotation runbook. |
| `ADMIN_TOTP_KEY` (secret)              | dev key (refused in production)                           | 32 bytes as 64 hex chars or base64. AES-256-GCM key of the staff TOTP secrets. See rotation runbook.              |
| `MOCK_PAYMENT_WEBHOOK_SECRET` (secret) | dev value (refused in production while `mock` is enabled) | HMAC key of the mock provider's webhooks (demo only).                                                             |

**Feed and simulator (demo)**

| Variable                                                      | Default     | Meaning                                                                  |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `FEED_PROVIDER`                                               | `mock`      | `mock` (simulated pricing, live simulator; demo only) or `manual`.       |
| `SIM_SPEED`                                                   | `1`         | Simulated match minutes per real second.                                 |
| `FEED_ROLLING_EVERY_MINUTES` / `FEED_ROLLING_HORIZON_MINUTES` | `5` / `120` | Rolling demo fixtures: one kicks off every N minutes, up to the horizon. |

**Providers and payments**

| Variable                                                                                           | Default              | Meaning                                                                                      |
| -------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDERS`                                                                                | `mock`               | Comma list: `mock` (demo only), `chapa`, `telebirr`.                                         |
| `KYC_PROVIDER` / `SMS_PROVIDER`                                                                    | `mock` / `mock`      | `mock` or `fayda`; `mock` or `http`. Real ones are licensed-mode only.                       |
| `CHAPA_BASE_URL`, `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`                                       | Chapa API URL, unset | Chapa credentials (secrets). The webhook secret is 32+ chars, also set in Chapa's dashboard. |
| `TELEBIRR_BASE_URL`, `TELEBIRR_CHECKOUT_URL`                                                       | unset                | telebirr endpoints. Leave unset, not empty.                                                  |
| `TELEBIRR_FABRIC_APP_ID`, `TELEBIRR_APP_SECRET`, `TELEBIRR_MERCHANT_APP_ID`, `TELEBIRR_SHORT_CODE` | unset                | telebirr merchant credentials (secrets).                                                     |
| `TELEBIRR_PRIVATE_KEY`, `TELEBIRR_PUBLIC_KEY`                                                      | unset                | PEM keys; `\n` in the value is read as a newline.                                            |

**Regulator, tax and features**

| Variable                                             | Default         | Meaning                                                                                                                                                                             |
| ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ELS_LICENSE_NUMBER`                                 | unset           | Required in licensed mode. Leave unset, not empty.                                                                                                                                  |
| `ELS_REPORTING_MODE`                                 | `file`          | `file` (JSONL stream + daily CSVs), `http` (placeholder: sends nothing), `off` (demo only). The legacy `ELS_REPORTING=disabled\|file\|http` is still read; setting both must agree. |
| `ELS_REPORT_DIR`                                     | `./var/els`     | Report directory; absolute in licensed mode. Compose fixes `/var/lib/vamos/els` (volume `els`).                                                                                     |
| `ELS_REPORT_URL`                                     | unset           | For the `http` placeholder only.                                                                                                                                                    |
| `TAX_CONFIG_CONFIRMED`                               | `false`         | Licensed mode requires `true` (counsel confirmed the winnings-tax settings).                                                                                                        |
| `FEATURE_CASINO`, `FEATURE_VIRTUALS`                 | `false`         | Not licensable; licensed mode refuses `true`.                                                                                                                                       |
| `SMS_BETTING_ENABLED`, `USSD_ENABLED`                | `false`         | SMS/USSD betting channels (legacy `FEATURE_SMS_BETTING`, `FEATURE_USSD`). Routes answer 404 while off.                                                                              |
| `SMS_AGGREGATOR`, `USSD_AGGREGATOR`                  | `mock`          | Only `mock` exists until an aggregator is contracted; licensed mode refuses it while the channel is on.                                                                             |
| `SMS_WEBHOOK_SECRET`, `USSD_SHARED_SECRET` (secrets) | dev values      | Inbound authentication of the channels. Production refuses the dev values while the channel is on; compose requires them to be set.                                                 |
| `SMS_SHORT_CODE`, `USSD_SERVICE_CODE`                | `8123`, `*123#` | Shown to players.                                                                                                                                                                   |

**Read only by the web and admin apps / the ops scripts**

| Variable                                                                                                    | Where                  | Meaning                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                                                                                       | web, admin (build arg) | Browser-visible api URL, inlined at **build** time. Compose passes `PUBLIC_API_URL`; rebuild after changing it. |
| `NEXT_PUBLIC_OPERATING_MODE`                                                                                | admin (build arg)      | `licensed` hides the demo banner. Cosmetic: the api's mode is what counts.                                      |
| `API_INTERNAL_URL`                                                                                          | web (runtime)          | Private api URL for server-side rendering (`http://api:4000` in compose).                                       |
| `PORT`, `HOST`                                                                                              | web, admin             | Listen port (and address for `server.mjs`).                                                                     |
| `ADMIN_PASSWORD`                                                                                            | `admin-create.js`      | Initial password of a new staff account (12+ chars); generated when unset.                                      |
| `BIND_ADDRESS`, `API_PORT`, `WEB_PORT`, `ADMIN_PORT`, `WORKER_HEALTH_PORT`, `VAMOS_SUBNET`, `VAMOS_VERSION` | compose only           | Published addresses/ports, the stack's network, the image tag.                                                  |

## 6. Secrets management

- `infra/.env.prod` is git-ignored and created with mode 600; treat it as the secret store of a single host,
  not as a long-term solution. Prefer injecting the same variables from a secret manager (Vault, a cloud
  secret store, SOPS/age-encrypted files, or your orchestrator's secrets) at deploy time.
- Generate secrets with `openssl rand -hex 32`; use hex for passwords that go into URLs.
- Give each environment its own secrets. Production secrets are readable only by the deploy account and the
  on-call leads; store a sealed copy of `ADMIN_TOTP_KEY` and `SESSION_SECRET` with the backups' keys: a
  database restore is useless for staff sign-in without the matching `ADMIN_TOTP_KEY`.
- Payment, KYC and SMS provider credentials belong to the licence holder; rotate them with the provider and
  update the secret store, then restart `api` and `worker`.
- Procedures for each secret: [rotating secrets](runbooks/rotating-secrets.md).

## 7. Hosting in Ethiopia and data residency (to confirm)

Open questions for counsel and the regulator **before** any real-money launch:

1. **PDPP residency.** Does the Personal Data Protection Proclamation (and any ELS licence condition)
   require personal data of Ethiopian players, and the ELS report files, to stay in Ethiopia, or is a
   transfer abroad allowed with safeguards or consent? Does the ELS require real-time access to the
   transaction stream on infrastructure it can inspect?
2. **What counts as personal data here.** Phone numbers, names, KYC fields (Fayda ID hash, last four digits,
   date of birth), bank/wallet identifiers, IP addresses in the audit log, and the pseudonymous `playerRef`
   in the ELS stream. The ELS stream already minimises: no names, phones or free text.
3. **In-country hosting options** to evaluate: colocation or cloud capacity in an Addis Ababa data centre
   (national carrier or local provider) versus a regional cloud. Weigh latency to mobile networks,
   bandwidth cost, power and uplink redundancy, the ability to run Docker/PostgreSQL with backups, and
   whether payment/KYC/SMS partners need private links or IP allowlists. Everything in this repository is
   plain Docker and PostgreSQL, so it moves between hosts without code changes.
4. **Backups and logs** are personal data too: keep copies where the residency decision allows, and encrypt
   them (`BACKUP_AGE_RECIPIENT` in `backup.sh`).
5. **Retention.** Ledger, audit log, ELS reports and summaries: 7 years (placeholder in
   `docs/compliance.md`, to confirm). Player PII is removed or anonymised on account closure once retention
   duties allow.
6. **Provider callbacks** from telebirr/Chapa must reach `api` from the internet (or a provider VPN): plan the
   public IP, allowlists and the clock (NTP) of the host.

Until these are answered, run only the demo, with no real player data.
