# 06. Re-pricing scheduled events after ratings change (rule O3)

|                |                                                                     |
| -------------- | ------------------------------------------------------------------- |
| Status         | Not started                                                         |
| Model / effort | Sonnet, high                                                        |
| Size           | about 200k tokens                                                   |
| Depends on     | task 01 (so the review's findings are in before more code is added) |
| Blocks         | nothing                                                             |

## Why

Every applied result updates two teams' ratings. Events already created for
those teams keep the prices they were created with. Over a season the prices
drift away from the model; the site would offer stale prices on upcoming
matches.

## What to build (in `apps/scraper`)

A `repriceScheduledEvents(ctx)` step in the promote task, after results:

1. Load scheduled scraped events in the horizon (`listScrapedEvents`) whose home
   or away team has changed ratings since the event's markets were last priced
   (compare `matches` or a stored `priced_at`/`priced_matches` stamp; if no
   stamp exists, add the smallest field that is needed, in a new migration,
   rather than re-pricing everything every minute).
2. Compute the new book with `priceFixture('football', home, away)`.
3. Read the event's current markets (`marketsWithSelections` in `@vamos/db`) and
   call the gate `checkReprice(previous, next)`:
   - `ok` -> apply with `upsertFixture` (it only moves open and suspended
     selections whose feed price moved) or `setSelectionOdds` with source
     `scraper`, in one transaction per event, then publish the deltas after
     COMMIT; audit `scrape.fixture.repriced`;
   - not ok -> keep the old prices and open the gates' `repriceReview` item
     (kind `odds_approval`, subject key `<feedRef>|reprice`) with the proposal.
4. Never re-price an event that is not `scheduled`, whose teams stopped being
   calibrated, or whose kickoff is within `MIN_LEAD_MS`.
5. A trader approving a reprice item uses the same route as opening betting
   (task 02 would need a `apply_reprice` decision; add it to the contract and
   route, with a test, if this task is done after task 02).

## Tests

Real Postgres: ratings change -> prices move within the ratio and are applied
once; a move beyond the ratio is held with a review item and prices unchanged;
repeated runs change nothing; an event with bets is re-priced only for future
bets (existing bets keep their odds: check with the betting fixtures); a
closed event is re-priced but stays closed.

## Acceptance

Tests pass, `pnpm --filter @vamos/scraper-app test` and the db suite stay green,
`docs/scraper.md` rule O3 and the status file are updated.

## Prompt to start it

> Read `docs/scraper-plan/06-repricing-after-ratings.md`, the gates in
> `packages/scraper/src/gates/odds.ts` and `apps/scraper/src/pipeline`; implement
> the re-pricing step as described with tests. Do not commit.
