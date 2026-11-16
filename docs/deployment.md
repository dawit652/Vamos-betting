# Deployment guide

How to run Nahubet in production: the images, the compose stack, configuration, the licensed-mode
checklist and operations. Day-to-day procedures are in [`runbooks/`](runbooks/README.md), backups in
[`backups.md`](backups.md). Nothing here is legal advice; items marked **to confirm** need counsel or the
regulator.

> **Operating mode.** `OPERATING_MODE=licensed` (real money) is the default. Licensed mode refuses to start only
> with the `mock` payment provider; the rest of section 4 is a checklist you work through by hand, because a
> missing item is logged as a warning, not refused.

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
                                  feed, live simulator, settlement, payouts, SMS,
                                  reconciliation, AML
```

| Service    | Image target | Port   | State                                | Notes                                                                                                                                 |
| ---------- | ------------ | ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | postgres:16  | 5432   | volume `pgdata`, WAL archive `pgwal` | Never published. The ledger, audit log and all business rows.                                                                         |
| `redis`    | redis:7      | 6379   | volume `redisdata` (AOF)             | Never published. Password, `noeviction` (BullMQ needs it).                                                                            |
| `migrate`  | `api`        | none   | none                                 | One-shot job: `node dist/ops/migrate.js`, runs before the api and worker start. The only service that connects as the database owner. |
| `api`      | `api`        | 4000   | none (stateless)                     | `/health`.                                                                                                                            |
| `worker`   | `worker`     | 4100   | none                                 | `/health`, `/ready`. Run **one** instance.                                                                                            |
| `scraper`  | `scraper`    | 4200   | volume `scraper_archive`             | `/health`, `/ready`; not published. Raw snapshots in `/var/lib/vamos/scraper`. Run **one** instance.                                  |
| `web`      | `web`        | 3000   | none                                 | Player PWA. `NEXT_PUBLIC_API_URL` is baked in at build time.                                                                          |
| `admin`    | `admin`      | 3001   | none                                 | Back office. Must be on a different origin from the web app.                                                                          |
| `proxy`    | caddy:2      | 80/443 | volumes `caddy_*`                    | Optional (`--profile proxy`): automatic TLS for three host names.                                                                     |

**Database roles.** The api and worker connect as `vamos_app`, a role the migrations create (0030) with only
what the app needs: no superuser, owner of nothing, no `TRUNCATE`, and only `INSERT`/`SELECT` on the
append-only tables (ledger, audit log, cash-outs, reconciliation, PSP statements), so it can
neither rewrite them nor switch their triggers off (`session_replication_role` needs a superuser). The
owner (`POSTGRES_USER`, a superuser in the postgres image) is used only by the `migrate` job, which also sets
`vamos_app`'s login from `APP_DB_PASSWORD` on every run, and by the ops scripts run through it (seed,
admin-create, admin-unlock). Local development and the e2e stack keep using one owner role (`vamos`); to try
the app role locally: `APP_DB_PASSWORD=<16+ chars> pnpm db:migrate`, then start the api/worker with
`DATABASE_URL=postgres://vamos_app:<password>@localhost:5432/vamos`. A new append-only table must `REVOKE`
`UPDATE, DELETE` from `vamos_app` in its guard migration (`packages/db/test/app-role.test.ts` checks it).

The images are built from one Dockerfile (`infra/docker/Dockerfile`): multi-stage, `pnpm fetch` for a cached
dependency layer, production-only `pnpm install --prod` per service, `node:22-alpine`, non-root user
`node`, a `HEALTHCHECK` in every image. Every container runs with `no-new-privileges` and no capabilities
(postgres keeps the few its entrypoint needs, Caddy only `NET_BIND_SERVICE`); api, worker, web, admin, migrate
and the proxy have read-only root filesystems. The web and admin code is owned by root (the `node` user cannot
change it); only Next's cache directory is writable (a tmpfs in compose). The api and worker are bundled by tsup (workspace packages inlined),
so their images hold only `dist/` and the external npm packages (about 320 MB). The `api` image also carries
the operations scripts (`dist/ops/{migrate,seed,admin-create,admin-unlock,totp-rekey}.js`) and the SQL migrations.

## 2. Environments

| Environment       | Mode / `NODE_ENV`         | Use                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local development | `demo` / `development`    | `pnpm services:start && pnpm dev` (README). Dev OTP inbox, demo staff, fast simulator knobs.                                                                                                                                                                   |
| CI / e2e          | `demo` / `development`    | `.github/workflows/ci.yml`: checks on every push; e2e and the `docker` job (compose build, boot, `scripts/smoke.sh`) on the default branch and on demand.                                                                                                      |
| Demo / staging    | `demo` / `production`     | The compose stack below. Play money, mock providers. Needs unique secrets and https URLs. No SMS leaves the server: the sign-up code is shown on screen, deposits are approved on the simulated phone and withdrawals by staff in the back office (section 8). |
| Production        | `licensed` / `production` |                                                                                                                                                                                                                                                                |

A database belongs to one mode for life: both the api and the worker `claimOperatingMode` at startup and
refuse to run a demo database as licensed (or the reverse). Never point a licensed deployment at a demo
database, and never copy production data into a lower environment.

## 3. Deploying the compose stack

Requirements: a Linux host with Docker Engine 25+ and the compose plugin (v2.20+, for `up --wait`), 2 vCPU / 4 GB RAM minimum for the demo, a disk with room for the
database, WAL archive and backups.

```bash
# 1. Configuration. Review every value; the generator only fills the secrets.
infra/scripts/init-env.sh                      # creates infra/.env.prod (mode 600, git-ignored)
$EDITOR infra/.env.prod                        # public URLs, mode, providers (section 5)

# 2. One shell variable pair makes every later command shorter.
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod

# 3. Build, start, check.
docker compose build                           # api, worker, scraper, web, admin (web/admin bake in PUBLIC_API_URL)
docker compose up -d --wait                    # postgres + redis -> migrate -> api + worker + scraper -> web + admin
scripts/smoke.sh --production --worker http://localhost:4100

# 4. First data.
docker compose run --rm migrate node dist/ops/seed.js        # demo catalogue/settings (idempotent)
docker compose run --rm -e ADMIN_PASSWORD='<12+ chars>' migrate \
  node dist/ops/admin-create.js --email you@example.et --name "Your Name" --role admin
```

