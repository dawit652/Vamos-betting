# Market-path evaluation (M-4)

Offline measurement of what `priceFootballFromMarket` prices from bookmaker closing odds, scored against the results. Item M-4 of `docs/feed-quality-plan.md`. Production pricing and every decision are unchanged.

**Status: no numbers yet.** The real football-data.co.uk files are not in the repository (see 03-odds-accuracy.md: data is never copied in, only aggregates are published). The command below is tested on a synthetic sample (`apps/scraper/test/fixtures/football-data-sample.csv`, 44 invented rows with made-up team names, generated from a Poisson model; its scores mean nothing). Run it on the real files and paste the output here.

## Command

Download the season files (for example `https://www.football-data.co.uk/mmz4281/2425/E0.csv`, one per league and season, 2019-20 or later for the closing columns) into a folder, then from the repository root:

```
pnpm --filter @vamos/scraper-app cli eval market --dir <folder> --json > market-path.json
pnpm --filter @vamos/scraper-app cli eval market --dir <folder>
pnpm --filter @vamos/scraper-app cli eval market --file E0.csv --file D1.csv
```

`--open` reads the opening columns (`B365H`, `PSH`, `P>2.5`, ...) instead of the closing ones (`B365CH`, `PSCH`, `PC>2.5`, ...). It needs no database.

Code: `apps/scraper/src/eval/market-path.ts` (pure, tested in `market-path.test.ts`), `apps/scraper/src/cli/eval-market.ts`. Metrics reuse `odds-lib.ts` (log-loss, Brier, RPS, `reliability`, bootstrap).

## Method

Per match with a final score:

1. **Input.** Closing 1X2 of the books B365, BW, IW, PS (Pinnacle), WH, VC, 1XB (each only if complete) and closing over/under 2.5 of B365 and Pinnacle (`B365C>2.5`, `PC>2.5`: the only books with totals in current files). Prices become integer milli.
2. **Consensus.** `marketConsensus` from `@vamos/core`, exactly as production: proportional de-vig per book, median across books, at least 2 books per market. `Avg*` and `Max*` columns are not books and are not used for the consensus.
3. **Our prices.** `priceFootballFromMarket(consensus)` with default margins (6%, correct score 15%). Matches with no 1X2 consensus (`no_consensus`) or no usable totals (`no_totals`, rule T2) are skipped and counted.
4. **Scoring.** Our own margin is removed again (proportional) so the forecasts are probabilities, not odds. Scored against the results:

| Market         | Forecast taken from our prices     | Compared with                                                | Notes                                                                                                                                                                                         |
| -------------- | ---------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1X2            | `1x2` (the consensus, re-margined) | consensus, Pinnacle no-vig (`PSC*`, proportional), base rate | log-loss, Brier, RPS; calibration (bias and ECE); our log-loss relative to Pinnacle with a 95% bootstrap interval, paired on matches with Pinnacle                                            |
| Over/under 2.5 | `ou` 2.5 (from the consensus)      | consensus, Pinnacle no-vig (`PC>2.5`, `PC<2.5`), base rate   | log-loss, Brier, calibration                                                                                                                                                                  |
| BTTS           | `btts` (Poisson fit)               | base rate only                                               | football-data has no BTTS odds                                                                                                                                                                |
| Asian handicap | `ah` at the closing line `AHCh`    | Pinnacle no-vig (`PCAHH`, `PCAHA`), base rate                | only lines we price (half lines, whole lines, 0 as draw no bet); quarter lines are counted as `unpricedLine`; a push (whole line, level) is excluded, and our price is conditional on no push |
| Half-time 1X2  | `ht_1x2` (mixed-Poisson halves)    | base rate only                                               | needs `HTHG`, `HTAG`; the files have no half-time odds                                                                                                                                        |
| Correct score  | `cs` (0-0 .. 4-4 and "other")      | base rate (empirical score frequency of the sample)          | log-loss only; no odds in the files                                                                                                                                                           |

Also reported: the fit residual (mean, and the share above `MAX_MARKET_FIT_RESIDUAL`, the level at which production holds an event for a trader), and everything per division (`Div`).

## Caveats

- **No market odds to compare with** for BTTS, half-time and correct score: the numbers say whether the Poisson model fitted to the 1X2 and 2.5 line beats a constant forecast, not whether it is as good as a bookmaker.
- **The base rate is in-sample** (frequencies of the evaluated sample), so it is slightly favourable to the base rate.
- **Pinnacle is also one of the books in our consensus**, so "ours vs Pinnacle" is not an independent comparison; the 1X2 and the over/under 2.5 are priced straight from the consensus, so their log-loss is expected to be within a hair of the consensus (the gap is the margin round trip and rounding to milli). The informative numbers are the Poisson-derived markets.
- **Over/under consensus rests on two books** (B365 and Pinnacle) in current files, the minimum production accepts. Matches missing either are skipped.
- **Whole-line AH:** our price excludes the push; Pinnacle's price includes the stake refund, so the two are close but not identical for lines -1, 1.
- **Closing odds only exist from 2019-20.** Older files need `--open`.
- Production prices some leagues from fewer or different books than these files hold; the result is an upper bound on market-path quality, not a forecast of the live scorecard (`eval scorecard`, M-2).

## Results

Not run yet (see Status). When run, record: matches read and priced, skip counts, the 1X2 and O/U log-loss of ours, consensus, Pinnacle and base rate, our log-loss vs Pinnacle with its interval (target within 1%, plan section 1.2), the BTTS, half-time and correct-score log-loss against the base rate, AH log-loss vs Pinnacle, the calibration biases and the share of matches above the fit-residual threshold.
