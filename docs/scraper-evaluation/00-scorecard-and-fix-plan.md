# Scraper evaluation: scorecard and fix plan

Evaluated on 2026-10-29 on real data (openfootball, the Fantasy Premier League data, and bookmaker closing odds
from a football-data.co.uk mirror), by three independent evaluators who measured and changed no production code.
Details and evidence are in the three reports:

- [01 Data accuracy and match results](01-data-accuracy.md)
- [02 Speed, freshness and resilience](02-speed-and-resilience.md) (partial: replay, throughput and most failure
  scenarios were not run)
- [03 Odds accuracy and price integrity](03-odds-accuracy.md)

## Verdict

**Not ready for real money. Fine for the demo and for a supervised shadow period.**

- **What works.** When the scraper has data it reads it correctly: kickoff times are exact for a complete season
  (380 of 380, including the clock change), full-time scores match the independent copy on all 398 finished
  matches, club-name matching made no wrong match in any test, the safety rules fail closed (nothing was cancelled
  or changed when half the data vanished), and settlement is fast.
- **What does not.** The data source is slow and sometimes frozen (median 2.8 days after the whistle in a good
  month, 16.7 days across last season, nothing at all for 37 days now). Upcoming kickoff times are often provisional
  (8 of the next 20 Premier League games had a wrong time, two of them start earlier than we would close betting).
  Every goalless draw is dropped. Our own prices are about 2% worse than the market and add no information to it, so
  a customer who bets only where we beat the market line would make money from us. There is no live (in-play) feed.
- **What no code can fix.** A fast, reliable result source needs a licensed provider (an account and money).
  Until then every result needs a trader, and kickoffs need a second upstream.

## Scorecard

Verdict: PASS meets the target, GAP does not, INFO is for information, UNKNOWN was not measured.

### Accuracy

| Metric                                              | Result                                                                                                                | Target    | Verdict | Report |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- | ------- | ------ |
| Kickoff UTC vs FPL, complete season 2025-26         | 380 of 380 exact, including 10 matches around the 25 Oct 2026 clock change                                            | >= 99.5%  | PASS    | 01     |
| Kickoff UTC, fixtures in the next 14 days           | 12 of 20 exact; 8 wrong, 2 start earlier than our kickoff                                                             | >= 99.5%  | GAP     | 01     |
| Full-time score vs FPL, finished matches            | 398 of 398 equal (and 380 of 380 per season vs football-data.co.uk)                                                   | 100%      | PASS    | 01, 03 |
| Goalless draws                                      | All 32 Premier League 0-0 results of the two seasons (27 of 380 matches in 2025-26, 7.1%) are rejected as `bad_score` | 0 lost    | GAP     | 01, 02 |
| Name resolution without alias, Premier League       | 23 of 23 clubs                                                                                                        | >= 98%    | PASS    | 01     |
| Name resolution without alias, other seeded leagues | LaLiga 64%, Serie A 77%, Ligue 1 77%, Bundesliga 92%                                                                  | >= 98%    | GAP     | 01     |
| Wrong team matches and collisions                   | 0 wrong, 0 collisions (2,782 mechanical variants and 50 real spellings probed)                                        | exactly 0 | PASS    | 01     |
| Latent wrong-match hazards                          | A global alias in the Costa Rica draft file; 18 of 34 unresolved clubs get a wrong top-1 suggestion                   | 0         | GAP     | 01     |
| Coverage of the next 21 days, Premier League        | 20 of 20 fixtures become events                                                                                       | report    | INFO    | 01     |
| Coverage of the next 21 days, other leagues         | 0 to 28%: the file has no kickoff time for most of them and we never guess one                                        | report    | GAP     | 01     |
| Source publishes wrong scores                       | 5 of 380 matches carried a wrong score for up to about 6 weeks                                                        | report    | INFO    | 01, 02 |
| Source format stability                             | 2 of 22 historic snapshots bad (invalid JSON; no dates); `"score": {}` for unplayed games                             | stable    | GAP     | 01, 02 |

### Speed and freshness

