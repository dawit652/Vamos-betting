# Feed quality plan: review queue, odds accuracy, result accuracy

Status: **living plan**, started 2026-11-10. Owner decisions are marked **DECISION**. Section 9 is the progress
table; update it as items land.

This plan covers the scraped (real) football feed in licensed mode: the back-office review queue (unknown teams and
competitions, fixture conflicts, uncalibrated ratings, odds approval), the accuracy of the odds we offer, the accuracy
and speed of automatic results, and a standing comparison with well-known sportsbooks.

---

## 1. Where we are (evidence)

### 1.1 Production snapshot, 2026-11-10 15:41 UTC (`scripts/feed-report.ps1`)

| Area                 | Finding                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack                | 7 services healthy, licensed database, public API 200. All six feed scripts finished.                                                                                                                 |
| Sources              | 64 enabled: 10 football-data.org, 4 openfootball, 24 The Odds API price sources, 24 The Odds API score sources. Every latest run `ok`.                                                                |
| **Premier League**   | **0 matches on the site.** footballdata-en1 fetched 280 fixtures and 100 results, theoddsapi-en1 10 fixtures: all rows have no competition. One open `unknown_competition`: "English Premier League". |
| Review queue (open)  | odds_approval **120**, unknown_team **48**, ratings_uncalibrated **37** (16 already resolved), fixture_conflict **2**, unknown_competition **1**.                                                     |
| Matches              | 110 scheduled in 12 competitions (14 to 24 November). **19 open for betting** (Championship 10, Eredivisie 9). Next 7 days: 22 matches, 0 open.                                                       |
| Competition policy   | 29 competitions enabled, all `pricing_source = market`, `auto_open` on, `auto_results` on (Conference League: off).                                                                                   |
| Bookmaker prices     | 10 books arriving: onexbet, marathonbet, tipico_de, betsson, unibet_se, williamhill, **pinnacle**, smarkets, **betfair_ex_uk**, matchbook. Up to 97 matched events.                                   |
| The Odds API credits | about 17,600 left (17,666 at 15:20, 17,624 at 15:39 on the first runs).                                                                                                                               |
| Unmatched rows       | No-team rows on theoddsapi be1 5, br1 2, cdr 8, ch1 6, en3 2, en4 1, nl1 2, sco1 1, tr1 5; footballdata-cl 8 fixtures and 7 results.                                                                  |
| Ratings              | 362 teams with ratings, 147 with a match count, 136 backfilled, 15 manual.                                                                                                                            |
| Aliases              | 51 team aliases, 4 competition aliases.                                                                                                                                                               |
| Results              | 0 applied (no match played yet).                                                                                                                                                                      |
| Logs                 | Only `sms_gateway_silent` every 5 minutes (no SMS forwarder handset yet).                                                                                                                             |

Sample unknown spellings: Erzurum BB, Genclerbirligi SK, Çorum FK, Amed SK, Besiktas JK, Gazişehir Gaziantep, Torku
Konyaspor, Falkirk F.C., St Johnstone, FC Twente Enschede, FC Zwolle, York City, Rochdale, Leicester City, Sheffield
Wednesday.

### 1.2 What the code does today (from reading it, file references in section 10)

- **Names match exactly, after normalisation.** NFKC, lowercase, diacritics folded, punctuation dropped, and only
  `fc cf sc afc bsc` stripped at the ends. No fuzzy matching. Suggestions use token overlap and were wrong for 18 of 34
  clubs outside the catalogue in our own evaluation. There's no bulk path: one item at a time, and the back office
  always creates an all-source alias.
- **The Premier League competition alias is only imported by `use-real-fixtures.sh`.** That script is demo-only, so a
  licensed install never gets it. This is the root cause of the empty Premier League.
- **Events are always created closed and on model prices.** Market prices replace them on a later pass.
- Betting opens when either:
  - F7 or F7b passes: auto_open on, **both teams calibrated (O1)**, prices sane (O2), and the kickoff confirmed by
    two upstreams (K2); or
  - a person opens it.
