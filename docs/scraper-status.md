# Scraper: build status and what is left

A living checklist for the work described in [scraper.md](scraper.md). It is
updated at every checkpoint so that a pause (for instance a usage limit) never
loses the plan. Newest facts first.

The task-by-task plan for everything below is in [scraper-plan/](scraper-plan/README.md).

## Usage budget (why the work is paused here)

- 2026-10-29 09:09 UTC: weekly allowance **93%** used (resets **2026-10-30
  20:00 UTC**), current 5-hour window 51% (resets 12:50 UTC). This is the stop
  line: no more agents are started until the weekly reset.
- What happened since the last checkpoint: the independent review (Opus) and the
  admin API routes (Sonnet) were started, then cancelled by an interruption
  before they wrote anything. They used about 5 points of the weekly allowance
  for no output. Both are still to do (see `scraper-plan/01` and `02`).
- Measured cost: about 1.0M agent tokens cost about 6 points of the weekly
  allowance, so one point is roughly 170–200k tokens.
- Policy: cheaper models wherever quality allows (Opus only for the safety
  gates and the final review), small waves, one usage check after each wave,
  stop and update this file at about 93% weekly.

## Done, verified and pushed

| Piece                                                                                                                                                          | Where                                                                | Tests                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Design spec, shared vocabulary, package and app skeletons                                                                                                      | `docs/scraper.md`, `packages/core/src/scrape.ts`, `packages/scraper` | –                                             |
| Admin API contracts (`/admin/feed/*`, typed review payloads)                                                                                                   | `packages/contracts/src/feed.ts`                                     | 22                                            |
| Scraper settings and licensed-mode checks (`FEED_PROVIDER=scraped`, `SCRAPER_*`)                                                                               | `packages/config`, env examples                                      | 45                                            |
| Ratings update from results, in-house pricing from ratings                                                                                                     | `packages/feed/src/pricing/ratings.ts`                               | 25                                            |
| Name matching, time zones, fixture clustering and matching                                                                                                     | `packages/scraper/src/normalize`, `match`                            | 96                                            |
| Source adapters: openfootball, generic JSON, generic HTML, registry, golden fixtures                                                                           | `packages/scraper/src/adapters`                                      | 79                                            |
| Polite fetcher (allow-list, robots, rate limit, retries, breaker), raw archive, cadence                                                                        | `packages/scraper/src/fetch`, `archive`                              | 126                                           |
| Safety gates: fixture, result consensus, shape, odds rules (brute-force reference model, mutation checks)                                                      | `packages/scraper/src/gates`                                         | 122                                           |
| Database: 10 tables, migrations 0033–0034, services                                                                                                            | `packages/db/src/schema/scrape.ts`, `src/scrape`, `migrations`       | 56 (full db suite: 605)                       |
| Scraper process: run pipeline, name resolution, fixture and result promotion (one `applyConfirmedResult` path), staff confirmation, scheduler, health endpoint | `apps/scraper`                                                       | 22, on a real Postgres, incl. fault injection |

The whole `@vamos/scraper` package passes (424 tests). `apps/scraper` passes
typecheck, lint and format, bundles with tsup, and a manual smoke test started
the process against the local database and Redis and got `ok` from `/health` and
`/ready`. `main.ts` and the health server are not covered by the automated
tests.

## Known limits of what is built (for the review to look at)

- New events for teams without calibrated ratings are created with markets
  priced from neutral ratings while betting is closed (`ratings_uncalibrated`
  item opens). Decide whether closed events should show those odds at all.
- Competitions without a policy row are skipped for fixtures (shadow mode);
  results treat a missing policy as all flags off.
- A staff decision is stored as the review item's `resolution` text:
  `{"decision":"apply_result"}`, `apply_result` or `apply_result:...`. The score
  applied always comes from the item payload, never from a request. Items are
  honoured for 24 h after they are resolved.
- A source without external ids that reschedules a match to another day leaves
  the old observation as a stale current row; this fails closed (cluster
  conflict or `kickoff_change`).
- The scheduler's skip-until-`retryAt` logic has no test.
- Re-pricing scheduled events after ratings change (rule O3) is built (task 06): see
  `scraper-plan/known-limits.md` for the choices. The payload of the F7 item written at
  creation is not in the contract's shape (known limit); the re-price item is.
- Raw snapshots are pruned after 30 days; evidence behind applied results is
  kept.

## Remaining (in this order)

1. **Independent adversarial review** of `apps/scraper`, the way the gates are
   used, the database services and the migrations, by a different model from the
   ones that wrote them (Opus, high or xhigh; Fable needs usage credits). Look
   especially for: any path that changes an event without a gate decision,
   transaction and lock-order mistakes, double application, and mapping errors
   between observations and events. Then fix what it finds.
2. **Back-office API routes** `/admin/feed/*` (health, review queue, resolve,
   aliases, source kill switch, competition policy) with tests (Sonnet, high).
   Contracts exist. The route that confirms a result may only write the
   `apply_result` resolution; it must never take a score from the request.
3. **Back-office pages** (health, review queue, alias mapping) (Sonnet, medium).
4. **Docker target, compose service, CI step** for `apps/scraper`, and a volume
   for `SCRAPER_ARCHIVE_DIR` that is included in backups (Sonnet, medium).
5. **Operations guide and runbook** ("a source broke", "a result is disputed",
   onboarding a new source checklist) (Haiku, low).
6. ~~**Re-pricing of scheduled events** after ratings change, gated by rule O3.~~ Done:
   `apps/scraper/src/pipeline/reprice.ts`, migration `0035_scrape_event_pricing`, the
   `apply_reprice` decision of `/admin/feed/review/:id/resolve` and its button on the
   review page.
7. **Live scores**, other sports, and headless-browser fetching (explicitly out
   of version 1).
8. Final full verification (typecheck, lint, format, all package tests, e2e)
   and a push.

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
  to replay) and a trader to approve the first prices.
- A shadow-mode period (2–4 weeks) before any competition goes automatic.
