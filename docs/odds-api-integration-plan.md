# The Odds API integration plan

_Plan date: 3 Nov 2026. Branch `claude/cool-albattani-kldl81`. Companion to [build-plan.md](./build-plan.md)._

Status of each phase is in §13. Repo rules are in `CLAUDE.md`; they all apply (bigint santim, integer milli
odds, double-entry ledger, zod at the edges, never weaken the licensed-mode guard).

## 1. Goal

Replace simulated odds with real market odds from [The Odds API](https://the-odds-api.com) (v4) in demo mode, and
make the same integration usable in licensed mode behind stricter checks.

- Every match a player sees is priced from real bookmaker odds. Nothing simulated is presented as real.
- Our prices are more accurate than any single bookmaker's: a consensus of many books, sharp books weighted up,
  margins removed properly, stale and outlying quotes dropped (§4).
- The sports, countries and leagues The Odds API covers become browsable categories (§6).
- Results come from the API's scores, so bets settle without a trader (§8).
- Good features of well-known sportsbooks are adopted where they fit the Ethiopian product (§11).

## 2. The Odds API in brief

| Endpoint                                   | Gives                                                                                                             | Credits                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `GET /v4/sports`                           | every sport key: `group`, `title`, `description`, `active`, `has_outrights`                                       | free                       |
| `GET /v4/sports/{key}/events`              | upcoming and live events (id, teams, `commence_time`), no odds                                                    | free                       |
| `GET /v4/sports/{key}/odds`                | every event of a league with each bookmaker's featured markets (`h2h`, `spreads`, `totals`, `outrights`, `*_lay`) | markets × regions          |
| `GET /v4/sports/{key}/events/{id}/odds`    | one event, any market (`btts`, `draw_no_bet`, `alternate_totals`, period markets…)                                | markets returned × regions |
| `GET /v4/sports/{key}/events/{id}/markets` | the markets each bookmaker has for an event                                                                       | 1                          |
| `GET /v4/sports/{key}/scores`              | live scores; with `daysFrom=1..3` also completed results                                                          | 1, or 2 with `daysFrom`    |
| `GET /v4/sports/{key}/participants`        | team or player names of a league                                                                                  | 1                          |
| `GET /v4/historical/…`                     | past odds snapshots (paid plans)                                                                                  | 10 × markets × regions     |

- One `/odds` call returns every event of a league, so the cost grows with leagues × markets × regions, not
  with the number of events.
- `regions`: `eu`, `uk`, `us`, `us2`, `au` (plus `us_ex`, `us_dfs`). A `bookmakers` list costs one region per
  10 bookmakers. The `eu` region includes **Pinnacle** and **Betfair Exchange**, the sharpest prices available.
- Every response carries `x-requests-remaining`, `x-requests-used` and `x-requests-last` (cost of the call).
- Prices are decimal (`oddsFormat=decimal`). Each bookmaker market has its own `last_update`.
- Scores update about every 30 s in play. They give the total score only (strings): no match minute, no
  half-time score, no periods.

**Gaps that shape the design** (to confirm against real responses, see §14):

- No Ethiopian Premier League and, as far as known, no CAF club competitions. AFCON appears only while it runs.
- No volleyball.
- Tennis keys are per tournament (`tennis_atp_paris_masters`, …) and exist only while the tournament runs.
- Outright keys (`*_winner`) have no home/away teams and are never resulted by the API.
- No half-time scores, so half-time markets cannot be settled from it.
- It aggregates bookmakers' public prices; it is not an official data feed. In-play prices lag the action by
  tens of seconds.

**Network:** this cloud environment cannot reach `the-odds-api.com` yet. Add `api.the-odds-api.com` to the
environment's allowed domains (or run the capture script on a machine that can reach it).
`scripts/odds-api/capture-samples.ps1` records real responses for the tests without exposing the key.

## 3. Architecture

```
 The Odds API ─HTTPS─► worker: oddsapi tasks ────────────► PostgreSQL ──► api ──► web, admin
   /sports, /events      catalogue sync (free, 6 h)      feed_leagues, categories, competitions, teams
   /odds                 odds poller (adaptive)          events, markets, selections, odds_history
   /scores               scores poller + results         feed_results → resultEvent → settlement (as today)
                         stale-odds sweep                markets suspended by 'feed'
                         credit governor                 feed_api_calls (credit log)
                               │
                               └──► Redis live channel → SSE deltas (as today)
```

Pure code goes in `@vamos/feed` (no database or Redis; network only through an injected `fetch`):

| Module                     | Responsibility                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `oddsapi/schema.ts`        | zod schemas of the responses. A malformed item is dropped and counted, never trusted.                              |
| `oddsapi/client.ts`        | HTTP client: timeout, retry with backoff on 429/5xx/network errors, quota headers, the key never in logs or errors |
| `oddsapi/leagues.ts`       | registry: sport key → our sport, category (country), competition, names, flags                                     |
| `oddsapi/map.ts`           | bookmaker markets → our market types and selection codes                                                           |
| `consensus/devig.ts`       | margin removal per bookmaker (power method, multiplicative fallback)                                               |
| `consensus/consensus.ts`   | staleness filter, outlier rejection, weighted consensus, quorum, dispersion                                        |
| `consensus/lines.ts`       | half-point line grouping and main-line choice                                                                      |
| `consensus/goals-model.ts` | Dixon–Coles fit to the consensus 1X2 + total; derived markets                                                      |
| `consensus/price.ts`       | fair probabilities → our odds with margin (reuses `buildMarket` / `priceProbability`)                              |

The database layer (`@vamos/db`), the worker tasks (`apps/worker/src/tasks/oddsapi/*`), the api and the admin
change as described in the phases. The mock provider, live simulator and drift keep working for
`FEED_PROVIDER=mock`; none of them ever touches an event of another provider.

## 4. Odds accuracy

Each market is priced from scratch on every poll:

1. **Map** each bookmaker's outcomes to our selection codes (`home`→`1`, `Draw`→`X`, `away`→`2`,
   `Over`/`Under` + `point`). A bookmaker missing an outcome, or with a price ≤ 1, is dropped for that market.
