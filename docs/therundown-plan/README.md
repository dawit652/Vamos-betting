# TheRundown adapter: plan

How Vamos connects to [TheRundown](https://therundown.io), an API for odds, schedules and scores from many
sportsbooks, starting on the cheapest paid plan (**Starter**). This is a plan: nothing in it is built yet.

Written 2026-10-31 on branch `claude/busy-rubin-1shjt6` (head `2513194`). The facts about TheRundown come from
[docs.therundown.io](https://docs.therundown.io) and [its pricing page](https://therundown.io/pricing/api), read on
2026-10-31. Their prices, limits and defaults changed several times in 2026, so check them again at signup
(section 9). Numbers in the rules below are starting values, tuned in the shadow run (task T7).

## 1. In short

- **Starter:** 49 USD a month, 25 million data points a month, 2 requests a second, **prices 60 seconds late**, all
  sportsbooks, no WebSocket, no delta feed.
- **The licence limits us more than the code does.** Starter is for internal or personal use, with no display to
  end users. Using the data as a betting operator, for trading or pricing, needs a separate **Supplemental
  Agreement** on every plan. Nothing may be kept longer than **24 hours** without that agreement.
- **So on Starter, TheRundown is a check, not our price.** Phase 1 compares our own prices (from team ratings, or
  typed by a trader) with the market and suspends a market when ours is clearly wrong: the **odds-error guard**.
  Staff see the market prices in the back office. Players never see TheRundown data.
- Publishing prices made from the market (phase 4) is planned in full and can be built and tested on Starter in
  shadow mode. It is switched on only with the Supplemental Agreement, and at least the Pro plan if players see it.
- **Costa Rica's Primera División is not covered.** TheRundown covers the big five European leagues, the Champions
  and Europa League, MLS, Liga MX, J-League, NBA, WNBA, ATP and WTA. The local league stays on the scraper and
  in-house pricing.
- TheRundown comes in **through the scraper** (`apps/scraper`, `FEED_PROVIDER=scraped`), which already has the
  polite fetcher, API-key handling, the safety gates, the review queue and the back-office pages.
- Three risk controls are worth building whatever the feed: **liability caps** enforced at bet placement, a
  **price expiry** that stops betting by itself when the reference goes stale, and **lower stake limits** on
  markets whose reference is a minute late.

## 2. What Starter gives

|                     | Starter                                                     | Pro                                | Ultra                              |
| ------------------- | ----------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Price a month       | 49 USD (a price tracker showed 39 USD in September 2026)    | 149 USD                            | 399 USD                            |
| Data points a month | 25 M, hard cap by default (overage optional, 12.25 USD / M) | 125 M                              | 500 M                              |
| Requests a second   | 2                                                           | 5                                  | 10                                 |
| Data delay          | 60 s                                                        | 30 s                               | none                               |
| Delta endpoints     | no (zero-delay plans only)                                  | no                                 | yes                                |
| WebSocket           | no                                                          | no                                 | 1 connection                       |
| Sportsbooks         | all                                                         | all                                | all                                |
| Price history       | 7 days                                                      | 30 days                            | 90 days                            |
| Licence             | internal or personal use only                               | display to users, with attribution | display to users, with attribution |

**Data points.** Each event in a response costs 2 (one for the event, one for its score) plus 1 for each price.
With `affiliate_ids=0` the response has scores and no prices: 2 points per event. The v1 schedule endpoint costs
nothing.

**The delay.** Every Starter price is at least 60 seconds old when we read it, and older by the next poll. This rules
out live betting on these prices and is why the limits near kickoff are stricter (section 6). TheRundown's polling
guide also says a plan with a delay cannot use the delta endpoints, so Starter polls small, filtered snapshots.

## 3. The licence

| Use                                                                         | On Starter                    | What it needs                                                  |
| --------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| Build, test, staff-only shadow runs in demo mode                            | yes                           | –                                                              |
| Market prices on back-office screens for staff                              | yes                           | –                                                              |
| Suspending our own markets automatically when ours are far from the market  | unclear: may count as trading | a written answer (section 9, question 1)                       |
| TheRundown data, or prices made from it, on player screens (play money too) | no                            | Pro or higher with attribution, and the Supplemental Agreement |
| Real-money pricing, risk checks or results                                  | no                            | the Supplemental Agreement                                     |
| Keeping responses, prices or scores longer than 24 h                        | no                            | the Supplemental Agreement                                     |
| Calibrating or backtesting our model on their odds                          | no                            | the Supplemental Agreement                                     |

What the code does about it:

- `THERUNDOWN_LICENCE` is `internal` (the default) or `operator`. A person sets `operator` once the signed
  Supplemental Agreement covers betting-operator use, display and longer retention.
- With `internal`, TheRundown data is shown only in the back office, everything taken from it is deleted after
  24 hours (raw snapshots, book prices, consensus, event map), and `THERUNDOWN_ODDS_USE=publish` is refused at
  startup.
- `licensedModeViolations()` refuses TheRundown in licensed mode unless the licence is `operator`. This only adds
  conditions to the guard.
- Every back-office screen that shows their data carries "Data provided by TheRundown", linked to therundown.io, at
  least 12 px with 4.5:1 contrast (their rule from Pro up; harmless before).
- Test fixtures are synthetic, hand-made in the documented response shape: saved real responses would be storage
  beyond 24 hours. A manual `therundown check` command validates the live schema and stores nothing.
- `scrape_observation_history` is append-only and is never pruned, so TheRundown fixtures and scores go into it
  only after TheRundown confirms in writing that we may keep them (phase 3 waits for that).

## 4. Coverage

| Our sport  | TheRundown sport IDs                                                                                                                                | Our markets it can price or check                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Football   | EPL 11, Ligue 1 12, Bundesliga 13, La Liga 14, Serie A 15, Champions League 16, Europa League 33, MLS 10, Liga MX 34, J-League 19, FIFA 18, Euro 17 | 1X2 (their market 1, with home, draw and away), over/under on half-point lines (market 3) |
| Basketball | NBA 4, WNBA 8, NCAAB 5                                                                                                                              | `ml` (market 1), `total` (market 3)                                                       |
| Tennis     | ATP 38, WTA 39                                                                                                                                      | `winner` (market 1)                                                                       |
| Volleyball | none                                                                                                                                                | –                                                                                         |

Not covered: Costa Rica's Primera División (Liga Promerica) and CONCACAF club competitions, as far as their sport
list shows. Spreads (market 2) are not used: we have no handicap market. Our other football markets (double chance,
both teams to score, draw no bet, half-time result, correct score) have no direct market price here; phase 4
derives them from a goal model fitted to the market's 1X2 and total.

Phase 1 starts with the five European leagues whose fixtures already come from openfootball: `premier-league`,
`laliga`, `bundesliga`, `serie-a`, `ligue-1`. The Champions League, MLS and Liga MX need a fixture source first
(phase 3, or another source).

## 5. Design

### 5.1 Where it fits

```
TheRundown REST API (Starter: 60 s late, 2 requests a second)
   │  PoliteFetcher: host allow-list, rate limit, Retry-After, backoff, circuit breaker;
   │  key in the X-TheRundown-Key header from SCRAPER_SECRET_THERUNDOWN (docs/scraper.md 6.7)
   ▼
budget governor (A3) ──► raw archive, deleted after 24 h (A5)
   ▼
adapter `therundown` (pure, zod-checked, never throws)
   ├─ prices ─► checks P1–P4 ─► consensus P5 ─► reference store (deleted after 24 h)
   │              ├─ phase 1: odds-error guard on our prices (P6) ─► suspend + review item
   │              └─ phase 4: publish (P7–P9) ─► upsertFixture (source 'therundown')
   └─ fixtures and scores (phase 3) ─► observations ─► existing gates F, K, R ─► catalogue
```

Not through `OddsFeedProvider` (`packages/feed/src/types.ts`) and the worker's `feed-ingest`: that interface is
synchronous, and that task moves kickoffs without the K rules and cancels scheduled events the feed stops listing
(`withdrawUnoffered`). With a real feed both are unsafe (rule F5: absence never cancels). That path stays the mock
provider's.

### 5.2 Files

| Path                                                                                                                      | What                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/odds.ts`                                                                                               | `americanToOddsMilli`, `americanToProbability`                                                                                      |
| `packages/scraper/src/adapters/therundown.ts`, `therundown-schema.ts`                                                     | zod schemas of the v2 fields we read; request planning; `parseTherundownPrices`; later `parseTherundownEvents`                      |
| `packages/feed/src/pricing/consensus.ts`                                                                                  | de-margin per book, outliers, weighted consensus, dispersion, confidence                                                            |
| `packages/feed/src/pricing/market-fit.ts` (phase 4)                                                                       | expected goals fitted to the market's 1X2 and total, priced with the existing football model                                        |
| `packages/scraper/src/gates/reference.ts`                                                                                 | rules P6 to P9 as pure functions                                                                                                    |
| `packages/scraper/src/fetch/budget.ts`                                                                                    | the budget governor (pure)                                                                                                          |
| `packages/db/src/schema/scrape.ts`, migration `0038_*`                                                                    | `reference_book_prices`, `reference_consensus`, `reference_event_map` (all pruned), `reference_budget`, `markets.price_valid_until` |
| `packages/db/src/risk/*`, a second migration                                                                              | `selection_exposure` counters, the `risk_limits` setting, reconciliation                                                            |
| `packages/db/src/betting/place.ts`, `selections.ts`                                                                       | refuse a market past `price_valid_until`; liability and stake checks                                                                |
| `apps/scraper/src/tasks/therundown.ts`                                                                                    | the poller: cadence tiers, one instance per key, health                                                                             |
| `apps/scraper/src/pipeline/reference.ts`                                                                                  | mapping, consensus, guard, apply                                                                                                    |
| `apps/scraper/src/cli/therundown.ts`                                                                                      | `therundown check`, `therundown budget`                                                                                             |
| `packages/config/src/config.ts`                                                                                           | `THERUNDOWN_*` and the licensed-mode checks                                                                                         |
| `packages/contracts/src/feed.ts`, `apps/api/src/modules/admin/feed.ts`, `apps/admin/src/app/{feed,trading,risk,settings}` | health panel, market column, review reasons, risk limits                                                                            |
| `docs/therundown.md`, `docs/runbooks/feed-budget-exhausted.md`                                                            | the normative design and a runbook                                                                                                  |

The `reference_*` tables carry a `provider` column, so another odds provider can reuse the consensus and the guard.

### 5.3 Access and budget (A)

- **A1 Plan check.** Every response's `X-Data-Delay-Seconds` and `X-Rate-Limit` are read. A missing delay header
  counts as 300 s (the Free plan's delay), never as 0. If the server reports a longer delay than `THERUNDOWN_PLAN`
  expects, the longer one is used everywhere.
- **A2 Rate and errors.** One poller per key (Redis lock), at most 1 request a second (half the plan's limit). A
  429 with `Retry-After` (burst): wait as told. A 429 "data point limit reached": stop until `X-Datapoints-Reset`,
  never retry. 5xx and timeouts: backoff with jitter up to 30 s, 3 tries (their guidance), then the circuit
  breaker. 401: stop, `source_broken` with reason `unauthorized`. 403 (the plan does not include it): stop that
  request kind, `source_broken` with reason `forbidden`.
- **A3 Budget.** Reads `X-Datapoints-Used`, `-Remaining` and `-Reset` from every response and logs `X-Datapoints`
  per request. Daily allowance = (remaining − reserve) ÷ days to reset; the reserve (5% of the quota) is kept for
  scores. **Green:** normal cadence. **Amber** (today on pace to pass the allowance): the two slowest tiers poll
  half as often. **Red** (remaining below the reserve): price polling stops, scores go on, references expire and
  their markets stop taking bets (P7), and `source_broken` opens with reason `budget_exhausted`. A response that
  costs more than twice its expected points raises an alert: a filter was ignored or a default changed.
  TheRundown's own hard cap stays on, so a bug cannot turn into a bill.
- **A4 Key.** Only in the `X-TheRundown-Key` header, never in the `?key=` query parameter (URLs end up in logs and
  archives). It reuses `docs/scraper.md` 6.7: `auth.secret` is `SCRAPER_SECRET_THERUNDOWN`, the value is never
  logged, and a response that echoes it is dropped. One key each for development, staging and production; rotation
  goes into `docs/runbooks/rotating-secrets.md`.
- **A5 Retention.** With `internal`, an hourly prune deletes TheRundown raw snapshots, book prices, consensus and
  map rows older than `THERUNDOWN_RETENTION_HOURS` (24). The archive's `keep` flag is never set on them. A test
  asserts that no such row survives 24 hours.

Requests, always with explicit filters (TheRundown changed its default markets in March and June 2026, and
`market_ids` takes at most 12):

- Far prices and discovery, one request per sport and UTC day:
  `GET /api/v2/sports/{sportId}/events/{date}?market_ids=1,3&affiliate_ids=3,32,7,9,19&main_line=true&hide_closed=true`
- Near prices, one request per event: `GET /api/v2/events/{eventId}` with the same filters (check at signup that
  this endpoint takes them and costs the same, question 6).
- Scores (phase 3): the day request with `affiliate_ids=0`. Fixtures (phase 3):
  `GET /api/v1/sports/{sportId}/schedule` (no data points).
- Book health: `GET /api/v2/affiliates` every hour.
- Dates are UTC days (`offset` 0): an evening kickoff in the Americas falls on the next UTC day.

Cadence per event, by time to kickoff:

| Time to kickoff | Poll every           | Max reference age (P7) |
| --------------- | -------------------- | ---------------------- |
| 7 days to 48 h  | 60 min (day request) | 3 h                    |
| 48 h to 12 h    | 20 min               | 60 min                 |
| 12 h to 3 h     | 5 min                | 15 min                 |
| last 3 h        | 1 min (single event) | 3 min                  |

Reference age = now − (fetch time − server delay).

Budget estimate for the full scope (nine football competitions and the NBA), to be replaced by the measured
`X-Datapoints` in week 1:

| Item                                    | Working                     | Points a month              |
| --------------------------------------- | --------------------------- | --------------------------- |
| One football event, 5 books, one poll   | 2 + 5 books × 5 prices = 27 | –                           |
| One football event over its last 7 days | 516 polls × 27 ≈ 14,000     | –                           |
| About 300 football events a month       | 300 × 14,000                | about 4.2 M                 |
| NBA in season, about 230 games a month  | 230 × 516 polls × 22        | about 2.6 M                 |
| Scores (phase 3)                        | 2 points per event per poll | under 0.3 M                 |
| Fixtures from the v1 schedule           | free                        | 0                           |
| **Total**                               |                             | **about 7 M of 25 M (28%)** |

Polling whole days in the last hours instead of single events would cost several times more.

### 5.4 Mapping (M)

- **M1 Teams and time.** A TheRundown event maps to our event with the same competition (M5), the same home and
  away teams (M2) and a start within `KICKOFF_TOLERANCE_MS` (5 min). Exactly one candidate: mapped. None or more
  than one: no reference, and nothing else happens. If the kickoffs differ by more than 5 min (up to 36 h), the
  event is not mapped for prices; and if TheRundown's kickoff is **earlier** while our betting is open, betting
  closes (like rule K1: closing only reduces exposure) and `kickoff_change` opens with subject
  `<feedRef>|therundown`. A trader who checked it dismisses the item for that TheRundown time; betting is closed
  again only if that time changes.
- **M2 Team names** resolve through aliases limited to the source `therundown` (rule N2: exact, never fuzzy). The
  map also keeps TheRundown's `team_id`, which their docs call stable across seasons. A known `team_id` with a new
  name, or a known name with a new `team_id`, is not mapped and opens `unknown_team`.
- **M3 Home and away** come only from `is_home` / `is_away`, checked against `score.team_id_home` /
  `team_id_away` and the moneyline participant IDs. Any disagreement drops the event (`home_away_mismatch`). Their
  `teams` array lists the away team first (the US habit): never read it by position.
- **M4 IDs do not survive a reschedule.** Their FAQ says soccer event IDs are built from the team IDs and the date,
  so a moved match gets a new ID. Mapping always goes through M1; an `event_id` is only a key inside the 24 h map.
  A TheRundown event that disappears changes nothing on our side (F5).
- **M5 Sport IDs.** Only the sport IDs in the source config are read, each tied to one competition label (resolved
  by competition aliases). TheRundown split sport IDs several times in 2026 (MLB playoffs 31, NHL preseason 27, NFL
  preseason 25). A configured competition whose event count drops opens `source_broken` (S1); a person adds new IDs.

### 5.5 Odds errors (P)

What can go wrong with prices, and the rule that stops it.

- **P1 Allow-list.** Only `period_id` 0 (full game) and the configured market IDs: 1 and 3 for football and
  basketball, 1 for tennis. Everything else is dropped and counted, above all the live markets (41, 42, 43, 96,
  1105; periods 7 and 13 to 18), which on Starter are 60 s late.
- **P2 Prices.** A price is American: a whole number with |x| ≥ 100 (−100 and +100 both mean 2.00). `0.0001` is
  TheRundown's "off the board" value: that book has no price, and the value never enters a calculation. Anything
  else (0, a fraction, |x| < 100, a value outside 1.001 to 1000 once converted) is dropped with `invalid_price`.
  Conversion is integer and rounds down, never in the player's favour: +x → 1000 + 10x milli; −x → 1000 +
  ⌊100000 ÷ x⌋ milli. The consensus uses exact probabilities: 100 ÷ (x + 100) for +x, x ÷ (x + 100) for −x.
- **P3 Lines and sides.** Totals only on the half-point lines our catalogue accepts (`2.5`, `215.5`; `parseLine`);
  whole and quarter lines (2, 2.25, 2.75) are dropped because they can push. Line text is normalised (`+2.5`,
  `2.50` → `2.5`). Over and under must be on the same line at the same book. Home, draw and away come from
  participant IDs (M3), never from names or positions.
- **P4 Book checks.** A book's market counts only if every outcome is priced (three for football 1X2, two
  otherwise), none is off the board or has `closed_at`, its overround is between 1.00 and 1.20 (below 1.00 is a
  sure win inside one book, so an error), its newest price is not older than 6 h (30 min in the last 3 h), and the
  book is `healthy` in `/api/v2/affiliates` (beta, unhealthy and unknown are left out).
- **P5 Consensus.** Per book, fair probabilities = its implied probabilities ÷ their sum (proportional, as in
  `priceBook`). A book with any outcome more than 4 percentage points from the median of the books is dropped as an
  outlier. The consensus is the weighted mean of the rest (Pinnacle 3; Circa, BookMaker and BetCRIS 2; others 1),
  normalised to 1. It exists only with at least 2 books, one of them an anchor (Pinnacle 3 or Circa 32). It carries
  the books used, the dispersion (the largest gap between a used book and the consensus), the as-of time and a
  confidence: **high** (an anchor plus 3 or more books, dispersion under 1.5 pp, Pinnacle's max stake
  `liquidity_usd` at least 1,000 USD), **low** (2 books, dispersion over 3 pp, or Pinnacle's max stake under
  250 USD), otherwise **normal**.
- **P6 Odds-error guard (phase 1).** For every open selection of our events with a consensus, including prices a
  trader typed: player's edge = consensus probability × our odds − 1. An edge above 3% (5% at low confidence)
  suspends the market at once (audited, actor the scraper) and opens `odds_approval` with subject
  `<feedRef>|reference`, reason `market_divergence`, our prices, the consensus and the books. A trader re-prices
  and re-opens the market in Trading; the item never offers "Open betting". An edge below −15% (we are far worse
  than the market) only opens an `info` item. The guard never sets a price. When a trader types a manual price, the
  Trading page warns before saving if the new price fails the same test.
- **P7 Price expiry (dead man's switch).** A market priced from TheRundown (phase 4), or checked by it in a
  competition set to require a reference, has `markets.price_valid_until` = as-of time + the tier's max reference
  age. Bet placement refuses its selections after that time (`unavailableReason` → `suspended`), so betting stops by
  itself if the poller, the budget or TheRundown fails; no job has to run. Expiry is not a status change: a market
  that a trader or the guard suspended stays suspended until a person opens it.
- **P8 Moves (phase 4).** A 1X2 or `ml` outcome that moves more than 8 pp from our last published price suspends
  the market and opens `odds_approval` with reason `large_move`. A move of more than 3 pp between two polls keeps
  the market suspended for one more poll before the new price goes out: news keeps moving prices for a minute or
  two, and our data is a minute behind.
- **P9 Publishing (phase 4).** Our prices come from the consensus through `priceBook` with our margin (6%), the
  other football markets from the fitted goal model, then O2. No price may be higher than the best price of any
  healthy book for that outcome (we must never be the easy side of an arbitrage). Prices are written with
  `upsertFixture` (source `therundown`), keeping the event's stored start time as `repriceScheduledEvents` does, so
  a trader's manual price stays until the market moves. Only for events scheduled on both sides, up to `CLOSE_LEAD`
  before kickoff.

### 5.6 Risk management (L)

- **L1 Liability caps (any feed).** A new setting `risk_limits` (back office, `settings.edit`): the largest
  liability per selection and per event, with overrides per competition. Bet placement checks every leg's
  selection in its own transaction with a guarded `UPDATE selection_exposure … WHERE liability + $payout <= $cap`
  (the ledger's pattern), so two bets at the same moment cannot both pass. Over the cap: 422 `liability_limit` with
  the largest stake that fits. A multiple counts its whole potential payout on each of its selections, as the Risk
  page does today (`listSelectionLiabilities`). Settlement, void, cash-out and a rejected live bet release it. A
  reconciliation job compares the counters with the open bets and alerts on any difference. At 80% of a cap the
  selection is highlighted on the Risk page.
- **L2 Stake limits.** On a market checked or priced from TheRundown, the largest stake is `betRules.maxStake` × a
  factor: 20% at high confidence, 10% normal, 5% low, halved in the last 3 h (when line-ups and late news move the
  market faster than a 60 s feed shows).
- **L3 Close early.** Events priced from TheRundown stop taking bets `CLOSE_LEAD` before kickoff (Starter: 2 min).
- **L4 No live betting** on TheRundown prices on Starter or Pro. Scraped events never go live anyway; live betting
  on Ultra would need its own plan.
- **L5 People void, not code.** A bet taken at a clearly wrong price is voided only by a trader, with the existing
  `staffVoidSelection`, under a "palpable error" rule in the house terms (that text must exist before real money).
  Each bet leg stores what the guard saw at placement (edge and confidence: our own numbers, not their prices) as
  evidence.
- **L6 One selection per match.** The bet slip already refuses two selections of the same match
  (`duplicate_event` in `packages/core/src/betslip.ts`), so same-match combinations cannot be mispriced.
- **L7 Later: sharp accounts.** Closing-line value per bet (our odds against TheRundown's closing consensus,
  computed within 24 h, only the percentage kept), used to lower the limits of accounts that keep beating the
  market. Needs the licence answer on derived numbers (question 3).

### 5.7 Results (phase 3)

TheRundown becomes one more fixture and score upstream, through the existing gates:

| TheRundown status                                                                                              | Observation                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `STATUS_SCHEDULED`                                                                                             | fixture, scheduled                                                                                                                      |
| `STATUS_POSTPONED`, `STATUS_CANCELED`                                                                          | fixture, postponed or cancelled: only `cancellation_proposed` (F6, R7)                                                                  |
| `STATUS_FINAL`                                                                                                 | result, regular time, only if the score has exactly two period entries that add up to the full-time score (the API does not check this) |
| `STATUS_FINAL_AET`, `STATUS_FINAL_PEN`                                                                         | result with an extra-time or penalties basis: R10, a person enters the 90-minute score                                                  |
| `STATUS_FORFEIT`                                                                                               | dropped with an issue; a person decides                                                                                                 |
| `STATUS_TBD`, `STATUS_DELAYED`                                                                                 | no result; the kickoff counts as unconfirmed (K5)                                                                                       |
| `STATUS_FULL_TIME` (extra time may follow), live statuses, `STATUS_SUSPENDED`, `STATUS_NOT_AVAILABLE`, unknown | nothing                                                                                                                                 |

- The half-time score is the first period entry (for `ht_1x2`).
- TheRundown is one upstream; rule R2 needs two. Ask where their scores come from (question 7). With openfootball
  on the five leagues, R2 can confirm results; where TheRundown is alone (MLS, Liga MX) a trader confirms each one
  (R6).
- Their docs say final scores are sometimes corrected later: R4's wait and R8 (`result_correction`) cover that.
- Basketball through the scraper needs the scraper's other-sports extension first (scraper plan 08): its match
  length and a score basis that includes overtime.

### 5.8 What happens when …

| Situation                                    | What the system does                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| TheRundown is down, slow or returns 5xx      | backoff, then the circuit breaker; references expire; phase 4 markets stop taking bets (P7); the phase 1 guard has no reference   |
| The budget runs low                          | amber: slow tiers poll less; red: price polling stops and `source_broken` opens (A3)                                              |
| 429                                          | burst: wait `Retry-After`; quota used up: wait for the reset (A2)                                                                 |
| 401 or 403                                   | stop and open `source_broken`; a person checks the key or the plan                                                                |
| The key leaks                                | rotate it (runbook); it was only ever in a header (A4)                                                                            |
| A book is off the board, closed or stale     | that book does not count; too few books: no reference (P4, P5)                                                                    |
| One book posts a wrong price                 | dropped as an outlier (P5)                                                                                                        |
| The books disagree                           | low confidence: a wider guard threshold and smaller stakes; phase 4 does not publish                                              |
| Home and away do not line up                 | the event is dropped (M3)                                                                                                         |
| A match is moved and gets a new ID           | mapped again by teams and time; nothing is cancelled (M1, M4)                                                                     |
| TheRundown shows an earlier kickoff          | betting closes and a trader checks (M1)                                                                                           |
| Postponed or cancelled                       | `cancellation_proposed` for a person; never automatic                                                                             |
| Live prices appear in a response             | dropped (P1)                                                                                                                      |
| The API changes a default or a field         | explicit filters; zod drops what does not parse; the cost alert (A3); the shape check (S1); a person reads their changelog weekly |
| Our model or a trader prices something wrong | the guard suspends the market (P6)                                                                                                |
| Late team news                               | stake limits halve in the last 3 h; in phase 4 the move rules and the early close (P8, L3)                                        |
| Data older than 24 h                         | the hourly prune deletes it (A5)                                                                                                  |

### 5.9 Configuration

| Variable                     | Default                 | Meaning                                                                      |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `THERUNDOWN_ENABLED`         | `false`                 | starts the poller (needs `FEED_PROVIDER=scraped`)                            |
| `THERUNDOWN_PLAN`            | `starter`               | the expected delay, rate and quota; the server's headers win when worse (A1) |
| `THERUNDOWN_LICENCE`         | `internal`              | `operator` once the Supplemental Agreement is signed                         |
| `THERUNDOWN_ODDS_USE`        | `reference`             | `off`, `reference` (phase 1) or `publish` (phase 4, needs `operator`)        |
| `THERUNDOWN_RETENTION_HOURS` | `24`                    | more than 24 needs `operator`                                                |
| `THERUNDOWN_BASE_URL`        | `https://therundown.io` | must be https in licensed mode                                               |
| `THERUNDOWN_MONTHLY_BUDGET`  | the plan's quota        | the data points we allow ourselves                                           |
| `SCRAPER_SECRET_THERUNDOWN`  | unset                   | the API key; read by the fetcher, never by `packages/config`                 |

New licensed-mode conditions: with TheRundown enabled, the licence must be `operator`, the plan not `free` and the
base URL https.

The source for `sources upsert --file`, as a draft:

```json
{
  "id": "therundown",
  "name": "TheRundown API",
  "adapter": "therundown",
  "upstream": "TheRundown",
  "config": {
    "allowedHosts": ["therundown.io"],
    "auth": { "header": "x-therundown-key", "secret": "SCRAPER_SECRET_THERUNDOWN" },
    "competitions": [
      { "sportId": 11, "competition": "TheRundown EPL" },
      { "sportId": 14, "competition": "TheRundown La Liga" },
      { "sportId": 13, "competition": "TheRundown Bundesliga" },
      { "sportId": 15, "competition": "TheRundown Serie A" },
      { "sportId": 12, "competition": "TheRundown Ligue 1" }
    ],
    "markets": [1, 3],
    "books": { "anchors": [3, 32], "others": [7, 9, 19] }
  }
}
```

The competition labels resolve through competition aliases to `premier-league`, `laliga`, `bundesliga`, `serie-a`
and `ligue-1`. Book IDs: 3 Pinnacle, 32 Circa Sports, 7 BookMaker, 9 BetCRIS, 19 DraftKings.

### 5.10 Back office

- **Feed health:** a TheRundown panel with the plan the server reports (delay, rate), points used, remaining and
  reset, today's spend against the allowance, the budget level, the last good poll per tier, errors by status code,
  and the books with their health.
- **Trading, event page:** per selection our odds, the consensus fair odds, the player's edge, the books used,
  confidence and age, with the attribution line.
- **Review:** `odds_approval` gets the reasons `market_divergence` and `large_move`; `source_broken` gets
  `budget_exhausted`, `unauthorized` and `forbidden`; `kickoff_change` gets the `|therundown` subject.
- **Settings:** `risk_limits` (L1, L2).

## 6. Starting values per plan

| Setting                           | Starter                      | Pro        | Ultra                          |
| --------------------------------- | ---------------------------- | ---------- | ------------------------------ |
| Delay assumed                     | 60 s, or the header if worse | 30 s       | 0                              |
| Polling in the last 3 h           | every 60 s, per event        | every 30 s | delta every 10 s, or WebSocket |
| Max reference age in the last 3 h | 3 min                        | 90 s       | 30 s                           |
| Guard: largest player edge        | 3% (5% at low confidence)    | 3%         | 2%                             |
| Stake factor at normal confidence | 10%                          | 20%        | 40%                            |
| Stop taking bets before kickoff   | 2 min                        | 1 min      | 0                              |
| Live betting on these prices      | no                           | no         | its own plan                   |

These are values to start the shadow run with, not results. When to move up: to **Pro** when players should see
market-based prices (with the agreement), or when the shadow numbers show the 60 s lag costing money; to **Ultra**
for live betting, or when the budget stays above 70% for two weeks.

## 7. Tasks

| #   | Task                                                                                  | Model / effort                            | Size      | Needs                           | Phase |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------- | --------- | ------------------------------- | ----- |
| T0  | Account, keys, written answers (section 9)                                            | a person                                  | 1–2 weeks | –                               | 0     |
| T1  | American odds in core; zod schemas and price parser; synthetic fixtures               | Sonnet high                               | 150k      | –                               | 1     |
| T2  | Consensus and rules P4 to P8 as pure functions                                        | Opus high                                 | 200k      | T1                              | 1     |
| T3  | Budget governor, poller, plan check, `therundown check`                               | Sonnet high                               | 200k      | T1; T0's key for the live check | 1     |
| T4  | Migration, pruning, mapping M1 to M5                                                  | Opus high                                 | 200k      | T2, T3                          | 1     |
| T5  | Guard in the pipeline, earlier-kickoff close, back-office panels                      | Sonnet high                               | 250k      | T4                              | 1     |
| T6  | Liability caps, stake factors, price expiry at placement, risk settings               | Opus high                                 | 300k      | – (any time; before real money) | risk  |
| T7  | Shadow run of phase 1, 2 to 4 weeks, and its scorecard                                | a person; Haiku low for the weekly report | weeks     | T5                              | 1     |
| T8  | TheRundown as fixture and score source                                                | Sonnet high                               | 250k      | T0's retention answer, T4       | 3     |
| T9  | Publish mode: goal-model fit, basketball, shadow publishing, a switch per competition | Opus high                                 | 400k      | `operator` licence, T5, T6      | 4     |
| T10 | `docs/therundown.md`, runbooks, operations guide                                      | Haiku low                                 | 80k       | T5                              | –     |

Every task is done when `pnpm typecheck`, `pnpm lint`, `pnpm format` and the tests of the packages it touched pass,
plus:

- **T1:** property tests: conversion is monotonic, −100 and +100 give 2.000, every result is a valid odds value or
  a drop. The parser never throws, and drops sentinels, live markets, quarter lines and wrong shapes with issues.
- **T2:** property tests: the consensus sums to 1, lies within the books' range, does not depend on book order, and
  one wild book never moves it further than the outlier rule allows.
- **T3:** fault tests with a fake fetch: both kinds of 429, 401, 403, 5xx, a missing delay header, a cost spike, a
  budget that turns red. No test touches the network.
- **T4:** on a real Postgres: rows older than 24 h are gone after a prune; ambiguous, swapped and rescheduled
  matches are not mapped.
- **T5:** on a real Postgres: a wrong price suspends the market and opens the item once (idempotent); an earlier
  kickoff closes betting; nothing writes a price.
- **T6:** concurrent placements never pass a cap; the counters reconcile after settlement, void and cash-out; a
  stale market refuses bets with no job running.

Prompts for a fresh session (each one also says: "read `docs/therundown-plan/README.md` first; do not commit"):

- **T1:** "Add `americanToOddsMilli` and `americanToProbability` to `packages/core/src/odds.ts` (rule P2, unit and
  fast-check tests). Then write `packages/scraper/src/adapters/therundown.ts`: zod schemas for the v2 event fields
  that rules P1 to P3 read, and a pure `parseTherundownPrices` that applies P1 to P3 and never throws. Synthetic
  fixtures only."
- **T2:** "Write `packages/feed/src/pricing/consensus.ts` (P4, P5) and `packages/scraper/src/gates/reference.ts`
  (P6 to P8) as pure functions with the constants of sections 5.5 and 6, with unit and property tests."
- **T3:** "Write `packages/scraper/src/fetch/budget.ts` (A3) and the poller `apps/scraper/src/tasks/therundown.ts`
  (A1, A2 and the cadence table) on the existing PoliteFetcher and its auth (A4), plus a `therundown check` CLI
  command that stores nothing."
- **T4:** "Add migration 0038 with the `reference_*` tables of section 5.2 and the hourly prune (A5), and the
  mapping rules M1 to M5 in `apps/scraper/src/pipeline/reference.ts`, with integration tests on
  `createTestDatabase`."
- **T5:** "Wire the guard (P6) and the earlier-kickoff close (M1) into the promotion pass, and add the back-office
  panels and review reasons of section 5.10."
- **T6:** "Build L1 to L3 and the placement check of P7: `selection_exposure` with a guarded update, `risk_limits`
  in settings, release on settlement, void and cash-out, reconciliation, and race tests."
- **T8, T9:** start them only when their "Needs" are met; their rules are in sections 5.7 and 5.5 (P7 to P9).

## 8. Phase 1 is done when

1. Two weeks of polling stay under 60% of the monthly quota's pace, with no "data point limit" 429.
2. At least 95% of mapped events have a reference younger than their tier's max age.
3. At least 98% of our events in the five leagues map, and a person who spot-checks 50 maps finds none wrong.
4. A trader judges the guard's suspensions mostly right (target: at most one false alarm a day), and every price
   error found another way is checked against what the guard did.
5. No player screen shows TheRundown data, and no TheRundown row older than 24 h exists (a test and a query).
6. Licensed mode refuses TheRundown without the `operator` licence (a test).

## 9. Questions for TheRundown (T0)

Send them to support@therundown.io after signing up, and read the full Terms of Service, not only the licensing
page. Write the answers into `docs/therundown-plan/answers.md`.

1. We build a sportsbook (a play-money demo now, a licensed real-money one in Costa Rica later). On Starter, may we
   show your prices to our staff and suspend our own markets automatically when our prices are far from yours, or
   is that "trading/pricing" that needs the Supplemental Agreement?
2. Is a public play-money demo that shows prices made from your odds "display to end users"? Which plan and
   agreement cover it?
3. May we keep, beyond 24 hours, (a) kickoff times and final scores taken from your data, and (b) our own derived
   numbers, such as "our price was 4% above the market when this bet was taken", as settlement and dispute
   evidence?
4. Football: does market 1 (home, draw, away) settle on 90 minutes plus stoppage time? How does it differ from
   market 563? Can `STATUS_FINAL` follow extra time?
5. Is `X-Data-Delay-Seconds` always 60 on Starter, and does the delay also apply to scores and schedules?
6. Does the single-event endpoint take `market_ids`, `affiliate_ids` and `main_line`, and cost the same per event?
7. Where do your scores and schedules come from? (Our rules count independent upstreams.)
8. Do you plan coverage of Costa Rica's Primera División or CONCACAF club competitions?
9. What does the Supplemental Agreement cost, and does it need Pro or higher?
10. May we keep a few real responses as test fixtures, or should they be synthetic?

## 10. Sources

- Plans and prices: https://therundown.io/pricing/api; the September 2026 price change:
  https://pricingsaas.com/companies/therundown/diffs/2026W39
- Data-point costs, headers and limits: https://docs.therundown.io/rate-limits
- Licensing and attribution: https://docs.therundown.io/licensing-and-attribution
- Polling on delayed plans: https://docs.therundown.io/guides/efficient-polling
- Events endpoint and fields:
  https://docs.therundown.io/api-reference/generated/v2-events/get-events-with-markets-for-a-sport-and-date
- Off-the-board value: https://docs.therundown.io/reference/sentinel-values
- Markets, periods, statuses: https://docs.therundown.io/reference/markets,
  https://docs.therundown.io/reference/periods, https://docs.therundown.io/reference/event-statuses
- Scores and results: https://docs.therundown.io/guides/scores-and-results
- Errors: https://docs.therundown.io/errors
- Sports and sportsbooks: https://docs.therundown.io/reference/sports,
  https://docs.therundown.io/reference/sportsbooks
- FAQ (soccer event IDs): https://docs.therundown.io/faq
- Changelog: https://docs.therundown.io/changelog
