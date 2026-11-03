# Real Odds API samples

Real responses from The Odds API v4, `eu` region, captured on 2026-11-03 at about 15:13Z by
`scripts/odds-api/capture-samples.ps1`. The capture is truncated: odds calls keep the first 2 events
and the first 6-8 bookmakers per event; scores keep a few rows. No API key is stored in these files.
The older files in `fixtures/` (not `real/`) are hand-made. Tests: `../real-samples.test.ts`.

Files: `sports.json` (all=true), `events-epl.json`, `odds-{epl,ucl,nba,tennis}.json`,
`scores-{epl,ucl,nba,tennis}.json`, `event-odds-epl.json` (one `/events/{id}/odds` object),
`event-markets-epl.json` (bookmaker to market keys), `participants-epl.json`, `errors.json` (status
and body of a 422 and a 404), `quota.json` (`x-requests-*` per call).

Facts learned:

- Per-event odds give a bookmaker no `last_update`; only its markets have one.
- A price of exactly 1.0 means "no price" (1xBet alternate totals); it is not a real quote.
- Exchanges (betfair_ex_eu, matchbook) also return `h2h_lay` markets, which are not back prices.
- Totals come on whole and half lines (3.0, 219.0, 218.5, 2.5); only half lines are usable.
- Soccer spreads are Asian handicaps, including 0.0 and plus or minus 1.0.
- Tennis returns no scores: `scores` and `last_update` are null.
- Cost is markets x regions per odds call; scores cost 2 with `daysFrom`; `/sports` and `/events` are free.
- An error body is `{ message, error_code, details_url }`.