2. **Drop stale quotes.** A bookmaker market whose `last_update` is older than the limit is ignored: 60 min
   prematch (15 min inside the last 3 hours before kick-off), 90 s in play. In play, quotes older than the last
   score change are ignored too (they are pre-goal prices).
3. **Remove each bookmaker's margin** with the **power method** (find k with Σ (1/oᵢ)ᵏ = 1). It corrects the
   favourite–longshot bias better than plain normalisation. Multiplicative normalisation is the fallback.
4. **Reject outliers.** With 3+ books, a book whose fair probability for any outcome is more than
   max(3 pp, 3 × 1.4826 × MAD) from the median is dropped (typically a stale or erroneous price).
5. **Weighted consensus.** Weighted mean of the fair probabilities, renormalised. Default weights: Pinnacle 3,
   Betfair/Matchbook/Smarkets exchanges 3, other books 1 (configurable).
6. **Quorum and agreement.** At least `ODDS_API_MIN_BOOKS` books (demo 2, licensed ≥ 3 with at least one sharp
   book). If the books still disagree by more than 8 pp on an outcome, the market is suspended: that usually
   means news (line-ups, injuries) that some books have not priced yet.
7. **Our margin.** Default 6% on main markets prematch, +2 pp in play, +2 pp on model-derived markets, 15% on
   correct score; configurable per league. Prices are rounded **down** to the hundredth, as today.
8. **Asymmetric updates.** A shortening price is written at once (a stale longer price would give value away);
   a lengthening price is written when it moves by 1% or more. Unchanged prices write nothing.
9. **Lines.** Only half-point lines are offered (whole and quarter lines can push or split). The main line is
   the one most books quote; ties go to the line closest to 50/50.
10. **Market-implied goals model.** For football, a Dixon–Coles model (λ home, λ away, ρ) is fitted to the
    consensus 1X2 and the main total. It prices BTTS, correct score and the other goal lines consistently with
    the real market. Used only when the fit error is ≤ 1.5 pp on every input; otherwise those markets stay
    suspended. Double chance and draw-no-bet are exact transforms of the consensus 1X2 (no model).
