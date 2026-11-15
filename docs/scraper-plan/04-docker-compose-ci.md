# 04. Image, compose service, backups and CI

|                |                                                                               |
| -------------- | ----------------------------------------------------------------------------- |
| Status         | Not started                                                                   |
| Model / effort | Sonnet, medium                                                                |
| Size           | about 150k tokens                                                             |
| Depends on     | – (the process already bundles with `pnpm --filter @vamos/scraper-app build`) |
| Blocks         | task 09                                                                       |

## Goal

Run the scraper in the production stack like the worker: its own hardened
container, a volume for the raw snapshots that is backed up, and a CI check.

## Work

1. **Dockerfile** (`infra/docker/Dockerfile`): add a `scraper` target next to
   `worker`. Copy the worker's pattern: a `deps-scraper` stage that installs the
   production dependencies (the bundle inlines the `@vamos/*` workspace
   packages, but `cheerio`, `pino`, `ioredis`, `pg`, `zod` and `drizzle-orm`
   stay external, so they must be in the image), the built `apps/scraper/dist`,
   `ENV SCRAPER_PORT=4200`, `HEALTHCHECK` on `/health`, non-root user.
2. **Compose** (`infra/docker-compose.prod.yml`): a `scraper` service:
   `FEED_PROVIDER=scraped` and the `SCRAPER_*` variables from the shared
   environment anchor, `read_only: true` with a tmpfs, the `hardening` anchor,
   a named volume `scraper_archive` mounted at `/var/lib/vamos/scraper` (set
   `SCRAPER_ARCHIVE_DIR` to that absolute path), `depends_on` migrate and redis,
   health check, port not published. One instance only (the source locks make a
   second harmless, but there is no reason for it).
3. **Environment**: `infra/env.prod.example` already has the scraper block;
   check it matches and add `SCRAPER_CONTACT` as required text. The licensed
   guard already requires an absolute archive directory, a contact and
   `SCRAPER_ROBOTS=enforce`.
4. **Backups** (`infra/scripts/backup.sh`, `restore-drill.sh`,
   `backup.test.sh`): add a `scraper` mode that tars the archive volume the way
   the removed `els` mode did (copy the pattern from git history,
   `git show 6badfc4^:infra/scripts/backup.sh`), include it in `all`, and keep
   the archive for as long as bets are kept (the evidence behind an applied
   result must survive: the database marks it `keep`). Update `docs/backups.md`
   to list the volume.
5. **CI** (`.github/workflows/ci.yml`): the package tests already run through
   `pnpm -r test`; extend the `docker` job to build the scraper image and boot it
   against the compose Postgres and Redis, then `curl /health`. Add
   `scripts/smoke.sh --scraper http://localhost:4200` (a small addition that
   checks `/health` and `/ready`).
6. **Docs**: a short section in `docs/deployment.md` (service table row, volume,
   the one-instance note).

## Acceptance

- `docker compose -f infra/docker-compose.prod.yml config` is valid.
- If Docker is available: the image builds and `/ready` answers; otherwise the
  CI job proves it (say which in the report).
- `bash infra/scripts/backup.test.sh` passes with the new mode.
- Prettier clean on the touched YAML, shell and Markdown.

## Prompt to start it

> Read `docs/scraper-plan/04-docker-compose-ci.md`; mirror how the `worker`
> service is built and run, and how the removed `els` volume was backed up
> (`git show 6badfc4^:infra/scripts/backup.sh`). Do not commit.