Validated on 2026-10-19 with Docker Engine 29.8 (all four images built, stack booted, `scripts/smoke.sh
--production --worker http://localhost:4100` passed 13 checks, `/ready` on the API skipped as 404 at that
time). The Caddy proxy profile and a restore from the dumps were not exercised in that run.

**Lost password or authenticator, or retiring an account.** The back office has no staff screen, and the
password reset by SMS needs a real SMS gateway, so recover a staff account from the server with `admin-reset`
(audited, refused for the only enabled admin when disabling):

```bash
docker compose run --rm -e ADMIN_PASSWORD='<12+ chars>' migrate node dist/ops/admin-reset.js --email you@example.et --action password
docker compose run --rm migrate node dist/ops/admin-reset.js --email you@example.et --action totp      # new authenticator key, shown once
docker compose run --rm migrate node dist/ops/admin-reset.js --email you@example.et --action disable   # or enable
```

`admin-create` prints the TOTP enrolment (scan the `otpauth://` URI); without `ADMIN_PASSWORD` it generates a
password that must be changed at first sign-in, within 72 hours (it stops working after that). The demo staff accounts (`<role>@demo.vamos.test`) exist only
in demo mode and only when `NODE_ENV` is not `production`.

**Upgrades.** `git pull`, `docker compose build`, `docker compose up -d --wait`. (Upgrading from a release
before the app role: add `APP_DB_PASSWORD=$(openssl rand -hex 16)` to `infra/.env.prod` first; compose refuses
to start without it. Upgrading from a release before the INSA readiness pass: add
`PASSWORD_PEPPER=$(openssl rand -hex 32)` the same way; existing password hashes are re-made with it at each
account's next sign-in.) The `migrate` job reruns
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
`/admin/*` allows only `ADMIN_WEB_URL`). Restrict the back office to a VPN or an IP allowlist if you can, and
restrict **both** halves of it: the admin host and the staff API, which is the `/admin` path prefix on the
**api** host (the back office calls it from the staff member's browser, so restricting only the admin host
leaves the staff API open). With the Caddy profile set `STAFF_ALLOWLIST` (space-separated IPs/CIDRs): Caddy
answers 403 to everyone else on `ADMIN_DOMAIN` and on `API_DOMAIN/admin*`. With your own balancer, apply the
same rule to both.

**The nahubet.com domain.** The domain is registered at Porkbun. On a server with the Caddy profile:

