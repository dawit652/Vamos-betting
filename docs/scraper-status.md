# Scraper: build status and what is left

A living checklist for the work described in [scraper.md](scraper.md). It is
updated at every checkpoint so that a pause (for instance a usage limit) never
loses the plan. Newest facts first.

## Usage budget

- Weekly allowance: **81% used** at 2026-10-29 00:10 UTC, resets
  **2026-10-30 20:00 UTC**. The 5-hour window had just reset to 0%.
- Policy while the weekly allowance is low: cheaper models wherever quality
  allows (Opus only for the safety gates and the final review), small waves,
  one usage check after each wave, stop and write this file when the weekly
  figure reaches about 93%.

## Done (committed and pushed)

| Piece | Where | State |
| --- | --- | --- |
| Design spec, shared vocabulary, package and app skeletons | `docs/scraper.md`, `packages/core/src/scrape.ts`, `packages/scraper` (types, constants), `apps/scraper` (empty) | done |
| Back-office API contracts (`/admin/feed/*`, typed review payloads) | `packages/contracts/src/feed.ts` | done, 22 tests |
| Scraper settings and licensed-mode checks (`FEED_PROVIDER=scraped`, `SCRAPER_*`) | `packages/config`, `.env.example`, `infra/env.prod.example` | done, 45 tests |
| Ratings update from results, in-house pricing from ratings | `packages/feed/src/pricing/ratings.ts` | done, 25 tests (thresholds of three statistical tests were relaxed after tuning showed they were too strict for one noisy season) |

## In progress (Wave 1, running when this was written)

| Piece | Model / effort | Notes |
| --- | --- | --- |
| Safety gates and result consensus (`packages/scraper/src/gates`) | Opus, max | Resumed after the limit. The most critical module |
| Database: schema, migration 0033, services | Sonnet, high | Restarted on a cheaper model |
| Name matching, time zones, fixture clustering (`normalize`, `match`) | Sonnet, high | Restarted on a cheaper model; `name.ts` kept |

## Not started or partly started

| Piece | Model / effort | Notes |
| --- | --- | --- |
| Polite fetcher, raw archive, cadence (`fetch`, `archive`) | Sonnet, high | `robots.ts` exists; resume the interrupted agent or restart |
| Source adapters: openfootball, generic JSON, generic HTML, registry, golden fixtures | Sonnet, medium | `common.ts`, a temporary time-zone fallback and a fixtures folder exist; switch to `zonedToUtc` when `normalize` has it |
| Scraper process: scheduler, run pipeline, fixture promotion, health endpoint (`apps/scraper`) | Sonnet or Opus, high | Needs all of the above |
| Result promotion: consensus into `resultEvent`, ratings update, settlement tests | Opus, high | The riskiest wiring; needs a real-Postgres end-to-end test through settlement |
| Back-office API routes `/admin/feed/*` and tests | Sonnet, high | Contracts already exist |
| Back-office pages (health, review queue, aliases) | Sonnet, medium | |
| Docker target, compose service, CI | Sonnet, medium | |
| Operations guide and runbook ("a source broke") | Haiku, low | |
| Independent adversarial safety review, then fixes | Opus, xhigh | Fable was unavailable (needs usage credits) |
| Full verification (typecheck, lint, format, all tests), final commit and push | orchestrator | |

## Decisions already taken (from the plan)

- TypeScript on Node 22, inside the monorepo.
- Odds are priced in-house from team ratings; scraped bookmaker odds are never
  published.
- Version 1: football, fixtures and final results, one competition at a time.
  Live scores, other sports and headless-browser fetching come later.
- New events start with betting closed; results need two independent upstreams,
  a waiting period and, until a competition is switched to automatic, a person's
  confirmation. Absence of a fixture never cancels anything.

## What still needs a person

- The real source list for your market (the reference adapter uses the
  public-domain openfootball dataset, which covers major European leagues, not
  Costa Rica or Ethiopia), and each source's terms of use.
- At least one genuinely independent second source for results (ideally a
  licensed data provider).
- Starting ratings for the teams of the chosen league (or a season of history
  to replay) and a trader to approve the first prices.
- A shadow-mode period (2–4 weeks) before any competition goes automatic.