- **O1 still applies to market-priced events.** The spec (O5) says they "count as calibrated", so promoted and
  foreign clubs can never open even with 10 books quoting. This is the main source of the 37 ratings items and many
  of the 120 approvals.
- **A held re-price leaves the old prices bettable.** A move over 1.25x is held for approval, and a lapsed market
  freezes prices with no suspend. Late team news is the exposure.
- **Market consensus is thin:**
  - at least 2 complete books;
  - equal weights and proportional de-vig;
  - a book older than 20 minutes is dropped;
  - Poisson fit residual up to 0.03, which is about half our margin;
  - the draw isn't fitted;
  - the half-time model gives the first half 49% of goals (about 45% is typical).
- **Our margin is a fixed 6% (correct score 15%).** The average book is 4.9% and Pinnacle 3.0%, as measured on 1X2
  in the October evaluation.
- **Results need two independent upstreams** agreeing for 15 minutes, with half time (every football event has an
  HT market). Half time only comes from football-data.org. **15 of 24 Odds API competitions have a single upstream**,
  so every result there waits 7h45 and then goes to a person.
- **Measurement exists only for the rating model**, offline. Results from October:
  - 1X2 log-loss 1.0304 vs base rate 1.0927;
  - 2.17% worse than the closing line;
  - calibration error up to 3.2 pp;
  - over/under and BTTS no better than base rates.
- **Nothing measures the market path in production.** There's no closing-line capture, no out-of-line check and no
  shadow report.
- **Credits don't fit the plan.** The Odds API plan is 20K credits a month, sized for 5 leagues (about 2.6–2.7K
  credits per league per month). 24 price sources plus 24 score sources need roughly 60–70K a month. The credit
  guard will fall to economy, then minimal, then stop. The result would be frozen prices and no second results
  upstream.
- **Bugs:**
  - `market_stale` doesn't fire for `no_totals` or `poor_fit`;
  - a manual Trading result doesn't update ratings and has no 105-minute floor;
  - home advantage is learned per competition but stored per team, so a cup result overwrites the league value;
  - several docs are stale (O5, scraper-operations "never opens betting", kickoff-safety "not built", `cli usage`).

---

## 2. Goals and success measures

| Goal                                                         | Measure                                                              | Target                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| Every enabled league shows its matches                       | Upcoming fixtures on the site vs fetched by sources, per competition | 100% for competitions with a source   |
| Review queue is real work only                               | Open items that need a human decision, vs total open                 | ≥ 90%; no item older than its event   |
| Unknown names resolved without manual typing                 | Unknown-name items open for more than 24 h                           | 0 for clubs in the catalogue          |
| Betting opens without hand approval when the market is solid | Share of market-priced events opened automatically                   | ≥ 90%                                 |
| Our odds are as good as the market                           | 1X2 relative log-loss vs Pinnacle no-vig close; closing-line value   | within 1% of Pinnacle; median CLV ≥ 0 |
| Never easier to beat than the market                         | Our price above the best book price                                  | 0 occurrences                         |
| Results are right and fast                                   | Applied results that disagree with the official score (after 48 h)   | 0                                     |
|                                                              | Final whistle to applied result, two-upstream competitions           | median ≤ 20 min, p90 ≤ 30 min         |
| Credits last the month                                       | Days until the credit guard leaves normal mode                       | ≥ 30                                  |

---

## 3. Guardrails (apply to every item)

1. **Scraped data never cancels, voids or abandons an event** (CLAUDE.md). Results reach `resultEvent` only through
   `applyConfirmedResult`. Nothing here changes that.
2. **Licensed-mode guard stays relaxed** (owner decision). Don't restore the strict checks.
3. **Money-path changes ship with unit plus integration tests.** That covers opening betting, prices, suspension,
   results and settlement. They're staged in shadow (measure first, then act).
