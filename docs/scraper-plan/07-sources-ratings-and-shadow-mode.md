# 07. Real sources, ratings and shadow mode

|                |                                                               |
| -------------- | ------------------------------------------------------------- |
| Status         | Not started (partly needs a person)                           |
| Model / effort | Sonnet, high for the CLI; people for the rest                 |
| Size           | CLI about 200k tokens; shadow mode 2–4 weeks of calendar time |
| Depends on     | task 02 for the review queue; the CLI can start earlier       |
| Blocks         | go-live                                                       |

## What only a person can do

1. **Choose the competitions** to cover first (one is enough).
2. **Find sources and read their terms.** For each: robots.txt, terms of use,
   whether automated access is permitted, the exact hosts. Record the decision.
   Do not use sources that forbid it.
3. **Write down each source's upstream** (who produces the data). The result
   rules count upstreams, not sources, so two sites copying the same vendor are
   one vote. At least **two sources with different upstreams** are needed for
   any result to apply; a licensed data provider is the best second source.
4. **Seed the teams**: catalogue teams and their names for the competition,
   starting ratings (or a season of history to replay), and a trader who reviews
   the first prices. The reference adapter's dataset (openfootball) covers major
   European leagues only, not Costa Rica or Ethiopia.

## Code to build: a source and ratings CLI (`apps/scraper/src/cli.ts`)

No admin screen creates sources, so onboarding needs a command line. Commands
(add a `cli` script to `apps/scraper/package.json`):

| Command                                                                 | What it does                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources list`                                                          | print `scrape_sources` with state                                                                                                                                             |
| `sources upsert --file source.json`                                     | validate with `createAdapter`, then `upsertSource`; a new source starts **disabled**                                                                                          |
| `dry-parse --source-file source.json --document page.html`              | parse a saved document and print observations and issues; no database, no network                                                                                             |
| `dry-fetch --source-file source.json`                                   | fetch through the `PoliteFetcher` (allow-list, robots, rate limit) and parse; print; **no database writes**                                                                   |
| `aliases import --file aliases.csv`                                     | bulk `addTeamAlias` / `addCompetitionAlias` (idempotent)                                                                                                                      |
| `ratings backfill --file results.json --competition <slug> [--dry-run]` | `replayRatings` over historical results in date order, then `setTeamRatings` with the `matches` count; refuses to overwrite a team with `manual = 1`; prints before and after |

Tests for each command on a real Postgres or with pure inputs. The backfill must
be idempotent per run (re-running with the same file must not double count:
store the highest replayed date or refuse when `matches` is already above the
file's count).

## Shadow mode

Run with every competition policy **off** (`enabled = false`): the scraper stores
observations and opens review items but creates nothing. Compare against a
ground truth that does not come from the scraper (an official site, a licensed
provider, or hand-checked samples).

Scorecard to meet for the last two weeks before anything is enabled:

| Measure                                                                     | Target                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Runs ending `broken` or `blocked`                                           | 0 unexplained                                                       |
| Open `unknown_team` / `unknown_competition` items older than 7 days         | 0                                                                   |
| Fixtures: clusters where sources disagree on kickoff by more than 5 minutes | explained or 0                                                      |
| Results: matches where both upstreams agreed within the confirmation window | all but explained exceptions                                        |
| Results compared with ground truth (at least 200 matches)                   | 100% identical regular-time scores, 0 unexplained `result_conflict` |
| Median time from the final whistle to "confirmed"                           | recorded; acceptable to the traders                                 |
| Events created, moved or changed that nobody expected (audit log review)    | 0                                                                   |
| Archive growth and fetch error rate                                         | within the storage plan; no robots refusals                         |

## Enabling order afterwards (from `docs/scraper.md` section 10)

1. Fixtures for one competition: policy `enabled`, `auto_open` off. A trader
   opens betting after looking at the prices.
2. Results through `result_ready` (a person confirms each).
3. `auto_results` for that competition after weeks of full agreement.
4. `auto_open` last, and only if the model's prices have been good.
   Each step is reversible by switching the flag off.

## Acceptance

CLI tests pass; the scorecard is filled in and saved
(`docs/scraper-plan/shadow-scorecard-<competition>.md`); each source has a
recorded terms check and upstream.

## Prompt to start the CLI part

> Read `docs/scraper-plan/07-sources-ratings-and-shadow-mode.md`; build
> `apps/scraper/src/cli.ts` and its tests as described, using `createAdapter`,
> `PoliteFetcher`, `upsertSource`, `addTeamAlias` and `replayRatings`. Do not
> commit.