| Porkbun DNS record             | Points to                   | Setting                                                                     |
| ------------------------------ | --------------------------- | --------------------------------------------------------------------------- |
| `A` (host empty) `nahubet.com` | the server's public IPv4    | `WEB_DOMAIN=nahubet.com`, `PUBLIC_WEB_URL=https://nahubet.com`              |
| `A` `api.nahubet.com`          | the same IPv4               | `API_DOMAIN=api.nahubet.com`, `PUBLIC_API_URL=https://api.nahubet.com`      |
| `A` `admin.nahubet.com`        | the same IPv4               | `ADMIN_DOMAIN=admin.nahubet.com`, `ADMIN_WEB_URL=https://admin.nahubet.com` |
| URL forward `www.nahubet.com`  | `https://nahubet.com` (301) | none (Porkbun's URL forwarding, so Caddy needs no fourth name)              |

Delete Porkbun's default parking records (`ALIAS`/`CNAME` to `pixie.porkbun.com`) first, set `ACME_EMAIL`, and
rebuild the web and admin images after changing `PUBLIC_API_URL` (it is inlined at build time). Commented
examples are in [`infra/env.prod.example`](../infra/env.prod.example).

**Sharing the demo through a tunnel** (one public name for a stack running on a PC, no open ports): point the
tunnel's public name (for example `nahubet.com`) at the web app on `http://localhost:3000` and set, in `.env`,
`PUBLIC_WEB_URL=https://nahubet.com`, `PUBLIC_API_URL=https://nahubet.com/_api`,
`API_PROXY_TARGET=http://127.0.0.1:4000` and `DEV_ALLOWED_ORIGINS=nahubet.com`. The browser then reaches the
API through the site's own origin (`/_api`), so the session cookie stays same-site. With a Cloudflare tunnel
the domain's nameservers must be Cloudflare's (change them at Porkbun under Authoritative Nameservers), then
`cloudflared tunnel route dns <tunnel> nahubet.com`.

**The back office through the tunnel** (staff on other computers and phones): the back office forwards `/_api`
to the API too when it runs with `API_PROXY_TARGET`, so it works from any address it is opened at. Add a
second public name (`admin.nahubet.com`) pointing at `http://localhost:3001`, set
`ADMIN_WEB_URL=https://admin.nahubet.com`, and add `admin.nahubet.com` to `DEV_ALLOWED_ORIGINS` (under
`next dev`, a host that is not listed gets no live-reload connection and the page never starts). The public
API URL must be `https` so the staff cookie is `__Host-` with path `/` and reaches `/_api/admin`. Before
publishing it, put it behind **Cloudflare Access** (Zero Trust, free for up to 50 users: a self-hosted
application for `admin.nahubet.com`, allowing only the staff's email addresses), and block the staff API on
the player name with a WAF custom rule (`http.host eq "nahubet.com" and starts_with(http.request.uri.path,
"/_api/admin")` → Block): the player site's `/_api` forwards every path, `/admin` included.

**A worker that hangs.** Compose marks a worker whose `/health` stops answering as `unhealthy` and does
nothing else. `infra/scripts/worker-watchdog.sh`, run once a minute on the host, restarts it: after two
runs in a row that read `unhealthy` it runs `docker compose restart worker` and writes one error line with
`"alarm":"worker_restarted"` to stderr (so to the journal). It restarts nothing else, never more than once
in 10 minutes (inside that time it writes `worker_unhealthy` and leaves the worker alone: look at it), and
leaves a worker that is stopped, missing or still starting to Docker and to you. `worker_restart_failed`
(exit 1) means the restart command itself failed. Settings: `WATCHDOG_UNHEALTHY_CHECKS` (2),
`WATCHDOG_MIN_RESTART_GAP_SECONDS` (600), `WATCHDOG_STATE_FILE` (`/run/vamos-worker-watchdog.state`), and
`COMPOSE_FILE` / `COMPOSE_ENV_FILES` as for `backup.sh`. **Installing it is a manual step on the server**;
nothing in the stack installs it. For example, with the repository at `/opt/vamos`:

```ini
# /etc/systemd/system/vamos-worker-watchdog.service
[Unit]
Description=Restart the Vamos worker when it is unhealthy
[Service]
Type=oneshot
WorkingDirectory=/opt/vamos
ExecStart=/opt/vamos/infra/scripts/worker-watchdog.sh

# /etc/systemd/system/vamos-worker-watchdog.timer
[Unit]
Description=Check the Vamos worker every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

Then `systemctl daemon-reload && systemctl enable --now vamos-worker-watchdog.timer`, and read its lines
with `journalctl -u vamos-worker-watchdog`. The alert that tells a person is the outbox age on the api's
`/metrics` (Metrics, below): the watchdog only shortens the outage.

**Scaling.**

- `api` is stateless (sessions in Postgres, rate limits and live fan-out in Redis): run more replicas behind
  the balancer (drop the host port mapping and give each replica its own service entry or use an
  orchestrator).
- `web` and `admin` are stateless Next.js servers; scale the same way.
- `worker`: keep **one** instance. Its tasks take advisory/Redis locks; scale vertically, and review the
  design before running a second worker ([plans/worker-standby-design.md](plans/worker-standby-design.md)).
  Docker restarts a worker that crashed, not one that hangs: see "A worker that hangs" below.
- `scraper`: keep **one** instance. The source locks make a second harmless, but it only duplicates fetches
  (and requests to the sources). Its raw snapshots are the `scraper_archive` volume
  (`/var/lib/vamos/scraper`, `SCRAPER_ARCHIVE_DIR`): the evidence behind every applied result, kept as long as
  bets are kept and backed up by `backup.sh scraper` ([backups.md](backups.md)). Its port is not published; check
  it from the host with the container address, e.g.
  `scripts/smoke.sh --scraper "http://$(docker inspect -f '{{ (index .NetworkSettings.Networks "vamos_vamos").IPAddress }}' "$(docker compose ps -q scraper)"):4200"`.
  The service always runs with `FEED_PROVIDER=scraped`; in licensed mode that needs `SCRAPER_CONTACT` and
  `SCRAPER_ROBOTS=enforce` (docs/scraper.md section 7). Daily operation, kill switches and the evidence kept:
  [scraper-operations.md](scraper-operations.md); incident procedures in [runbooks](runbooks/README.md).
  The onboarding command line (sources, aliases, ratings) runs inside the scraper image, because Postgres is not
  published: `docker compose run --rm --no-deps scraper node dist/cli.js sources list` (files are mounted with
  `-v "$PWD/source.json:/in/source.json:ro"`; see [scraper.md](scraper.md#production)).
- `postgres`: a single primary. Size `max_connections` (set to 200 in the compose file) against
  api replicas x pool + worker pool (10). Read replicas are not used. Move to a managed or HA Postgres
  (streaming replication + failover) when the licence requires higher availability.
- Redis holds queues (BullMQ), pub/sub and rate-limit counters. Losing it loses queued jobs, not money:
  jobs are recreated from the outbox by sweeps. Use AOF (default here) anyway.

### Scaling out the API (opt-in overlay)

One API process is limited by its own CPU, not by the database (A6 of the scale plan measured it:
`docs/load-testing.md`, 15 Nov 2026). More processes are the lever. `infra/docker-compose.scale.yml`
runs several API replicas behind Caddy, with PgBouncer in front of Postgres. It is an overlay: it
adds a stateless `pgbouncer` service and changes only how `api` runs; the base file, its volumes and
the database are untouched (nothing starts on an empty volume).

```bash
# start (the same env file as the base stack; needs Docker Compose 2.24+)
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.scale.yml --profile proxy up -d
# 4 API replicas instead of the default 3, 3 web replicas instead of 2
API_REPLICAS=4 WEB_REPLICAS=3 docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.scale.yml --profile proxy up -d
# back to one API process: stop the extras and start with the base file alone
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.scale.yml stop pgbouncer
docker compose -f infra/docker-compose.prod.yml --profile proxy up -d --remove-orphans
```

- **PgBouncer** (`infra/pgbouncer`, `infra/docker/pgbouncer.Dockerfile`, Alpine's own package) pools in
  _transaction_ mode: a server connection is held for one transaction only, so `PGB_POOL_SIZE` (default 40) connections serve up to `PGB_MAX_CLIENT_CONN` (default 3000) client connections. The `vamos_app`
  role logs in through it (SCRAM). The worker, the scraper and the migrate job keep a direct
  connection to Postgres. Postgres' `max_connections` is 200; the pool plus those three stay far below it.
- **Why transaction pooling is safe here.** The API and the code it shares use only transaction-level
  advisory locks, no LISTEN, no session-level SET, no temporary tables and no held cursors. This is
  tested twice: `packages/db/test/pooling-safety.test.ts` fails if such a statement is added, and the
  whole `packages/db` (792 of 793 tests; the one failure is the `vamos_app` login test, whose role the
  test PgBouncer did not know) and `apps/api` (523 of 523) suites pass through PgBouncer in
  transaction mode (15 Nov 2026). **Keep it so**: a feature that needs session state must use the
  worker's direct connection.
- **API replicas** (`API_REPLICAS`, each with `API_DB_POOL_MAX` connections to PgBouncer, default 20)
  have no host port; Caddy (`infra/caddy/Caddyfile.scale`, mounted by the overlay) finds every replica
  by DNS (`dynamic a`, refreshed every 5 s) and sends a request to the one with the fewest connections.
  Any replica can serve any request: sessions are in Postgres, rate limits and the live fan-out in Redis.
  A live stream stays on the replica it opened on. `/metrics` is per process (see Metrics): scrape every
  replica. `DB_POOL_MAX` sets one process's pool in the base stack too.
- **Web replicas** (`WEB_REPLICAS`, default 2): one web process renders about 40 to 60 pages a second
  and was the first part to break in the load test (`docs/load-testing.md`, A1b), so the overlay runs
  several, also without a host port, balanced by Caddy the same way (`dynamic a web`). Pages hold no
  state between requests (each one asks the API), so any replica can serve any page.
- **What is not done**: the overlay was validated here by `docker compose config`, a native PgBouncer run
  of the real entrypoint (SCRAM login as `vamos_app`) and the test suites above; the Docker image build
  and `Caddyfile.scale` are validated by CI (`docker` job, or Actions → CI → Run workflow). The throughput
  gain of several replicas has **not** been measured: try it on staging with `pnpm load:bets --api <url>`
  before relying on it.

### Live streams on their own processes (opt-in overlay)

Open live streams (`GET /live/stream`, `GET /me/stream`) hold a connection each for minutes or hours.
`API_ROLE` lets them run on API processes of their own, so thousands of idle streams never share a
process (an event loop, a database pool) with bet placement. The same image and code run in every
role: `all` (the default, one process serves everything), `streams` (only `/health`, `/live/stream`
and `/me/stream`; `/me/stream` still checks the session cookie or bearer token) and `no-streams`
(everything else; the two stream paths answer 404). Whatever the roles, a session revoked on one
process ends the player's streams on every stream process (Redis announcement), and the worker's
live and player messages reach every process through Redis.

**The proxy must send the two stream paths to the stream processes**, and nothing else there: a
`streams` process answers 404 to every other path, a `no-streams` process to the two stream paths.
`infra/caddy/Caddyfile.streams` does this (a `handle @streams` for `/live/stream` and `/me/stream` to
`api-streams:4000`, flushed and with no read timeout; the rest to `api:4000`; the staff allowlist and
the `/metrics` 404 are handled first). With your own balancer: route those two paths to the stream
processes, give them an idle timeout of at least an hour (proxies often cut at 60 s; the clients
reconnect, but needlessly), and turn response buffering off for them.

`infra/docker-compose.streams.yml` is an overlay like the scale-out one: it adds the `api-streams`
service (the `api` service's image and settings with `API_ROLE=streams`, no host port,
`API_STREAMS_REPLICAS` processes, default 2; `nofile` raised to 65536; a pool of
`API_STREAMS_DB_POOL_MAX`, default 5, straight to Postgres), sets `API_ROLE=no-streams` on `api` and
mounts `Caddyfile.streams` in the proxy. It changes no volume, port or project name and starts
nothing on a new volume.

```bash
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.streams.yml --profile proxy up -d
# back to one process serving everything: start with the base file alone
docker compose -f infra/docker-compose.prod.yml --profile proxy up -d --remove-orphans
```

- Start it only with the proxy profile (or your own balancer routing the two paths): without a router, `api`
  refuses the stream paths. With the scale-out overlay too, list both files; its `Caddyfile.scale` mount
  and this overlay's both set the proxy's Caddyfile, so use `Caddyfile.streams` (copy its `handle`
  blocks into your scaled Caddyfile) and name the overlay last.
- `/metrics` is per process: scrape `api-streams` too (the open-stream gauges, `live` and `me`, are
  there).
- **Not measured.** `scripts/load/pages.ts` with 2,000 streams on `streams` processes while `pnpm load:bets`
  runs against `no-streams` ones is the check (A1b of the scale plan); it has not been run. The
  overlay was validated by `docker compose config`; `Caddyfile.streams` was not run through
  `caddy validate` here (CI's `docker` job does).

**Observability.** Logs are JSON (pino) with a request id (`x-request-id`, echoed in error bodies) and
redacted secrets; compose rotates them (20 MB x 5). Ship them with your agent of choice. Traces are exported
over OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Probes: api `GET /health`, worker `GET
:4100/health` and `/ready` (database, Redis, queues). Alert on: any container unhealthy or restarting,
`/ready` failing, payouts pending > 24 h (flagged in the back office), a reconciliation run with status
`mismatches` or `failed`, disk below 20%, a failed backup.

## 4. Licensed-mode checklist

In `OPERATING_MODE=licensed` the app **refuses to start only** if `PAYMENT_PROVIDERS` contains `mock`
(`licensedModeViolations` in `packages/config/src/config.ts`). It logs a warning for plain-http provider URLs and for
problems with the SMS deposit rail (`SMS Rail compliance notes`), and checks nothing else. The production rules
of `loadConfig` still apply (with `NODE_ENV=production`: https public URLs, a unique `SESSION_SECRET`,
`ADMIN_TOTP_KEY` and `PASSWORD_PEPPER`). Real-money safety therefore depends on you working through this
list before launch and reading the startup log:

- [ ] `NODE_ENV=production`; `PUBLIC_WEB_URL`, `ADMIN_WEB_URL`, `PUBLIC_API_URL` are https and the admin
      origin differs from the web origin.
- [ ] Unique `SESSION_SECRET` (32+ chars), `ADMIN_TOTP_KEY` (32 bytes), `PASSWORD_PEPPER` (32+ chars), and no
      development default left in any secret of a feature that is on.
- [ ] `PAYMENT_PROVIDERS` lists only real providers (`chapa`, `telebirr`, `sms`), each with its credentials; no
      `mock`. Webhook URLs registered with the providers point at `PAYMENT_CALLBACK_BASE_URL` (default
      `PUBLIC_API_URL`). `CHAPA_WEBHOOK_SECRET` is at least 32 characters. `PAYMENT_CALLBACK_BASE_URL`,
      `CHAPA_BASE_URL`, `TELEBIRR_BASE_URL` and `TELEBIRR_CHECKOUT_URL` are https whenever set
      (plain http is refused, even on loopback).
- [ ] With the SMS deposit rail (`sms`, [runbook](runbooks/sms-rail.md)): `SMS_RAIL_MODE=live`; its own
      `SMS_GATEWAY_SECRET` (32+ chars, shared with no other secret); `OPERATOR_LEGAL_NAME` set and every
      account in `SMS_COLLECTION_ACCOUNTS` in that name (no personal SIMs); `RECEIPT_VERIFY=audit`; and
      `PAYOUT_REQUIRE_PROOF=true` (or the explicit, logged waiver `PAYOUT_PROOF_WAIVED=true`). These SMS-rail
      items are your check: licensed mode only logs them as warnings at start and does not refuse to start
      without them. The database also refuses simulator SMS once it is licensed.
- [ ] `KYC_PROVIDER=mock` (the only KYC adapter: ID checks are simulated). `SMS_PROVIDER=http` has no adapter yet, so
      the api and worker refuse to start with it; `mock` means no code can be delivered: set `REGISTRATION_SMS_VERIFICATION=off` so players can still register (their phone is then not proven, and password reset by SMS does not work: staff must reset passwords).
- [ ] `FEED_PROVIDER=manual` (traders only) or a licensed real feed once an adapter exists; `mock` is refused.
- [ ] `TAX_CONFIG_CONFIRMED=true`, set only after counsel confirmed the winnings-tax rate, base and exemption.
- [ ] `FEATURE_CASINO=false`, `FEATURE_VIRTUALS=false` (not licensable). SMS/USSD betting stays off until the
      regulator approves the channel and a real aggregator is contracted (the mock aggregators are refused).
- [ ] Operational readiness (not enforced by code): backups running and a restore drill passed in the last
      30 days; the runbooks reviewed by the on-call staff; the admin host and the staff API (`/admin*` on the
      api host) restricted (`STAFF_ALLOWLIST`); staff accounts created
      with TOTP; responsible-gambling limits and age rule (21) reviewed; data residency decided (below);
      secrets in a secret manager (below); alerts wired.

## 5. Configuration reference

Variables are read by `@vamos/config` (`loadConfig`) in the api, worker and the ops scripts, unless noted.
The compose file passes them from `infra/.env.prod`; the template with comments is
[`infra/env.prod.example`](../infra/env.prod.example) (derived from `.env.example`). "Secret" values belong
in a secret manager, not in git.

**Core**

| Variable                                           | Default                        | Meaning                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                         | `production`                   | `production` enables Secure cookies, hides dev routes and the OTP inbox, and refuses development secrets.                                                                                                |
| `OPERATING_MODE`                                   | `licensed`                     | `demo` or `licensed` (section 4).                                                                                                                                                                        |
| `LOG_LEVEL`                                        | `info`                         | pino level: fatal, error, warn, info, debug, trace, silent.                                                                                                                                              |
| `API_HOST` / `API_PORT`                            | `0.0.0.0` / `4000`             | api listen address (the image fixes 4000).                                                                                                                                                               |
| `API_ROLE`                                         | `all`                          | Which routes this api process serves: `all` (everything), `streams` (only `/health`, `GET /live/stream`, `GET /me/stream`) or `no-streams` (everything else). See "Live streams on their own processes". |
| `CATALOG_CACHE_SECONDS`                            | `2`                            | Seconds the api reuses `/sports`, competitions and `/events` list answers per query (0 = off, max 30). Never event pages, search or betting.                                                             |
| `TELEGRAM_BOT_TOKEN`                               | unset (no bot)                 | The Telegram bot's token from @BotFather (secret). The worker then sends owner alerts to `TELEGRAM_OWNER_CHAT_IDS` and answers players' read-only questions. `docs/runbooks/telegram-bot.md`.            |
| `TELEGRAM_OWNER_CHAT_IDS`                          | empty                          | Chat ids (ask the bot `/id`) that get the owner alerts and may use `/status`; needs the token.                                                                                                           |
| `TELEGRAM_PLAYER_MENU`                             | `on`                           | `on`: players may ask for matches and odds; `off`: alerts only.                                                                                                                                          |
| `API_INTERNAL_URL`                                 | `PUBLIC_API_URL`               | Where the worker reads the catalogue for the bot (compose sets `http://api:4000`).                                                                                                                       |
| `PLAYER_SESSION_HOURS`                             | `8760` (a year)                | How long a player stays signed in after signing in (1 to 17,520). The owner's choice: players stay signed in until they sign out. Staff sessions keep 12 hours and 30 minutes idle.                      |
| `PLAYER_SESSION_IDLE_MINUTES`                      | `0` (none)                     | Minutes without a request after which a player session ends; 0 = never. Set `12` hours and `30` minutes to return to ASVS level 2 limits.                                                                |
| `PUBLIC_API_URL`                                   | `http://localhost:4000`        | Public api URL. Also baked into web/admin at build time (`NEXT_PUBLIC_API_URL`). https in production.                                                                                                    |
| `PUBLIC_WEB_URL` / `ADMIN_WEB_URL`                 | `:3000` / `:3001` on localhost | Public origins (CORS, cookies, redirects). Must differ; https in production.                                                                                                                             |
| `PAYMENT_CALLBACK_BASE_URL`                        | `PUBLIC_API_URL`               | Base URL providers call for webhooks. Leave **unset** (not empty) to use the default.                                                                                                                    |
| `TRUST_PROXY`                                      | empty (nobody)                 | Proxy addresses/CIDRs whose `X-Forwarded-For` sets the client IP. `true` and hop counts are refused.                                                                                                     |
| `WORKER_HEALTH_HOST` / `WORKER_HEALTH_PORT`        | `0.0.0.0` / `4100`             | Worker `/health` and `/ready` server (`0` turns it off).                                                                                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | unset                          | Tracing is on only when the endpoint is set; the name defaults to `vamos-api` / `vamos-worker`.                                                                                                          |

**Data stores and secrets**

| Variable                               | Default                                                   | Meaning                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | local dev URL                                             | Postgres URL. Compose builds the api/worker URL for `vamos_app` from `APP_DB_PASSWORD`, the migrate job's from `POSTGRES_USER`, `POSTGRES_PASSWORD` (owner), both with `POSTGRES_DB`. |
| `APP_DB_PASSWORD` (secret)             | unset                                                     | Migrate job only: gives the app role `vamos_app` its login and this password (16+ printable characters, hex from `init-env.sh`).                                                      |
| `REDIS_URL`                            | local dev URL                                             | Redis URL. Compose builds it from `REDIS_PASSWORD`.                                                                                                                                   |
| `QUEUE_PREFIX`                         | `vamos`                                                   | Key prefix of the BullMQ queues. Change only with an empty queue.                                                                                                                     |
| `SESSION_SECRET` (secret)              | dev value (refused in production)                         | 32+ chars. Keys OTP hashes and the national-ID hash that stops one ID opening two accounts. See rotation runbook.                                                                     |
| `PASSWORD_PEPPER` (secret)             | unset (required in production and licensed mode)          | 32+ chars, not the `SESSION_SECRET`. argon2's secret key for every password hash, kept outside the database (losing it makes passwords unusable). See rotation runbook.               |
| `METRICS_TOKEN` (secret)               | unset (route off)                                         | 32+ chars. Bearer token of `GET /metrics` on the api and the worker health port; unset, the route answers 404. See "Metrics" below.                                                   |
| `ADMIN_TOTP_KEY` (secret)              | dev key (refused in production)                           | 32 bytes as 64 hex chars or base64. AES-256-GCM key of the staff TOTP secrets. See rotation runbook.                                                                                  |
| `MOCK_PAYMENT_WEBHOOK_SECRET` (secret) | dev value (refused in production while `mock` is enabled) | HMAC key of the mock provider's webhooks (demo only).                                                                                                                                 |

**Feed and simulator (demo)**

| Variable                                                      | Default     | Meaning                                                                  |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `FEED_PROVIDER`                                               | `scrapper`  | `mock` (simulated pricing, live simulator; demo only) or `manual`.       |
| `SIM_SPEED`                                                   | `1`         | Simulated match minutes per real second.                                 |
| `FEED_ROLLING_EVERY_MINUTES` / `FEED_ROLLING_HORIZON_MINUTES` | `5` / `120` | Rolling demo fixtures: one kicks off every N minutes, up to the horizon. |

**Providers and payments**

| Variable                                                                                           | Default              | Meaning                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDERS`                                                                                | `sms`                | Comma list: `mock` (demo only), `chapa`, `telebirr`, `sms` (the SMS deposit rail).                                                                                                                                                                                                                                                          |
| `KYC_PROVIDER` / `SMS_PROVIDER`                                                                    | `mock` / `mock`      | `mock` only; `mock` or `http` (`http` has no adapter yet: startup is refused).                                                                                                                                                                                                                                                              |
| `REGISTRATION_SMS_VERIFICATION`                                                                    | `required`           | `off` registers players without an SMS code (the API hands the code back and the web app submits it): the phone number is then **not proven** to be the player's. For a deployment with no SMS gateway (`SMS_PROVIDER=mock`). Password-reset and payout-account codes are never handed back, so they cannot be used without a real gateway. |
| `CHAPA_BASE_URL`, `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`                                       | Chapa API URL, unset | Chapa credentials (secrets). The webhook secret is 32+ chars, also set in Chapa's dashboard.                                                                                                                                                                                                                                                |
| `TELEBIRR_BASE_URL`, `TELEBIRR_CHECKOUT_URL`                                                       | unset                | telebirr endpoints. Leave unset, not empty.                                                                                                                                                                                                                                                                                                 |
| `TELEBIRR_FABRIC_APP_ID`, `TELEBIRR_APP_SECRET`, `TELEBIRR_MERCHANT_APP_ID`, `TELEBIRR_SHORT_CODE` | unset                | telebirr merchant credentials (secrets).                                                                                                                                                                                                                                                                                                    |
| `TELEBIRR_PRIVATE_KEY`, `TELEBIRR_PUBLIC_KEY`                                                      | unset                | PEM keys; `\n` in the value is read as a newline.                                                                                                                                                                                                                                                                                           |

**SMS deposit rail** (`sms`; see [the runbook](runbooks/sms-rail.md))

| Variable                           | Default | Meaning                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMS_RAIL_MODE`                    | `live`  | `simulated` (demo: demo collection accounts and the dev SMS simulator) or `live` (licensed mode only, and required there).                                                                                                                                                                                  |
| `SMS_GATEWAY_SECRET`               | unset   | Secret, 32+ chars. The collection handset's forwarder sends it as `x-gateway-secret` to `POST /payments/webhooks/sms`. It alone can credit deposits: rotate on staff changes.                                                                                                                               |
| `SMS_GATEWAY_ALLOWLIST`            | empty   | Comma list of exact client addresses allowed to post SMS; empty allows any (the secret still applies).                                                                                                                                                                                                      |
| `SMS_COLLECTION_ACCOUNTS`          | unset   | JSON array of `{ "id"?: "…", "institution": "telebirr", "account": "09…", "name": "…", "hint"?: "…" }` (`id`: default `institution:account`, unique; the forwarder of that handset sends it as `account`), the accounts players pay into. Live rail only.                                                   |
| `OPERATOR_LEGAL_NAME`              | unset   | The licence holder's legal name; every collection account must be in it.                                                                                                                                                                                                                                    |
| `RECEIPT_VERIFY`                   | `audit` | `audit` checks every credited telebirr SMS against the receipt page (required live), `off` does not.                                                                                                                                                                                                        |
| `RECEIPT_VERIFY_TIMEOUT_MS`        | `6000`  | Timeout of one receipt-page request (500–30000).                                                                                                                                                                                                                                                            |
| `FLOAT_FORECAST_HORIZON_HOURS`     | `6`     | Payout float forecast: bets whose last match ends within this many hours count (1–48).                                                                                                                                                                                                                      |
| `FLOAT_FORECAST_WITHDRAWN_PERCENT` | `20`    | The percent of those bets' possible net payouts expected to be withdrawn (0–100). The alarm `payout_float_low` (error log with `alarm`, plus an owner alert) is raised by the worker when a collection account's last known SMS balance is below the forecast; the health panel shows both. Live rail only. |
| `FLOAT_FORECAST_EVENT_MINUTES`     | `120`   | How long a match is assumed to last from its start (the catalogue has no end time) (30–600).                                                                                                                                                                                                                |
| `SMS_HEARTBEAT_ALARM_MINUTES`      | `20`    | Alarm `sms_handset_heartbeat_missed` when a handset that sends heartbeats has been quiet this long (5–1440); a handset that never sent one is not judged.                                                                                                                                                   |
| `PAYOUT_REQUIRE_PROOF`             | `false` | `true`: a manual payout settles only with its debit SMS as proof. Set it in production: licensed mode without it only logs a warning, it is not enforced.                                                                                                                                                   |
| `PAYOUT_PROOF_WAIVED`              | `false` | The explicit waiver of `PAYOUT_REQUIRE_PROOF` in licensed mode (the api logs a warning at start).                                                                                                                                                                                                           |

**Tax and features**

| Variable                                             | Default         | Meaning                                                                                                                             |
| ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TAX_CONFIG_CONFIRMED`                               | `true`          | Licensed mode requires `true` (counsel confirmed the winnings-tax settings).                                                        |
| `FEATURE_CASINO`, `FEATURE_VIRTUALS`                 | `true`          | Not licensable; keep `false` (licensed mode no longer checks it).                                                                   |
| `SMS_BETTING_ENABLED`, `USSD_ENABLED`                | `true`          | SMS/USSD betting channels (legacy `FEATURE_SMS_BETTING`, `FEATURE_USSD`). Routes answer 404 while off.                              |
| `SMS_AGGREGATOR`, `USSD_AGGREGATOR`                  | `mock`          | Only `mock` exists until an aggregator is contracted; do not use it in production (licensed mode no longer checks it).              |
| `SMS_WEBHOOK_SECRET`, `USSD_SHARED_SECRET` (secrets) | dev values      | Inbound authentication of the channels. Production refuses the dev values while the channel is on; compose requires them to be set. |
| `SMS_SHORT_CODE`, `USSD_SERVICE_CODE`                | `8123`, `*123#` | Shown to players.                                                                                                                   |

**Read only by the web and admin apps / the ops scripts**

| Variable                                                                                                    | Where                  | Meaning                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                                                                                       | web, admin (build arg) | Browser-visible api URL, inlined at **build** time. Compose passes `PUBLIC_API_URL`; rebuild after changing it.                             |
| `NEXT_PUBLIC_OPERATING_MODE`                                                                                | admin (build arg)      | `licensed` hides the demo banner. Cosmetic: the api's mode is what counts.                                                                  |
| `API_INTERNAL_URL`                                                                                          | web (runtime)          | Private api URL for server-side rendering (`http://api:4000` in compose).                                                                   |
| `CATALOG_REUSE_MS`                                                                                          | web (runtime)          | Milliseconds the web server reuses a public catalogue answer (sports, competitions, event lists) per URL; default `2000`, `0` turns it off. |
| `PORT`, `HOST`                                                                                              | web, admin             | Listen port (and address for `server.mjs`).                                                                                                 |
| `ADMIN_PASSWORD`                                                                                            | `admin-create.js`      | Initial password of a new staff account (12+ chars); generated when unset.                                                                  |
| `BIND_ADDRESS`, `API_PORT`, `WEB_PORT`, `ADMIN_PORT`, `WORKER_HEALTH_PORT`, `VAMOS_SUBNET`, `VAMOS_VERSION` | compose only           | Published addresses/ports, the stack's network, the image tag.                                                                              |
| `WEB_DOMAIN`, `API_DOMAIN`, `ADMIN_DOMAIN`, `ACME_EMAIL`, `STAFF_ALLOWLIST`                                 | compose (`proxy`)      | Caddy host names and ACME contact; `STAFF_ALLOWLIST` limits the admin host and `/admin*` on the api host.                                   |

### Metrics

`GET /metrics` on the api answers in the Prometheus text format (version 0.0.4) for a scraper that sends
`Authorization: Bearer <METRICS_TOKEN>`. Without `METRICS_TOKEN` the route answers 404, and a missing or wrong
token gets 401. It is read-only and counts requests by route template (never the raw URL).

- `http_requests_total{route,status}` (status as a class: `2xx` to `5xx`) and the `http_request_duration_seconds`
  histogram by route.
- `sse_open_streams{stream="live|me"}`: open streams on this api process.
- `db_pool_connections{state="total|idle|waiting"}`: this process's database pool.
- `nodejs_eventloop_delay_seconds{quantile="0.5|0.99"}`, `process_resident_memory_bytes`,
  `nodejs_heap_used_bytes`.
- Business gauges, read from the database at scrape time and kept 15 seconds (concurrent scrapes share one
  result): `sms_open_deposits`, `sms_open_deposits_busiest{base_amount_birr}` (the 5 base amounts with most open
  deposits; a base amount near 99 open deposits is out of free amounts), `manual_payout_oldest_approved_seconds`,
  `manual_payout_claimed_idle` (claimed over 30 minutes ago) and `withdrawals_awaiting_review`.
- `outbox_unpublished` and `outbox_oldest_unpublished_seconds`, the same two gauges the worker serves (below). The
  worker's copy stops answering when the worker is down or hung, which is exactly when the age grows; the api's
  keeps answering. **Alert on `outbox_oldest_unpublished_seconds > 60` from the api**: it covers a worker that is
  down, hung, or cut off from Redis.

**Worker.** The worker answers `GET /metrics` on its health port (`WORKER_HEALTH_PORT`, default 4100) with the same
`METRICS_TOKEN` and the same rules (no token: 404; missing or wrong bearer: 401; Redis unreadable: 503). It
reads Redis and the outbox at scrape time and keeps the result 5 seconds:

- `queue_jobs{queue,state}` for every queue (`settlement`, `payouts`, `sms`, ...) and `state` of `waiting` (ready to
  be taken), `active`, `delayed` (not due yet, e.g. a live bet's acceptance delay) and `failed`.
- `queue_oldest_waiting_seconds{queue}`: how long the oldest waiting job has waited (0: none). A value that keeps
  growing means the consumers of that queue are stuck or too slow; `payouts` and `settlement` are the ones to alert on.
- `outbox_unpublished` and `outbox_oldest_unpublished_seconds`: the rows the dispatcher has not yet handed to the
  queues, and the age of the oldest. Every queue is fed from the outbox, so this is the step before all of them:
  a live bet's acceptance, a payout and a result to settle all wait here first. The dispatcher drains about 9,000
  rows a second (measured on the 4-CPU development container), so the healthy value is 0 or a few seconds. Alert
  on an age over 60 seconds: the worker is down, Redis refuses jobs, or a dead letter waits for a redrive (dead
  letters are counted here too, and logged at error level).

```sh
WORKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q worker)")
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" "http://$WORKER_IP:4100/metrics"
```

Each api process reports its own counters, so scrape every process. Caddy answers 404 for `/metrics` on the
public api host: scrape from the host over the compose network instead, with the container's address:

```sh
API_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q api)")
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" "http://$API_IP:4000/metrics"
```

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

1. **PDPP residency.** Does the Personal Data Protection Proclamation (and any licence condition)
   require personal data of Ethiopian players to stay in Ethiopia, or is a transfer abroad allowed with
   safeguards or consent?
2. **What counts as personal data here.** Phone numbers, names, KYC fields (Fayda ID hash, last four digits,
   date of birth), bank/wallet identifiers and IP addresses in the audit log.
3. **In-country hosting options** to evaluate: colocation or cloud capacity in an Addis Ababa data centre
   (national carrier or local provider) versus a regional cloud. Weigh latency to mobile networks,
   bandwidth cost, power and uplink redundancy, the ability to run Docker/PostgreSQL with backups, and
   whether payment/KYC/SMS partners need private links or IP allowlists. Everything in this repository is
   plain Docker and PostgreSQL, so it moves between hosts without code changes.
4. **Backups and logs** are personal data too: keep copies where the residency decision allows, and encrypt
   them (`BACKUP_AGE_RECIPIENT` in `backup.sh`).
5. **Retention.** Ledger, audit log and reconciliation: 7 years (a placeholder, to confirm). Player PII is removed or anonymised on account closure once retention
   duties allow.
6. **Provider callbacks** from telebirr/Chapa must reach `api` from the internet (or a provider VPN): plan the
   public IP, allowlists and the clock (NTP) of the host.

Until these are answered, run only the demo, with no real player data.

## 8. Testing deposits and withdrawals on a demo deployment

A demo deployment (`OPERATING_MODE=licensed`, `NODE_ENV=production`, `PAYMENT_PROVIDERS=mock`) runs the
whole money path with play money: the ledger, idempotency, limits, KYC, wagering, staff review, the
payout worker and the ELS stream are the same code as in licensed mode; only the providers are
simulated. Nothing here moves real money, and nothing here can: real deposits need licensed mode (section 4).

What a tester needs: the site (`PUBLIC_WEB_URL`), the back office (`ADMIN_WEB_URL`) and a staff account
with the `admin` or `finance` role (`admin-create.js`, section 3; scan the printed `otpauth://` URI into an
authenticator app).

| Step           | Where                               | What to do                                                                                                                                                                                                    |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Register    | `/register`                         | Any Ethiopian mobile number (`09…`/`07…`), a 12+ character password, an adult date of birth. No SMS is sent: the verify page shows the code, **Fill in**, **Verify**.                                         |
| 2. Verify ID   | Account → Identity (`/account/kyc`) | Any 12-digit Fayda FIN and a name. The mock registry verifies it, except an ID ending `0000` (not found) or `9999` (manual review: approve it in the back office KYC queue).                                  |
| 3. Deposit     | Wallet → Deposit                    | Choose an amount, **Deposit**. Open the simulated phone (the link under the waiting card, `/dev/phone`, same browser), enter PIN `1234` and **Approve** (or **Decline**). The balance updates within seconds. |
| 4. Bet it      | Any match                           | Every deposit must be staked once before it can be withdrawn (anti-money-laundering rule, wagering multiplier 1x in the back office settings). The withdraw page shows how much is left to bet.               |
| 5. Withdraw    | Wallet → Withdraw                   | Withdrawals go to the player's own registered number. Below the auto-approve threshold (default ETB 5,000) they are approved at once; from it upwards they wait for staff.                                    |
| 6. Approve     | Back office → Withdrawals           | **Approve** (or **Reject** with a reason). The worker pays within seconds.                                                                                                                                    |
| 7. See it paid | Wallet → Withdraw                   | The tracker shows Requested → Approved → Processing → Paid. Payout outcomes follow the number: ending `0000` fails (the money goes back), `9999` stays pending until the next status check.                   |

The same walk-through runs automatically against any deployment (about 5 to 10 minutes, most of it
waiting for a simulated match to be played; screenshots optional):

```bash
E2E_WEB_URL=https://www.example.et E2E_API_URL=https://api.example.et E2E_ADMIN_URL=https://admin.example.et \
E2E_STAFF_EMAIL=you@example.et E2E_STAFF_PASSWORD='…' E2E_STAFF_TOTP_SECRET=<base32 secret from admin-create> \
E2E_SCREENSHOTS_DIR=/tmp/vamos-shots pnpm e2e:deployment
```

It uses a fresh random player each run (the play-money rows stay in the demo database). If `STAFF_ALLOWLIST`
is set, run it from an allowed address.

## Player sign-in: 4-digit PIN and long sessions (owner's choice, 16 Nov 2026)

- **New player passwords are 4-digit PINs** (registration, SMS reset, change). The API refuses
  (`weak_password`, `pinWeaknessReason` in `packages/core/src/pin.ts`): one digit four times; runs up
  or down, also round the 0 (1234, 9876, 7890); pair patterns (1212, 1122, 1221) and three of a digit
  (1112); the years 1940 to 2030 (birth years, either calendar); a short list of frequent PINs (2580,
  1004...); and any four digits in a row of the player's own number (its end, its 09.. start). That
  is about 590 of the 10,000 PINs. Accounts made with an older long password keep signing in with
  it (the login field shows the full keyboard for that); a shorter old password must be reset by SMS.
- **Guessing limits per number:** 6 PIN checks per 15 minutes and 15 per day, from any address
  (`DEFAULT_AUTH_LIMITS` in `apps/api/src/lib/rate-limits.ts`), counting the login form AND the
  checks a signed-in player makes (changing the PIN, ending other sessions), so a stolen session
  gets no more guesses than a stranger. Lifted at once when the owner of the number resets the PIN
  with an SMS code. A sign-in from a new device sends the player an SMS.
- **Sessions:** a player stays signed in for `PLAYER_SESSION_HOURS` (default a year) with no idle
  limit (`PLAYER_SESSION_IDLE_MINUTES=0`). Signing out, a PIN change or reset, self-exclusion and a
  disabled account end sessions at once.
- **What this trades away:** a 4-digit PIN and year-long sessions are weaker than the ASVS level 2
  rules the API followed before (12+ character passwords, 12-hour sessions with 30 minutes idle).
  The limits above leave a stranger about 15 guesses a day on one number, but someone trying one
  common PIN on many numbers is only slowed by the per-address limit, and a phone left signed in
  stays signed in. Money still only leaves to the player's own registered wallet or KYC-named bank
  account. To go back to the strict session limits set `PLAYER_SESSION_HOURS=12` and
  `PLAYER_SESSION_IDLE_MINUTES=30`.