11. **Freshness guard.** A sweep suspends (as `feed`) every market of an event whose consensus is older than
    its limit; the next fresh poll re-opens them. Suspended is better than wrong.
12. **Measure it.** The last pre-kick-off consensus (the closing line) is kept per selection. The back office
    reports Brier score and log-loss per league, and each player's closing-line value (to spot sharp bettors).
13. **Spend credits where bets happen.** Polling is most frequent near kick-off and in play (§9).

All of steps 3–10 are pure functions with unit and property tests (fast-check): de-vigged probabilities sum
to 1, our price never exceeds the fair price, more books never make a market less available, and so on.

## 5. Market mapping

| Sport      | API market             | Our market                      | Source                                           |
| ---------- | ---------------------- | ------------------------------- | ------------------------------------------------ |
| football   | `h2h` (home/Draw/away) | `1x2`                           | consensus                                        |
| football   | from the 1X2 consensus | `dc`, `dnb`                     | exact transforms                                 |
| football   | `totals` (x.5 lines)   | `ou:<line>`                     | consensus; whole and quarter lines ignored       |
| football   | (none on `/odds`)      | `btts`, `cs`, other `ou` lines  | Dixon–Coles fit, gated on fit quality            |
| football   | `spreads` (x.5 lines)  | `hcp:<line>` (new)              | consensus, Phase 11                              |
| football   | —                      | `ht_1x2`                        | **not offered**: no half-time score to settle it |
| basketball | `h2h`                  | `ml` (incl. overtime)           | consensus                                        |
| basketball | `totals`               | `total:<line>` (incl. overtime) | consensus                                        |
| basketball | `spreads`              | `hcp:<line>` (new)              | consensus, Phase 11                              |
| tennis     | `h2h`                  | `winner`                        | consensus; retirement rule in §8                 |

The per-event endpoint (`btts`, `draw_no_bet`, `alternate_totals`) costs credits per event. It is used, within
budget, only for featured matches to check the model's derived prices against the market.

## 6. Categories, leagues and teams

- **Catalogue sync** (free, every 6 h): `/sports?all=true` → one `feed_leagues` row per sport key (group,
  title, description, active, has_outrights, enabled, poll state, last error, margin override).
- **Registry** (`oddsapi/leagues.ts`) maps each key to our sport, a category (country or region with its
  ISO code, so the web can show a flag) and a competition. Known keys reuse the seeded rows and their Amharic
  names (`soccer_epl` → England / Premier League, `basketball_nba` → USA / NBA, …). Unknown keys get a
  category from the title's "– Country" suffix or the group. Tennis gets ATP / WTA categories with one
  competition per tournament.
- **Which leagues are on:** football, basketball and tennis keys in the registry's tier 1 by default (top
  European leagues, UEFA competitions, NBA, Euroleague, ATP/WTA), plus anything in `ODDS_API_SPORTS`. Staff
  switch leagues on and off in the back office. Politics and other non-sport keys are never enabled.
- **Teams** are created on first sight by exact name; `feed_team_aliases` (provider, sport, external name →
  team) lets staff merge a name into an existing team and keep its Amharic name.
- **An event is created only when its first consensus has quorum**, so the board never shows a match without
  real prices. `/events` (free) tells the scheduler when a league has matches coming, without spending credits.
- **Browsing** (Betika/SportyBet style): sport chips → countries with flags → leagues with match counts, a
  "Top leagues" row, and search by team or league (Phase 8).

## 7. In play

- At `commence_time` prematch markets stop being bettable (as today). With in-play off, nothing else happens.
- With in-play on, the poller fetches the league every 60 s while it has a live match. Markets reopen only with
  a fresh consensus whose quotes are newer than the last score change; otherwise they stay suspended.
- A score change seen on `/scores` suspends every market of the event at once.
- The live delay (6 s) stays. Licensed mode keeps in-play off unless `ODDS_API_INPLAY=true` (aggregated prices
  lag; an official feed is the right source for real-money in-play).
- Real events have no match clock: the web shows "LIVE" and the score.
- Early in-play settlement (`certainMarketResult`) is not used for real events: API scores can be revised.

