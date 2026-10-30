# Scraper: build status and what is left

A living checklist for the work described in [scraper.md](scraper.md). Newest
facts first. The task-by-task plan is in [scraper-plan/](scraper-plan/README.md).

## Evaluation of 2026-10-29: not ready for real money

Three independent evaluators measured accuracy, speed, odds and resilience on real data. The merged scorecard and the
ranked fix plan, with the model and effort chosen for each task, are in
[scraper-evaluation/00-scorecard-and-fix-plan.md](scraper-evaluation/00-scorecard-and-fix-plan.md); the evidence is in
reports [01](scraper-evaluation/01-data-accuracy.md), [02](scraper-evaluation/02-speed-and-resilience.md) and
[03](scraper-evaluation/03-odds-accuracy.md).

- **Fixed already:** goalless draws are no longer dropped (F-03); generic aliases that could map a foreign
  club to a Costa Rican one are gone from the draft alias file (F-13, alias part); the flaky test teardown that made
  a passing test run exit with an error is gone (F-20), so the first real CI run should not fail at random; opening
  betting by hand (the review item and the Trading switch) re-checks the teams' ratings and the prices (F-10).
  A match that is over with no score from any source now raises a "No result yet" item 7 h 45 min after kickoff (F-04).
  A source that answers but shows nothing new 48 hours after a match it lists ended now raises a "source stale" item (F-02).
- **Next (Wave 1, after the weekly allowance resets on 2026-10-30 18:00 UTC):** the kickoff safety rule (F-01, Opus
  first).
- **Needs a decision from the owner:** a licensed data provider (F-06) and an exposure policy for model-priced
  events (F-05).
- **Not measured yet:** replay of the real history, concurrency and crash tests, throughput, failure scenarios and
  per-league odds (F-19).
- **Demo you can run today:** one command builds a finished match with two bets in the demo database, and you
  watch a trader apply the result and the bets settle ("Try a result today" in
  [scraper-local-test.md](scraper-local-test.md)). Proven by a test and by a run by hand with the real
  scraper, API and worker on 2026-10-30.

## Status on 2026-10-29 (evening): code complete for version 1, Costa Rica prepared