| Metric                                            | Result                                                                                          | Target        | Verdict | Report |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- | ------- | ------ |
| Whistle to score visible in the source, in season | Median 66.5 h, p90 149 h (45 matches); 2025-26 as a whole: median 401 h, 53% later than 14 d    | live: seconds | GAP     | 02     |
| Source frozen                                     | No update since 2026-09-22 (37 days); 30 played matches without a score                         | none          | GAP     | 02     |
| FPL data as a faster second source                | No: median 31 days for 2025-26                                                                  | n/a           | INFO    | 02     |
| Our pipeline, two upstreams, no human             | Visible to applied: best 15, median 17, p90 19 minutes (almost all of it the 15-minute R4 wait) | p90 <= 30 min | PASS    | 02     |
| Our pipeline, one upstream plus a trader          | Item opens at kickoff + 7 h 45 min, applied 60 s after the trader confirms                      | none          | GAP     | 02     |
| Settlement after a result is applied              | Median 10.9 ms per bet; 100 bets in 0.57 s (the queue hop was not run)                          | <= 60 s       | PASS    | 02     |
| Live (in-play) feed                               | None in v1: no live observation kind                                                            | seconds       | GAP     | 02     |

### Odds

| Metric                                                 | Result                                                                                                           | Target        | Verdict          | Report |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- | ------ |
| 1X2 log-loss vs the best naive baseline                | Better: PL 2025-26 1.030 vs 1.093 (n=380); six league-seasons 1.005 vs 1.084 (n=2,131)                           | beat baseline | PASS             | 03     |
| Model vs bookmaker closing line                        | 2.17% worse in relative log-loss [0.73, 3.66] (n=760); the model's disagreement with the market predicts nothing | within 2%     | GAP (borderline) | 03     |
| A customer who bets only where we beat the market line | +12.5% return [1.8, 23.3] over 891 bets (we expect about -6%)                                                    | about -6%     | GAP              | 03     |
| Backing every outcome at our 1X2 prices                | -5.8% [-7.7, -4.0], the declared margin                                                                          | about -6%     | PASS             | 03     |
| Calibration (expected calibration error, pooled)       | Home 1.5, draw 2.3, away 3.2 percentage points; worst decile up to 10.7 pp for draws (n=63)                      | <= 2 pp       | GAP              | 03     |
| Home advantage                                         | Model 1.146, observed 1.213 (Premier League 1.247): away wins are priced too short                               | match         | GAP              | 03     |
| Margin delivered on the book                           | 22.8% of rating pairs outside 6% +- 0.5 pp; over/under: 36% of lines outside (down to -4.4 pp)                   | +- 0.5 pp     | GAP              | 03     |
| Integrity: sums, bounds, rounding, coherence, symmetry | 0 violations in 6,561 books and 2,825 mirror comparisons                                                         | 0             | PASS             | 03     |
| Re-price holds for a trader                            | 21.6% of re-prices held (all from non-1X2 markets); about 12 events per matchday round                           | <= 10%        | GAP              | 03     |
| Uncalibrated team cannot be opened                     | Holds on every scraper path; the generic back-office open has no O1 or O2 check                                  | none          | GAP              | 03     |

### Resilience (only two checks were run)

| Metric                                                                                          | Result                                                                | Target      | Verdict | Report |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------- | ------- | ------ |
| Identical snapshot                                                                              | 0 business tables changed                                             | 0 writes    | PASS    | 02     |
| Absence never cancels                                                                           | Dropped 45% and 50% of records for 4 simulated days: 0 events changed | 0           | PASS    | 02     |
| A source that returns half its records                                                          | Accepted as a healthy run, 16 of 16 runs                              | fail closed | GAP     | 02     |
| Stale observations create events                                                                | 4 of 9 events came from fixtures the source had not listed for 2 days | none        | GAP     | 02     |
| Replay of the real history, concurrency, throughput, trader workload per day, failure scenarios | Not measured                                                          | n/a         | UNKNOWN | 02     |

## Gaps and fixes, ranked

Severity is the effect on bets and prices if uncorrected. The model and effort column is the plan's rule applied:

- **Opus, high:** safety rules that decide when betting stays open, risk and exposure design, rule specifications.
- **Sonnet, high:** multi-file logic with property and regression tests, model changes that a backtest can accept or reject.
- **Sonnet, medium:** contained fixes with a clear specification.
- **Haiku, low:** data and wording edits that tests already guard.

Every fix is accepted by re-running the evaluation script that found the gap, not only by unit tests.

