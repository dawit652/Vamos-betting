# 02. Back-office API routes (`/admin/feed/*`)

|                |                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status         | **In progress** when this plan was written (a Sonnet agent was building it; check `apps/api/src/modules/admin/feed.ts` and `apps/api/test/admin-feed.test.ts` before restarting) |
| Model / effort | Sonnet, high                                                                                                                                                                     |
| Size           | about 250k tokens                                                                                                                                                                |
| Depends on     | contracts `packages/contracts/src/feed.ts` (done), database services (done)                                                                                                      |
| Blocks         | task 03                                                                                                                                                                          |

## Goal

Let staff see the health of the sources, work the review queue and control the
scraper from the back office, without any request ever being able to supply a
score or cancel an event.

## Routes (exactly the contract table)

| Route                                                  | Permission                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GET /admin/feed/health`                               | `trading.view`                                                             |
| `GET /admin/feed/review`, `GET /admin/feed/review/:id` | `trading.view`                                                             |
| `POST /admin/feed/review/:id/resolve`                  | `trading.status` (and `trading.result` for `apply_result`, checked inside) |
| `GET /admin/feed/aliases`                              | `trading.view`                                                             |
| `POST /admin/feed/aliases`                             | `trading.status`                                                           |
| `PUT /admin/feed/sources/:id` (enable or disable)      | `trading.status`                                                           |
| `GET /admin/feed/competitions`                         | `trading.view`                                                             |
| `PUT /admin/feed/competitions/:id` (policy flags)      | `settings.edit`                                                            |

The registered routes must equal the contract table (the compliance test
`registers exactly the contract routes` is the pattern).

## Behaviour of `POST /admin/feed/review/:id/resolve`

The body is a strict discriminated union on `decision`; unknown fields are
rejected, so a client can never send a score.

| Decision                          | Allowed for kind                           | Effect                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dismiss` {note}                  | any open item                              | resolve as dismissed with the note                                                                                                                                                                              |
| `map_alias` {targetId, sourceId?} | `unknown_team`, `unknown_competition`      | alias text = `normalizeName(payload.raw)`, sport `football`; add the alias (idempotent); resolve the item. The scraper's next promote pass re-resolves stored observations                                      |
| `open_betting`                    | `odds_approval`                            | only if the event is `scheduled`, unresulted, kickoff at least `MIN_LEAD_MS` ahead and betting is closed: `setEventBettingOpen(true)` and resolve, in one transaction; publish deltas the way `trading.ts` does |
| `apply_result`                    | `result_ready`, `result_unverified` (open) | resolve with the text `{"decision":"apply_result","by":"<admin id>"}`. **Nothing else**: the scraper applies the score from the item payload after re-validating. Needs `trading.result`                        |
| `apply_kickoff`                   | `kickoff_change`                           | validate event scheduled and unresulted and `proposedKickoff` at least `MIN_LEAD_MS` ahead; update only the start time (`upsertFixture` with no markets, so nothing is re-priced); resolve                      |

Any other kind and decision combination answers 422 with a clear code; a
non-open item 409; an unknown id 404.

## Other behaviour

- `GET /admin/feed/health`: `sourceHealth(now)`, `countReviewItemsByKind` and
  `listCompetitionPolicies`; each source's `state` is `disabled`, `broken` or
  `blocked` (from the last run), `stale` (last ok run older than three times its
  cadence, or never), `learning` (fewer than 3 ok runs) or `ok`.
- Source enable/disable and the competition policy go through the existing
  audited services. A policy for a competition that does not exist is 404.
- Every mutation is audited with the staff actor (the services already audit; do
  not double-audit).
- `apps/api/package.json` gains `"@vamos/scraper": "workspace:*"` (the package
  is `sideEffects: false`, so only `normalizeName` is bundled).

## Files

- create `apps/api/src/modules/admin/feed.ts`, `apps/api/test/admin-feed.test.ts`
- change the file where the compliance routes are registered
  (`apps/api/src/modules/admin/routes.ts`), `apps/api/package.json`

## Tests required

- RBAC table: 401 without a session, 403 per role lacking the permission, per
  route.
- Happy path and main refusals for each route.
- A body with an extra `score` field is rejected.
- `map_alias` creates the alias and closes the item; `apply_result` stores only
  the decision text; `open_betting` only for scheduled `odds_approval` events
  with a future kickoff; `apply_kickoff` moves only the start time (markets and
  odds unchanged); audit rows exist.
- Drift test: the closed sets in `packages/contracts/src/feed.ts` equal the
  `SCRAPE_*` arrays of `@vamos/core`.

## Acceptance

`pnpm --filter @vamos/api typecheck`, the new test file passes, lint and format
clean on the touched files, and the existing admin tests still pass.

## Prompt to start it

> Read `docs/scraper-plan/02-admin-api-routes.md`, `docs/scraper.md` section 8
> and `packages/contracts/src/feed.ts`, then implement the routes exactly as
> described, copying the style of `apps/api/src/modules/admin/compliance.ts`.
> Do not commit.