4. **Automatic name mapping is source-scoped and audited,** never global. A wrong alias can settle bets on the wrong
   team. Two independent signals are needed: the name, and the fixture context (kickoff plus opponent).
5. **Comparison with other sportsbooks uses licensed data only:** The Odds API books. Local competitors (Ethiopian or
   Costa Rican books) are checked by hand. We don't scrape sites whose terms forbid it.
6. **Model and effort per task** (CLAUDE.md, owner request):
   - **Opus-high** for money-path design and code;
   - **Sonnet-medium** (`routine-coder`) for well-specified code, UI and docs;
   - **Haiku-low** (`quick-task`) for running checks and reports.

   At most two agents at once. The main session reviews, verifies and commits.

---

## 4. Workstream 0: immediate operations (no code, owner on the server)

| ID  | Action                                                                                                                                                                                                                         | Why                                      | Who              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------- |
| O-1 | Import the Premier League competition alias (command in section 8).                                                                                                                                                            | Brings in the 380 Premier League matches | Owner, 1 command |
| O-2 | **DECIDED 2026-11-10: upgrade to the 100K-credit plan** (about 60–70K a month needed for the 24 leagues). Keep all 24. Workstream 4 still lowers the need. After the upgrade, check the credit guard is back in `normal` mode. | Prevents frozen prices and lost results  | Owner            |
| O-3 | Set up the SMS forwarder handset, or accept the `sms_gateway_silent` alarm until then.                                                                                                                                         | Deposits can't arrive without it         | Owner            |
| O-4 | Re-run `scripts/feed-report.ps1` (now with sections 16–20: why each approval waits, every unknown name, uncalibrated teams).                                                                                                   | Exact inputs for W1                      | Owner            |
| O-5 | In the back office, dismiss nothing in bulk yet. Items come back while their cause persists.                                                                                                                                   | Avoid churn                              | Owner            |

---

## 5. Workstream 1: review queue

### W1.1 Unknown competition and unknown team

| ID  | Change                                                                                                                                                                                                                                                                                                                                                                                | Files                                                                         | Tests                                                                                                          | Risk                  | Tier                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------- |
| U-1 | `use-football-data.sh` imports `aliases-openfootball-en1.csv` (the Premier League competition alias), so a licensed install doesn't depend on the demo script.                                                                                                                                                                                                                        | infra/scripts/use-football-data.sh                                            | script syntax; idempotent import already tested                                                                | low                   | Opus (tiny)          |
| U-2 | **Alias CSV for The Odds API spellings in all 24 competitions,** built from the production unknown list (O-4 section 18) and checked against the catalogue short names. Imported by `use-odds-api.sh` and `add-more-competitions.sh`, source-scoped to `theoddsapi-*`.                                                                                                                | docs/scraper-plan/data/aliases-theoddsapi-*.csv, the two scripts              | catalogue tests: every target exists, no alias maps to two teams                                               | low                   | Sonnet + main review |
| U-3 | **Normaliser: strip more legal-form affixes at the ends:** `fk sk jk bb as ac ca cd ud sv fsv vfb vfl tsg ssc` and a short sponsor-prefix list (Torku). Only applied when the stripped name **still resolves to exactly one** team. Otherwise fall back to today's behaviour.                                                                                                         | packages/scraper/src/normalize/name.ts, alias.ts                              | property tests: no new ambiguity on the catalogue; known pairs (Besiktas JK, Falkirk F.C., FC Twente Enschede) | medium (wrong merges) | Opus                 |
| U-4 | **Fixture-context suggestions.** For an unknown name, look up the catalogue fixtures in the same competition within ±24 h whose opponent resolved. Exactly one candidate plus name similarity at least 0.6 gives a **strong suggestion**. Auto-apply as a **source-scoped** alias only behind a setting (off by default) and only while R2 (two upstreams) protects results. Audited. | apps/scraper/src/pipeline/run-source.ts, normalize/alias.ts, new settings key | unit: unique and ambiguous cases; pipeline: alias applied, rows re-resolve, audit row                          | medium-high           | Opus                 |
| U-5 | **Back office bulk map.** List unknown names grouped by spelling, showing the strong suggestion and the fixture context. Tick, then "Map selected" (source-scoped by default, all-source optional).                                                                                                                                                                                   | apps/admin/src/app/feed/review, API resolve route (batch)                     | API tests; e2e map flow (missing today)                                                                        | low                   | Sonnet               |
| U-6 | **Catalogue gap report.** A CLI that lists clubs seen in sources for a competition but missing from the catalogue (e.g. Champions League and cup newcomers), as a CSV ready for `add club` review.                                                                                                                                                                                    | apps/scraper/src/cli                                                          | CLI test                                                                                                       | low                   | Sonnet               |