| ID   | Severity | Gap                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                        | Size | Model and effort                                             | Accepted by                                                                      |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| F-01 | Critical | Provisional kickoffs: betting can stay open after the real kickoff                                                               | Fail closed: a current observation that starts earlier than the event suspends betting at once and raises the item; a single-source, default-slot kickoff cannot be opened until confirmed (second upstream, or the match is close and the time has been stable). Spec first, then code and property tests | M    | Opus high (design), then Sonnet high                         | `data-fpl.ts` and a new replay test                                              |
| F-02 | High     | The source freezes or lags and nothing says so ("stale" only means no successful run in 3 hours)                                 | A content-stale state: the source answers but has not changed for N days while matches are due; shown in the back office and as a review item                                                                                                                                                              | S    | Sonnet medium                                                | `speed-freshness.ts`, new test                                                   |
| F-03 | High     | Every goalless draw is dropped (`[0, 0]` read as `bad_score`)                                                                    | Accept a bare two-number list as the full-time score (regular time) for league sources; treat `"score": {}` as "no score"; add the real examples to the golden fixtures                                                                                                                                    | S    | Sonnet medium                                                | `data-fpl.ts`: 0 rejected real results. Done (commit SHA_PLACEHOLDER)            |
| F-04 | High     | No signal when a match was played and no source has a result                                                                     | An "overdue result" review item after N hours, so a trader can settle from an official site                                                                                                                                                                                                                | S-M  | Sonnet medium                                                | New integration test                                                             |
| F-05 | High     | A customer who beats the market line profits from our model prices (+12.5% over 891 bets)                                        | An exposure policy for model-priced events: stake and liability caps, trader approval, shading or suspension where a licensed market line disagrees. Design first (a written specification), then limits in the back office                                                                                | L    | Opus high (design), then Sonnet high                         | Re-run `odds-market.ts` with the limits                                          |
| F-06 | High     | One slow, sometimes frozen upstream; every result needs a trader                                                                 | A licensed provider as a second upstream (API-Football is the draft). **Needs your account and a written answer on betting use.** Code part: verify the adapter against the real schema, then agreement rules                                                                                              | L    | Sonnet high (adapter), Opus high review of the gate settings | Shadow scorecard (200 results)                                                   |
| F-07 | Medium   | Prices: home advantage fixed at 1.15 (observed 1.21 to 1.25), so away is too short                                               | A per-league home advantage learned from results                                                                                                                                                                                                                                                           | M    | Sonnet high                                                  | `odds-backtest.ts`, out of sample                                                |
| F-08 | Medium   | Margin is not delivered on lopsided over/under, double chance and 1X2 lines                                                      | Spread the margin over the whole book and round to hit the total                                                                                                                                                                                                                                           | M    | Sonnet high                                                  | `odds-integrity.ts`: 0 outside +- 0.5 pp                                         |
| F-09 | Medium   | Re-price holds 21.6% against a 10% target                                                                                        | Apply the 1.25 move rule to 1X2 and the 2.5 line only (all holds come from other markets); keep the rating step as it is until tested out of sample                                                                                                                                                        | S    | Sonnet medium                                                | `odds-volatility.ts`                                                             |
| F-10 | Medium   | The generic trader "open betting" skips the calibration and price checks (`trading.ts:145`)                                      | Refuse uncalibrated scraped events and re-run the price checks when opening                                                                                                                                                                                                                                | S    | Sonnet medium                                                | New API test                                                                     |
| F-11 | Medium   | Results older than 14 days are not looked at; 53% of last season's scores arrived later, and corrections came 8 to 42 days after | Widen the look-back for results and corrections; flag corrections of settled results beyond it. Derived from code, not yet replayed                                                                                                                                                                        | M    | Sonnet high                                                  | Replay (evaluation P2)                                                           |
| F-12 | Medium   | A half-empty answer passes the shape gate; stale observations still create events                                                | Fail a run whose accepted records drop sharply against the last good run; ignore observations the source stopped listing                                                                                                                                                                                   | S-M  | Sonnet high                                                  | `speed-checks.ts`                                                                |
| F-13 | Medium   | Name hazards: global alias in the Costa Rica draft; wrong top suggestions; other leagues 64 to 92%                               | Scope every alias row to its source; show no suggestion below a similarity floor; ship the alias files for the other leagues                                                                                                                                                                               | S    | Haiku low (alias files), Sonnet medium (suggestions)         | alias file done (5c55e7f); suggestions and other leagues' alias files still open |
| F-14 | Medium   | Club renames change raw-name keys (11 renames changed 308 keys)                                                                  | Key observations by stable ids where the source has them, and merge on a confirmed rename                                                                                                                                                                                                                  | M    | Sonnet high                                                  | History replay                                                                   |
| F-15 | Medium   | No live (in-play) feed                                                                                                           | Specification of the live rules (task 08A: L1 to L5) first and have it reviewed; build only with a live source                                                                                                                                                                                             | L    | Opus high (spec), then Sonnet high                           | Rule reference model and replay                                                  |
| F-16 | Low      | With one source, a result item opens only at kickoff + 7 h 45 min                                                                | Tune once a faster single source exists                                                                                                                                                                                                                                                                    | S    | Sonnet medium                                                | `speed-latency.ts`                                                               |
| F-17 | Low      | Draws priced about 1.7 points low (interval crosses zero); over/under and BTTS have no skill beyond base rates                   | Test a low-score (Dixon-Coles) correction out of sample; adopt only if the log-loss improves                                                                                                                                                                                                               | M    | Sonnet high                                                  | `odds-backtest.ts`, out of sample                                                |
| F-18 | Low      | One time zone per source                                                                                                         | One source per zone, or a zone per request                                                                                                                                                                                                                                                                 | S    | Haiku low                                                    | Unit test                                                                        |
| F-19 | n/a      | Evaluation not finished: replay, throughput, concurrency, failure scenarios, other leagues' odds, trader workload per day        | Run the leftover parts of the three reports (their "Not done" sections give the commands)                                                                                                                                                                                                                  | M    | Sonnet high                                                  | New sections in the reports                                                      |

