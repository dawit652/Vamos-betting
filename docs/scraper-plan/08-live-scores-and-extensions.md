# 08. Later: live scores and other extensions

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| Status         | Not part of version 1                                  |
| Model / effort | Opus, high for the rules; Sonnet for the plumbing      |
| Size           | large; plan it as its own project                      |
| Depends on     | version 1 running in shadow without unexplained errors |

None of this is needed to take pre-match bets on football. It is written down so
that the design choices are not lost.

## A. Live scores (in-play betting)

Scraped live data is slower and less reliable than an official feed. Only do
this with a licensed provider or a source that is fast and permitted.

- New observation kind `live` (minute, period, score) in `types.ts`, the core
  vocabulary, the adapters and the database tables (a new migration).
- New gate rules, with ids, tests and a reference model like the result rules:
  - L1 a score only changes by small positive steps and never goes down;
  - L2 the minute never goes backwards; periods follow a legal order;
  - L3 a goal needs a second source or a short stability window before odds
    react (the platform's live-bet acceptance delay helps but does not replace
    this);
  - L4 **staleness fails closed**: no fresh observation for N seconds in play ->
    `suspendEvent` (suspended by `feed`, so only the feed reopens it); reopen
    only on fresh, consistent data;
  - L5 any violated rule -> suspend, change nothing, open a review item.
- In-play prices from `priceMatch(..., { state })` with the live margin; apply
  with `applyLiveState` and `setSelectionOdds`; cash-out depends on
  `stateChangedAt`, so scores must be written only when they really changed.
- Settlement of in-play markets (`resultMarket` for markets decided early) is a
  separate, riskier step: do it last.

## B. Other sports

Basketball, tennis and volleyball have no draws and different score shapes.
Each needs: observation score types, adapter support, `resultEvent` semantics
(winner markets), rating updates (`updateFootballRatings` is football only),
pricing checks (`priceFixture` refuses other sports on purpose) and calibration
rules. Do them one sport at a time, each with its own shadow period.

## C. Headless-browser fetching

For sources that render their data in the browser. Playwright is already a
dependency of `e2e`. Constraints: a separate, sandboxed process (memory and CPU
limits, no access to the database), the same allow-list, robots and rate limits,
no login, no CAPTCHA or bot-protection circumvention, and a per-source switch.
Prefer finding the JSON endpoint the page itself calls.

## D. Smaller items

- `json-ld` mode for the generic HTML adapter (schema.org `SportsEvent`).
- A licensed-provider adapter (`licensed_api` kind) as a second upstream.
- iCalendar (`ical`) adapter for club and league calendars.
- A private-address and DNS-rebinding check in the fetcher (today only the
  exact-host allow-list protects against fetching internal addresses).
- Metrics endpoint and alerting rules for the run statuses.
- A per-source terms flag shown in the back office.

## Prompt to start A

> Read `docs/scraper-plan/08-live-scores-and-extensions.md` section A and
> `docs/scraper.md`; first write the rule specification (L1–L5 with the same
> structure as the result rules) and have it reviewed before any code.
