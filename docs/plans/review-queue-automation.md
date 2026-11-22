# Review queue: what can resolve by itself (plan)

Written 23 Nov 2026 by the first account. **Status: the owner said go (23 Nov: "implement the plan"); step 2 built, the rest in order.** The owner asked to
"optimize the algorithm to fix most of the issues by itself", then "before implementing make a
plan". Every step below waits for the owner's go (decisions D1-D7 at the end). Build on top of the
server's branch: before every push,
`git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.

## What the server showed (23 Nov 2026, about 02:30 Addis Ababa)

Read with `scripts/review-study.sh` (read-only; run it again to compare after each step):

```powershell
ssh root@13.140.208.4 "cd /opt/nahubet && git fetch -q origin claude/eager-cerf-ox9vkq && git show origin/claude/eager-cerf-ox9vkq:scripts/review-study.sh | bash"
```

665 open items. Expired prices: 0. Suspended markets: 4,582 of 45,066 on open upcoming matches.
Every competition policy has `enabled`, `auto_open` and `auto_results` on, `pricing_source`
`market` (a few `model`), **and `extra_time` on, leagues included**.

| Kind, reason                                              | Open | Match behind it                    | Cause                                                                                   |
| --------------------------------------------------------- | ---: | ---------------------------------- | --------------------------------------------------------------------------------------- |
| source_broken (odds out of line)                          |  129 | -                                  | Our price above the best bookmaker price, `SCRAPER_CAP_AT_BEST_PRICE=off`: a warning    |
| unknown_team                                              |  133 | -                                  | Teams missing from the catalogue (Al-Kholood, VfL Bochum, Ferencváros...), weak guesses |
| odds_approval, re-price too large                         |   86 | upcoming (52 with betting open)    | Stored prices are the model's, the new ones a market's: a move over 25 % is held        |
| odds_approval, market_priced                              |   65 | upcoming, betting closed           | F7b (automatic opening) does not open them; which condition fails is not logged         |
| ratings_uncalibrated                                      |   41 | upcoming, betting closed           | Teams without ratings (Brasileirão 17, Premier League 10, Champions League 5...)        |
| result_ready, policy_requires_person                      |   36 | kicked off                         | **Two sources agree, but R5 never applies with `extra_time` on**                        |
| kickoff_change, sources_disagree                          |   34 | 25 upcoming closed, 4 open, 5 past | openfootball moved many kickoffs at 22 Nov 18:26 UTC; football-data / The Odds API lag  |
| odds_approval, kickoff_unconfirmed                        |   30 | upcoming, betting closed           | Kickoff not confirmed yet (opens by itself once it is)                                  |
| result_unverified                                         |   48 | kicked off                         | 28 one source without the half time, 20 a single source                                 |
| fixture_missing                                           |   21 | kicked off                         | No source lists the fixture any more: pointless once played                             |
| kickoff_change, earlier_kickoff                           |   16 | upcoming                           | A source reports an earlier time: betting closed (rule K1, correct)                     |
| result_overdue / conflict, fixture_conflict, source_stale |   15 | mixed                              | For a person                                                                            |

Closed upcoming matches, by league: Premier League 33 by kickoff disagreements and 10 by ratings;
FA Cup 14, League One 12, League Two 12, Europa League 8 by `market_priced`; Bundesliga, Serie A,
LaLiga, Champions League, DFB-Pokal by held re-prices and unconfirmed kickoffs. Auto-open runs:
110 checked, 1 opened. Re-pricing runs: about 40 matches, 0 to 5 held each run.

Samples: Elversberg v Stuttgart (DFB-Pokal) stored 2.17 / 2.81, market 3.60 / 1.81 (the model had
the wrong favourite); Freiburg v Hoffenheim 1.37 / 5.38 / 6.93 → 2.10 / 3.84 / 3.09.

Also on the server: The Odds API credits run out in about 5 days (before the reset on 1 Dec);
`openfootball` French Ligue 1 has had nothing new for 11 days.

## The plan (one commit each, with tests; full checks before each push)

### Step 0. Extra time off for leagues (owner, no code: the biggest win)

R5 (`packages/scraper/src/gates/result.ts`) applies a confirmed result by itself only when the
policy's `extra_time` is off (a source could pass an extra-time score off as regular time). With it
on everywhere, every result waits for a person. Switch **Extra time** off in Back office → Feed →
Competitions for the leagues, where no match goes to extra time: premier-league, championship,
league-one, league-two, laliga, primera-division, serie-a, bundesliga, ligue-1, eredivisie,
primeira-liga, belgian-pro-league, scottish-premiership, super-lig, swiss-super-league,
saudi-pro-league, brasileirao-serie-a, ethiopian-premier-league. Keep it on for the cups and UEFA
and CAF competitions (fa-cup, efl-cup, dfb-pokal, copa-del-rey, coppa-italia, coupe-de-france,
uefa-champions-league, uefa-europa-league, uefa-conference-league, caf-champions-league,
caf-confederation-cup), and leave nba, atp-tour, volleyball and the `hl-` / `nb-` boards as they are.
Results confirmed by two independent sources then settle on time, and finished matches stop waiting.

### Step 1. Close items that no longer matter (safe; Q1b)

Extend the sweeper (`apps/scraper/src/pipeline/review-sweep.ts`, rule Q1, which today closes only
`odds_approval` / `ratings_uncalibrated` of gone, started, resulted or cancelled matches) to:
`kickoff_change`, `fixture_missing` and `fixture_conflict` of a match that kicked off, finished,
was cancelled or is gone; `unknown_team` whose `payload.fixture.kickoff` passed more than a day ago.
Never `result_*` (they are about settling) and never `source_*`. Expected now: about 35 items.
Tests: `apps/scraper/test/review-sweep-stale.test.ts`.

### Step 2. A strong market replaces the stored prices (built 23 Nov)

New rule A-2 in `apps/scraper/src/pipeline/reprice.ts`, next to A-1 (`firstMarketPrice`): in a
competition with `pricing_source = market`, when the new prices come from a strong market
(`price.source === 'market' && price.backsOpening`: at least 3 books, one sharp) the 25 % bound
(`MAX_PRICE_MOVE_RATIO`) is waived, and a pending hold is looked at again at once. A weak market or
the model's own move is still held. Reason: the held proposal keeps the OLD prices live on 52 open
matches, the riskier choice when a strong market has moved. The draft change (13 lines):

```ts
const strongMarket =
  price.source === 'market' && price.backsOpening && policy.pricingSource === 'market';
