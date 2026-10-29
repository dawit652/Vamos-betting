# Scraper: build status and what is left

A living checklist for the work described in [scraper.md](scraper.md). Newest
facts first. The task-by-task plan is in [scraper-plan/](scraper-plan/README.md).

## Status on 2026-10-29: code complete for version 1

Every code task of the plan (01–07 and 09) is done, verified and pushed on
branch `claude/busy-rubin-1shjt6`. What is left needs people (sources, terms,
ratings, a shadow period); see the end of this file.

### Final verification (task 09)

| Check                                                           | Result                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` | pass (lint with zero warnings)                                                                                                                                                |
| `pnpm format:check`                                             | only the known `packages/core/src/common-passwords.ts` warning                                                                                                                |
| All package tests (Postgres 16 and Redis running)               | 2,933 pass: core 662, db 608, scraper 441, api 405, web 194, feed 168, worker 103, payments 93, scraper-app 91, contracts 62, admin 52, config 45, i18n 9                     |
| Migrations                                                      | `pnpm db:migrate` applies 0033–0035; `drizzle-kit generate` reports no schema changes                                                                                         |
| Bundle and smoke test                                           | `pnpm --filter @vamos/scraper-app build`; `node dist/main.js` with `FEED_PROVIDER=scraped` answers `ok` on `/health` and `/ready`                                             |
| No dangerous capability                                         | no `voidMarket` or `voidSelection` call in `apps/scraper`, `packages/scraper` or the feed routes; the only `resultEvent` call is in `applyConfirmedResult`, status `finished` |
| Licensed guard                                                  | covered by the `@vamos/config` tests                                                                                                                                          |
| Docker image, compose service, archive backup                   | `backup.test.sh` passes; image build and boot are proven by the CI `docker` job (no Docker daemon in the build session)                                                       |
| e2e (Playwright)                                                | not run (optional for the scraper; needs the dev stack)                                                                                                                       |

One flaky test was fixed during verification: `scrape-observations.test.ts`
assumed an order between two observations with the same kickoff, which is by a
random id.

### What was built in this round

| Task | What                                                                                                                                                         | Commits              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 01   | Independent review ([review-2026-10.md](scraper-plan/review-2026-10.md)): 10 findings; all 5 high and 3 medium fixed with regression tests; 2 low in backlog | `0bcc08f`…`2020b9b`  |
| 02   | `/admin/feed/*` routes, strict resolve body (no request can carry a score or a price)                                                                        | `5980f33`            |
| 03   | Back-office pages `/feed`, `/feed/review`, `/feed/review/[id]`, `/feed/aliases`                                                                              | `15c0281`            |
| 04   | Docker `scraper` target, compose service, `scraper_archive` volume in backups, CI smoke                                                                      | `d964c32`            |
| 05   | [Operations guide](scraper-operations.md) and three runbooks                                                                                                 | `7b0b7cf`            |
| 06   | Re-pricing after ratings change (rule O3), migration 0035, `apply_reprice` decision                                                                          | `6d887e4`, `7442397` |
| 07   | Source and ratings CLI (`sources`, `dry-parse`, `dry-fetch`, `aliases import`, `ratings backfill`); fixed a bundle crash at start                            | `f13f8f7`            |
| –    | The F7 `odds_approval` item is written in the contract's shape, so "Open betting" works on real items                                                        | `9ed1bf7`            |

## Open items (code)

- Review findings 9 and 10 (low): see the review report.
- No alias removal from the back office or the CLI (`removeAlias` exists).
- No documented route to run the CLI's write commands against the production
  database (Postgres is not published by the stack).
- Snapshots behind an open dispute are pruned after 30 days like any other; the
  disputed-result runbook says to export evidence first.
- `open_betting` is refused on `ratings_uncalibrated` items by design; a trader
  must calibrate (or set `manual`) first.
- The admin pages have not been checked by hand in a browser; an e2e flow
  (`e2e/tests/feed.spec.ts`) is optional.
- Version 1 excludes live scores, other sports and headless-browser fetching
  (task 08).

Everything else is in [known-limits.md](scraper-plan/known-limits.md).

## Decisions already taken (from the plan)

- TypeScript on Node 22, inside the monorepo.
- Odds are priced in-house from team ratings; scraped bookmaker odds are never
  published.
- Version 1: football, fixtures and final results, one competition at a time.
- New events start with betting closed; results need two independent upstreams,
  a waiting period and, until a competition is switched to automatic, a person's
  confirmation. Absence of a fixture never cancels anything.

## What still needs a person

- The real source list for your market (the reference adapter uses the
  public-domain openfootball dataset, which covers major European leagues, not
  Costa Rica or Ethiopia), and each source's terms of use.
- At least one genuinely independent second source for results (ideally a
  licensed data provider). Two scrapers of the same upstream do not count as two.
- Starting ratings for the teams of the chosen league (or a season of history
  to replay with `ratings backfill`) and a trader to approve the first prices.
- A shadow-mode period (2–4 weeks) and the scorecard of task 07 before any
  competition goes automatic.
- Proposed lines for CLAUDE.md (not edited by the agents): "Scraper: results
  reach `resultEvent` only through the gates; no code path may cancel, void or
  abandon an event from scraped data" and "see docs/scraper.md".
