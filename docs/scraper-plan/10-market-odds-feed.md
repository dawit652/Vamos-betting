# 10. A licensed market odds feed (plan)

Status (2026-11-01): **the owner reversed "check only" to "market first"; built, unverified against the real
provider.** The plan below (M1 to M5, steps 1 to 8: a check that only closes) is **not** what was built. By the
owner's decision, bookmaker odds from the licensed feed now get priority over our team-rating model when pricing a
competition that is switched to it (`docs/scraper.md` section 1 and rule O5; default is still the model).
Built: the adapter `therundown` (american or decimal prices to integer milli, golden file synthetic), the table
`scrape_market_odds` with its queries and pruning (migration 0038), the consensus (`marketConsensus` in
`packages/core`, median of margin-free books, at least 2 books), the pricing from it (`packages/feed/src/pricing/market.ts`:
1X2, double chance, draw no bet and the 2.5 line from the consensus, the rest from a goals model fitted to it, fit
residual at most 0.03), the per-competition flag `pricing_source` (migration 0039, a select on the back office
`/feed` page), the shared `priceEvent` and the re-pricing and hand-over changes (`apps/scraper/src/pipeline`).
Every price change still goes through the O3 bounds, O2 and a trader. **Not built:** M2 out-of-line check, M3, M4,
the review kind `odds_out_of_line`, M5 (the feed's fixtures and results as a second upstream), the replay
acceptance of step 6 and the request budget alarms. **Not done and needed first:** the written licence (G2), one
real response to replace the synthetic golden file and confirm `priceFormat`, the sport id, `periodId` and the
market ids (see `docs/scraper-operations.md` section 8). Original status: plan, not built. Owner of the decision to buy: the person running Nahubet. Related fix-plan items: F-05
(exposure policy, high), F-06 (a second upstream, high), F-17 (draw pricing).

## Why, in one paragraph

Our prices come from our own model (team ratings, `packages/feed/src/pricing`). The odds evaluation showed what
that costs: a customer who simply bets wherever our price is longer than the market's makes +12.5% over 891 bets
(F-05). A feed of what 25+ bookmakers offer is the cheapest protection against that: it tells us, before a bet is
accepted, when our price is out of line with the market. It can also give a second, independent source of kickoff
times and results, which the kickoff-safety rules (K2, `kickoff-safety.md`) and the result rules (R2) need. It does
**not** change the rule that copied bookmaker odds are never shown to players (`docs/scraper.md` section 1): we use
the market as a check on our prices, not as our prices.

## 0. Before any money is spent (owner)

| Gate | Pass when                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | The plan is an **API plan** with a key, request limits and documented endpoints (the $24.99 "Basic" card shown on 2026-10-31 is the viewing product for bettors: web and app screens, no API) |
| G2   | The licence allows use by a **betting operator** to manage its own prices, confirmed in writing by the provider                                                                               |
| G3   | It covers our competitions: Premier League and Costa Rica's Primera División at least                                                                                                         |
| G4   | For football it gives prematch 1X2 and over/under 2.5 from several bookmakers, with a timestamp per price                                                                                     |
| G5   | Optional but valuable: fixtures with kickoff times, final scores (half time too), postponed/cancelled status                                                                                  |
| G6   | The key can be sent in a request header (else step 2 adds a redacted query-string key, see below)                                                                                             |

If G1 or G2 fails, stop: do not build. Send the documentation link to the developer; nothing is coded before G1-G4
are known from the real documentation and one real response.

## 1. What it will do (rules, to be specified in `docs/scraper.md` before code)

- **M1 Market snapshot.** For each scraped event with open or soon-open betting, the scraper reads the market
  prices for 1X2 and over/under 2.5 on a schedule (more often near kickoff), stores them as observations of a new
  data class `market_odds` (raw page archived like every read), and computes a **consensus price** per selection:
  the median of the bookmakers' implied probabilities with their margin removed. Never shown to players.
- **M2 Out-of-line check.** Before betting opens, and on every price change, our fair probability is compared with
  the consensus. If any main selection differs by more than a threshold (start: 4 percentage points, to be set by the
  replay in step 6), the event cannot be opened without a trader, and an open event is **closed** with a review item
  `odds_out_of_line` showing both prices. Same fail-closed shape as K1: it can only close, never open, never change a
  price by itself.
- **M3 No market, no automatic opening.** An event with no fresh consensus (older than its schedule allows) is
  treated as unchecked: a trader must open it, exactly like an unconfirmed kickoff.
- **M4 Stake limits from disagreement (with F-05).** The exposure policy decides per-bet and per-event limits;
  the smaller the agreement with the market, the lower the limit. Specified with F-05, not before.
- **M5 Second upstream (if G5 passes).** Fixtures and scores from the same provider become an ordinary
  `generic-json` source with its own `upstream` name, so they count towards K2 (kickoff confirmation, C1) and R2
  (two independent results). Half time missing means it cannot vote on events with half-time markets (R2).

Never: publish the feed's prices, copy them into our markets, settle anything from them, or use them to void bets.

## 2. Work, in order (each step committed with its tests green)

| Step | What                                                                                                                                                                                                                                                                                          | Size | Model / effort                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------- |
| 1    | Spec: rules M1 to M5 in `docs/scraper.md`, thresholds as named constants, review kind `odds_out_of_line`, a fail-closed argument like section 4 of `kickoff-safety.md`                                                                                                                        | M    | Opus high                                               |
| 2    | Source plumbing: if the key must go in the URL, add a query-string secret that is removed from every log, archive name and stored URL (tested); else reuse the header secret (`SCRAPER_SECRET_<NAME>`)                                                                                        | S    | Sonnet high                                             |
| 3    | Adapter `market-odds` (one real response saved as a golden fixture): parse bookmakers, markets, prices, timestamps; consensus with margin removed in `packages/core` (pure, unit and property tests)                                                                                          | M    | Sonnet high                                             |
| 4    | Storage and migration: data class `market_odds`, observation rows, retention like other raw pages                                                                                                                                                                                             | S-M  | Sonnet high                                             |
| 5    | Gates M2, M3 in `packages/scraper/src/gates`, the closing pass and the opening guard (both reuse the kickoff-safety plumbing: `assertScrapedEventMayOpen`, the row lock, audit, live delta), review kind through core, contracts, migration and the back office (the contract test covers it) | M    | Sonnet high                                             |
| 6    | Replay acceptance: re-run the odds evaluation (`apps/scraper/src/eval/odds-market.ts`) with M2 on: the +12.5% edge must fall to about zero, and report how many correct events a trader then has to open                                                                                      | M    | Sonnet high                                             |
| 7    | M5 if G5 passes: the provider's fixtures and results as a second `generic-json` source, shadow first (compared with openfootball and the official sites for a few weeks before it counts)                                                                                                     | M    | Sonnet high, Opus high review of the agreement settings |
| 8    | Operations: back-office wording, runbook "odds out of line", request budget (calls per day against the plan's limit), alarms when the feed is stale (reuse S5)                                                                                                                                | S    | Sonnet medium                                           |

Estimated: about one week of agent work spread over several sessions; steps 1-6 are the part that protects money.

## 3. What the owner provides

1. The provider's name and its API documentation link (or one sample response with the key removed).
2. The written answer on use by a betting operator (G2).
3. The key, put only in the server's environment as `SCRAPER_SECRET_<NAME>` (never in chat, the database or files).
4. Decisions: the M2 threshold after the replay (step 6), and the stake limits with F-05.

## 4. Costs and risks

- Monthly fee plus request budget: near kickoff the schedule reads more often; step 8 sizes it against the plan.
- A feed outage must never open anything: M3 makes "no market data" mean "a trader decides".
- Bookmakers move together on news (injuries); a large move that our ratings do not know about is exactly when M2
  should close betting, so that is intended, not a false alarm.
- Licence: using a consumer plan for an operator is likely a breach of its terms; G2 exists for that.