## Plan, in waves

Size guide, from the earlier work: S about 60 to 100k tokens, M 150 to 250k, L 300k and more. About 1 point of the weekly
allowance is roughly 170 to 200k tokens.

| Wave | When                                      | Tasks                               | Why this order                                                                                                              |
| ---- | ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | Now (cheap, high value)                   | F-03, then F-13 (alias file scope)  | Both are small, nothing else depends on them, and F-03 stops real results being lost                                        |
| 1    | After the weekly reset (30 Oct 18:00 UTC) | F-01 (Opus first), F-02, F-04, F-10 | The safety rule for provisional kickoffs is the one gap that can cost money today; the others are the alarms a trader needs |
| 2    | Next                                      | F-07, F-08, F-09, F-12, F-11        | Pricing and gate improvements that each have a measured acceptance test                                                     |
| 3    | Needs you first                           | F-06, F-05, F-15                    | A licensed source and an exposure policy are decisions with money and risk; the code follows them                           |
| 4    | When budget allows                        | F-14, F-16, F-17, F-18, F-19        | Lower severity or waiting on earlier waves                                                                                  |

## Before real money

All of these must be true. None is true today.

1. F-01 to F-06 closed, F-10 closed, and the scorecard above re-run with no critical or high GAP.
2. At least two upstreams with different origins for kickoffs and results, 200 results compared with an independent
   truth, and a result agreement rate recorded (the shadow scorecard of plan task 07).
3. An exposure policy in force for model-priced events (stake and liability caps, trader approval), or prices taken
   from a licensed odds feed.
4. A decision on in-play betting: build it (F-15) or keep it off for this market.
5. CI running on GitHub (the account's billing) and green, and legal sign-off on every source's terms.

## What no code can fix (needs you)

- A licensed data provider: account, money, and a written answer on betting-operator use (F-06). Without it, every
  result is confirmed by a person and kickoffs stay single-sourced.
- The exposure policy: how much a customer may stake, and how much the book may lose on an event, are business
  decisions (F-05).
- The GitHub Actions billing block, so the checks run on every push again.

## What this evaluation did not measure

Replay of the real update history through the whole pipeline, concurrency and crash recovery, throughput for 20 or
more leagues, trader workload per day, most failure scenarios, per-league odds deep dives, and an out-of-sample test of
any model change. Each report has a "Not done" section with the commands.