### W1.2 Fixture conflict

| ID  | Change                                                                                                                       | Tier               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| F-1 | Show the disagreement (sources, kickoffs, status) on the review page. The payload already has `reasons` and `detail`.        | Sonnet             |
| F-2 | Auto-close a fixture_conflict when the sources agree again for 2 consecutive runs. It's dismiss-only today and never closes. | Opus (gate change) |

### W1.3 Uncalibrated ratings

| ID  | Change                                                                                                                                                                                                                                                                                              | Files                                                                                                                          | Risk                 | Tier     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------- | -------- |
| R-1 | **Market-priced events count as calibrated** for opening (align the code with spec O5). Applies only when the event's current prices come from a market consensus that meets the stricter W2 rules (at least 3 books including one sharp book, fresh, sane overround). Model-priced events keep O1. | packages/scraper/src/gates/fixture.ts (F7), apps/scraper/src/pipeline/auto-open.ts, apps/api/src/modules/admin/open-betting.ts | high (opens betting) | **Opus** |
| R-2 | The ratings item names the team(s) and their match count; `ratings list --unrated` shows unrated teams.                                                                                                                                                                                             | promote-fixtures.ts payload, cli/ratings.ts                                                                                    | low                  | Sonnet   |
| R-3 | Ratings page in the back office (view, set manual, trigger backfill).                                                                                                                                                                                                                               | admin app + API                                                                                                                | medium               | Sonnet   |

### W1.4 Odds approval

| ID  | Change                                                                                                                                                                                                                  | Risk   | Tier                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- |
| A-1 | **Create market-priced events on market prices when a consensus exists.** Today they start on the model and the later switch triggers a >1.25x re-price hold.                                                           | high   | Opus                 |
| A-2 | **A held re-price suspends the event's markets** until it's approved, instead of leaving the old prices bettable. A lapsed market closer than 3 h to kickoff with no fresh consensus for 30 minutes also suspends.      | high   | Opus                 |
| A-3 | The review page shows the pricing source, books used, residual, our price vs the consensus vs Pinnacle, and the kickoff evidence. All are in the payload or derivable.                                                  | low    | Sonnet               |
| A-4 | **Bulk approve** in the back office: select items whose prices are within tolerance of the consensus (e.g. every 1X2 price within 3% of the no-vig consensus, after margin). It re-checks O2 and kickoff on the server. | medium | Sonnet + Opus review |
| A-5 | **DECISION: K2 for human opens.** Build `recordKickoffConfirmation` for traders (spec exists), or document that human opens skip K2.                                                                                    | medium | Opus                 |

### W1.5 Queue hygiene and visibility

| ID  | Change                                                                                                                                                                            | Tier                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Q-1 | **Sweeper:** close odds_approval and ratings_uncalibrated items whose event is already open, has started, is resulted, or no longer exists. Resolution `auto: <reason>`, audited. | Sonnet + main review |
| Q-2 | `cli review counts`: open items by kind with the oldest date. `countReviewItemsByKind` already exists.                                                                            | Sonnet               |
| Q-3 | Re-raised dismissals: show "dismissed n times" and the last note instead of a fresh item.                                                                                         | Sonnet               |

