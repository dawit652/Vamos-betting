# Hulusport parity plan

More leagues, about 700 options a match, automatic results, for under 200 USD a month.

Written 12 November 2026. Status: **proposal**. Nothing in it is built or switched on.

## What this is based on

| Input           | Detail                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hulusport       | The inspection report of 12 Nov 2026 (`hulusport_report.md`, supplied by the owner and not in this repository) and our own notes of 7 Nov ([competitor-notes.md](../competitor-notes.md)).                                                                                                        |
| Nahubet         | The code that runs on the server: branch `claude/lucid-knuth-pmfncm`, commit `661763f` (release v0.2.0), and the production snapshot of 10 Nov in [feed-quality-plan.md](../feed-quality-plan.md). nahubet.com could not be opened from the work environment, so the live site was not looked at. |
| Provider prices | Looked up on 12 Nov 2026 through web search. The providers' own pages could not be opened from the work environment, so confirm every price at signup.                                                                                                                                            |
| Prototype       | A script written for this plan that defines, prices and checks the markets of section 4.1. Delivered together with this file as `market-factory-prototype.mjs` and kept out of the repository. It is evidence for the plan, not production code.                                                  |

Each fact below carries one of these labels where it matters:

- **Measured:** I ran it for this plan.
- **Code:** read in this repository.
- **Report:** from the Hulusport report.
- **Looked up:** public sources found on 12 Nov, not the provider's own page.
- **Assumed:** what I know of the provider from before; Phase 0 confirms it.
- **Estimate:** my own figure.

---

## 1. In short

1. **Hulusport is bigger, not better.** It lists about ten times the football matches and eight to twelve times the options per match. Nahubet's price source is at least as good (ten independent bookmakers, including Pinnacle and three betting exchanges), and its prices reach the phone faster.
2. **Most of Hulusport's 500 to 800 options are calculated, not bought.** A feed prices a few core numbers per match and a formula produces the rest. Nahubet already has such a formula: it turns the bookmakers' 1X2 and goals prices into 67 options. Extending it is code, not a subscription.
3. **Measured:** one score model gives **591 options that settle from only the half-time and full-time score**, and 637 with Asian quarter lines. After dropping options nobody would list, a normal top-league match shows **500 to 540** of them, or 540 to 580 with quarter lines. Hulusport's typical football match has 514. Goal-time, corner and card markets take the count past 700.
4. **Two subscriptions do the rest: 148 USD a month.**
   - The Odds API 5M plan, 119 USD (today: the 100K plan, 59 USD): sharp prices for about 60 football competitions and for the main other sports (Assumed; Phase 0 gives the exact list).
   - API-Football Ultra, 29 USD: fixtures, half-time scores and 90-minute scores for more than 1,200 football leagues. This gives every league a second result source.
5. **Results become automatic** for league matches everywhere and for cup matches that end in 90 minutes. Today that is 9 leagues. Postponed and cancelled matches still need a person, unless you change today's rule (decision D7).
6. **200 USD cannot buy** live betting on real matches, official data contracts or table tennis. Hulusport has no live betting either.
7. **Phase 0 costs nothing** and checks the six facts this plan depends on before any money is spent.

---

## 2. Hulusport and Nahubet side by side

|                            | Hulusport (Report)                                                                                | Nahubet today (Code, snapshot 10 Nov)                                                                                                                     | Nahubet after this plan                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Sports with real matches   | 14                                                                                                | 1: football. Basketball, tennis and volleyball exist only in the simulator                                                                                | 3 with automatic results (football, basketball, ice hockey); up to 6 more whose results a person confirms                                 |
| Leagues                    | 310, of which 146 football                                                                        | 29 football competitions, 24 with bookmaker prices                                                                                                        | About 60 football competitions on sharp prices (Assumed), plus the leagues API-Football has bookmaker odds for (Phase 0 gives the number) |
| Matches listed             | 2,368, of which 1,106 football and 327 table tennis                                               | 110 scheduled, 19 open for betting. The Premier League was missing because of a known alias gap                                                           | About 1,000 football matches in season (Estimate)                                                                                         |
| Options per football match | Typical 514, top matches 500 to 805, about 105 market types                                       | 67 options, 9 market types                                                                                                                                | 500 to 540 from the two scores, 540 to 580 with quarter lines (Measured); about 700 with goal-time, corner and card markets               |
| Where prices come from     | One feed in Sportradar's format, through its platform vendor                                      | The Odds API: ten independent bookmakers on 1X2 and goals, margins removed, middle value taken, the other markets calculated from those, our margin added | The same, with more reference prices per match; a wider bookmaker set for smaller leagues                                                 |
| Our margin                 | Not known                                                                                         | 6%, correct score 15%. Decided: 5 / 6 / 7 / 15% by market and league                                                                                      | Set per market family from measured error                                                                                                 |
| Price age on the phone     | Up to 5 to 10 minutes (browser cache)                                                             | Feed read every 10 minutes in the last 3 hours, every 30 in the last 24; changes pushed to the phone                                                      | Read every 2 to 5 minutes near kickoff                                                                                                    |
| How early matches go up    | Football: typical 4.9 days, up to 35                                                              | Up to 14 days; betting opens once the kickoff is confirmed                                                                                                | 21 to 28 days for the big leagues                                                                                                         |
| Live betting               | None                                                                                              | On simulated matches only                                                                                                                                 | None on real matches (the same as Hulusport)                                                                                              |
| Results                    | Settled on its server; method not visible                                                         | Automatic in 9 leagues (two sources agree for 15 minutes). 15 competitions and every cup need a person                                                    | Automatic for league matches everywhere and cups that end in 90 minutes. Target: 95% of matches with no person                            |
| Feed cost a month          | 4,000 to 12,000 USD if bought directly (Estimate); more likely a share of revenue to its platform | 59 USD                                                                                                                                                    | 148 USD; up to about 193 with three more sports                                                                                           |
| Front end                  | React single-page app; the whole board (over 4 MB) sent to every visitor; installable; Telegram   | Next.js installable app; paged lists; live price updates; USSD and SMS betting built, off until a carrier is contracted                                   | The same, with market groups loaded when opened                                                                                           |
| Products beside sports     | Casino (103 providers), raffles, predictor games, a jackpot, cash-out claims                      | Jackpots, cash-out, multi bonus. Casino is excluded by policy                                                                                             | Unchanged                                                                                                                                 |
| Languages                  | English, Amharic, French                                                                          | Amharic, English, Afaan Oromo, Tigrinya                                                                                                                   | Unchanged                                                                                                                                 |