// A-1 / A-2: a pending hold they let through is looked at again.
if (
  state === 'current' &&
  stamp?.ratingsKey !== key &&
  (await holdPending(tx, event.feedRef)) &&
  (strongMarket || (await firstMarket()))
)
  state = 'go';
// ...
const waived =
  !check.ok &&
  enabled &&
  check.issues.every((issue) => issue.code === 'price_move_too_large') &&
  (strongMarket || (await firstMarket()));
// resolution text: 'a strong market (3+ books, one sharp) replaced the prices (A-2)'
```

Tests (`apps/scraper/test/reprice-market.test.ts`): calibrated teams, strong market, move over 25 %
→ applied and the hold closed; weak market → held; model move → held; a pending hold is applied on
the next pass without a new price. Expected: most of the 86.

### Step 3. Kickoff disagreements: the earliest fresh time (money: needs D3)

Today `sources_disagree` holds the match closed until a person picks the time. Proposal: when the
fresh independent sources disagree, move the match to the **earliest** fresh kickoff and let F7b
open it; when every source later agrees on a later time, F4 moves it as it does today. Bets then
close at the earliest time any source names, so no bet is ever taken after the real kickoff; the
cost is a shown kickoff that may be early for a while. K1 (an earlier report closes betting) stays.
Code: `decideExisting` in `packages/scraper/src/gates/fixture.ts` (F4) and the item close in
`promote-fixtures.ts`; tests next to `kickoff-item-close.test.ts`. **Do not switch openfootball
off instead:** it may be the first to show December's TV kickoff times, and its earlier times are
what keeps betting from staying open past a real kickoff.

### Step 4. Why F7b does not open (diagnostics first, then D4 / D5)

Add per-condition counts to the "auto open run" log (`apps/scraper/src/pipeline/auto-open.ts`):
kickoff not confirmed, open `kickoff_change`, held re-price, a person decided, teams uncalibrated
and market not strong, price checks (O2). Run the study again, then, if the data says so:

- 4a (D4): count a board's fresh kickoff (mr-z / Narobet, mr-x / Hulusport rows linked to the
  match) as an independent kickoff statement, so single-upstream leagues (FA Cup, League One / Two,
  Belgian, Scottish, Turkish, Swiss: The Odds API only) can reach C1;
- 4b (D5): accept a fresh Narobet price (switch `narobet_pricing` on) as market backing (O1m) for
  teams without ratings, optionally with the board cap (ETB 20,000 per match).

### Step 5. Unknown teams (a person)

Most are teams the catalogue does not have. Creating teams automatically is not planned (a wrong
team mis-settles bets); a person assigns or creates them in Back office → Feed → Review → unknown
names. Step 1 closes the ones whose fixture was played.

### Step 6. Results with the half time missing (later, money)

When two sources agree on the full time and only the half time is missing, settle the full-time
markets automatically and leave the half-time ones for a person. Needs a settlement design (main
session, Opus). A single source stays with a person.

## Warnings for the owner

- **The Odds API credits run out in about 5 days.** Upgrade, or let a session reduce the polling.
  Without them the bookmaker prices stop, and more matches lock or wait.
- **129 matches have one of our prices above the best bookmaker price**
  (`SCRAPER_CAP_AT_BEST_PRICE=off`): money risk. `on` caps them at the next re-pricing (a large cap
  is held for a person like any re-price). Owner's choice (D6).

## Decisions for the owner

| #   | Question                                                               | Recommendation |
| --- | ---------------------------------------------------------------------- | -------------- |
| D1  | Step 0: extra time off for the leagues listed                          | Yes, now       |
| D2  | Step 2: a strong market replaces our prices whatever the move          | Yes            |
| D3  | Step 3: on a kickoff disagreement, use the earliest fresh time         | Yes            |
| D4  | Step 4a: boards' kickoffs count as an independent confirmation         | After step 4   |
| D5  | Step 4b: a fresh Narobet price backs opening for teams without ratings | After step 4   |
| D6  | `SCRAPER_CAP_AT_BEST_PRICE=on`                                         | Yes            |
| D7  | The Odds API: upgrade the plan or reduce polling                       | Owner          |