## 8. Results and settlement

- The scores poller asks for `daysFrom=1` while a league has live or unresulted matches (every 2 min in play,
  every 10 min after the expected end).
- `completed: true` with both scores → a `feed_results` row. After `ODDS_API_RESULT_CONFIRM_MINUTES` (default 10) with the same score on a later poll, the event is resulted with `resultEvent` and settlement runs through
  the outbox exactly as today. A changed score restarts the wait.
- **Needs staff review instead** (back office queue, one click to accept the feed score):
  - cup competitions in licensed mode (90-minute markets; the API score may include extra time or penalties)
  - tennis in licensed mode (retirements and walkovers)
  - any score the mapping cannot read
- **Overdue:** no result 48 h after kick-off → markets suspended and the event goes to the review queue. Demo
  mode voids it after 72 h so play-money bets do not hang.
- **Postponement:** a start time that moves more than 48 h after bets were taken voids the old event and
  creates a new one (house rule), instead of silently moving the bets.
- An event that disappears from `/odds` is never cancelled for that reason alone (bookmakers pull prices for
  many reasons); its markets go stale and are suspended until it comes back or a result arrives.

## 9. Credits and polling

Cost per league call: football `h2h,totals` = 2, basketball `h2h,totals,spreads` = 3, tennis `h2h` = 1 (one
region). Scores with `daysFrom` = 2.

| Next kick-off in the league | Odds poll every                |
| --------------------------- | ------------------------------ |
| match in play (in-play on)  | 60 s                           |
| ≤ 1 h                       | 5 min                          |
| ≤ 6 h                       | 15 min                         |
| ≤ 24 h                      | 60 min                         |
| ≤ 72 h                      | 3 h                            |
| later or none               | not polled (`/events` is free) |

Rough cost of one league's match day: ~100 credits prematch, ~480 for 4 h of in-play polling, ~250 for
scores. Fifteen leagues with ten match days a month come to about 50K credits a month without in-play and
about 125K with it on every league.

The **governor** keeps spending inside `ODDS_API_MONTHLY_CREDITS`:

- every call is logged in `feed_api_calls` (endpoint, league, cost, status, remaining);
- when the trailing 24 h spend runs ahead of monthly ÷ 30, every interval stretches by the same factor;
- below `ODDS_API_RESERVE_PERCENT` of the quota, only in-play and scores run; below 1%, only scores of events
  with open bets;
- 401 (bad key or no credits left) pauses the provider for an hour and raises an alert; 429 backs off.

Recommendation: the 100K-credit plan for the demo with in-play on the top leagues only; measure one week and
adjust. Check the current plans on the API's pricing page.

## 10. Demo and licensed mode

|                                       | demo                                            | licensed                                            |
| ------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `FEED_PROVIDER=theoddsapi`            | allowed                                         | allowed only with every check below                 |
| `ODDS_API_KEY`                        | required                                        | required                                            |
| `ODDS_API_BASE_URL`                   | any                                             | https only                                          |
| minimum books                         | 2                                               | 3, at least one sharp                               |
| in-play                               | on                                              | off unless `ODDS_API_INPLAY=true`                   |
| results                               | automatic after the confirmation wait           | cups and tennis reviewed by staff, others automatic |
| overdue events                        | void after 72 h                                 | staff review                                        |
| leagues the API lacks (Ethiopia, CAF) | optional simulated fallback, marked "Simulated" | refused (simulated odds are never allowed)          |

The licensed-mode guard only gains checks; nothing in it is relaxed. `FEED_PROVIDER=mock` stays refused there.

## 11. What we take from well-known sportsbooks

From public product pages and general market knowledge (not re-checked from this environment, which cannot
browse those sites); the Ethiopian operators are covered in
[research/ethiopia-betting-sites-feature-comparison.md](./research/ethiopia-betting-sites-feature-comparison.md).

