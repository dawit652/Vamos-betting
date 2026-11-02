# The Odds API on the 30 USD plan: plan

How Vamos takes bookmaker odds for its market-priced football competitions from
[The Odds API](https://the-odds-api.com) on the **20K plan (30 USD a month)**, as cheaply, reliably and accurately as
that plan allows.

> **Status 2026-11-02: Phase 0 done (P0b and P0c, results in section 10), the over/under fix P2b and the adapter
> P2 are in, the reading schedule and credit guard P3 are in, and the house liability caps (TheRundown plan, rule
> L1) are built. The alarms (P4) are not built, so the five sources stay disabled.** The Odds API replaces TheRundown as the market feed: TheRundown's
> cheap plans do not allow use by a betting operator (`docs/therundown-plan/README.md`, section 3). Most of what is
> needed already exists from the TheRundown work: the `scrape_market_odds` table, `marketConsensus`, the market
> pricing (`packages/feed/src/pricing/market.ts`), the per-competition `pricing_source` switch and the 5-minute close
> lead. Costa Rica's Primera División is out of scope: the owner does not need it, and The Odds API does not cover it.

Written 2026-11-01 on branch `claude/reconcile-therundown` (head `a1d2935`). The facts about The Odds API come from
its pages read that day (section 9). It has changed credit allocations before, so check them again at signup.

## 1. In short

- **One request per league costs 2 credits** (`h2h` and `totals`, up to 10 bookmakers), however many matches it
  returns. A response with no events is free.
- **Scope: the five leagues that already get fixtures from openfootball:** Premier League, LaLiga, Serie A,
  Bundesliga and Ligue 1. Each league is its own source, read more often as its next kickoff gets closer.
- **Budget: about 13,500 of the 20,000 credits in a normal month (68%), about 16,000 in a heavy month (80%).** A
  credit guard slows reading before the quota can run out, and never lets it reach zero.
- **Accuracy: ten bookmakers that set their prices independently,** including Pinnacle and three betting exchanges.
  Stale books are dropped, and the consensus is the median of what is left.
- **Reliability:**
  - The key never lands in a URL that we store.
  - Each league has exactly one market feed.
  - Alarms fire for low credits and for stale prices.
  - One switch in the back office puts a league back on the model straight away.
- **What the free probe found (section 10):**
  - The `x-api-key` header works, so the key never has to be in a URL: P1 is skipped.
  - The 1X2 is well covered: a median of 8 to 10 of the ten books per match, never fewer than 5.
  - `last_update` looks like "last seen": every book's median age was 0 to 2 minutes, even for matches days away.
  - Over/under was the weak spot. `totals` gives one main line per book, and five of the first ten books gave none:
    only 18% of Bundesliga matches (77 to 81% elsewhere) had the 2.5 line from 2 books.
  - Without a 2.5 consensus, today's pricing fits goals to the 1X2 alone and prices over 2.5 about 5 to 9 points
    too low (10.3). P2b, now done, closes that hole.
  - The discovery run (P0c) chose a new ten (4.2): three books that gave no totals make way for `betsson`,
    `unibet_se` and `tipico_de`, which quote 2.5. In the Bundesliga only `williamhill` and `betsson` quote 2.5; the
    others give 3.5, which P2b's rule T1 uses.
  - `alternate_totals` on the per-event endpoint gives the 2.5 line from 15 to 16 books, Pinnacle and Betfair
    included, for 1 credit per match: an optional accuracy step (P7).

- **Order:**
  1. Free key and probe (done). Licence email: not sent (owner's decision, section 8).
  2. Book discovery (P0c, done).
  3. Adapter, with the key in a header.
  4. Over/under fix in the pricing (P2b, done).
  5. Reading schedule and credit guard.
  6. Alarms.
  7. Two weeks of shadow on the paid plan.
  8. Premier League on market prices, then the other four leagues.

## 2. The plan, in facts

| Item                      | 20K plan                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Price                     | 30 USD a month, cancel any time                                                                                                                                                                                                          |
| Credits                   | 20,000 a month, reset on the 1st                                                                                                                                                                                                         |
| `/v4/sports/{sport}/odds` | costs markets × regions; up to 10 named `bookmakers` count as one region; costs nothing when no event is returned                                                                                                                        |
| Free endpoints            | `/v4/sports`, `/v4/sports/{sport}/events`                                                                                                                                                                                                |
| Other costs               | `/participants` 1; `/scores` 1 (2 with `daysFrom`); historical odds 10 × markets × regions (paid plans only)                                                                                                                             |
| Freshness                 | pre-match odds refreshed every 60 s, faster in the last 6 h, up to 2 min late; exchanges every 20 s                                                                                                                                      |
| Rate limit                | 30 requests a second (`EXCEEDED_FREQ_LIMIT`, HTTP 429)                                                                                                                                                                                   |
| Usage headers             | `x-requests-remaining`, `x-requests-used`, `x-requests-last` on every response                                                                                                                                                           |
| Errors that matter        | `INVALID_KEY`, `DEACTIVATED_KEY`, `OUT_OF_USAGE_CREDITS`, `EXCEEDED_FREQ_LIMIT`, `INVALID_BOOKMAKERS`, `INVALID_MARKET`                                                                                                                  |
| Key                       | the docs show only the `apiKey` query parameter; **the `x-api-key` header is accepted** (probe 2026-11-01; undocumented, so asked in section 8)                                                                                          |
| Football markets          | `h2h` (home, away and `Draw`); `totals`: **one main line per book**, and many books return none (10.4); every line as `alternate_totals`, on the per-event endpoint only (15 to 16 books with 2.5 in P0c); `last_update` per book market |
| Sport keys                | `soccer_epl`, `soccer_spain_la_liga`, `soccer_italy_serie_a`, `soccer_germany_bundesliga`, `soccer_france_ligue_one`                                                                                                                     |
| Licence                   | allowed: commercial use in your own apps. Forbidden: reselling or redistributing the data as a data product. Not mentioned: a betting operator setting its prices from it, so ask in writing (section 8)                                 |

## 3. What the code already expects

| Fact                                                                                                                                                         | Where                                                                               | What it means here                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A 1X2 consensus needs at least 2 books (`CONSENSUS_MIN_BOOKS`)                                                                                               | `packages/core/src/market-consensus.ts:58`                                          | ten books leave room to lose some                         |
| A book is dropped when its overround is outside 1 to 1.25                                                                                                    | `market-consensus.ts:65`                                                            | an exchange book just under 1.00 drops out; harmless      |
| Only the over/under **2.5** line prices; whole and quarter lines are dropped                                                                                 | `packages/feed/src/pricing/market.ts:49`, `adapters/therundown.ts:331`              | a book whose main line is 3.5 or 2.75 adds no goals price |
| Each price row needs its own timestamp (`price_updated_at NOT NULL`)                                                                                         | migration 0038                                                                      | taken from `last_update`                                  |
| A price counts for 3 h after **we** last saw it (`MARKET_ODDS_MAX_AGE_MS`). It must also come from the source's newest sighting and from its latest `ok` run | `packages/scraper/src/constants.ts:80`, `packages/db/src/scrape/market-odds.ts:361` | read each league at least every 2.5 h                     |
| A bookmaker is one voice per upstream (`upstream:bookmaker`)                                                                                                 | `apps/scraper/src/pipeline/event-pricing.ts:136`                                    | two feeds on one league would count Pinnacle twice        |
| A market-priced event whose market goes stale keeps its prices. It never falls back to the model by itself                                                   | `apps/scraper/src/pipeline/reprice.ts:227`                                          | an outage freezes prices, so an alarm is needed           |
| A new pricing key means a re-price, and the key includes the book counts                                                                                     | `market.ts:166`                                                                     | a book that blinks in and out re-prices (measured in P5)  |
| Prices stop moving 10 min before kickoff (`MIN_LEAD_MS`); betting closes 5 min before (`MARKET_CLOSE_LEAD_MS`)                                               | `constants.ts:16`, `constants.ts:87`                                                | no read helps in the last 10 min                          |
| Events are created up to 14 days ahead (`FIXTURE_HORIZON_MS`)                                                                                                | `constants.ts:14`                                                                   | prices are wanted that far out                            |
| The shape check S1 counts accepted fixture records                                                                                                           | `packages/scraper/src/gates/shape.ts:52`                                            | it does not watch a source that only yields prices        |
| A key travels only in a header                                                                                                                               | `packages/scraper/src/adapters/common.ts:602`, `fetch/auth.ts`                      | the query string needs new, careful code (4.4)            |
| No credit budget exists. The scheduler reads a source every 15 min (fixtures) or 5–60 min (results), up to 10% early                                         | `apps/scraper/src/tasks/scheduler.ts:34`, `fetch/cadence.ts`                        | an odds schedule and a guard are new                      |

## 4. Design

### 4.1 The request

One request per league per run, always with explicit filters:

```
GET https://api.the-odds-api.com/v4/sports/{sportKey}/odds
    ?bookmakers=pinnacle,betfair_ex_uk,matchbook,smarkets,williamhill,betsson,unibet_se,tipico_de,marathonbet,onexbet
    &markets=h2h,totals&oddsFormat=decimal&dateFormat=iso
    (the key goes in the x-api-key header, added by the fetcher only)
```

- **Cost: 2 credits** (2 markets × 1 region).
- **Never `regions=`.** It would give 28 EU books for the same price, but several of them copy one price (4.2).
- **No time filters.** The cost is the same either way, and a stable URL keeps the run history comparable. The
  adapter drops what it cannot use (A4).
- **Never these:**
  - the per-event endpoint (`/events/{id}/odds`), which is charged per event (only the optional P7 step reads
    `alternate_totals` there);
  - `/scores`, because openfootball already gives the results;
  - extra markets.

### 4.2 The ten bookmakers

| Key                                      | Why                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pinnacle`                               | the sharpest book, with a low margin; its main totals are Asian lines (2.75, 3), so it rarely counts for over/under |
| `betfair_ex_uk`, `matchbook`, `smarkets` | exchanges: prices made by bettors, margin about 1%, refreshed every 20 s; Betfair and Smarkets give no totals       |
| `williamhill`                            | large UK book with its own traders; its main total is always 2.5                                                    |
| `betsson`                                | own traders; its main total is always 2.5, the only other such book in the Bundesliga                               |
| `unibet_se`                              | Kambi, the supplier behind the Unibet sites, BetRivers and others; margin 2.5 to 3.3%; main total usually 2.5       |
| `tipico_de`                              | large German book with its own traders; main total usually 2.5                                                      |
| `marathonbet`, `onexbet`                 | low-margin international books; main total usually 2.5 (3.5 in the Bundesliga)                                      |

Each of these sets its prices on its own. Left out on purpose, because they copy a listed book (same owner or same
supplier):

- Sky Bet, Betfair Sportsbook and FanDuel: Paddy Power's group (Flutter).
- Coral and BetMGM: Ladbrokes' group (Entain).
- 888sport: William Hill's group.
- NordicBet: Betsson's group.
- The other Unibet sites, BetRivers and Casumo: Kambi, already in through `unibet_se` (Casumo and BetRivers had
  identical prices in the probe).
- `betfair_ex_eu`: the same exchange as `betfair_ex_uk` (identical prices).
- The two Winamax sites.

Spares for the 1X2 if a listed book drops out (none of them gives totals): `paddypower`, `draftkings`, `betfred_uk`,
`betvictor`. Never the French books (`winamax_fr`, `unibet_fr`, `betclic_fr`, `pmu_fr`): margins of 11 to 17%.
Eleven books or more would double the cost, so the config refuses it.

**Chosen after Phase 0 (10.4):** the first list had `paddypower`, `ladbrokes_uk` and `betvictor`, which gave no
totals (and Ladbrokes covered only 2 to 6 matches in four leagues). `betsson`, `unibet_se` and `tipico_de` replaced
them: they quote 2.5, cover nearly every match and set their own prices.

### 4.3 Adapter `theoddsapi` (rules A)

- **A1 Config.**
  - One `sportKey` per source, with its `competition` label (resolved through competition aliases).
  - `bookmakers`: 2 to 10 distinct keys.
  - `markets`: a subset of `h2h` and `totals` (default both).
  - `horizonDays`: 15.
  - `maxBookAgeMinutes`: null until Phase 0, then 20.
  - `allowedHosts`: must cover `api.the-odds-api.com`.
  - `secret`: the name `SCRAPER_SECRET_THEODDSAPI`.
- **A2 Plan.** The request of 4.1, with a new purpose `odds` and auth `{ header: 'x-api-key', secret }` (Phase 0 proved the header; rules K are
  only the fallback). One request per
  run. Until P3 lands, the scheduler reads an `odds` source as it reads fixtures (every 15 min); the sources stay
  disabled until P5.
- **A3 Shape.**
  - The body must be a JSON array. Anything else is fatal, and nothing is stored.
  - An event needs:
    - `id`;
    - `sport_key` equal to the config's;
    - `commence_time` as an ISO instant;
    - `home_team` and `away_team`.

    A bad event is dropped with an issue.
- **A4 Time.** These events are skipped:
  - events that have started (`commence_time` ≤ fetch time; the endpoint also returns live games);
  - events that start beyond the horizon.
- **A5 Books.**
  - Only configured bookmakers are read.
  - `h2h` → `1x2`: the outcome named exactly `home_team` is `1`, `away_team` is `2`, and `Draw` is `X`. All three
    must be there, or the book is dropped.
  - `totals` → `ou`, grouped by `point`. Only x.5 lines that have both Over and Under are kept.
  - The same book listed twice with different prices is dropped, as in `therundown`.
- **A6 Prices.**
  - Conversion uses `decimalToMilli` (`adapters/odds-price.ts`): exact, rounds down, accepts 1.01 to 1000.
  - A failure drops that book's market.
  - When most prices fail, the page is fatal (`wrong_price_format`), as in `therundown`.
- **A7 Timestamps.**
  - A market's `last_update` becomes `price_updated_at` (required).
  - With `maxBookAgeMinutes` set, a market older than that at fetch time is dropped: their scraper has stopped
    seeing that book.
  - A `last_update` more than 5 min in the future is dropped.
- **A8 Output.**
  - Price rows only:
    - bookmaker = the key (`pinnacle`);
    - external ref = the event `id`;
    - upstream `TheOddsAPI`;
    - rows sorted;
    - the parser never throws.
  - No fixtures and no results: the openfootball sources keep those roles. Making The Odds API a fixture upstream
    for the kickoff rules is a separate, later decision.
- **A9 Usage.** A new optional `SourceAdapter.readUsage(headers)` returns `x-requests-last`, `x-requests-used` and
  `x-requests-remaining`. The expected cost per request is markets × ⌈books ÷ 10⌉, which is 2.

S1 counts fixture records, so it does not watch this source. A3's fatal checks, the alarms (4.8) and the shadow
report (P5) stand in for it.

### 4.4 The key in the query string (rules K)

> **Not needed while the header works (Phase 0, section 10.1).** These rules stay as the fallback if The Odds API
> ever refuses the header; the refused-key alarm (4.8) is what would tell us.

The docs show the key only as `?apiKey=`. Phase 0 tests on the free `/v4/sports` whether a header is accepted. If one
is, skip rules K and use the header.

- **K1** `requestAuthSchema` and `RequestAuthRef` become either `{ header, secret }` or `{ query, secret }`. The
  `query` name must match `^[A-Za-z][A-Za-z0-9_]{0,31}$`.
- **K2** The fetcher refuses a plan item whose URL already has a parameter with that name (`secret_invalid`), so an
  adapter can never put a key in a URL.
- **K3** The parameter is added only to the copy of the URL passed to `fetch()` inside `#exchange`. Every URL the
  fetcher returns or remembers is the plan URL without the key:
  - `FetchOk.url`;
  - `not_modified`;
  - validators;
  - robots;
  - the rate limiter;
  - error messages.

  So `scrape_raw.url`, run issues and archive names never hold the key.

- **K4** A request with a query key never follows a redirect (it is refused), because a `Location` header can carry
  the query string onwards.
- **K5** What exists stays: error messages pass through `redactSecret`, and a body that echoes the key is refused
  (`secret_echoed`).
- **K6** Test on a local HTTP server:
  1. The key arrives exactly once, in the query.
  2. Search for the key's value in each of these, and find no hit:
     - `scrape_raw`;
     - `scrape_runs.issues`;
     - archive file names;
     - captured logs;
     - `FetchOk`;
     - the errors of a forced network failure.

  `docs/scraper.md` 6.7 then says:
  - a query key is allowed only when the provider has no header;
  - `therundown` keeps its header (rule A4 of its plan).

### 4.5 Reading schedule

Each source is read according to the next kickoff in **its own price rows** that is more than `MIN_LEAD_MS` (10 min)
ahead:

| Next kickoff   | Read every | Why                                                                       |
| -------------- | ---------- | ------------------------------------------------------------------------- |
| within 3 h     | 10 min     | team news and line-ups (about 75 min before kickoff) move prices the most |
| within 24 h    | 30 min     |                                                                           |
| within 14 days | 2 h        | under the 3 h price age, so prices never lapse between reads              |
| none           | 6 h        | international breaks and summer; a new round is picked up within 6 h      |

- A source's first run is due at once, as today.
- The scheduler's 10% early jitter and its failure backoff (doubling, at most 6 h) apply as for every source.
- It is built as a new pure function `marketOddsPollIntervalMs(now, nextKickoff, mode)` in `fetch/cadence.ts`, with
  its constants in `constants.ts`.
- The scheduler uses it for every source whose plan has purpose `odds`.

### 4.6 Credit budget

Per league, in a normal month (four rounds, Friday to Monday):

| Next kickoff   | Hours     | Reads | Credits                             |
| -------------- | --------- | ----- | ----------------------------------- |
| within 3 h     | about 88  | 528   | 1,056                               |
| within 24 h    | about 296 | 592   | 1,184                               |
| further        | about 336 | 168   | 336                                 |
| **One league** | 720       | 1,288 | **2,576 (about 2,700 with jitter)** |

| Use                                                                | Credits               | Share of 20,000 |
| ------------------------------------------------------------------ | --------------------- | --------------- |
| Five leagues, normal month                                         | about 13,500          | 68%             |
| Five leagues, heavy month (Premier League six rounds, others five) | about 16,000          | 80%             |
| Busiest day (Saturday, all five leagues)                           | about 900             | 4.5%            |
| Phase 0 probe (free plan)                                          | about 40 of 500       | –               |
| Optional historical replay (P7)                                    | at most 3,000 a month | –               |

Adding the Champions League later (it needs a fixture source first) would cost about 800 a month. If heavy months
keep triggering the guard, the 100K plan (59 USD) gives five times the room.

### 4.7 Credit guard (rules G)

The guard is a pure function, `creditGuardMode({ quota, remaining, spentLast24h, daysLeftInMonth })`, in
`packages/scraper/src/fetch/credit-guard.ts`. The quota is `x-requests-used` + `x-requests-remaining` from the latest
response, so the free key and the paid key need no setting.

| Mode    | When                                                                                                      | Reads                                                     |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| normal  | none of the conditions below                                                                              | the schedule of 4.5                                       |
| economy | remaining under 20% of the quota with more than 7 days left, or more than 7.5% of the quota spent in 24 h | 15 min / 60 min / 2.5 h / 6 h                             |
| minimal | remaining under 10%                                                                                       | only leagues with a kickoff within 3 h, every 30 min      |
| stop    | remaining under 1%, or an answer that refuses the key (401)                                               | nothing until the 1st (UTC), or until a person re-enables |

- **G1** There is one guard per key, shared by every `theoddsapi` source.
- **G2** Usage is stored per run. Migration `0041` adds two nullable columns, both ≥ 0:
  - `scrape_runs.api_credits_spent`: the sum of `x-requests-last`;
  - `api_credits_remaining`: from the run's last response.

  The scheduler reads the latest remaining and the spend of the last 24 h.

- **G3** A response that costs more than the expected 2 credits opens an alarm (`unexpected_cost`). It means a book
  list over 10, or a default that changed.
- **G4** Every mode change is logged, and opens or resolves its alarm (4.8).
- **G5** Development and staging use a free-plan key (a second account) and run by hand. Only production holds the
  paid key, so tests cannot use up the production month.

A normal month never leaves `normal`. The guard is there for bugs and heavy months.

### 4.8 Alarms

The review kind `source_broken` accepts any `reason` (contract `packages/contracts/src/feed.ts:521`), so no new
review kind and no migration are needed:

| Reason             | Opens when                                                                                                                     | Resolves when              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `budget_low`       | the guard is in economy or minimal                                                                                             | the guard is normal again  |
| `budget_exhausted` | the guard stops                                                                                                                | credits are back (the 1st) |
| `unexpected_cost`  | rule G3 fires                                                                                                                  | a person dismisses it      |
| `unauthorized`     | a 401 (bad or deactivated key, or no credits left)                                                                             | a read succeeds            |
| `market_stale`     | a market-priced league has an event within 24 h of kickoff whose prices are older than 3 h (the re-pricing pass's `keep` case) | fresh prices arrive        |

The back-office `/feed` page also shows the credits remaining, the guard's mode and the last read per league.

### 4.9 Licence and licensed mode

- **L1** The owner emails The Odds API (section 8) before paying. The written answer goes in
  `docs/theoddsapi-plan/answers.md`.
- **L2** Players never see a bookmaker's raw price. They see ours, made from the consensus with our margin (rule
  O5).
- **L3 Removed (owner's decision, 2026-11-02).** It kept `theoddsapi` sources off in licensed mode until
  `SCRAPER_THEODDSAPI_LICENCE=confirmed`. The owner treats the paid plan as the licence and accepts the risk that
  the terms do not cover an operator setting prices (section 2, "Licence"; section 8 not sent). The sources run in
  licensed mode like any other. The licensed-mode guard in `packages/config/src/config.ts` was never part of L3
  and is unchanged.

### 4.10 What happens when …

| Situation                                     | What the system does                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Odds API is down or returns 5xx           | retries, backoff and the circuit breaker; prices stay; `market_stale` after 3 h                                                                                    |
| Credits run low                               | economy, then minimal; `budget_low`                                                                                                                                |
| Credits run out (`OUT_OF_USAGE_CREDITS`)      | the read fails; stop until the 1st; `budget_exhausted`                                                                                                             |
| A 429                                         | wait for Retry-After, or back off (we send about five requests per ten minutes)                                                                                    |
| A book is missing, stale or wrong             | that book does not count. The checks that remain: the median of the other books, the overround check, a fit residual of at most 0.03, the O3 bounds and the trader |
| Fewer than 2 books                            | no consensus: new events keep model prices, and market-priced events keep theirs                                                                                   |
| No 2.5 line                                   | P2b: the fit uses the other x.5 lines (T1); with none, the match gets no market price (T2, decision 7.4)                                                           |
| A team name is unknown                        | the existing alias review; the event stays on the model until the name resolves                                                                                    |
| A match is moved                              | the rows carry the new kickoff and link through the existing window; this source never moves a kickoff                                                             |
| A live game is in the response                | skipped (A4)                                                                                                                                                       |
| The key leaks                                 | rotate it in the account; we never stored it                                                                                                                       |
| Someone enables TheRundown on the same league | not allowed (books would count twice); `therundown-free` stays disabled                                                                                            |

## 5. Phases and tasks

### P0: free account and licence email

- Who: the owner.
- Size: an hour, then the wait for the reply.
- Needs: nothing.
- Work:
  - Open a free account.
  - Put the key in `.env` as `SCRAPER_SECRET_THEODDSAPI`.
  - Send the email in section 8. Not sent: the owner's decision (section 8).

### P0b: probe script

- Who: routine-coder (Sonnet medium) writes it; the main session runs it and reads the report.
- Size: S.
- Needs: P0.
- File: `apps/scraper/src/cli/theoddsapi-probe.ts`.
- Calls (about 31 credits):
  - a header test on `/v4/sports` (free);
  - `/participants` for each league (5 credits);
  - `/odds` for each league (10 credits);
  - eight Premier League reads in a match day's last 3 h (16 credits).
- Report, per league:
  - events;
  - books per event with a complete 1X2;
  - books per event with a 2.5 line;
  - `last_update` age;
  - overround per book;
  - credits per call.
- It saves bodies to the OS temp folder, outside the repository, and never prints the key or a URL that contains it.

### P0c: book discovery and the over/under check

- Who: the owner runs it; the main session reads the report.
- Size: S, about 18 of the free credits. **Done 2026-11-01** (10.4), 18 credits.
- Needs: P0b.
- Command:

  ```
  pnpm --filter @vamos/scraper-app exec tsx src/cli/theoddsapi-probe.ts --leagues soccer_epl,soccer_germany_bundesliga --regions uk,eu,us --alt-totals 1 --events
  ```

- It answers:
  - Is a request with no key refused (so the header result is proven)?
  - Of every UK, EU and US book, which quote 2.5 as their main total, cover most matches and set their own prices?
  - Does `alternate_totals` on the per-event endpoint give the 2.5 line for these leagues, and from which books?
- Then:
  - Swap the books that give no totals and add least to the 1X2 for books that quote 2.5. First to go:
    `ladbrokes_uk` (2 to 6 matches in four leagues, no totals), `betvictor` and `paddypower` (no totals, margins of
    6 to 10%). Keep `pinnacle`, `betfair_ex_uk`, `matchbook`, `williamhill`, `marathonbet` and `onexbet`.
  - Still ten books at most, each setting its own prices (4.2).
  - Re-reading the saved bodies costs nothing: `--from-dir <folder> --events`.

### P1: key in the query string

- Who: the main session, Opus high (security work).
- Size: M.
- Needs: nothing.
- **Skipped:** P0b found the `x-api-key` header accepted (P0c confirms it). Do P1 only if the header is ever refused.
- Work: rules K1 to K6 (4.4).

### P2: the adapter

- Who: routine-coder (Sonnet medium), with an Opus high review.
- Size: M.
- Needs: P0b and P0c (the book list).
- **Done 2026-11-02:** `packages/scraper/src/adapters/theoddsapi.ts`, migration 0041 (the adapter name), the five
  disabled source files with the new ten books, unit tests (`theoddsapi.test.ts`) and a run on a real Postgres
  (`apps/scraper/test/theoddsapi-run.test.ts`: the key only in the `x-api-key` header, the prices stored and
  linked, the match priced from the market). What differs from the rules below:
  - A1/A2: the key goes in the `x-api-key` header (Phase 0), never the query; `maxBookAgeMinutes` defaults to 20.
    The plan item's purpose is `fixtures` (read at the fixtures cadence) until P3 gives odds their own schedule.
  - A9 (reading the usage headers) moved to P3, which stores them: it needs the fetcher to pass headers on.
    `theOddsApiCost(config)` gives the expected cost (2).
  - The competition labels are the openfootball ones, so the existing competition aliases resolve them. Team
    aliases: no CSV yet. Unknown names go to the alias review as usual; the CSV can be built from the probe's
    `/participants` bodies (`--participants`) when they are at hand.
- Work:
  - Rules A1 to A9, with unit tests on a synthetic fixture shaped like P0b's response.
  - Five sources, disabled: `docs/scraper-plan/data/source-theoddsapi-{en1,es1,it1,de1,fr1}.json`.
  - Team and competition aliases from `/participants`, in `docs/theoddsapi-plan/aliases-theoddsapi.csv`, checked
    by a person.

### P2b: no goal lines from a 1X2-only fit (rules T)

- Who: the main session, Opus high (money path: pricing).
- Size: M. **Done 2026-11-01.**
- Needs: nothing. It is a hole in today's pricing, whatever the feed.
- Why: with a 1X2 consensus and no 2.5 consensus, `fitGoalsToMarket` fits both expected goals to the 1X2 alone. Two
  targets, two unknowns: the fit is exact, so the event passes the residual check and is priced from the market. But
  the independent Poisson can only reach the market's draw (F-17) by lowering the goals, so over 2.5 comes out 5 to
  9 points low (10.3), and every over/under, BTTS and correct-score price inherits it.
- Rules:
  - **T1** The fit uses one goal line with the 1X2: 2.5 when it has a consensus (exactly as before, so nothing
    changes for those matches), otherwise the x.5 line from 1.5 to 4.5 with the most books, then the nearest to 2.5,
    then the lower. `marketPricingKey` shows the line it fitted (`ou3.5:310/5`). The 2.5 line is still priced
    straight from its consensus when it has one.
    - One line, not all of them: a second line would change the prices of matches that have 2.5, and the independent
      Poisson matches several lines less closely, so more matches would be held as `poor_fit`.
    - On the cases of 10.3, a 3.5 or 1.5 line puts the fitted goals within 0.02 of the truth and over 2.5 within half
      a point, with a fit residual of about 0.8%.
  - **T2** With no over/under consensus on any x.5 line, the event is not priced from the market: new fallback
    reason `no_totals`, and the team-rating model prices the whole match (decision 7.4).
  - **T3** Moved to P5, because there is no shadow report yet. The reason is already recorded in the audit
    (`marketFallback`) and in the `odds_approval` payload (`pricing.fallback`).
- Tests:
  - the cases of 10.3: a 1X2 alone gives `no_totals`;
  - a 3.5-only consensus moves the fitted goals to it;
  - property: for a market generated by the model itself, the fit recovers its expected goals within 0.01 from any
    subset of its x.5 lines.

### P3: storage, reading schedule and guard

- Who: the main session, Opus high (migration and scheduler).
- Size: M.
- Needs: P2.
- **Done 2026-11-02.** What was built, and where it differs:
  - Migration **0042** (0041 went to the adapter name): `scrape_runs.api_credits_spent`, `api_credits_used` and
    `api_credits_remaining`, nullable, ≥ 0. `used` is stored too, because the quota is used + remaining.
  - `run-source` reads each response's usage through the adapter (`usage.read`, rule A9), stores it on the run,
    and adds the issue `unexpected_cost` when a response costs more than expected (G3). A failed fetch keeps its
    HTTP status in the issue, so the guard can tell a refused key (401).
  - `marketOddsPollIntervalMs` (`fetch/cadence.ts`) and `creditGuardMode` (`fetch/credit-guard.ts`), pure, with
    property tests. The adapter's requests have purpose `odds`.
  - The scheduler groups odds sources by key (the secret's name, G1) and works out each key's mode on every pass
    from this month's runs. A 401 stops the key until a later reading clears it, a person changes a source of
    the key, or the month ends. In minimal mode a league with no stored kickoff is not read. Mode changes are
    logged (G4); the alarms are P4.
  - Rule L3 was built, then removed on the owner's decision (4.9).
  - Tests: `credit-guard.test.ts` and `apps/scraper/test/scheduler-odds.test.ts` on a real Postgres.
- Work:
  - Migration 0041.
  - Usage recording in `run-source`.
  - The reading schedule (4.5).
  - The guard (4.7).
  - The scheduler wiring.
  - Rule L3.

### P4: alarms and operations

- Who: routine-coder (Sonnet medium).
- Size: S to M.
- Needs: P3.
- Work:
  - The alarms (4.8).
  - The credits panel on `/feed`.
  - This source's rules in `docs/scraper.md`.
  - A runbook, `docs/runbooks/odds-credits-low.md`.

### P5: shadow run

- Who: the owner buys the plan; routine-coder writes the report; quick-task (Haiku low) runs it each week.
- Size: two weeks.
- Needs: P4.
- Work:
  - Buy the 20K plan.
  - Enable the five sources while every league stays on `model`.
  - The report counts events per fallback reason: `no_consensus`, `no_totals`, `poor_fit` (rule T3).
  - Run for two weeks.

### P6: switching on

- Who: the owner or a trader.
- Size: two weeks.
- Needs: the gates of section 6.
- Work: switch the Premier League to `market` (back office `/feed`) for one week, then the other four leagues.

### P7: optional accuracy steps

- Who: the main session, Opus high (money path).
- Size: M each.
- Needs: P5's data. Each step is decided on that data:
  - never offer more than the best book's price, so no bettor gets a better price from us than from a listed book;
  - raise `CONSENSUS_MIN_BOOKS` to 3;
  - bucket the book counts in the pricing key;
  - read `alternate_totals` for each match on the per-event endpoint, for a 2.5 line from Pinnacle, Betfair and the
    large UK and US books (10.4): 1 credit per match and read with up to 10 named books, about 550 credits a month
    at 3 reads per match;
  - a historical replay of at most 3,000 credits a month.

### When each task is done

Each task is done when `pnpm typecheck`, `pnpm lint`, `pnpm format` and the tests of the packages it touched pass,
plus:

- **P0b:** the report exists for all five leagues, and each odds call cost 2 credits. Done 2026-11-01 (section 10).
- **P0c (done 2026-11-01):** the report exists for the Premier League and the Bundesliga, and 4.2 lists the new ten with the reason for
  each change.
- **P2b (done 2026-11-01):** rules T1 and T2 with the tests listed in P2b; every existing pricing and event-pricing
  test still passes. T3 is part of P5.
- **P1:**
  - K6 passes;
  - every existing auth and fetcher test still passes;
  - a header source behaves exactly as before.
- **P2 (done 2026-11-02):**
  - The parser never throws.
  - Tests cover:
    - the draw found by name;
    - outcomes in another order;
    - a missing draw;
    - a 2.75 and a 3.5 line;
    - a game that has started;
    - a game beyond the horizon;
    - an eleventh book;
    - the same book with two prices;
    - a stale and a future `last_update`;
    - prices such as 2.07 and 1.952, converted exactly (2070, 1952).
  - An integration test on `createTestDatabase` stores rows, then prices an event of a market-priced league from them.
- **P3 (done 2026-11-02):**
  - Property tests:
    - the interval never drops below 10 min;
    - the interval never grows as kickoff gets closer;
    - fewer credits remaining never gives a faster mode;
    - `stop` never reads.
  - On a real Postgres: the usage columns are written, and the guard reads them.
- **P4:** each alarm opens once and resolves (idempotent), on a real Postgres.

### Prompts for a fresh session

Each prompt also says: "read `docs/theoddsapi-plan/README.md` first; do not commit".

- **P0b:** "Write `apps/scraper/src/cli/theoddsapi-probe.ts` (task P0b): read the key from
  `SCRAPER_SECRET_THEODDSAPI`, never print it or a URL that contains it, make the listed calls, save the bodies
  under the OS temp folder, and print the report and the credits from `x-requests-last`. Do not run it."
- **P1:** "Implement rules K1 to K6 (section 4.4) in `packages/scraper/src/fetch/{auth,polite-fetcher}.ts`,
  `adapters/common.ts` and `types.ts`, with the leak test K6 on a local HTTP server. Header auth must behave exactly
  as before."
- **P2:** "Write `packages/scraper/src/adapters/theoddsapi.ts` (rules A1 to A9), registered like `therundown`. Add
  its tests on a synthetic fixture shaped like the probe's Premier League response, the five disabled source files
  and the alias CSV built from the probe's participants."
- **P2b (done 2026-11-01):** "Implement rules T1 to T3 (task P2b) in `packages/feed/src/pricing/market.ts` and
  `apps/scraper/src/pipeline/event-pricing.ts` (and the fallback enum in `packages/contracts/src/feed.ts`), with the
  tests listed in P2b. The 2.5 price of an event that has a 2.5 consensus must not change."
- **P3:** "Add migration 0041 (rule G2) and usage recording in `apps/scraper/src/pipeline/run-source.ts`. Write
  `marketOddsPollIntervalMs` (4.5) and `creditGuardMode` (4.7) as pure functions with unit and property tests. Wire
  them into the scheduler for purpose `odds`, and add rule L3."
- **P4:** "Add the alarms of section 4.8 (reasons on `source_broken`), the credits panel on `/feed`, this source's
  rules in `docs/scraper.md`, and `docs/runbooks/odds-credits-low.md`."
- **P5 report:** "Write `apps/scraper/src/cli/market-shadow-report.ts`. For the five leagues over the last 7 days,
  report:
  - credits per day against the plan;
  - the share of events with a fresh consensus from at least 2 and at least 3 books, by hours to kickoff;
  - the share with a 2.5 consensus;
  - fit residuals;
  - unresolved names;
  - pricing-key changes that come only from a book count;
  - the gap between the model's and the market's 1X2."

## 6. Switching a league on

The shadow run (P5) passes when, over two weeks, all of these hold:

1. Credits stay at or under 70% of the month's pace, with no guard alarm.
2. From 48 h before kickoff, at least 95% of the five leagues' events have a fresh 1X2 consensus from at least 3
   books.
3. At most 2% of priced events fail the fit (`poor_fit`).
4. P2b is in, and from 48 h before kickoff at least 90% of each league's events have 2 books on one x.5 over/under
   line (the rest go to the team-rating model, decision 7.4).
5. No team name has been unresolved for the last 7 days.
6. A search of the database, the archive and the logs for the key finds nothing (the key travels only in the header;
   K6 as well if P1 was ever done).
7. For real money only: the paid plan is active (the owner's decision replaces the written licence answer, 4.9).
8. For real money only: the house liability caps are set (back office, Settings, "House liability caps"). They
   default to no cap. The owner decides the amounts from the bankroll: the most the house can afford to owe if one
   outcome, or one match, goes against it.

Then the Premier League goes to `market` for one week, while a trader watches re-prices and held proposals. After
that, the other four leagues. If anything looks wrong, set the league back to `model` in the same select.

## 7. Decisions for the owner

1. **Stale market near kickoff.** Two options:
   - Keep the last prices (what happens today). A frozen market price still knows more than the model, which never
     reacts to news.
   - Stop betting on an event whose prices are older than X within 3 h of kickoff (fail closed). Recommended before
     real money, together with the liability caps of `docs/therundown-plan/README.md` (task T6).
2. Which P7 steps to take, once the shadow numbers are in.
3. Stay on 30 USD unless the guard leaves `normal` two months running; then move to the 59 USD plan.
4. **A match with a 1X2 consensus but no over/under consensus (P2b, rule T2).** Decided 2026-11-01: the first
   option, the team-rating model. The options were:
   - Price the whole match from the team-rating model, as for a match with no consensus at all. Recommended: simple,
     and what already happens to every match the feed does not cover.
   - Keep 1X2, double chance and draw no bet from the market and take the goal markets off for that match. Better
     prices where we have them, but a second pricing mode to build and test.

## 8. Email to The Odds API (P0)

> **Owner's decision 2026-11-01: not sent.** The owner accepts that The Odds API may close the account; the demo
> goes ahead without an answer. Gate 7 (section 6) brings the question back before real money.

To team@the-odds-api.com, from the account's address:

> We are building a sportsbook: a play-money demo now, and a licensed real-money operation in Costa Rica later.
>
> 1. May we use your odds internally to set our own prices? We add our own margin, players never see your prices,
>    and we never pass your data on. Is this allowed on the 20K plan?
> 2. Does the same answer hold for the play-money demo?
> 3. May we keep raw responses for 7 days? May we keep numbers we derive from them for longer, as evidence (for
>    example, our price against the market when a bet was taken)?
> 4. Your API accepts the key in an `x-api-key` header. May we rely on that, and would you tell us before it changes?
> 5. When the monthly credits run out, are requests refused until the 1st, with no overage charge?
> 6. Soccer `totals` gives one main line per bookmaker. Is `alternate_totals` on the per-event endpoint the supported
>    way to get every book's 2.5 line, and is it available on the 20K plan?
> 7. Is `last_update` the time you last saw the price, or the time it last changed?
> 8. Do you publish an uptime figure or a status page?

## 9. Sources

- Plans and prices: https://the-odds-api.com/
- Endpoints, credit costs, parameters and usage headers: https://the-odds-api.com/liveapi/guides/v4/
- Error codes: https://the-odds-api.com/liveapi/guides/v4/api-error-codes.html
- Markets: https://the-odds-api.com/sports-odds-data/betting-markets.html
- Bookmakers by region: https://the-odds-api.com/sports-odds-data/bookmaker-apis.html
- Sports and sport keys: https://the-odds-api.com/sports-odds-data/sports-apis.html
- Update intervals and latency: https://the-odds-api.com/sports-odds-data/update-intervals.html
- Rate limit: https://the-odds-api.com/guide/rate-limit.html
- FAQ (credit reset, cancelling): https://the-odds-api.com/manage/faqs.html
- Terms: https://the-odds-api.com/terms-and-conditions

## 10. Phase 0 results (2026-11-01, free key)

### 10.1 Auth, cost and freshness

- `/v4/sports` answered 200 with the key only in an `x-api-key` header, and the usage headers showed the account's
  500 credits, so the header identified the account. In P0c a request with no key got 401, so the header is proven;
  every charged P0c call used it.
- Each `/odds` call cost 2 credits and each `/participants` call 1, as section 2 says. The run cost 15 credits.
- Every book's median `last_update` age was 0 to 2 minutes, even for matches more than a week away whose prices
  rarely move. So `last_update` is most likely when their scraper last saw the price, which is what A7 needs.

### 10.2 Coverage (prematch events)

| League         | Events | Books with a complete 1X2 (min / median / max) | Books on 2.5 (min / median / max) | Matches with a 2.5 consensus | Matches with 2 books on one x.5 line |
| -------------- | -----: | ---------------------------------------------- | --------------------------------- | ---------------------------: | -----------------------------------: |
| Premier League |     13 | 5 / 9 / 10                                     | 1 / 3 / 5                         |                     10 (77%) |                             12 (92%) |
| LaLiga         |     14 | 8 / 9 / 10                                     | 1 / 4 / 5                         |                     11 (79%) |                            14 (100%) |
| Serie A        |     16 | 6 / 8 / 10                                     | 1 / 4 / 5                         |                     13 (81%) |                            16 (100%) |
| Bundesliga     |     11 | 8 / 10 / 10                                    | 1 / 1 / 4                         |                      2 (18%) |                            11 (100%) |
| Ligue 1        |     14 | 7 / 8 / 9                                      | 1 / 3 / 4                         |                     11 (79%) |                            14 (100%) |

With the first ten books. The last two columns come from re-reading the saved bodies (`--from-dir`): with rule T1, 92
to 100% of matches already had a totals line the fit can use.

Per book:

- `totals` holds at most one line per book and match: the line counts add up to the books' matches, exactly so in
  the Bundesliga and Ligue 1.
- **No totals at all:** `betfair_ex_uk`, `smarkets`, `paddypower`, `betvictor`, `ladbrokes_uk`.
- **Always 2.5:** `williamhill`, every match, even in the Bundesliga where most main lines are 3.5.
- **Usually 2.5 (mostly 3.5 in the Bundesliga):** `onexbet`, `marathonbet`, `matchbook`.
- **Asian main lines (2.75, 3, 3.25):** `pinnacle`. The consensus takes x.5 lines only, so Pinnacle rarely counts.
- **Thin coverage:** `ladbrokes_uk` (2 to 6 matches outside the Bundesliga), `matchbook` (none in Ligue 1),
  `betfair_ex_uk` (6 of 16 in Serie A), `betvictor` (8 to 14).
- **Median 1X2 overround:** `betfair_ex_uk` 0.6–3.9%, `matchbook` 0.7–5.1%, `onexbet` 1.5–1.6%, `smarkets` 2.6–5.1%
  but 13.4% in Serie A (a thin exchange market; the median across books absorbs it), `marathonbet` 4.3–4.6%,
  `pinnacle` 4.8–5.6%, `ladbrokes_uk` 6.2–7.1%, `betvictor` 6.4–9.8%, `paddypower` 6.6–8.9%, `williamhill` 7.1–9.1%.

### 10.3 What a missing 2.5 line costs today

Measured with today's `fitGoalsToMarket`, on markets generated by the model with the draw raised by F-17's
1.7 points (taken from home and away in proportion):

| True expected goals (home v away) | True over 2.5 | 1X2-only fit: goals | 1X2-only fit: over 2.5 | Error       |
| --------------------------------- | ------------: | ------------------: | ---------------------: | ----------- |
| 2.75 (1.40 v 1.35)                |         51.8% |                2.46 |                  44.7% | −7.2 points |
| 2.70 (1.60 v 1.10)                |         50.6% |                2.42 |                  43.6% | −7.0 points |
| 2.90 (2.10 v 0.80)                |         55.4% |                2.59 |                  47.8% | −7.6 points |
| 2.20 (1.15 v 1.05)                |         37.7% |                2.00 |                  32.4% | −5.3 points |
| 3.40 (1.90 v 1.50)                |         66.0% |                2.99 |                  57.4% | −8.6 points |

With a draw premium of 2.5 points the errors are 7.6 to 12.4 points. In the first row we would sell over 2.5 at about
2.11 (44.7% plus the 6% margin) against a fair 1.93: an edge of about 9% for the bettor. The fit's residual is 0, so
nothing holds such a match today. Task P2b.

### 10.4 Book discovery (P0c, 18 credits)

Every UK, EU and US book for the Premier League and the Bundesliga (`--regions uk,eu,us`, 6 credits per league):

- 50 books; 39 to 50 per match (17 for a match three weeks away).
- **Main total:** in the Premier League most books with totals give 2.5. In the Bundesliga only `williamhill`,
  `betsson` and `nordicbet` give 2.5; the others give 3.5 (4.5 for Bayern's match), and `pinnacle` and `bovada`
  quarter or whole lines.
- **No totals at all,** besides the five of 10.2: `betano_uk`, `betclic_fr`, `betfair_sb_uk`, `betfred_uk`, `betway`,
  `boylesports`, `coral`, `draftkings`, `everygame`, `fanduel`, `livescorebet`, `skybet`, `sport888`, `unibet_fr`,
  `unibet_uk`, `virginbet`, `winamax_de`, `winamax_fr`.
- **Copies seen in the prices:** `betfair_ex_eu` equals `betfair_ex_uk`; `casumo` equals `betrivers`.
- **French books** carry 1X2 margins of 11 to 17% (`winamax_fr` 16.7%, `unibet_fr` 13.9%, `betclic_fr` 12.1%,
  `pmu_fr` 11.0%).
- **`alternate_totals`, per event:** 15 books (Liverpool v Arsenal) and 16 (Union Berlin v Köln) gave both sides of
  2.5, among them `pinnacle`, `betfair_ex_uk`, `draftkings`, `fanduel`, `paddypower`, `williamhill` and `betrivers`.
  Cost: markets × regions, so 3 credits with three regions and 1 with up to 10 named books. A book can leave its main
  line out of this market (`bovada` had no 2.5 there).
- **The new ten on these bodies:** `--from-dir <folder> --books <the ten>` re-reads them with only those books.
  Expected from the per-book counts: a 2.5 consensus on every match of both leagues, made of exactly `williamhill`
  and `betsson` on most Bundesliga matches, plus a 3.5 consensus of about five books there.