---

## 3. What Hulusport's numbers are made of

- **It rents its board.** Hulusport is one brand on a shared platform (shamo.bet, abolbet.com and others use it too). The platform maps one upstream feed for all of them. Hulusport probably pays a share of revenue, not a feed bill (Report).
- **The depth is generated.** 915 of its 1,106 football matches carry 500 or more options (Report). A list that long on that many matches is what a pricing model produces from a few core numbers per match. 96 matches have fewer than 50 options, probably because the feed has only basic prices for them.
- **The match count is padded.** 327 matches are table tennis (228 of them Czech Liga Pro), 137 are American college games and 68 are boxing "matchups" (Report). Football is 1,106.
- **Its weak points** are ones Nahubet can beat:
  - prices on screen up to 10 minutes old;
  - a 4 MB first load on cheap phones;
  - no USSD or SMS betting, and no Afaan Oromo or Tigrinya.

So parity means three things: about 150 football competitions, 500 or more options on most matches, and results that settle without staff.

---

## 4. The plan: three ideas

### 4.1 Idea 1: a market factory (options per match, no feed cost)

**How it works.** Today the pricing code and the settlement code each describe a market in their own way. The factory describes every market **once**, as a rule that says who wins for a given score. That one rule does both jobs:

- **Price:** add up the model's probability of every score where the selection wins.
- **Settle:** apply the same rule to the real half-time and full-time score.

A price and its settlement can then never disagree, and a new market is one small rule plus tests.

**What the prototype measured** (independent Poisson goals, a low-score correction, 45% of goals in the first half):

| Tier | Settles from                                                     | Market lines |  Options | In the prototype                      |
| ---- | ---------------------------------------------------------------- | -----------: | -------: | ------------------------------------- |
| A    | Half-time and full-time score                                    |          164 |      591 | Priced and checked                    |
| Q    | The same, plus half-won and half-lost bets (Asian quarter lines) |           23 |       46 | Priced; rules checked on known scores |
| B    | Minute and team of each goal                                     |  11 families |       70 | Counted only                          |
| C    | Corners and cards                                                |  13 families |       78 | Counted only                          |
| D    | Scorer of each goal, line-ups                                    |   3 families | about 91 | Counted only                          |

Running total: 591, 637, 707, 785, 876. Tiers A and Q have 92 market types.

Options listed for four example matches, after dropping markets whose favourite would pay under 1.02 and long shots over 500.0:

| Match                                        | Tier A | Tiers A + Q |
| -------------------------------------------- | -----: | ----------: |
| Balanced top-league match                    |    541 |         583 |
| Away favourite (like Valencia v Real Madrid) |    537 |         579 |
| Heavy home favourite                         |    517 |         551 |
| Low-scoring match                            |    503 |         541 |

Checks that passed:

- The 4,356 score states add up to a probability of exactly 1.
- Every either-or market of Tier A has exactly one winner for every score, or is void as a whole.
- No option is priced above its fair odds, and every either-or market keeps the full 7% margin.
- 400,000 simulated matches agree with the calculated probabilities on all 591 Tier A options (worst deviation 2.5 standard errors, which is normal for 591 comparisons).
- Six combinations that no score can produce were found and removed.

Speed: about 10 milliseconds a match on one processor core. The whole of Hulusport's football board (1,100 matches) prices in 10 to 11 seconds.

**What is in Tier A** (all standard bookmaker markets):