| Feature                                          | Seen at                             | Vamos today          | Plan                                     |
| ------------------------------------------------ | ----------------------------------- | -------------------- | ---------------------------------------- |
| Odds movement arrows and flash                   | bet365, SportyBet, 1xBet            | no                   | Phase 8                                  |
| Country → league browser with flags, top leagues | bet365, SportyBet, Betika           | sport chips, leagues | Phases 6 and 8                           |
| Search for teams and leagues                     | bet365, SportyBet, 1xBet            | no                   | Phase 8                                  |
| "Updated n min ago", suspended instead of stale  | Betfair Exchange, Pinnacle          | no                   | Phases 6 and 8                           |
| Handicap / point spreads                         | all of them                         | no                   | Phase 11                                 |
| Low margins on the main markets                  | Pinnacle                            | 6% everywhere        | per-league margins; 4–5% on top 1X2      |
| Outrights (league and tournament winners)        | all of them                         | no                   | Phase 13                                 |
| Bet builder / same-game multi                    | bet365, Betway, DraftKings, FanDuel | no                   | Phase 14, priced from the fitted model   |
| Early payout when 2 goals ahead                  | bet365                              | no                   | Phase 14                                 |
| Odds boosts, "Accumulator of the day" +10%       | Betway, SportyBet, 1xBet            | multi-bonus ladder   | Phase 14, capped, built on the consensus |
| Acca insurance ("One Cut")                       | SportyBet, bet365                   | no                   | Phase 14                                 |
| Favourite leagues and teams                      | bet365, DraftKings                  | no                   | Phase 14 (stored on the phone)           |
| Stake limits that follow market depth            | Pinnacle                            | global caps          | Phase 15 (fewer books → lower limit)     |
| Partial and automatic cash-out                   | bet365                              | full cash-out        | later                                    |

Excluded by policy, whatever competitors do: casino, crash and virtual games, crypto, politics markets.

## 12. Recommendations beyond the request

1. **Faster in-play data later.** The Odds API covers prematch well. If real-money in-play grows, a low-latency
   official feed (Sportradar, Genius Sports or similar) can be added for in-play while The Odds API keeps
   pricing prematch and acts as an independent price monitor. The provider interface takes both.
2. **Cover Ethiopia.** The Ethiopian Premier League and CAF competitions are the product's core and the API
   lacks them. Add a second source for them (API-Football covers Ethiopian fixtures and results; its odds
   coverage must be checked), or have traders price them with the existing model, clearly marked.
3. **Start narrow:** 15–20 leagues and in-play on the top 5. Measure credits and accuracy for a week, then widen.
4. **Publish margins** per market type in the help pages; it builds the trust local competitors lacked.
5. **Never show a stale price.** Every freshness limit errs towards suspending.
6. **Risk:** lower stake limits on thin markets and far from kick-off, and alert on players with consistently
   positive closing-line value.

## 13. Phases

"Lead" work stays in the main session at full reasoning depth (money, settlement, pricing math, guards).
Mechanical work goes to cheaper sub-agents with low or medium effort and a precise brief, to save tokens.