---

## 6. Workstream 2: odds accuracy and comparison with sportsbooks

### W2.1 Measure first (shadow, no behaviour change)

| ID  | Change                                                                                                                                                                                                                                                                                                                                                                | Tier                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M-1 | **Price snapshots at close.** For every opened scraped event, at betting close (kickoff −5 min) store our offered prices, the no-vig consensus, Pinnacle's no-vig price, the best price among books, book count and overround, per market and selection. New table (migration) or `odds_history` with a `source` tag.                                                 | Opus                  |
| M-2 | **Scorecard command** (`cli eval scorecard --days 7`). It reads snapshots plus applied results and reports, per competition and market: our overround vs each book; closing-line value vs Pinnacle and consensus; 1X2 Brier, log-loss and RPS for us vs consensus vs Pinnacle; calibration bins; how often we were the best price in the market (the arbitrage risk). | Sonnet (spec by Opus) |
| M-3 | **Weekly report** written to `docs/scraper-evaluation/scorecard-YYYY-WW.md` (or pasted from the server), compared with the targets in section 2.                                                                                                                                                                                                                      | Haiku                 |
| M-4 | Extend the offline evaluation to the market path (`priceFootballFromMarket`), handicaps, half time and correct score, against football-data.co.uk closing odds.                                                                                                                                                                                                       | Sonnet                |

### W2.2 Improve (each behind a setting, switched on after M-2 shows a gain)

| ID  | Change                                                                                                                                                                                                                                                                               | Expected effect                               | Tier         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------ |
| P-1 | **Consensus quality:** at least 3 books with at least 1 sharp (pinnacle, betfair_ex_uk, smarkets, matchbook); weights sharp 2, others 1; drop outliers (more than 3 MAD from the median implied probability) and books whose price hasn't changed for many reads (frozen detection). | fewer stale or odd consensuses                | Opus         |
| P-2 | **De-vig by the power method** (or Shin) instead of proportional, which corrects the favourite-longshot bias.                                                                                                                                                                        | better long-shot prices                       | Opus         |
| P-3 | **Never better than the market:** after margin, cap every selection at the best book price and flag `odds_out_of_line` when the cap binds.                                                                                                                                           | removes arbitrage exposure                    | Opus         |
| P-4 | **Fit the draw:** Dixon-Coles low-score correction (ρ) fitted to home, draw and away plus over 2.5, instead of independent Poisson on home and away only.                                                                                                                            | draw, correct score and BTTS closer to market | Opus         |
| P-5 | **Half-time share** learned from football-data.org HT/FT history (10 leagues) instead of a fixed 49%.                                                                                                                                                                                | HT 1X2 accuracy                               | Opus         |
| P-6 | **DECISION: margin per market and tier,** e.g. 1X2 top leagues 5%, other leagues 6%, derived markets 7–8%, correct score 15%, from settings instead of code constants.                                                                                                               | competitiveness vs Betika-style books         | Opus + owner |
| P-7 | Fix: `market_stale` also for `no_totals` and `poor_fit`.                                                                                                                                                                                                                             | no silent freeze                              | Sonnet       |
| P-8 | Fix: home advantage stored per (team, competition) or only league results update it.                                                                                                                                                                                                 | model-priced accuracy                         | Opus         |

### W2.3 Comparison with well-known sportsbooks

- **International books:** The Odds API already delivers Pinnacle, Betfair Exchange, Smarkets, Matchbook, William
  Hill, Unibet, Betsson, Tipico, Marathonbet and 1xBet. M-2 reports our price against each, and P-3 caps us at the
  best of them.
- **Local competitors** (e.g. Betika and the Ethiopian books): a weekly **manual spot check** of 20 matches (1X2,
  over/under 2.5, BTTS) entered into a CSV that M-2 can read. No scraping of sites whose terms forbid it.

