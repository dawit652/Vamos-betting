# Scraper plan: the remaining work

What is left to finish the data scraper described in [../scraper.md](../scraper.md),
one file per task. Each task file says what to build, which files to touch, how
to know it is done, and carries a short prompt for starting it in a fresh agent
or session.

Written 2026-10-29. Branch `claude/gallant-davinci-kwmu2k`, last pushed commit
`badf0c5`.

## Where things stand

**Update 2026-10-29 (afternoon):** tasks 01 to 07 and 09 are done, verified and
pushed; task 08 stays out of version 1. The current state, test counts and what
still needs a person are in [../scraper-status.md](../scraper-status.md). The
text below is the plan as written before that work.

**Built, verified and pushed**

| Piece                                                                           | Where                                            | Tests              |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| Design spec and shared vocabulary                                               | `docs/scraper.md`, `packages/core/src/scrape.ts` | –                  |
| Admin API contracts                                                             | `packages/contracts/src/feed.ts`                 | 22                 |
| Scraper settings and licensed-mode checks                                       | `packages/config`                                | 45                 |
| Ratings update and in-house pricing                                             | `packages/feed/src/pricing/ratings.ts`           | 25                 |
| Name matching, time zones, fixture clustering                                   | `packages/scraper/src/normalize`, `match`        | 96                 |
| Source adapters (openfootball, generic JSON, generic HTML)                      | `packages/scraper/src/adapters`                  | 79                 |
| Polite fetcher, raw archive, cadence                                            | `packages/scraper/src/fetch`, `archive`          | 126                |
| Safety gates (fixture, result consensus, shape, odds)                           | `packages/scraper/src/gates`                     | 122                |
| Database: 10 tables, migrations 0033–0034, services                             | `packages/db/src/scrape`                         | 56 (db suite: 605) |
| Scraper process: run pipeline, promotion, staff confirmation, scheduler, health | `apps/scraper`                                   | 22                 |

**Started but cancelled before producing any output** (an interruption stopped
the background agents; nothing from them is on disk): task 01, the independent
review, and task 02, the admin API routes. Treat both as not started. The one
related change that did land is `"sideEffects": false` in
`packages/scraper/package.json`, which task 02 relies on.

**Not started:** tasks 01 to 09.

## Tasks, order and dependencies

```
01 review ──► fixes ───────────────┐
02 admin API ──► 03 admin pages ───┤
04 Docker / compose / CI ──────────┼──► 09 final verification ──► go-live checklist
05 operations docs (after 02–04) ──┤
06 re-pricing (after 01) ──────────┤
07 sources, ratings, shadow mode ──┘     (needs a person; its CLI part can start after 02)
08 later: live scores, other sports, browser fetching, licensed feed
```

| #                                           | Task                                      | Model / effort                          | Rough size         | Needs             | Blocks go-live?                            |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------- | ------------------ | ----------------- | ------------------------------------------ |
| [01](01-independent-review.md)              | Independent review and fixes              | Opus high, then Sonnet high             | 300k + 100k tokens | –                 | **yes** (no open critical or high finding) |
| [02](02-admin-api-routes.md)                | `/admin/feed/*` routes                    | Sonnet high                             | 250k               | contracts (done)  | **yes**                                    |
| [03](03-admin-pages.md)                     | Back-office pages                         | Sonnet medium                           | 250k               | 02                | **yes** (staff need a screen)              |
| [04](04-docker-compose-ci.md)               | Image, compose service, backups, CI       | Sonnet medium                           | 150k               | –                 | **yes**                                    |
| [05](05-operations-docs-and-runbooks.md)    | Operations guide and runbooks             | Haiku low                               | 80k                | 02, 03, 04        | recommended                                |
| [06](06-repricing-after-ratings.md)         | Re-price scheduled events (rule O3)       | Sonnet high                             | 200k               | 01                | no                                         |
| [07](07-sources-ratings-and-shadow-mode.md) | Source CLI, ratings backfill, shadow mode | Sonnet high (code), a person (the rest) | 200k + weeks       | 02                | **yes**                                    |
| [08](08-live-scores-and-extensions.md)      | Live scores and extensions                | Opus high                               | large              | v1 live in shadow | no (not version 1)                         |
| [09](09-final-verification-and-release.md)  | Full checks, release                      | orchestrator                            | 100k               | all of the above  | **yes**                                    |

Also read [known-limits.md](known-limits.md): every deviation and safer reading
the builders took, collected in one place.

## Budget and pacing

- Usage limits at the time of writing: weekly allowance **88%** used (resets
  **2026-10-30 20:00 UTC**); a 5-hour window resets every five hours (the one
  running at 07:56 UTC resets at 12:50 UTC).
- Measured cost: about 1.0M agent tokens cost about 6 points of the weekly
  allowance, so one point is roughly 170–200k tokens. Opus costs more per token
  than Sonnet; the sizes above are estimates, not promises.
- How to check usage cheaply: read the newest `rate_limit_event` of the session
  (`list_events` with `kinds: ["rate_limit_event"]`, `limit: 30`), which shows
  both utilisation figures.
- Rules while the allowance is tight: one wave of at most two agents at a time;
  check usage after each; stop starting new work at about 93% weekly and update
  [../scraper-status.md](../scraper-status.md) instead; use Opus only for tasks
  01 and 08; prefer `effort: high` over `max`.
- Agents must not commit; the orchestrator commits after verifying (typecheck,
  lint, format, the package's tests) and pushes.

## Definition of done for version 1

1. Tasks 01 to 04, 07 and 09 are finished; 05 is finished or consciously
   skipped.
2. No open critical or high finding from task 01.
3. At least two sources with different upstreams run in shadow mode for
   2–4 weeks and meet the scorecard in task 07.
4. One competition goes live with `auto_open` and `auto_results` both off:
   a trader opens betting and confirms every result. Automation is switched on
   per competition only after the scorecard holds for weeks.
5. Nothing in the system can cancel, void or abandon an event from scraped
   data (this is a property of the gates and is re-checked in task 09).
