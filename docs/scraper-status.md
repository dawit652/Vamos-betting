# Scraper: build status and what is left

A living checklist for the work described in [scraper.md](scraper.md). It is
updated at every checkpoint so that a pause (for instance a usage limit) never
loses the plan. Newest facts first.

## Usage budget (why the work is paced)

- 2026-10-29 00:39 UTC: weekly allowance **87% used**, 5-hour window 65%.
  The weekly allowance resets **2026-10-30 20:00 UTC**; the 5-hour window resets
  at 05:10 UTC.
- Measured cost: the whole foundation (five agents, about 1.0M tokens) cost
  about 6 points of the weekly allowance, so one point is roughly 170–200k
  tokens.
- Policy: cheaper models wherever quality allows (Opus only for the safety
  gates and the final review), small waves, one usage check after each wave,
  stop and update this file at about 93% weekly.

## Done, verified and pushed

| Piece                                                                                                               | Where                                                                | Tests                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------- |
| Design spec, shared vocabulary, package and app skeletons                                                           | `docs/scraper.md`, `packages/core/src/scrape.ts`, `packages/scraper` | –                       |
| Admin API contracts (`/admin/feed/*`, typed review payloads)                                                        | `packages/contracts/src/feed.ts`                                     | 22                      |
| Scraper settings and licensed-mode checks (`FEED_PROVIDER=scraped`, `SCRAPER_*`)                                    | `packages/config`, env examples                                      | 45                      |
| Ratings update from results, in-house pricing from ratings                                                          | `packages/feed/src/pricing/ratings.ts`                               | 25                      |
| Name matching, time zones, fixture clustering and matching                                                          | `packages/scraper/src/normalize`, `match`                            | 96                      |
| Source adapters: openfootball, generic JSON, generic HTML, registry, golden fixtures                                | `packages/scraper/src/adapters`                                      | 79                      |
| Polite fetcher (allow-list, robots, rate limit, retries, breaker), raw archive, cadence                             | `packages/scraper/src/fetch`, `archive`                              | 126                     |
| Safety gates: fixture, result consensus, shape, odds rules (with a brute-force reference model and mutation checks) | `packages/scraper/src/gates`                                         | 122                     |
| Database: 10 tables, migrations 0033–0034, services                                                                 | `packages/db/src/schema/scrape.ts`, `src/scrape`, `migrations`       | 56 (full db suite: 605) |

The whole `@vamos/scraper` package passes (424 tests), typecheck and lint clean.

## In progress

| Piece                                                                                                                                                                                                      | Model / effort | Notes                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Scraper process `apps/scraper`: run pipeline, name resolution, fixture and result promotion, staff-confirmation path, scheduler, health endpoint, integration and fault-injection tests on a real Postgres | Sonnet, high   | The glue that makes everything above feed the site. Lean scope: re-pricing of existing events after a ratings change (rule O3) is left out |

## Remaining (in this order)

1. **Independent adversarial review** of the pipeline, the promotion code and
   the gates' use of them (Opus, high or xhigh; a different model from the one
   that wrote it). Fable was not available (needs usage credits). Then fix what
   it finds.
2. **Back-office API routes** `/admin/feed/*` (health, review queue, resolve,
   aliases, source kill switch, competition policy) with tests (Sonnet, high).
   Contracts exist. The route that confirms a result must only record the
   decision `apply_result` on the review item; the scraper applies the score
   from the item itself, so a client can never supply one.
3. **Back-office pages** (health, review queue, alias mapping) (Sonnet, medium).
4. **Docker target, compose service, CI step** for `apps/scraper`, and a volume
   for `SCRAPER_ARCHIVE_DIR` that is included in backups (Sonnet, medium).
5. **Operations guide and runbook** ("a source broke", "a result is disputed",
   onboarding a new source checklist) (Haiku, low).
6. **Re-pricing of scheduled events** after ratings change, gated by rule O3.
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