---

## 7. Workstream 3: result accuracy and speed

| ID  | Change                                                                                                                                                                                         | Risk                    | Tier          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------- |
| S-1 | **Coverage matrix** per competition: which upstreams give full time, half time and score basis (extra time and penalties). Generated by a CLI from the source configs.                         | low                     | Sonnet        |
| S-2 | **Offer half-time markets only where an HT-capable upstream exists.** Then FT-only competitions can pass R2 with the Odds API scores plus a second FT source, instead of always waiting 7h45.  | medium                  | Opus          |
| S-3 | **Second results upstream** for the 15 single-source competitions: openfootball where it covers the league, else a paid API (e.g. API-Football, which has HT and basis). **DECISION:** budget. | medium                  | Opus + owner  |
| S-4 | **Cup basis:** verify that the Odds API cup sources report regular time, not after extra time or penalties. If unknown, raise `score_basis_unknown` instead of assuming.                       | high (wrong settlement) | Opus          |
| S-5 | Fix: a manual Trading result updates ratings and enforces the 105-minute floor.                                                                                                                | medium                  | Opus          |
| S-6 | **Result audit command:** 48 h after each applied result, compare with every source and football-data.org; report mismatches, plus latency (final whistle to applied). Weekly in M-3.          | low                     | Sonnet        |
| S-7 | **Truth check:** 200 settled matches vs an independent official source before turning `auto_results` on for single-source competitions.                                                        | low                     | Haiku + owner |

---

## 8. Workstream 4: credits and reliability