Every code task of the plan (01–07 and 09) is done, and a second round of
decisions taken on the person's behalf is built, verified and pushed on branch
`claude/busy-rubin-1shjt6` (pull request #2). What is left needs people:
sources and their terms, accounts, ratings and a shadow period (see the end of
this file).

### Verification on `d76e719`

| Check                                                                              | Result                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm audit --prod`                              | pass, no known vulnerabilities                                                                                                                                                                                                                                                                                                     |
| `pnpm format:check`, `pnpm typecheck`, `pnpm lint`                                 | pass (lint with zero warnings)                                                                                                                                                                                                                                                                                                     |
| All package tests (Postgres 16, Redis 7)                                           | 3,079 pass: core 662, db 609, scraper 521, api 408, web 194, feed 168, scraper-app 149, worker 103, payments 93, contracts 63, admin 55, config 45, i18n 9                                                                                                                                                                         |
| `pnpm build`                                                                       | pass                                                                                                                                                                                                                                                                                                                               |
| Migrations                                                                         | 0033–0035 apply; `drizzle-kit generate` reports no schema changes                                                                                                                                                                                                                                                                  |
| End-to-end (`pnpm e2e` as the CI job runs it, fresh database)                      | 17 of 17 pass, including the new `feed.spec.ts`, with Costa Rica seeded first                                                                                                                                                                                                                                                      |
| Docker job (all five images, production compose, smoke test, archive volume, CLI)  | pass locally on `d76e719`: stack healthy, smoke 15 passed and 1 skipped (`/ready` on the API predates this work), `sources list` and `ratings list` run in the scraper image, `SCRAPER_SECRET_API_FOOTBALL` reaches only the scraper service; a real encrypted backup and restore drill of the archive passed earlier on `ebd7ab6` |
| Back office in a browser (every `/feed` page and action, trader and support roles) | pass; four display defects fixed                                                                                                                                                                                                                                                                                                   |
| No dangerous capability                                                            | no `voidMarket` or `voidSelection` call in the scraper or the feed routes; the only `resultEvent` call is in `applyConfirmedResult`, status `finished`                                                                                                                                                                             |
| GitHub Actions                                                                     | **blocked outside the code**: no job has been given a runner since 2026-10-27 15:11 UTC, on any branch (account minutes or spending limit)                                                                                                                                                                                         |

### Round 2: decisions taken on the person's behalf

| Decision                                                                                                                                                   | Commits                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Scraper rule added to CLAUDE.md; CI unblocked from its one formatting failure; CI runs once per push instead of twice on branches with a pull request      | `ebd7ab6`                       |
| Pull request #2 opened against the default branch (it contains #1)                                                                                         | –                               |
| Remove an alias (API, back office, CLI); `ratings set` / `ratings list` for traders; the CLI documented and tested inside the scraper image for production | `fdf6b3a`, `85c9562`, `8020042` |
| Review findings 9 and 10 (low) fixed                                                                                                                       | `eb5c8fd`, `6ae55b1`            |
| Snapshots behind an open result dispute are kept, not pruned                                                                                               | `6c314a0`                       |
| A promotion read that hits its row limit decides nothing near the cut                                                                                      | `9f5896c`                       |
| When teams become calibrated, `ratings_uncalibrated` closes and a trader gets an "Open betting" item (betting is never opened automatically here)          | `3f33d59`                       |
| Scheduler retry logic tested                                                                                                                               | `70c243e`                       |
| Back office checked in a browser, display fixes, repeatable e2e flow and a demo-only seeding tool (`seed:review`)                                          | `af790f3`, `6ef1b91`, `feab881` |
| A demo-only finished match with two bets (`seed:result-demo`): a trader applies the result and the bets settle; test plus a by-hand run on 2026-10-30      | –                               |
| Closed events may show their (unbettable) prices; a trader reviews prices before opening betting                                                           | no change                       |
| First competition: Costa Rica's Primera División (Liga FPD). Research and recommendation in [sources-costa-rica.md](scraper-plan/sources-costa-rica.md)    | `9a107e0`                       |
| The Primera División and its ten Apertura 2026 clubs are in the catalogue (first, featured, uncalibrated ratings); alias file draft                        | `9241257`                       |
| `generic-json` sources can send an API key header whose value comes from an environment secret (needed for API-Football)                                   | `50283b8`, `d76e719`            |

### Round 1 (plan tasks)

| Task | What                                                                                                                   | Commits              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 01   | Independent review ([review-2026-10.md](scraper-plan/review-2026-10.md)): 10 findings, all fixed with regression tests | `0bcc08f`…`6ae55b1`  |
| 02   | `/admin/feed/*` routes, strict resolve body (no request can carry a score or a price)                                  | `5980f33`            |
| 03   | Back-office pages `/feed`, `/feed/review`, `/feed/review/[id]`, `/feed/aliases`                                        | `15c0281`            |
| 04   | Docker `scraper` target, compose service, `scraper_archive` volume in backups, CI smoke                                | `d964c32`            |
| 05   | [Operations guide](scraper-operations.md) and three runbooks                                                           | `7b0b7cf`            |
| 06   | Re-pricing after ratings change (rule O3), migration 0035, `apply_reprice` decision                                    | `6d887e4`, `7442397` |
| 07   | Source and ratings CLI; fixed a bundle crash at start                                                                  | `f13f8f7`            |
| –    | The F7 `odds_approval` item is written in the contract's shape, so "Open betting" works on real items                  | `9ed1bf7`            |

## Open items (code)

- The ratings history for Costa Rica (two tournaments, about 180 matches) could
  not be transcribed: the environment's network policy refused the pages.
- Municipal Liberia and Guadalupe are not seeded (their 2026-27 status was
  unverified); add them if they play.
- The API key block exists for `generic-json` only. `Authorization` headers are
  refused on purpose; allowing `Bearer` later is a one-line change.
- Locally, `pnpm e2e` needs a Chromium matching the pinned Playwright 1.56.1
  (revision 1194); the dev container ships revision 1243. CI installs its own.
- Possible follow-ups from the hardening round: mark snapshots when a staff
  rejection reopens a `result_unverified` item; the 20,000-row limit of
  `reresolveChangedAliases` only warns.
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

- **GitHub Actions**: no CI job has started since 2026-10-27. GitHub's
  message is "The job was not started because recent account payments have
  failed or your spending limit needs to be increased". The Free plan's free
  minutes for October appear to be used up and the Actions budget is $0
  (Settings → Billing and licensing → Budgets and alerts). Nothing has to be
  paid: the free minutes reset on 1 November, and CI now uses about a third of
  the minutes per push (see the cost note in `.github/workflows/ci.yml`). The
  pull request is mergeable without CI, because none of its checks is
  required. Check Payment history for a failed payment if the jobs still do
  not start after 1 November. Do not make the repository public just for the
  minutes: it is a betting platform's code.
- **Network access for the research**: allow `en.wikipedia.org`,
  `es.wikipedia.org`, `www.unafut.com`, `www.fedefutbol.com`,
  `www.api-football.com`, `api-sports.io`, `www.sportmonks.com` and
  `docs.sportmonks.com` in the environment's network settings, so the terms,
  robots files, page structure and ratings history can be read and verified.
- **Sources**: read UNAFUT's terms and robots file and ask UNAFUT for
  permission; sign up for API-Football, test league 162, and ask API-Sports in
  writing whether a betting operator may use the data and where it comes from.
  Legal sign-off on each source.
- **Competition settings**: switch `extraTime` on for the Primera División
  before the semifinals (9 December 2026); confirm the 2026-27 club list.
- **Ratings and prices**: starting ratings (`ratings backfill` once the history
  is available, or `ratings set`), and a trader to approve the first prices.
- **Shadow mode**: the scorecard needs 200 results compared with ground truth;
  this tournament has about 30 matches left, so plan for the Clausura 2027.
  Until then a person confirms every result.