| Group                  | Examples                                                                                                                                                                                             | Options |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: |
| Full time              | 1X2, double chance, draw no bet, over/under 0.5 to 6.5, Asian totals, handicaps to ±3.5, three-way handicaps, both teams to score, correct score, exact goals, odd/even, winning margin, goal ranges |     163 |
| Full-time combinations | 1X2 with both teams to score, 1X2 with over/under, double chance with each, "1 or GG"                                                                                                                |      78 |
| First half             | The same families on the first-half score                                                                                                                                                            |      93 |
| Second half            | The same families on the second-half score                                                                                                                                                           |      93 |
| Teams                  | Team totals, team exact goals, clean sheet, win to nil, "home no bet"                                                                                                                                |      52 |
| Across the halves      | Half time / full time, highest-scoring half, win both or either half, score in both halves, half-time / full-time correct score                                                                      |     112 |

**What each tier needs:**

- **Tier A needs nothing new from the feed.** It settles from the two scores the result rules already require, so it keeps today's two-source safety.
- **Tier Q needs a settlement change.** A bet can today be won, lost or void. Quarter lines add half won and half lost. That touches payouts, cash-out and tax, so it is a money-path task of its own.
- **Tiers B, C and D rest on one source** (API-Football's match events and statistics), in the leagues where it has them. They need their own models, and a decision on single-source settlement (D6). Prices for corners, cards and scorers without a market reference are easy for informed bettors to beat, so they start with small limits or wait.

**Reaching "700" on the button.** There are two routes, and the choice is D9:

1. Tiers B and C for the big leagues: about 700, with markets players look for (first team to score, corners), on single-source settlement.
2. About 120 more score-only combinations in Tier A: about 700 with two-source settlement, but markets that are rarely bet.

My recommendation is route 1 for the big leagues only, after Tier A has run for a month.

**Accuracy of 590 calculated prices.** The prototype proves the arithmetic, not the model. Before real limits:

- **Fit the draw and the first half.** Today the model's two numbers (each side's expected goals) are fitted to the home win, the away win and one goals line. The draw is not fitted, and the first half is fixed at 49% of goals ([feed-quality-plan.md](../feed-quality-plan.md), items P-4 and P-5). With 590 options resting on it, fit the draw (the low-score correction) and learn the first-half share per league. Both are already planned; they become part of this work.
- **Test every family on history, in one pass.** Because each market is a rule, one loop can take 20 seasons of results with closing odds (football-data.co.uk, which `eval market` already reads), fit the model to each match's closing prices, and compare predicted with actual frequency for all 92 market types. Families that fail get a higher margin, a lower limit, or are left out.
- **Margin by family.** 5 to 6% on 1X2 and over/under, 7% on close derivatives (already decided as P-6), 10 to 15% on correct scores and long combinations.
- **Self-defending margins.** Every week, compare the money kept per family with the margin charged. A family that keeps less than expected for three weeks is suspended automatically and raised for review.
- **Never above the market.** Where a real bookmaker price exists for an option, cap ours at the best of them (rule O7, `SCRAPER_CAP_AT_BEST_PRICE`, built and off today).

Accumulators cannot combine two options of the same match (Code: `duplicate_event` in `packages/core/src/betslip.ts`), so related options cannot be stacked against the house.

### 4.2 Idea 2: a two-layer feed (leagues and matches)

No single cheap provider gives sharp prices and results for every league. Two together do.

| Layer       | Provider                        | What it gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Cost a month |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: |
| Prices      | The Odds API, 5M plan           | 1X2, goals and handicap prices from ten independent bookmakers for about 60 football competitions. Main markets for NBA, EuroLeague, NHL, NFL, MLB, cricket, rugby, boxing. Both lists are Assumed: the free `/v4/sports` call gives the exact ones. Extra football markets per match (alternate goal lines, both teams to score, draw no bet, double chance) as reference prices; how many bookmakers quote each varies, and our probe of 1 Nov found alternate goal lines from 15 to 16 of them. Final scores |      119 USD |
| Spine       | API-Football, Ultra plan        | Every fixture, kickoff change, half-time score, 90-minute score, extra-time and penalty score, and status of 1,200+ football leagues, with stable team and match numbers. Goal events, corners and cards where covered. Bookmaker odds for leagues The Odds API lacks                                                                                                                                                                                                                                           |       29 USD |
| Free checks | football-data.org, openfootball | A third opinion on results in ten competitions (already running)                                                                                                                                                                                                                                                                                                                                                                                                                                                |            0 |

**Why the 5M plan.** A league costs about 2,200 credits a month at today's reading schedule (Code: the `sources budget` estimate gives about 53,000 for 24 competitions). The 100K plan cannot carry 60. The next plan is 5,000,000 credits for 60 USD more.

| Use on the 5M plan                                         |    Credits a month (Estimate) |
| ---------------------------------------------------------- | ----------------------------: |
| 60 football competitions, three markets, scores            |                       190,000 |
| 25 competitions of other sports                            |                       100,000 |
| Extra reference markets for the 300 biggest matches a week |                       130,000 |
| Total                                                      | 420,000, about 8% of the plan |

The spare credits buy speed: read every 2 to 5 minutes near kickoff, and read again at once when Pinnacle or an exchange moves.

**Three classes of league, decided by data.** A nightly job classes each competition from what the feeds delivered. Margins, limits and the market list follow the class, so 150 leagues need no hand-kept settings.