| ID  | Change                                                                                                                                                                                                               | Tier   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C-1 | Budget calculator CLI: credits per day per source from the read schedule and the fixture calendar, vs plan and reset date.                                                                                           | Sonnet |
| C-2 | **Tiered polling:** priority competitions keep the 10/30/120-minute schedule; others read 30/120/360. Scores sources only where they are the second upstream (skip where football-data.org already gives FT and HT). | Opus   |
| C-3 | Alarm when the 30-day projection exceeds the remaining credits (today's guard reacts only after spending).                                                                                                           | Sonnet |

### Owner commands for workstream 0

O-1, the Premier League alias (on the server, inside tmux):

```bash
cd /opt/nahubet-new && export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod && docker compose run --rm -T --no-deps -v "$PWD/docs/scraper-plan/data:/in:ro" scraper node dist/cli.js aliases import --file /in/aliases-openfootball-en1.csv
```

Changed aliases re-resolve the stored rows, so the Premier League fixtures appear after the next promotion pass,
within about a minute.

O-4, the report (on the PC):

```powershell
pwsh -File "C:\Users\dawit\Desktop\claude projects\vamos betting two\scripts\feed-report.ps1"
```

---

## 9. Progress

Legend: ✅ done and verified · 🟡 in progress · ⬜ not started. "Session" = the 2026-11-10 working session.

| ID         | Item                                                    | Status | Notes                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —          | `scripts/feed-report.ps1` (20 read-only sections)       | ✅     | tested against a migrated database                                                                                                                                                                                                                                 |
| U-1        | Premier League alias imported by `use-football-data.sh` | ✅     | commit b8d7eb4; syntax checked                                                                                                                                                                                                                                     |
| O-1        | Import the Premier League alias on the server           | ⬜     | owner, section 8                                                                                                                                                                                                                                                   |
| Q-2        | `cli review counts`                                     | ✅     | `review counts`; db 2/2, cli 3/3                                                                                                                                                                                                                                   |
| R-1        | Market-priced events count as calibrated                | ✅     | rule O1m; scraper 427/428 (cli-usage: Windows only), api 53/53; deploy pending                                                                                                                                                                                     |
| Q-1        | Review queue sweeper                                    | ✅     | rule Q1; sweeper 8/8, auto-open 14/14                                                                                                                                                                                                                              |
| A-2        | Suspend on held re-price or lapsed market               | ✅     | rule A2; migration 0045 (`suspended_for`)                                                                                                                                                                                                                          |
| P-7        | `market_stale` for no_totals and poor_fit               | ✅     | with A-2                                                                                                                                                                                                                                                           |
| S-5        | Manual result updates ratings, 105-minute floor         | ✅     | rules R1 (person) and O4 (hand results); scraper 4/4, api 4/4                                                                                                                                                                                                      |
| A-1        | First market price of uncalibrated teams not held       | ✅     | rule A1 (switch at the next pass, not at creation); scraper 4/4                                                                                                                                                                                                    |
| M-1        | Prices at betting close                                 | ✅     | rule M1; migration 0046 (`scrape_close_prices`); scraper 2/2, db 2/2                                                                                                                                                                                               |
| U-3        | Legal-form fallback for team names                      | ✅     | rule N2b; unit 68/68, seeded-catalogue check 1/1                                                                                                                                                                                                                   |
| M-2        | `eval scorecard` command                                | ✅     | reads M1 captures and results; unit 11/11, cli 3/3 (seeded loop, not fast-check)                                                                                                                                                                                   |
| F-2        | Fixture conflicts close once sources agree (2 passes)   | ✅     | rule F6c; streak in the item payload, no migration; unit 13/13, scraper 4/4                                                                                                                                                                                        |
| S-4        | Cup scores of The Odds API wait for a person            | ✅     | rules A10, R10a; cup basis `unknown`; result 74/74, adapter 55/55, scraper 2/2                                                                                                                                                                                     |
| S-2        | Half-time markets only where a source gives half time   | ✅     | rule O6; `SCRAPER_HALF_TIME_MARKETS` (default `all`); unit 8/8, scraper 4/4                                                                                                                                                                                        |
| R-2        | Ratings items name the teams; `ratings list --unrated`  | ✅     | `uncalibratedTeams` in the payload; bar never below 8; cli 1/1, scraper 1/1                                                                                                                                                                                        |
| C-3        | Alarm when the credit projection overruns the month     | ✅     | reason `budget_projection` (guard normal only); unit 14/14, scheduler 15/15                                                                                                                                                                                        |
| F-1, A-3   | Review page: disagreements, pricing facts, vs market    | ✅     | read-only `comparison` on the detail route; admin 68/68, api 40/40                                                                                                                                                                                                 |
| S-1        | `sources coverage` matrix                               | ✅     | flags `single-result-upstream`; cli 3/3                                                                                                                                                                                                                            |
| C-1        | `sources budget` estimate                               | ✅     | replays the read schedule; cli 3/3                                                                                                                                                                                                                                 |
| U-6        | `review gaps [--csv]` catalogue gap report              | ✅     | open unknown_team spellings by competition; cli 4/4                                                                                                                                                                                                                |
| Q-3        | Re-raised dismissals show "dismissed n times"           | ✅     | `payload.dismissals`, no migration; db 3/3, admin 3/3                                                                                                                                                                                                              |
| S-6        | `review results-audit` (48 h after applied results)     | ✅     | mismatches per source, latency vs targets; unit 9/9, cli 3/3                                                                                                                                                                                                       |
| P-8        | Only league results write the home advantage            | ✅     | rule O4 (`setsHomeAdvantage`); no migration; feed 6/6, scraper 3/3, cli 1/1                                                                                                                                                                                        |
| M-4        | `eval market` offline market-path evaluation            | ✅     | `priceFootballFromMarket` on football-data.co.uk closing odds: 1X2, O/U 2.5, BTTS, AH, HT 1X2, correct score; method in docs/scraper-evaluation/04-market-path.md, no real numbers yet (files not in repo); unit 16/16, cli 3/3                                    |
| U-2        | Known Odds API spellings (first part)                   | 🟡     | 2 aliases (Twente, PEC Zwolle); 8 clubs missing from the catalogue (U-6 lists)                                                                                                                                                                                     |
| U-5        | Back-office bulk map of unknown names                   | ✅     | `POST /admin/feed/review/map-batch` (trading.status, per-item); api 23/23 (with R-3)                                                                                                                                                                               |
| R-3        | Back-office ratings page                                | ✅     | list, unrated, set by hand (trading.odds); backfill stays a server command                                                                                                                                                                                         |
| A-4        | Bulk approve in the back office                         | ✅     | `POST /admin/feed/review/open-batch` (trading.status, per-item) and read-only `open-check`; every 1X2 price within 3% of the no-vig consensus after our 6% margin (`withinConsensusTolerance`), else refused; no consensus refused; core 9/9, api 11/11, admin 6/6 |
| all others | see sections 5–8                                        | ⬜     |                                                                                                                                                                                                                                                                    |

**Session 2 (2026-11-10/11):** final full check at c5dc4be: typecheck, lint and prettier clean; db 730, scraper 874,
core 803, contracts 73, feed 213, config 51, api 474, admin 89, scraper app 518 tests, all passing. Earlier check at 21ea98a: typecheck, lint and prettier clean; db 730, scraper 866,
core 803, contracts 73, api 464, admin 71, scraper app 510 tests, all passing (Linux).

**Next, in order:** deploy (migrations 0045 and 0046 run in the `migrate` job at start); add the 8 missing clubs
(`review gaps --csv`) and finish U-2 from the server's unknown list; after a week of matches, M-3
(`eval scorecard --days 7`) and S-6 (`review results-audit --days 7`), compared with section 2; switch
`SCRAPER_HALF_TIME_MARKETS=covered` together with S-3 (a second results upstream); then P-items only where the
scorecard shows a gain (measure before tuning prices). Owner decisions still open: P-6 (margins), S-3 (budget), A-5.

**Environment (2026-11-10):** the owner's PC had 4–5 GB free on C:. Docker started later in the day, and the
integration tests ran. The owner will free disk space; Docker's reclaimable space is about 4 GB of build cache and
2.3 GB of unused images (`docker builder prune`, `docker image prune -a`). Keep the `infra_pgdata` volume.
Integration tests need `DATABASE_URL` pointing at the Docker Postgres (port 5433, database `vamos`) and `REDIS_URL`.
Without it they fall back to port 5432, where another Postgres refuses the password.

---

## 10. References

- Review queue mechanics:
  - kinds: packages/core/src/scrape.ts:74-107;
  - gates: packages/scraper/src/gates/*;
  - pipeline: apps/scraper/src/pipeline/*;
  - API: apps/api/src/modules/admin/feed.ts:523-840;
  - review page: apps/admin/src/app/feed/review/[id]/page.tsx.
- Names: packages/scraper/src/normalize/name.ts:101, alias.ts:207-285; alias CSVs in docs/scraper-plan/data.
- Opening betting: gates/fixture.ts:352-380 (F7), pipeline/auto-open.ts:78,289 (F7b),
  apps/api/src/modules/admin/open-betting.ts:38-70.
- Pricing:
  - choice: pipeline/event-pricing.ts:82;
  - consensus: packages/core/src/market-consensus.ts:58;
  - fit: packages/feed/src/pricing/market.ts:50,134,226;
  - margin: packages/feed/src/pricing/book.ts:19-31.
- Re-price: pipeline/reprice.ts:118,237-250,367-401; gates/odds.ts:69,199,238; scraper constants.ts:67-109.
- Results: gates/result.ts:155-381; pipeline/promote-results.ts:270-828; db/catalog/results.ts:95.
- Credits: docs/theoddsapi-plan/README.md; fetch/credit-guard.ts:39; pipeline/credit-alarms.ts.
- Offline evaluation: apps/scraper/src/eval/*; docs/scraper-evaluation/00-03.