| #   | Phase              | Scope                                                                                                                                                                             | Complexity       | Built by           | Status  |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------ | ------- |
| 0   | Plan               | this document, `scripts/odds-api/capture-samples.ps1`                                                                                                                             | low              | lead               | done    |
| 1   | Config and guard   | `FEED_PROVIDER=theoddsapi`, `ODDS_API_*` settings, licensed checks, tests                                                                                                         | medium, safety   | lead               | planned |
| 2   | Client and schemas | client, zod schemas, fake-fetch tests, fixtures recorded from real responses                                                                                                      | medium           | sub-agent (medium) | planned |
| 3   | Consensus engine   | de-vig, consensus, outliers, quorum, lines, Dixon–Coles fit, pricing, property tests                                                                                              | high, money      | lead               | planned |
| 4   | League registry    | sport key → sport, country, league, flags, Amharic names (pending review)                                                                                                         | low              | sub-agent (low)    | planned |
| 5   | Database           | migration: `feed_leagues`, `feed_team_aliases`, `feed_api_calls`, `feed_results`, `events.odds_updated_at`; catalogue functions; suspend-missing; live refresh; integration tests | high             | lead               | planned |
| 6   | Worker             | catalogue sync, odds poller with scheduler and governor, scores and results, stale and overdue sweeps, retiring mock events                                                       | high             | lead               | planned |
| 7   | API and contracts  | `oddsUpdatedAt` and `simulated` on events; admin feed endpoints                                                                                                                   | medium           | sub-agent (medium) | planned |
| 8   | Web                | odds arrows, freshness, flags and league browser, live score without clock, search                                                                                                | medium           | sub-agent (medium) | planned |
| 9   | Admin              | feed page: credits, leagues on/off and margins, results review, aliases                                                                                                           | medium           | sub-agent (medium) | planned |
| 10  | i18n and docs      | en/am/om/ti strings; architecture, deployment and runbook updates                                                                                                                 | low              | sub-agent (low)    | planned |
| 11  | Handicap           | core `hcp` market (signed half-point lines), settlement, spreads mapping                                                                                                          | high, settlement | lead               | planned |
| 12  | More sports        | ice hockey, American football, baseball, cricket, rugby, MMA, boxing, Aussie rules                                                                                                | high             | lead + sub-agent   | planned |
| 13  | Outrights          | outright events and markets, staff settlement                                                                                                                                     | high             | lead               | planned |
| 14  | Growth features    | boosts, accumulator of the day, early payout, bet builder, favourites                                                                                                             | medium–high      | mixed              | planned |
| 15  | Review             | adversarial review (money, security, reliability), e2e against a stub Odds API                                                                                                    | high             | reviewers          | planned |

**Done means:** with `ODDS_API_KEY` set and the host reachable, `pnpm dev` shows real matches with consensus
prices; prices follow the market; matches settle from scores; nothing simulated is shown; credit use stays
inside the budget. Format, lint, typecheck, unit, integration and e2e tests all pass.

## 14. Risks and open questions

| Risk                                   | Mitigation                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| In-play prices lag                     | in-play off in licensed mode; freshness and score-change guards              |
| Extra time and penalties in cup scores | staff review in licensed mode                                                |
| Tennis retirements                     | staff review in licensed mode                                                |
| Two teams with the same name           | alias table, staff merge                                                     |
| Response format changes                | zod schemas drop bad items; alert when more than 5% of a response is dropped |
| Running out of credits                 | governor and reserve; 401 pauses polling and alerts                          |
| No Ethiopian or CAF coverage           | second source or trader pricing (§12)                                        |

**To confirm with real responses** (run `scripts/odds-api/capture-samples.ps1`): the full sport key list,
which bookmakers the `eu` region returns, whether tennis has scores, how scores look in play, the error body
format, and whether `/odds` charges for markets requested or returned.

## 15. Configuration

| Variable                          | Default                           | Meaning                                                  |
| --------------------------------- | --------------------------------- | -------------------------------------------------------- |
| `FEED_PROVIDER`                   | `mock`                            | `theoddsapi` turns this integration on                   |
| `ODDS_API_KEY`                    | —                                 | secret; required with `theoddsapi`; never logged         |
| `ODDS_API_BASE_URL`               | `https://api.the-odds-api.com/v4` | https required in licensed mode                          |
| `ODDS_API_REGIONS`                | `eu`                              | regions to read                                          |
| `ODDS_API_BOOKMAKERS`             | —                                 | explicit bookmakers instead of regions (10 = one region) |
| `ODDS_API_SPORTS`                 | registry tier 1                   | extra sport keys to enable                               |
| `ODDS_API_MONTHLY_CREDITS`        | `20000`                           | the governor's monthly target                            |
| `ODDS_API_RESERVE_PERCENT`        | `10`                              | credits kept for in-play and results                     |
| `ODDS_API_MIN_BOOKS`              | 2 demo, 3 licensed                | quorum per market; licensed mode refuses less than 3     |
| `ODDS_API_MARGIN_BPS`             | `600`                             | our margin on main markets (basis points)                |
| `ODDS_API_DERIVED_MARKETS`        | `true`                            | BTTS, correct score and extra lines from the goals model |
| `ODDS_API_INPLAY`                 | on in demo, off in licensed       | in-play pricing                                          |
| `ODDS_API_RESULT_CONFIRM_MINUTES` | `10`                              | wait before a feed result is applied                     |