| Class   | Evidence                                                                                          | Markets      | Margin   | Limits | Betting closes                                   |
| ------- | ------------------------------------------------------------------------------------------------- | ------------ | -------- | ------ | ------------------------------------------------ |
| 1 Sharp | Three or more independent bookmakers, one of them Pinnacle or an exchange (today's rule O1m)      | Full factory | 5 to 7%  | Normal | 5 minutes before kickoff (today)                 |
| 2 Soft  | Four or more independent bookmakers from API-Football, no sharp one, prices stable over two reads | Tier A       | 8 to 10% | Low    | 60 minutes before kickoff, to be tuned in shadow |
| 3 None  | No bookmaker prices                                                                               | Not offered  | –        | –      | –                                                |

Class 2 needs its own version of one existing rule. Rule A2 suspends a match in its last 3 hours when its bookmaker prices are older than 30 minutes. A feed that refreshes every 3 hours would fail that for every match, so Class 2 gets a slower rule and an earlier close instead.

Class 3 is the answer to "any league at all". Our own rating model is 2.17% worse than the market's closing prices, and a bettor who picks only our best prices made 12.5% in the October test (Code: `docs/scraper-evaluation`). A league with no market price is a league where we would be the easiest book to beat.

**The request budget of API-Football** (Assumed: one request with `date=` returns every fixture of that day worldwide):

| Job                                               |         Requests a day (Estimate) |
| ------------------------------------------------- | --------------------------------: |
| Today's fixtures and scores, once a minute        |                             1,440 |
| Yesterday and the next 28 days, a few times a day |                               300 |
| Bookmaker odds for Class 2, every 3 hours         |                             2,500 |
| Events and statistics of finished matches         |                               200 |
| Total                                             | about 4,500 of the 75,000 allowed |

**The spine also fixes names.** With 24 competitions the review queue already held 48 unknown team names. With 150 it would not be workable by hand. Three changes:

1. **The catalogue comes from the spine.** Competitions and teams are imported with API-Football's numbers; nobody types clubs into `packages/db/src/seed/catalog.ts`. Amharic names are added over time and fall back to English.
2. **The Odds API's names are matched by the fixture, not by spelling alone.** Rule N4 already does this and is off (`SCRAPER_AUTO_ALIAS`): same competition, within 24 hours, the opponent already known, exactly one candidate, a similar name. It maps one source's spelling only and writes an audit record. With the spine it can be stricter: the kickoff must also match to within 5 minutes.
3. **A new mapping does not open betting by itself** until a second fixture has confirmed it.

**Other sports.** Start with markets that follow the bookmakers directly: winner, handicap and total. No model is needed, only the consensus and our margin. Derived markets come later, per sport:

| Sport                                      | Hulusport: leagues, matches, typical options | Our price source                                | Result source                                                                  | Derived markets later                                          |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Basketball                                 | 62, 232, 110                                 | The Odds API (NBA, EuroLeague and others)       | The Odds API scores and API-Basketball                                         | Alternate lines, quarters and halves from a normal-curve model |
| Ice hockey                                 | 41, 288, 56                                  | The Odds API (NHL, Swedish and Finnish leagues) | The Odds API scores and API-Hockey                                             | The football factory with three periods                        |
| American football                          | 3, 173, 18                                   | The Odds API (NFL, college)                     | The Odds API scores only, so a person confirms until a second source is bought | Few needed                                                     |
| Baseball                                   | 1, 5, 8                                      | The Odds API (MLB)                              | The Odds API scores only, so a person confirms                                 | Few needed                                                     |
| Handball                                   | 25, 86, 38                                   | API-Handball odds (Class 2)                     | API-Handball and a second source to be found                                   | Totals and handicaps                                           |
| Volleyball                                 | 18, 62, 27                                   | API-Volleyball odds (Class 2)                   | API-Volleyball and a second source to be found                                 | Set scores from the winner price                               |
| Cricket, rugby, boxing                     | 5, 75, 2 (rugby 22)                          | The Odds API                                    | The Odds API scores only, so a person confirms                                 | Winner only, as Hulusport mostly does                          |
| Table tennis, floorball, futsal, waterpolo | 9, 341, 2 to 5                               | **Not offered**                                 | –                                                                              | –                                                              |

Table tennis is 327 of those 341 matches. These are leagues with matches every few minutes, in a sport that has drawn repeated match-fixing alerts (my knowledge, not checked today), and I know of no provider in this budget with reliable results for them. Leaving it out is a decision, not a gap.

### 4.3 Idea 3: results without a person

**Today** (Code: `docs/scraper.md` section 6.2). A result is applied automatically when two independent sources give the same full-time score and nothing changes for 15 minutes. Only 9 leagues have a second source. In the other 15 competitions each result waits 7 hours 45 minutes and then goes to a person. Cup results always go to a person, because The Odds API does not say whether a score includes extra time.

**The changes:**

| #   | Change                                                                                                                                                                                                                                       | Effect                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | API-Football becomes a result source for every competition, read once a minute by date. It gives the 90-minute score and the half-time score separately from extra time and penalties, and says how the match ended (Assumed; check 0.4)     | Every league match has two sources: The Odds API's score and API-Football's. Results apply about 17 minutes after both show them (Code: measured in October for two sources) |
| R-2 | Half-time scores exist everywhere                                                                                                                                                                                                            | Half-time markets can be offered in every league, and the 310 Tier A options that need the half-time score can settle                                                        |
| R-3 | **Cup rule by agreement** (decision D4). When API-Football says a cup match ended in 90 minutes, and The Odds API reports the same score, that score can only be the 90-minute score. Let it count as the second source in exactly that case | Cup matches without extra time settle by themselves. Matches with extra time or penalties still go to a person                                                               |
| R-4 | Two sources confirm kickoff times everywhere                                                                                                                                                                                                 | Betting can open earlier than 72 hours before kickoff without a person                                                                                                       |
| R-5 | Bulk confirm for what is left (item R-B of the feed quality plan)                                                                                                                                                                            | A few clicks a day                                                                                                                                                           |

R-3 changes a rule that was decided conservatively (R10, S-4). The worry then was that a wrongly configured source could pass off an extra-time score. R-3 answers it by trusting only a per-match statement from the data ("this match ended after 90 minutes"), never a setting.

**What "fully automatic" will and will not mean:**

| Case                                   | After this plan                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| League match, sources agree            | Automatic                                                                                                                                                                       |
| Cup match ended in 90 minutes          | Automatic after D4                                                                                                                                                              |
| Cup match with extra time or penalties | A person, unless two sources both give the 90-minute score explicitly                                                                                                           |
| Sources disagree                       | A person. This is the rule that protects money                                                                                                                                  |
| Postponed, cancelled, abandoned        | A person today. CLAUDE.md forbids voiding from scraped data. D7 asks whether to keep that                                                                                       |
| Score corrected after settlement       | A person: a correction takes paid money back                                                                                                                                    |
| Goal-time, corner and card markets     | A person, or single-source settlement after a longer wait (D6)                                                                                                                  |
| Class 2 leagues with one result source | A person, until a second source passes a 200-match check (S-7). A candidate is TheSportsDB at about 9 USD a month (Looked up; it is community-maintained, so the check matters) |

The target is 95% of matches settled with no person, a median of 20 minutes after the final whistle, and no wrong result. `review results-audit` already measures all three.

### 4.4 More accurate prices than Hulusport

Hulusport's margin and accuracy are not known. What can be claimed and measured:

| Lever                                                                                                     | State                           |
| --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Reference from sharp bookmakers and exchanges, not one trading feed                                       | Running                         |
| Weight sharp bookmakers double, drop outliers and frozen prices (P-1)                                     | Planned                         |
| Remove margins by the power method, which treats long shots fairly (P-2)                                  | Planned                         |
| Fit the draw and learn the first-half share (P-4, P-5)                                                    | Planned; needed for the factory |
| Fit to more reference prices: handicap line, alternate goal lines, both teams to score, first-half prices | New, uses the spare 5M credits  |
| Where a real price exists for an option, use it directly and cap at the best bookmaker (O7)               | Built, off                      |
| Weekly scorecard against Pinnacle's closing price (`eval scorecard`)                                      | Built; needs a week of matches  |

The measure of success stays the one already set: 1X2 within 1% of Pinnacle's closing price, a median closing-line value of zero or better, and never a price above the best bookmaker.

### 4.5 Faster and lighter than Hulusport

| Topic               | Hulusport (Report)                                             | Nahubet design                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First load          | Whole catalogue and match list, over 4 MB, kept in the browser | Paged lists as today. A match page loads the main group first and each other group when opened                                                                                                                                                                                    |
| Price updates       | Fetched and cached 5 to 10 minutes                             | Pushed as small changes, as today                                                                                                                                                                                                                                                 |
| 590 options a match | Loaded when a match is opened; size not measured               | The names of the options ship once with the app. A match sends only numbers: about 4 to 6 KB compressed (Estimate)                                                                                                                                                                |
| Storage             | Not known                                                      | **Keep the recipe, not every price.** Each pricing run stores its inputs: expected goals, the two fitted corrections, margins, the bookmaker prices used. Any price ever shown can be recomputed exactly. The price history table keeps main markets and options that were bet on |
| Why this matters    | –                                                              | Today every price change of every option writes a history row and sends a message to the phones (Code: `setSelectionOdds`). 590 options on 1,100 matches re-priced ten times a day would be about 6 million rows a day (Estimate)                                                 |

---

## 5. Budget

| Option          | Subscriptions                                                                          |       A month | What it buys                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------- | ------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today           | The Odds API 100K                                                                      |        59 USD | 24 competitions, 67 options, 9 leagues settled automatically                                                                                                |
| Lean            | The Odds API 100K, API-Football Ultra                                                  |        88 USD | A second result source and half-time scores in all 24 competitions, the factory, Class 2 leagues                                                            |
| **Recommended** | The Odds API 5M, API-Football Ultra                                                    |   **148 USD** | All of the above, about 60 football competitions on sharp prices, faster reads, other sports' main markets. Start on Lean and move here when Phase 3 starts |
| Full            | Recommended, plus API-Basketball, API-Hockey and one of API-Handball or API-Volleyball | about 193 USD | Period scores for derived markets in those sports, and their smaller leagues                                                                                |

Price notes:

- **The Odds API** (Looked up, matches its pricing page as quoted in search results): 20K credits 30 USD, 100K 59 USD, 5M 119 USD, 15M 249 USD. A read costs markets × regions, and only markets that return data are charged.
- **API-Football** (Looked up): Pro 19 USD (7,500 requests a day), Ultra 29 USD (75,000), Mega 39 USD (150,000). Every plan includes every competition and endpoint.
- **API-Sports' other sports** are separate subscriptions (Looked up). Handball is listed at 15, 25 and 35; the currency was not shown and the other sports' prices were not confirmed. About 15 USD each is an assumption.
- **TheSportsDB**, the candidate second result source for Class 2 leagues, is listed at 6 or 9 USD depending on the source (Looked up). It fits the Full budget in place of one sport API.
- Taxes, card fees and exchange costs are not included.
- The free plans (500 credits; 100 requests a day) are enough for Phase 0.

Not needed in this plan: odds-api.io (from about 99 GBP for 5 bookmakers), OddsPapi (published prices disagree with each other), Sportmonks (odds are a paid extra on top of plans limited by league count).

---

## 6. Creative, considered, and rejected

| Idea                                                                            | Why not                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read Hulusport's own public board (two open requests give its whole price list) | It is their data under their terms, and it comes from a licensed feed whose owner would have a claim too. They can block it in a minute. It would make Nahubet a late copy of a competitor's prices, errors included. It also breaks the project's own rule against publishing scraped bookmaker odds |
| Feeds that resell bet365 or other bookmaker screens (BetsAPI and similar)       | Same problem with a middleman                                                                                                                                                                                                                                                                         |
| Scraping live-score sites for results                                           | Their terms forbid it; pages change without notice. A paid API at 29 USD removes the reason                                                                                                                                                                                                           |
| Pricing leagues from our own ratings where no bookmaker price exists            | Measured: the easiest prices to beat. See Class 3                                                                                                                                                                                                                                                     |
| Table tennis and similar filler                                                 | Integrity risk and no reliable results in budget                                                                                                                                                                                                                                                      |
| Live betting on real matches                                                    | Needs a fast official data feed, which costs thousands a month. Prices that are two minutes late lose money to anyone watching the match                                                                                                                                                              |
| A white-label platform like Hulusport's                                         | Revenue share with monthly minimums, and the owner would give up the code already built                                                                                                                                                                                                               |

---

## 7. Phases

Who does a task follows CLAUDE.md: **Opus** for design and the money path, **Sonnet** for well-specified code, **Haiku** for checks and reports. Each task is one pull request with its tests. Every change that touches prices, opening or results runs in shadow first.

### Phase 0: prove the facts (free, no money-path code)

| #   | Check                                                                                                                                                                           | Passes when                                                                                                                      | If it fails                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0.1 | The Odds API `/v4/sports` (free call)                                                                                                                                           | We have the exact football list                                                                                                  | Class 1 is smaller; Class 2 carries more    |
| 0.2 | API-Football free key: `/leagues`                                                                                                                                               | We know how many football leagues have odds, events and statistics, and whether the Ethiopian Premier League and CAF are covered | The league target drops to what it covers   |
| 0.3 | API-Football odds: bookmakers, page size, real refresh time                                                                                                                     | Four or more independent bookmakers a match; refresh every 3 hours as its guide says. Two competitors claim once a day           | Class 2 closes earlier, or is dropped       |
| 0.4 | API-Football scores on real cup matches that went to extra time                                                                                                                 | The 90-minute score is given separately                                                                                          | R-3 cannot be built on it                   |
| 0.5 | Written answers from The Odds API (the draft email in `docs/theoddsapi-plan` was never sent) and from API-Sports: may a betting operator use the data to set prices and settle? | Yes in writing                                                                                                                   | Owner's decision; other providers cost more |
| 0.6 | History test of every Tier A family (4.1)                                                                                                                                       | A list of families with their error and margin                                                                                   | Failing families are left out               |

### Phase 1: results everywhere (API-Football, 29 USD)

| #   | Task                                                                                                                                                      | Who           | Done when                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| 1.1 | Adapter `apifootball`: read by date, match numbers, every status, 90-minute and half-time scores                                                          | Opus          | Golden-file tests from real responses; shadow run on the 24 competitions |
| 1.2 | Truth check against football-data.org on this season's finished matches in the nine leagues both cover, at least 200 matches (S-7)                        | Haiku, owner  | No disagreement, or each one explained                                   |
| 1.3 | Add the API-Football source to the seven single-source leagues (`auto_results` is already on); the cups and the two European competitions follow with 1.4 | Sonnet, owner | `sources coverage` shows two result sources for every league             |
| 1.4 | Cup rule R-3, if D4 is yes                                                                                                                                | Opus          | Gate tests, including the wrong-setting case                             |
| 1.5 | Kickoff confirmation from two sources everywhere                                                                                                          | Sonnet        | Events open more than 72 hours ahead with no person                      |

### Phase 2: the market factory (no new subscription)

| #   | Task                                                                                                                           | Who              | Done when                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| 2.1 | Market rules in `packages/core`, one per market type. Today's 12 types keep their codes and stored rows                        | Opus             | Property tests: one winner per score; the rule that prices is the rule that settles  |
| 2.2 | Pricing from the rule table, with the draw fit and the learned first-half share as switches                                    | Opus             | With both switches off, today's 67 options come out unchanged to the last thousandth |
| 2.3 | Storage by pricing run; bulk writes; the sanity check O2 per family; new markets added without holding the others for approval | Opus (migration) | A re-price of 590 options is one transaction                                         |
| 2.4 | Match page: groups, filter chips, market search, lazy loading; labels in Amharic and English                                   | Sonnet           | Lighthouse budget on a cheap-phone profile                                           |
| 2.5 | Margins and limits per family from settings                                                                                    | Opus             | Settings page; liability caps apply per family                                       |
| 2.6 | Tier Q: half-won and half-lost in settlement, payout, cash-out and tax                                                         | Opus             | Property tests on stake splitting; payouts rounded down                              |

Rollout: priced but hidden for a week, then shown with low limits, then normal limits where the scorecard is good.

### Phase 3: breadth (upgrade The Odds API to 5M, 119 USD)

| #   | Task                                                                                             | Who                   |
| --- | ------------------------------------------------------------------------------------------------ | --------------------- |
| 3.1 | Catalogue import from the spine                                                                  | Opus (design), Sonnet |
| 3.2 | Name matching by fixture, switched on after it makes no wrong match on the 24 known competitions | Opus                  |
| 3.3 | Class 1 in waves of 10 to 12 competitions; each wave is promoted by its own scorecard            | Sonnet, owner         |
| 3.4 | League classes computed nightly; Class 2 rules                                                   | Opus                  |
| 3.5 | More reference prices: handicap line everywhere, extra markets for the top matches               | Opus                  |
| 3.6 | Fixture horizon from 14 to 21 or 28 days for Class 1                                             | Sonnet                |

### Phase 4: other sports and the extra tiers (optional, about 15 USD each)

| #   | Task                                                                                                                                             | Who                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 4.1 | Winner, handicap and total for basketball and ice hockey with two result sources; American football and baseball with one, confirmed by a person | Opus (result rules per sport), Sonnet |
| 4.2 | Derived markets per sport                                                                                                                        | Opus                                  |
| 4.3 | Tier B, then Tier C, for Class 1 leagues with coverage, under D6                                                                                 | Opus                                  |

Order: Phase 0, then 1 and 2 side by side (they do not touch each other), then 3, then 4.

---

## 8. How we will know it matches Hulusport

| Measure                            | Hulusport (Report)            | Target                                                                               | Read from              |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| Football competitions with matches | 146                           | 60 sharp plus Class 2; 146 if Phase 0.2 allows                                       | Catalogue              |
| Football matches listed            | 1,106                         | 1,000 in season (60 competitions, about 8 matches a round, two rounds in the window) | Catalogue              |
| Options, typical football match    | 514                           | 500 or more from scores; 540 or more with quarter lines                              | The "+N" button        |
| Options, top match                 | 805                           | 700 with Tiers B and C                                                               | The "+N" button        |
| Price age near kickoff             | Up to 10 minutes              | Under 5 minutes                                                                      | Feed page              |
| Our 1X2 against Pinnacle's close   | Not known                     | Within 1%                                                                            | `eval scorecard`       |
| Price above the best bookmaker     | Not known                     | Never                                                                                | `eval scorecard`       |
| Matches settled with no person     | Not known                     | 95%                                                                                  | `review results-audit` |
| Whistle to settled                 | Not known                     | Median 20 minutes                                                                    | `review results-audit` |
| Feed cost a month                  | Thousands, or a revenue share | 148 USD                                                                              | Invoices               |

---

## 9. Decisions for the owner

| #   | Decision                                                                                                                                | My recommendation                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1  | Buy API-Football Ultra (29 USD). This reverses yesterday's choice of no paid results source (S-3)                                       | Yes. It is the cheapest single step: it gives the 15 single-source competitions a second result source |
| D2  | Upgrade The Odds API from 100K to 5M (119 USD)                                                                                          | Yes, at the start of Phase 3, not before                                                               |
| D3  | Get both providers' written answer on operator use (Phase 0.5)                                                                          | Yes, before real limits                                                                                |
| D4  | Cup rule by agreement (R-3)                                                                                                             | Yes                                                                                                    |
| D5  | Class 2: open betting on a consensus with no sharp bookmaker, with low limits                                                           | Yes, after a month of shadow                                                                           |
| D6  | Single-source settlement for goal-time, corner and card markets after a longer wait                                                     | Not yet; decide after Phase 2                                                                          |
| D7  | Void automatically when two sources agree a match is postponed and it is not played within 48 hours. This changes the rule in CLAUDE.md | Keep today's rule for now. Postponements are a small share of matches                                  |
| D8  | Which other sports first                                                                                                                | Basketball and ice hockey                                                                              |
| D9  | The route to 700 (4.1)                                                                                                                  | Tier B for big leagues, later                                                                          |

---

## 10. Risks and limits

- **Provider terms.** Neither provider has confirmed in writing that a betting operator may use its data. The Odds API could close the account; the owner accepted that on 1 Nov for the demo. With real limits it is a business risk, so 0.5 comes first.
- **Regulation.** The Hulusport report found no source confirming any restored Ethiopian licence. This plan is about data and code and changes nothing about that question.
- **One spine.** If API-Football is down, Class 1 keeps running on The Odds API and the free sources as today; results in single-source competitions wait for a person; Class 2 is suspended by the existing stale-price rule.
- **Model risk grows with the menu.** 590 prices from one fit means one bad fit misprices 590 options. Hence the history test, margins by family, low starting limits and the weekly scorecard.
- **Assumed facts.** The football count on The Odds API, API-Football's by-date requests, its odds refresh and its cup scores are from my knowledge of the providers, not from their pages today. Phase 0 exists to replace each with a measured fact.
- **Effort.** Phases 1 and 2 are mostly money-path work, which the project keeps for the main Opus session. They are the slow part, not the subscriptions.

---

## Appendix: prototype output

The output of `market-factory-prototype.mjs`, unedited. The two speed figures change a little from run to run.

```text
(dropped 6 selections that no score can produce)
CATALOGUE (everything the factory can define)
  Tier A  score-only, whole/half lines : 164 market lines, 591 selections
  Tier Q  quarter (Asian) lines        : 23 market lines, 46 selections
  distinct market types (A+Q)          : 92
  by group: {"Full time":163,"Full time combinations":78,"1st half":75,"1st half combinations":18,"2nd half":75,"2nd half combinations":18,"Teams":52,"Halves":112,"Quarter lines":46}
  Tier B  goal timeline (minute and scoring team of each goal): 11 families, 70 selections (counted, not priced) -> running total 707
  Tier C  match statistics (corners, cards) plus their own count model: 13 families, 78 selections (counted, not priced) -> running total 785
  Tier D  line-ups and the scorer of each goal: 3 families, 91 selections (counted, not priced) -> running total 876

OFFERED after pruning (favourite >= 1.02, list selections <= 500.0), 7% margin
  Balanced top-league match (1.45 v 1.15): Tier A 141 lines / 541 selections; Tier Q 21 / 42; total 583
  Away favourite, like Valencia v Real Madrid (1.05 v 1.80): Tier A 139 lines / 537 selections; Tier Q 21 / 42; total 579
  Heavy home favourite (2.60 v 0.60): Tier A 132 lines / 517 selections; Tier Q 17 / 34; total 551
  Low-scoring match (0.95 v 0.80): Tier A 123 lines / 503 selections; Tier Q 19 / 38; total 541

CHECKS (independent Poisson, 1.45 v 1.15, first-half share 0.45)
  states: 4356, probability mass 1.000000000000
  every Tier A partition market: exactly one winner per state (or all void): ok
  selections priced above their fair odds: 0
  smallest overround of a Tier A partition market: 1.0700 (target >= 1.07)
  Monte Carlo 400,000 matches vs integration, 591 selections: worst z-score 2.54 (h2.1x2_btts 1&yes model 0.0692 sim 0.0702)

SPEED: 152.8 ms to price one match (all 637 selections, single core, unoptimised)
  => 1,100 matches (Hulusport's football board) in about 168 s; markets offered per run avg 163
SPEED with a precomputed resolver table (built once in 164 ms): 9.25 ms per match
  => 1,100 matches in about 10.2 s on one core; table equals direct integration (max diff 0.0e+0)
```

## Sources

- Hulusport: `hulusport_report.md` (12 Nov 2026) and [competitor-notes.md](../competitor-notes.md).
- Nahubet: this repository at `661763f`; [feed-quality-plan.md](../feed-quality-plan.md), [scraper.md](../scraper.md), [theoddsapi-plan](../theoddsapi-plan/README.md), [scraper-evaluation](../scraper-evaluation/00-scorecard-and-fix-plan.md).
- [The Odds API](https://the-odds-api.com/), its [V4 documentation](https://the-odds-api.com/liveapi/guides/v4/) (cost of a request), [betting markets](https://the-odds-api.com/sports-odds-data/betting-markets.html) and [EPL odds page](https://the-odds-api.com/sports/epl-odds.html) (extra football markets).
- [API-Football pricing](https://www.api-football.com/pricing), its [RapidAPI listing](https://rapidapi.com/api-sports/api/api-football/pricing) and its [beginner's guide](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide) (odds 1 to 14 days ahead, refreshed every 3 hours).
- The competing claim that API-Football odds refresh once a day: [OddsPapi](https://oddspapi.io/blog/api-football-alternative/), [GOAL API](https://goal-api.com/blog/api-football-alternative).
- API-Sports other sports: [handball](https://api-sports.io/sports/handball), [basketball](https://api-sports.io/sports/basketball).
- Alternatives priced: [odds-api.io comparison](https://odds-api.io/blog/odds-api-io-vs-the-odds-api), [OddsPapi pricing post](https://oddspapi.io/blog/?p=2498), [Sportmonks plans](https://www.sportmonks.com/football-api/plans-pricing).
- Free result sources: [football-data.org free tier limits](https://www.thestatsapi.com/blog/football-data-org-free-tier-limits-2026), [TheSportsDB review](https://sportsapis.dev/apis/thesportsdb).
