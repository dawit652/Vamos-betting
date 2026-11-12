# Hulusport parity plan

More leagues, about 700 options a match, results and reviews with no person, for under 200 USD a month.

Written 12 November 2026. **Revision 2, the same day.** Status: **proposal**. Nothing in it is built or switched on.

## What changed in revision 2

The owner asked for four things: cheaper and better APIs, more leagues through our own scraper, no manual review, and more reliability and accuracy. This revision answers each.

| Asked                                | What changed                                                                                                                                                                                                                                                                                         | Where        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Cheaper, better APIs                 | Fifteen providers compared, most on their own pages this time. One cheap candidate is ruled out by its own terms. Two cheap or free result sources are added. The price layer stays on the 59 USD plan until measurements say otherwise                                                              | 4.2, 5, 6    |
| More leagues with our scraper        | A **league factory**: the scraper finds a league on both providers, binds it, imports its clubs, matches the team names from fixtures and moves it from shadow to open by measured gates. No source file, alias file or script is written by hand                                                    | 4.3          |
| No manual review                     | Every one of the 16 review items gets an automatic rule that fails closed. Results follow a **four-rung ladder** that always ends: settled, or void under a published 48-hour rule. A person is told, never waited for                                                                               | 4.4          |
| More reliable                        | Three result sources where two were planned, a measured trust score per source, a nightly self-audit that demotes a league by itself, and a price expiry that closes betting when the scraper is dark                                                                                                | 4.5          |
| More accurate                        | Real prices used directly where they exist, bookmaker weights and league parameters learned nightly, limits that grow with the evidence                                                                                                                                                              | 4.6          |
| More efficient                       | Fixture lists and kickoff times from an endpoint that costs no credits, scores read only when a match has ended, the smallest plan that fits each step                                                                                                                                               | 4.2, 5       |
| First spend falls from 148 to 87 USD | The Odds API 100K (59, as today), API-Football Pro (19), TheSportsDB (9). The 5M upgrade becomes a later step, taken when a measurement asks for it. Both figures stay under 200                                                                                                                     | 5            |
| Facts replaced                       | The Odds API lists **67** football competitions, not "about 60". Its prices and request costs are confirmed. API-Football's pages still could not be read, and the key saved for the work environment did not work (API-Football answered "missing application key"), so checks 0.2 to 0.4 stay open | 4.2, Phase 0 |

Three decisions alter rules that were decided conservatively: voiding without a person (D7), corrections that only pay out (D10), and a majority of sources or one trusted source deciding a result (D11). Each is in section 9, runs in shadow first, and changes a line of CLAUDE.md or `docs/scraper.md` in the same pull request as its code.

## What this is based on

| Input           | Detail                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hulusport       | The inspection report of 12 Nov 2026 (`hulusport_report.md`, supplied by the owner and not in this repository) and our own notes of 7 Nov ([competitor-notes.md](../competitor-notes.md)).                                                       |
| Nahubet         | The code that runs on the server: branch `claude/lucid-knuth-pmfncm`, commit `661763f` (release v0.2.0), and the production snapshot of 10 Nov in [feed-quality-plan.md](../feed-quality-plan.md). nahubet.com was not looked at.                |
| Provider prices | Revision 1 used web search only. Revision 2 read the providers' own pricing, coverage and terms pages on 12 Nov, except API-Football and API-Sports, whose pages refuse automated readers. Confirm every price at signup.                        |
| Review rules    | The 16 review kinds in `packages/core/src/scrape.ts` and the rules of [scraper.md](../scraper.md) section 6, read for revision 2.                                                                                                                |
| Prototype       | A script written for this plan that defines, prices and checks the markets of section 4.1. Delivered together with this file as `market-factory-prototype.mjs` and kept out of the repository. It is evidence for the plan, not production code. |

Each fact below carries one of these labels where it matters:

- **Measured:** I ran it for this plan.
- **Read:** on the provider's own page or API on 12 Nov.
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
4. **Three subscriptions do the rest: 87 USD a month.**
   - The Odds API 100K plan, 59 USD (today's plan): sharp prices for **67 football competitions** and the main other sports (Read). Free fixture lists and smarter reading make the plan carry all of them (Estimate; check 0.9).
   - API-Football Pro, 19 USD (Looked up): fixtures, half-time scores and 90-minute scores for more than 1,200 football leagues. Every league gets a second result source.
   - TheSportsDB, 9 USD (Read): a third opinion on results, and a second result source for NBA, NHL, NFL and MLB.
   - Later, when a measurement asks for it: The Odds API 5M (plus 60) and API-Football Ultra (plus 10), 157 USD in all.
5. **The scraper adds leagues by itself.** It binds each competition on both providers, imports the clubs, matches team names from fixtures and opens betting when measured gates pass. Adding a league costs no typing (4.3).
6. **Nothing waits for a person.** Every review item has an automatic rule. Every match ends settled or void within 48 hours of its kickoff time. This needs three rule changes (D7, D10, D11). The owner gets alerts and a weekly report, not a queue (4.4).
7. **200 USD cannot buy** live betting on real matches, official data contracts or table tennis. Hulusport has no live betting either. It also cannot buy sharp prices for more than the 67 competitions unless check 0.3 passes.
8. **Phase 0 costs nothing** and checks the facts this plan depends on before any money is spent.

---

## 2. Hulusport and Nahubet side by side

|                            | Hulusport (Report)                                                                                | Nahubet today (Code, snapshot 10 Nov)                                                                                                                     | Nahubet after this plan                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sports with real matches   | 14                                                                                                | 1: football. Basketball, tennis and volleyball exist only in the simulator                                                                                | 5 with automatic results (football, basketball, ice hockey, American football, baseball); more as their sources earn trust  |
| Leagues                    | 310, of which 146 football                                                                        | 29 football competitions, 24 with bookmaker prices                                                                                                        | 67 football competitions on sharp prices (Read), plus the leagues API-Football has usable bookmaker odds for (check 0.3)    |
| Matches listed             | 2,368, of which 1,106 football and 327 table tennis                                               | 110 scheduled, 19 open for betting. The Premier League was missing because of a known alias gap                                                           | 800 to 1,000 football matches in season (Estimate)                                                                          |
| Options per football match | Typical 514, top matches 500 to 805, about 105 market types                                       | 67 options, 9 market types                                                                                                                                | 500 to 540 from the two scores, 540 to 580 with quarter lines (Measured); about 700 with goal-time, corner and card markets |
| Where prices come from     | One feed in Sportradar's format, through its platform vendor                                      | The Odds API: ten independent bookmakers on 1X2 and goals, margins removed, middle value taken, the other markets calculated from those, our margin added | The same, with real prices used directly where they exist and more reference prices per match                               |
| Our margin                 | Not known                                                                                         | 6%, correct score 15%. Decided: 5 / 6 / 7 / 15% by market and league                                                                                      | Set per market family from measured error, and raised by itself when a family keeps less than it should                     |
| Price age on the phone     | Up to 5 to 10 minutes (browser cache)                                                             | Feed read every 10 minutes in the last 3 hours, every 30 in the last 24; changes pushed to the phone                                                      | The same on the 59 USD plan; every 2 to 5 minutes near kickoff after the 5M upgrade                                         |
| How early matches go up    | Football: typical 4.9 days, up to 35                                                              | Up to 14 days; betting opens once the kickoff is confirmed                                                                                                | 21 to 28 days for the big leagues                                                                                           |
| Live betting               | None                                                                                              | On simulated matches only                                                                                                                                 | None on real matches (the same as Hulusport)                                                                                |
| Adding a league            | Done by its platform vendor                                                                       | A source file, an alias file, catalogue rows and a script, by hand                                                                                        | Automatic: found, bound, mapped and graduated by the scraper                                                                |
| Results                    | Settled on its server; method not visible                                                         | Automatic in 9 leagues (two sources agree for 15 minutes). 15 competitions and every cup need a person                                                    | Automatic everywhere: 95% within about 20 minutes, the rest by the ladder; void at 48 hours if a match has no result        |
| Staff work on the feed     | Not known                                                                                         | A review queue: 120 approvals, 48 unknown names and 37 rating items open on 10 Nov                                                                        | None waiting. Alerts and a weekly report                                                                                    |
| Feed cost a month          | 4,000 to 12,000 USD if bought directly (Estimate); more likely a share of revenue to its platform | 59 USD                                                                                                                                                    | 87 USD; 157 after the upgrades; up to about 190 with more sports                                                            |
| Front end                  | React single-page app; the whole board (over 4 MB) sent to every visitor; installable; Telegram   | Next.js installable app; paged lists; live price updates; USSD and SMS betting built, off until a carrier is contracted                                   | The same, with market groups loaded when opened                                                                             |
| Products beside sports     | Casino (103 providers), raffles, predictor games, a jackpot, cash-out claims                      | Jackpots, cash-out, multi bonus. Casino is excluded by policy                                                                                             | Unchanged                                                                                                                   |
| Languages                  | English, Amharic, French                                                                          | Amharic, English, Afaan Oromo, Tigrinya                                                                                                                   | Unchanged                                                                                                                   |

---

## 3. What Hulusport's numbers are made of

- **It rents its board.** Hulusport is one brand on a shared platform (shamo.bet, abolbet.com and others use it too). The platform maps one upstream feed for all of them. Hulusport probably pays a share of revenue, not a feed bill (Report).
- **The depth is generated.** 915 of its 1,106 football matches carry 500 or more options (Report). A list that long on that many matches is what a pricing model produces from a few core numbers per match. 96 matches have fewer than 50 options, probably because the feed has only basic prices for them.
- **The match count is padded.** 327 matches are table tennis (228 of them Czech Liga Pro), 137 are American college games and 68 are boxing "matchups" (Report). Football is 1,106.
- **Its weak points** are ones Nahubet can beat:
  - prices on screen up to 10 minutes old;
  - a 4 MB first load on cheap phones;
  - no USSD or SMS betting, and no Afaan Oromo or Tigrinya.

So parity means four things: as many football competitions as can be priced safely, 500 or more options on most matches, results that settle without staff, and a feed that runs itself.

---

## 4. The plan: four ideas

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

- **Tier A needs nothing new from the feed.** It settles from the two scores the result rules already require, so it keeps the result ladder's safety (4.4).
- **Tier Q needs a settlement change.** A bet can today be won, lost or void. Quarter lines add half won and half lost. That touches payouts, cash-out and tax, so it is a money-path task of its own.
- **Tiers B, C and D rest on one source** (API-Football's match events and statistics), in the leagues where it has them. They need their own models. They settle under rung C of the result ladder (one trusted source, after a wait), so they also need D11. Prices for corners, cards and scorers without a market reference are easy for informed bettors to beat, so they start with small limits or wait.

**Reaching "700" on the button.** There are two routes, and the choice is D9:

1. Tiers B and C for the big leagues: about 700, with markets players look for (first team to score, corners), on single-source settlement.
2. About 120 more score-only combinations in Tier A: about 700 with two-source settlement, but markets that are rarely bet.

My recommendation is route 1 for the big leagues only, after Tier A has run for a month.

**Accuracy of 590 calculated prices.** The prototype proves the arithmetic, not the model. Before real limits:

- **Fit the draw and the first half.** Today the model's two numbers (each side's expected goals) are fitted to the home win, the away win and one goals line. The draw is not fitted, and the first half is fixed at 49% of goals ([feed-quality-plan.md](../feed-quality-plan.md), items P-4 and P-5). With 590 options resting on it, fit the draw (the low-score correction) and learn the first-half share per league. Both are already planned; they become part of this work.
- **Test every family on history, in one pass.** Because each market is a rule, one loop can take 20 seasons of results with closing odds (football-data.co.uk, which `eval market` already reads), fit the model to each match's closing prices, and compare predicted with actual frequency for all 92 market types. Families that fail get a higher margin, a lower limit, or are left out.
- **Margin by family.** 5 to 6% on 1X2 and over/under, 7% on close derivatives (already decided as P-6), 10 to 15% on correct scores and long combinations.
- **Self-defending margins, with no review.** Every week a job compares the money kept per family with the margin charged. A family that keeps less than expected for three weeks is suspended by the job. It returns once, two points of margin higher, after the history test passes at that margin. If it fails again it stays off. Both moves are written to the weekly report; neither waits for anyone.
- **Never above the market.** Where a real bookmaker price exists for an option, cap ours at the best of them (rule O7, `SCRAPER_CAP_AT_BEST_PRICE`, built and off today).

Accumulators cannot combine two options of the same match (Code: `duplicate_event` in `packages/core/src/betslip.ts`), so related options cannot be stacked against the house.

### 4.2 Idea 2: a three-layer feed, chosen from a comparison

No single cheap provider gives sharp prices and results for every league. Three together do, and the third makes disagreements decidable without a person.

**The providers compared.** Prices are a month, read on each provider's own page on 12 Nov unless labelled.

| Provider                    | Price                                                                                | What it gives                                                                                                                                                                             | Verdict                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Odds API                | Free 500 credits; 30 USD 20K; **59 USD 100K**; 119 USD 5M; 249 USD 15M               | 67 football competitions, about 55 competitions of other sports and 52 tennis tournaments; Pinnacle and three exchanges among the bookmakers; pre-match prices refreshed every 60 seconds | **Keep** as the price layer. Its terms allow commercial use in an app and forbid only reselling the data; operator pricing is not mentioned, so still ask (0.5) |
| API-Football                | Pro 19 USD (7,500 requests a day), Ultra 29 (75,000), Mega 39 (Looked up)            | Every fixture, status, half-time and 90-minute score of 1,200+ leagues; goal events; some bookmaker odds                                                                                  | **Add** as the spine. Its pages refuse automated readers, so its prices and terms were not re-read                                                              |
| TheSportsDB                 | Free (30 requests a minute); **9 USD**; 20 USD business                              | Scores for football and for NFL, NBA, MLB and NHL, refreshed every 2 minutes on the paid plans. Community-maintained (Assumed)                                                            | **Add** as the third opinion, only after it passes the truth check                                                                                              |
| football-data.org           | **Free**: 12 competitions, 10 calls a minute, scores delayed; 12 EUR for live scores | Full-time and half-time scores, and whether a match went to extra time                                                                                                                    | **Keep** (already running). The 12 EUR plan is not needed: settlement waits 15 minutes anyway                                                                   |
| OpenLigaDB                  | **Free**, no key                                                                     | German leagues 1 to 3 and the DFB-Pokal, with the half-time score and the score "after 90 minutes" as separate fields (Measured on a 2026 Bundesliga round)                               | **Add** as a free extra opinion for Germany; community-maintained, so it passes the truth check first                                                           |
| openfootball                | Free                                                                                 | Fixtures and results of nine leagues, slow                                                                                                                                                | Keep (already running) as a backup                                                                                                                              |
| odds-api.io                 | 65 USD for 2 bookmakers; 129 for 5; 239 for 10; 5,000 requests an hour               | Every market of the chosen bookmakers, among them two sharp Asian ones                                                                                                                    | **Ruled out by its terms:** "You may not copy odds or prices from the data ... into the odds that a sportsbook ... offers to its own customers"                 |
| OddsPapi                    | No fixed plans: a calculator of bookmakers times requests; a free account            | Says 300+ bookmakers, Pinnacle included                                                                                                                                                   | Not now. No terms page was found and revision 1 found its published prices disagreeing. Ask it the question of 0.5 before any use                               |
| Sportmonks                  | 29 EUR for 5 leagues; 99 for 30; 249 for 120; odds are a paid extra                  | Good data, priced by league count                                                                                                                                                         | Too dear for breadth: 120 leagues cost more than this whole plan                                                                                                |
| SportsGameOdds              | Free for 8 leagues; 99 USD for 17; 299 for 53                                        | Aimed at American sports                                                                                                                                                                  | Fewer leagues for more money                                                                                                                                    |
| TheRundown                  | 49 USD (read 31 Oct, [therundown-plan](../therundown-plan/README.md))                | Prices 60 seconds late; five European leagues                                                                                                                                             | Operator use needs a separate agreement on every plan; fewer leagues                                                                                            |
| BALLDONTLIE                 | Free at 5 requests a minute; 9.99 USD a league                                       | American leagues and some football                                                                                                                                                        | A candidate free check for NBA, NFL, MLB and NHL results (0.7). Per-league pricing makes it dear for football                                                   |
| Pinnacle resellers          | From 99 USD (Looked up)                                                              | One bookmaker's screen, resold. Pinnacle closed its own public API in July 2025 (Looked up)                                                                                               | No: one book, and the same problem as any resold screen                                                                                                         |
| Goalserve                   | No price on its page; 30-day trial                                                   | Scores and odds for many sports                                                                                                                                                           | Ask only if 0.3 fails and Class 2 is wanted                                                                                                                     |
| Sportradar, Genius, LSports | Thousands a month (Estimate)                                                         | Official data, live betting, settlement                                                                                                                                                   | Out of budget; the route to live betting later                                                                                                                  |

**The three layers.**

| Layer         | Provider                                                    | What it gives                                                                                                                                                                                                                                                                                                                                                                                                                                      | Cost a month |
| ------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: |
| Prices        | The Odds API, 100K plan (5M later)                          | 1X2, goals and handicap prices from ten independent bookmakers for 67 football competitions: 41 leagues, 7 domestic cups, 9 club internationals and 10 national-team competitions (Read). Africa appears only as the Cup of Nations. Main markets for NBA, EuroLeague, NHL, NFL, MLB, cricket, rugby, boxing and tennis. Extra football markets per match as reference prices. Final scores. **Fixture lists and kickoff times at no credit cost** |       59 USD |
| Spine         | API-Football, Pro plan (Ultra later)                        | Every fixture, kickoff change, half-time score, 90-minute score, extra-time and penalty score, and status of 1,200+ football leagues, with stable team and match numbers. Goal events, corners and cards where covered. Bookmaker odds for leagues The Odds API lacks                                                                                                                                                                              |       19 USD |
| Third opinion | TheSportsDB; football-data.org, OpenLigaDB and openfootball | A third score for the same match, so that one wrong source is outvoted and not escalated. Free in 12 competitions and in Germany; 9 USD for the rest and for four American leagues                                                                                                                                                                                                                                                                 |        9 USD |

**Why the 100K plan is enough to start.** Revision 1 moved to the 5M plan to carry 60 competitions on today's reading schedule (about 2,200 credits a competition a month; Code: `sources budget` gives about 53,000 for 24). Three facts from The Odds API's own guide change the sum (Read):

1. `/v4/sports` and `/v4/sports/{sport}/events` cost **no credits**. They give the list of competitions in season and every fixture with its kickoff time. So the scraper knows, for free, which leagues have matches in the window, and it has a second kickoff source everywhere.
2. A prices read costs one credit per market for our ten bookmakers, whatever the number of matches, and nothing when no match is returned. So a league between rounds costs nothing.
3. A scores read costs 2 credits. Today it is repeated every few minutes once a match should have ended. With the spine reading every result in the world once a minute, the scraper reads The Odds API's scores only when the spine says a match of that league has ended, and once more to confirm.

| Use on the 100K plan                                                                           |     Credits a month (Estimate) |
| ---------------------------------------------------------------------------------------------- | -----------------------------: |
| 12 priority competitions on today's fast schedule (every 10 minutes near kickoff), two markets |                         21,000 |
| About 35 other competitions in season, standard schedule (every 30 minutes near kickoff)       |                         21,000 |
| The handicap market on the 12 priority competitions                                            |                         10,500 |
| 10 competitions of other sports, standard schedule, three markets                              |                          9,000 |
| Scores, read when the spine reports a final whistle                                            |                          5,000 |
| Fixture lists and kickoff times                                                                |                              0 |
| Total                                                                                          | 66,500, two thirds of the plan |

The tiered schedule and the credit guard exist (Code: `SCRAPER_PRIORITY_COMPETITIONS`, items C-2 and C-3). The busiest Saturday comes close to the guard's daily trigger of 7,500 credits, so `sources budget` must show the margin before each wave of leagues (check 0.9).

**When to move to the 5M plan (plus 60 USD).** On any one of these, by measurement and not by date:

- the monthly projection passes 85,000 credits (the `budget_projection` alarm, built);
- the factory goes to normal limits: more reference prices per match (alternate goal lines, both teams to score, first-half prices) are worth about 130,000 credits a month;
- the scorecard shows our prices near kickoff lag the market, which reading every 2 to 5 minutes fixes.

**The request budget of API-Football** (Assumed: one request with `date=` returns every fixture of that day worldwide):

| Job                                                         |              Requests a day (Estimate) |
| ----------------------------------------------------------- | -------------------------------------: |
| Today's fixtures and scores, once a minute                  |                                  1,440 |
| Yesterday and the next 28 days, a few times a day           |                                    300 |
| A second look at each finished match, by number, with goals |                                    200 |
| Total for results                                           |       1,940, a quarter of the Pro plan |
| Bookmaker odds for Class 2, every 3 hours                   |                                  2,500 |
| Total with Class 2                                          | 4,440 of the 7,500 the Pro plan allows |

Move to Ultra (29 USD) when the goal-time and corner tiers start: they need two more requests per finished match.

**Three classes of league, decided by data.** A nightly job classes each competition from what the feeds delivered. Margins, limits and the market list follow the class, so no league has hand-kept settings.

| Class   | Evidence                                                                                          | Markets      | Margin   | Limits | Betting closes                                   |
| ------- | ------------------------------------------------------------------------------------------------- | ------------ | -------- | ------ | ------------------------------------------------ |
| 1 Sharp | Three or more independent bookmakers, one of them Pinnacle or an exchange (today's rule O1m)      | Full factory | 5 to 7%  | Normal | 5 minutes before kickoff (today)                 |
| 2 Soft  | Four or more independent bookmakers from API-Football, no sharp one, prices stable over two reads | Tier A       | 8 to 10% | Low    | 60 minutes before kickoff, to be tuned in shadow |
| 3 None  | No bookmaker prices                                                                               | Not offered  | –        | –      | –                                                |

Class 2 is the only route past 67 competitions in this budget, and it hangs on one unconfirmed fact. API-Football's guide says its odds refresh every 3 hours and appear up to 14 days ahead. Two competitors, and one listing of the API-Sports odds tool, say once a day and 7 days ahead (Looked up). If check 0.3 measures once a day, Class 2 is dropped: a day-old price is the easiest price to beat. The honest count is then 67.

Class 2 also needs its own version of one existing rule. Rule A2 suspends a match in its last 3 hours when its bookmaker prices are older than 30 minutes. A feed that refreshes every 3 hours would fail that for every match, so Class 2 gets a slower rule and an earlier close instead.

Class 3 is the answer to "any league at all". Our own rating model is 2.17% worse than the market's closing prices, and a bettor who picks only our best prices made 12.5% in the October test (Code: `docs/scraper-evaluation`). A league with no market price is a league where we would be the easiest book to beat. It also means no event in this plan is priced by the model alone.

**Other sports.** Start with markets that follow the bookmakers directly: winner, handicap and total. No model is needed, only the consensus and our margin. A sport is offered when it has two result sources, or one that has earned trust (4.4).

| Sport                                      | Hulusport: leagues, matches, typical options | Our price source                                             | Result sources                                                                               | Derived markets later                                          |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Basketball                                 | 62, 232, 110                                 | The Odds API (NBA, EuroLeague, WNBA, Australia's NBL)        | The Odds API scores and TheSportsDB for the NBA; API-Basketball for the others               | Alternate lines, quarters and halves from a normal-curve model |
| Ice hockey                                 | 41, 288, 56                                  | The Odds API (NHL, AHL, two Swedish and two Finnish leagues) | The Odds API scores and TheSportsDB for the NHL; API-Hockey for the others                   | The football factory with three periods                        |
| American football                          | 3, 173, 18                                   | The Odds API (NFL, college, CFL)                             | The Odds API scores and TheSportsDB for the NFL: automatic, where revision 1 needed a person | Few needed                                                     |
| Baseball                                   | 1, 5, 8                                      | The Odds API (MLB, Japan, Korea)                             | The Odds API scores and TheSportsDB for MLB                                                  | Few needed                                                     |
| Tennis                                     | Not in the report's summary                  | The Odds API lists the big ATP and WTA tournaments (Read)    | One source today: offered when a second is found or the first earns trust                    | Match winner only                                              |
| Handball                                   | 25, 86, 38                                   | API-Handball odds (Class 2, if 0.3 passes for it)            | API-Handball and a second source to be found                                                 | Totals and handicaps                                           |
| Volleyball                                 | 18, 62, 27                                   | API-Volleyball odds (Class 2, if 0.3 passes for it)          | API-Volleyball and a second source to be found                                               | Set scores from the winner price                               |
| Cricket, rugby, boxing                     | 5, 75, 2 (rugby 22)                          | The Odds API                                                 | The Odds API scores only: offered once that source has earned trust in shadow                | Winner only, as Hulusport mostly does                          |
| Table tennis, floorball, futsal, waterpolo | 9, 341, 2 to 5                               | **Not offered**                                              | –                                                                                            | –                                                              |

The Odds API's scores cover "selected sports" (Read), so check 0.1 lists which of these it scores.

Table tennis is 327 of those 341 matches. These are leagues with matches every few minutes, in a sport that has drawn repeated match-fixing alerts (my knowledge, not checked today), and I know of no provider in this budget with reliable results for them. Leaving it out is a decision, not a gap.

### 4.3 Idea 3: a league factory (the scraper adds leagues by itself)

**Today a league is added by hand** (Code): a source file per provider in `docs/scraper-plan/data`, an alias file of team spellings, the clubs typed into `packages/db/src/seed/catalog.ts`, a script (`add-more-leagues.sh` and three like it), then a person switches the source on, opens betting and confirms results until the league is trusted. With 24 competitions that left 48 unknown team names in the queue and the Premier League empty for want of one alias. At 67 it does not work.

**The scraper already has every part the factory needs** (Code):

| Part                                                                                         | State today                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A source is a row of data (`scrape_sources`), checked by `sources upsert`, not code          | Built                                                          |
| The `theoddsapi` adapter reads any competition from its key                                  | Built                                                          |
| The `generic-json` adapter can already read API-Football with a key header                   | Built; a draft source file exists (`source-api-football.json`) |
| Shadow mode: a competition whose policy is off is observed and nothing is created            | Built (rule S4)                                                |
| Switches per competition: listed, open by itself, settle by itself, price source             | Built (`scrape_competition_policy`)                            |
| Name matching by fixture, for one source only, audited                                       | Built, off (rule N4, `SCRAPER_AUTO_ALIAS`)                     |
| Betting opens by itself when prices and kickoff pass their checks                            | Built (rules F7b, O1m, O2, K2)                                 |
| Measurements: `sources coverage`, `sources budget`, `review results-audit`, `eval scorecard` | Built as commands a person runs                                |

What is missing is the part that writes the rows and reads the measurements. That is the factory: one command, `leagues sync`, run nightly by the scraper.

**The five steps, all automatic:**

1. **Find.** Read The Odds API's `/v4/sports` (free) and API-Football's `/leagues`. A competition on both lists and in season is a candidate.
2. **Bind.** The same competition has a different name and number on each provider. The factory binds them by their fixtures, not their names: two competitions are the same when at least six fixtures of the next 14 days pair up, kickoff within 5 minutes and team names alike, and at least 80% of all their fixtures do. The binding is stored with its evidence. After this step no competition is ever matched by name again, so the `unknown_competition` item cannot occur for a factory league.
3. **Import.** Competition and clubs come from the spine with its numbers. Nobody types a club. Names fall back to English until an Amharic name is added. Promoted and relegated clubs arrive with the spine's list each season.
4. **Map the team names by votes.** The Odds API spells clubs its own way. For each bound competition the factory pairs the two providers' fixtures by kickoff time. Each pair is a vote: this spelling is that club. A spelling is mapped when it has **two votes from two different fixtures and none against**, and no other spelling claims the same club. The mapping is an alias for that source only, with an audit row, exactly as rule N4 writes it today. Until a club is mapped its matches are simply not listed. A later vote against an alias suspends it, closes betting on that club's matches and starts the vote again.
5. **Graduate.** A league climbs by gates that the nightly job measures, and falls by the same job.

| Stage             | Enters when (starting values, tuned in shadow)                                                                                                                                                    | What runs                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0 Found           | Bound on both providers                                                                                                                                                                           | Nothing                                                           |
| 1 Shadow          | Sources written                                                                                                                                                                                   | Observed only; would-be prices, openings and results are recorded |
| 2 Open, low limit | 14 days in shadow; every club mapped; two sources agreed on the kickoff of 98% of fixtures; a sharp consensus on 90% of fixtures; 20 finished matches whose shadow result matched on every source | Listed, opens and settles by itself, limits at a quarter          |
| 3 Normal          | Four weeks at stage 2; 40 settled matches; no wrong result in the nightly audit; median closing-line value of zero or better; never a price above the best bookmaker                              | Normal limits                                                     |
| Back to shadow    | A wrong result found by the audit; a sharp consensus on under 70% of fixtures for a week; a source of the league loses its trust                                                                  | New matches are not listed; open ones follow the result ladder    |

**Why this is safe without a person.** A wrong binding or a wrong alias cannot settle a bet by itself: the two providers would then be talking about different matches, their fixtures and scores would disagree, and every rule downstream fails closed on disagreement. The worst outcome of a factory mistake is a league that is not listed.

**What it replaces.** The owner's waves of 10 to 12 competitions, the 200-match truth check by hand (S-7), the alias files (U-2), the catalogue gap report (U-6) and the bulk-map screen (U-5) are not needed for factory leagues. The 24 competitions of today are re-bound by the factory too, which also clears the 48 unknown names.

**What Ethiopian players will miss.** The Odds API has no Ethiopian Premier League, no CAF club competition and no South African or Egyptian league (Read). They can only come through Class 2, if check 0.3 passes and API-Football has odds for them (check 0.2).

### 4.4 Idea 4: no person in the loop

**The principle.** Today a doubtful case is held for a person. In this plan a doubtful case **fails closed and has a deadline**: the match is not listed, or betting closes, or the market is suspended, and a rule decides it within a fixed time. A person is told what happened. Nothing waits for a click.

**Every review item and its rule.** The 16 kinds are those of `packages/core/src/scrape.ts` (Code).

| Review item today       | Why a person is asked                       | The automatic rule                                                                                                                                                                         | Until it resolves                   |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `unknown_team`          | A spelling no alias matches                 | Team votes (4.3)                                                                                                                                                                           | Match not listed                    |
| `unknown_competition`   | A label no alias matches                    | Cannot occur: competitions are bound by number                                                                                                                                             | –                                   |
| `fixture_conflict`      | Sources disagree, or two events match       | The spine's match number is the identity, so two events cannot match. A disagreement closes by itself when the sources agree again (rule F6c, built)                                       | Match not listed                    |
| `kickoff_change`        | A move the rules do not apply               | Every match now has two kickoff sources, so an agreed move applies (rule F4a, built). A lone earlier time closes betting at once (K1, built) and betting reopens on agreement (F7b, built) | Betting closed on an earlier report |
| `fixture_missing`       | No source lists the match                   | Betting closes while no source lists the match and reopens when one does (new, in the manner of K1). If it is not played, the 48-hour rule ends it                                         | Betting closed                      |
| `cancellation_proposed` | Postponed, cancelled, abandoned: would void | The 48-hour rule below (D7)                                                                                                                                                                | Betting closed                      |
| `ratings_uncalibrated`  | A model-priced match with an unrated team   | Cannot occur: no event is priced by the model alone. Market-priced events already count as calibrated (O1m, built)                                                                         | –                                   |
| `odds_approval`         | A trader opens betting                      | Betting opens by itself when prices and kickoff pass (F7b, O1m, O2, K2, built). A failing check is tried again on every pass                                                               | Betting closed                      |
| A held re-price         | A price moved more than 1.25 times          | The move applies when the next read confirms it with three bookmakers, one of them sharp. A big move that the market repeats is news, not an error                                         | Suspended (A2, built)               |
| `result_ready`          | The competition is not on automatic results | The league's stage switches it on (4.3)                                                                                                                                                    | –                                   |
| `result_unverified`     | One source only                             | Result ladder, rungs B and C                                                                                                                                                               | Bets wait                           |
| `result_conflict`       | Sources disagree                            | Result ladder, rung B, else D                                                                                                                                                              | Bets wait                           |
| `score_basis_unknown`   | A cup score may include extra time          | The spine says per match how it ended; cup rules R-3 and R-3b below                                                                                                                        | Bets wait                           |
| `result_overdue`        | No score anywhere                           | Result ladder, rung D                                                                                                                                                                      | Bets wait                           |
| `result_correction`     | A new score after settlement                | Forward-only correction below (D10)                                                                                                                                                        | –                                   |
| `source_broken`         | A source's answers changed shape            | The breaker and the recovery are automatic already. The league runs on its other sources; prices without a fresh consensus suspend (A2)                                                    | Suspended, alert                    |
| `source_stale`          | A source answers but shows nothing new      | The same, and the source loses its trust until it shows new data                                                                                                                           | Alert                               |

The review table stays as the record of what the scraper saw and decided. Each item is closed by the rule that handled it, with the evidence, as the sweeper (rule Q1) and rule F6c do today.

**Hand steps outside the queue, and what replaces them:**

| Done by hand today                                                            | In this plan                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Source files, alias files, catalogue rows, onboarding scripts                 | The league factory (4.3)                                                         |
| Switching a source on, switching automatic opening and results on             | The league's stage                                                               |
| The 200-match truth check before a source may settle (S-7)                    | `sources truth-check`: this season's finished matches compared in a few requests |
| The weekly scorecard and results audit, run and pasted by a person (M-3, S-6) | A nightly job writes them and feeds the stages and the trust scores              |
| The `extra_time` switch before play-offs and cup semifinals                   | The spine's per-match status; the switch is retired for factory leagues          |
| A trader's tick that the kickoff was checked (A-5)                            | Not needed: two kickoff sources                                                  |
| Bulk confirm of single-source results (R-B, planned on 11 Nov)                | Not built: the ladder replaces it                                                |
| The weekly spot check of 20 matches against local competitors                 | Dropped. The scorecard against Pinnacle and the best bookmaker is the measure    |
| A suspended market family raised for review                                   | Returns once at a higher margin, else stays off (4.1)                            |

**The result ladder.** Every match is on exactly one rung at a time and always reaches an end.

| Rung                 | From                                 | Rule                                                                                                                                                                                                                                                         | Share of matches (Estimate) |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------: |
| A Agreement          | The final whistle                    | Two independent sources give the same 90-minute score and nothing changes for 15 minutes. This is today's rule (R2, R4) and it stays the normal path                                                                                                         |                 95% or more |
| B Majority           | 30 minutes after                     | Three or more sources have a final score and one differs. The scraper reads the match again from the spine by its number. The majority score applies once it has stood for 2 hours. The source that differed loses trust                                     |                    under 2% |
| C One trusted source | 6 hours after                        | One source alone has a score. It applies when that source is **trusted**, the score has stood for 6 hours, its goal events add up to the score where it has events, and no source says otherwise                                                             |                     2 to 3% |
| D The 48-hour rule   | 48 hours after the scheduled kickoff | Nothing above holds: no score, an even split, or the match was postponed, cancelled, abandoned or awarded. Bets on the match are void: stakes go back and an accumulator counts the leg at odds of 1.00. A match played later is listed again as a new event |                    under 1% |

- **Trusted** is measured, not declared. A source is trusted for a sport when the nightly audit has compared at least 500 of its final scores with settled results and 99.8% matched. A new source counts for nothing until then. `sources truth-check` gives a new source its first 500 from this season's history in one evening.
- **Half time.** A half-time score counts when the spine's first-half goals add up to it, and a second source agrees where one exists (football-data.org in 12 competitions, OpenLigaDB in Germany). Elsewhere it rests on one source, as rule R2 already allows.
- **What does not change.** Only a 90-minute score settles a bet. Results reach the catalogue only through `applyConfirmedResult`. No result applies before 105 minutes after kickoff. Every automatic step is idempotent and writes an audit row with the evidence it used.

**Cups, without a person.** The Odds API does not say whether a score includes extra time, so today every cup result goes to a person (rules R10, R10a).

| #    | Rule                                                                                                                                                                                                                                                                                           | Covers                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| R-3  | **Ended in 90 minutes.** The spine says this match ended after 90 minutes, and The Odds API reports the same score. That score can only be the 90-minute score, so it counts as the second source                                                                                              | Most cup matches                       |
| R-3b | **Went to extra time: the sums must close.** The spine gives the 90-minute score and the extra-time goals separately. Its 90-minute score counts as confirmed when its goals up to minute 90 add up to it, and 90-minute score plus extra-time goals equals the final score of a second source | Extra time and penalties               |
| –    | A second source that states the 90-minute score itself counts directly: OpenLigaDB has an "after 90 minutes" result (Measured), football-data.org a regular-time score (Assumed)                                                                                                               | Champions League, DFB-Pokal and others |
| –    | If neither rule can be checked, rung C applies: the spine's explicit 90-minute score, stable for 6 hours                                                                                                                                                                                       | The rest                               |

Both rules keep the caution behind the old decision (S-4): they trust a statement the data makes about one match, never a setting someone typed. Check 0.4 must show how each source reports real matches that went to extra time and penalties before either rule is built.

**The 48-hour rule (D7).** CLAUDE.md says today that no code path may cancel, void or abandon an event from scraped data. Removing the person from postponed matches means changing that sentence. The proposed rule:

1. **At once, on one source:** a postponed, cancelled or abandoned report closes betting on the match. This only reduces exposure, as rule K1 does.
2. **If the match is played within 48 hours** of its original kickoff time, bets stand and settle from the result. The spine keeps the same match number when a match moves, so the event follows it.
3. **Void by rule at 48 hours** when all of these hold: two independent sources report the match as not played, or one does and no source has a final score; the report has stood for 6 hours; and the original kickoff time is 48 hours past.
4. **Awarded results** (walkovers, results given by a committee) are not played scores. They void.

Players must be able to read this rule before they bet, so the house rules page states it (task 1.9). Most bookmakers print a rule of this shape, with a window of 24 to 72 hours (my knowledge, not checked today).

**Corrections after settlement (D10).** Today a changed score after settlement goes to a person, because a correction takes paid money back (rule R8). The proposed rule takes no money back:

- When two sources agree on a different 90-minute score within 72 hours of the match and it has stood for 2 hours, bets that the corrected score makes winners are paid. Bets already paid stay paid.
- After 72 hours a changed score changes nothing. The house rules say so.
- The cost is the payout of one side of one match, and it is limited by the liability caps enforced at bet placement (Code: built on 1 Nov). Each case is an alert, a cost line in the weekly report and a loss of trust for the source that caused it.

Taking winnings back would need negative balances, disputes and a person. Paying both sides in a rare case needs none of them.

**What still reaches a person, and why.**

| What                                                | How often               | Why it stays                                                |
| --------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| The decisions of section 9, the subscriptions       | Once                    | Money and rules are the owner's                             |
| The house rules text (48-hour rule, 90-minute rule) | Once                    | It is a promise to players                                  |
| Alerts by SMS or Telegram                           | A few a week (Estimate) | To know, not to act: the safe action has already been taken |
| The weekly report                                   | Weekly                  | To see the measures of section 8 against their targets      |
| Code review of the money-path tasks                 | Per task                | As CLAUDE.md requires                                       |

### 4.5 More reliable

| Risk                                   | Defence                                                                                                                                                                                                                                  | State                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| One source publishes a wrong score     | Three sources and a majority (rung B). Revision 1 had two and a person                                                                                                                                                                   | New                                                    |
| A source is quietly bad                | A trust score per source and sport from the nightly audit. A source under 99.5% stops counting as a second source; under 99.8% it cannot settle alone                                                                                    | New; the audit command exists (`review results-audit`) |
| A league goes bad                      | The nightly job sends it back to shadow (4.3)                                                                                                                                                                                            | New                                                    |
| The scraper itself stops               | **Price expiry.** Every price is stored with a time after which bet placement refuses it. A dark scraper then closes betting with no job running. Rule A2 suspends stale prices today, but only while the scraper is alive               | Specified as P7 in the TheRundown plan, not built      |
| The Odds API is down or out of credits | The credit guard slows reading before the quota ends (built). Prices expire; betting pauses. Results continue on the spine and the third opinion                                                                                         | Built, plus expiry                                     |
| API-Football is down                   | Prices and Class 1 betting continue. Results fall to the other sources: rung A where two remain, else they wait for the spine, and the 48-hour rule is the end                                                                           | New                                                    |
| A provider changes a field             | The shape check stores nothing from a changed page and trips the breaker (rule S1, built). Golden-file tests from real responses for each adapter                                                                                        | Built; new files for the new adapter                   |
| A new rule misbehaves                  | Every rule of 4.4 runs four weeks in shadow first: it records what it would have done, and the report compares that with what happened                                                                                                   | New                                                    |
| A fault nobody thought of              | Replay tests: the raw archive of real days is replayed with faults injected (a wrong score from one source, a frozen source, a postponement, a dark provider) and the outcome must be "closed, suspended or void", never "settled wrong" | New; the archive and replay exist                      |
| One provider account closed            | The free sources keep 12 competitions settling. The price layer has no cheap substitute (4.2), which is why check 0.5 comes before real limits                                                                                           | Open risk                                              |

### 4.6 More accurate prices than Hulusport

Hulusport's margin and accuracy are not known. What can be claimed and measured:

| Lever                                                                                                                                                         | State                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Reference from sharp bookmakers and exchanges, not one trading feed                                                                                           | Running                         |
| Weight sharp bookmakers double, drop outliers and frozen prices (P-1)                                                                                         | Planned                         |
| Remove margins by the power method, which treats long shots fairly (P-2)                                                                                      | Planned                         |
| Fit the draw and learn the first-half share (P-4, P-5)                                                                                                        | Planned; needed for the factory |
| **A real price first.** For each option: the consensus of real prices for that exact option where three bookmakers quote it; else the model; else not offered | New                             |
| Fit to more reference prices: handicap line, alternate goal lines, both teams to score, first-half prices                                                     | New; in full after the 5M step  |
| **Weights that learn.** Each night a bookmaker's weight moves toward how close its prices were to Pinnacle's close, within fixed bounds                       | New                             |
| **League numbers that learn.** First-half share, draw correction and home advantage per league from its own history, refreshed weekly                         | New; extends P-5 and F-07       |
| **Limits follow the evidence.** A selection's limit grows with the number of bookmakers behind it, a sharp one among them, and the league's stage             | New                             |
| Where a real price exists for an option, cap ours at the best bookmaker (O7)                                                                                  | Built, off                      |
| Weekly scorecard against Pinnacle's closing price (`eval scorecard`)                                                                                          | Built; made a nightly job       |

The measure of success stays the one already set: 1X2 within 1% of Pinnacle's closing price, a median closing-line value of zero or better, and never a price above the best bookmaker.

### 4.7 Faster and lighter than Hulusport

| Topic               | Hulusport (Report)                                             | Nahubet design                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First load          | Whole catalogue and match list, over 4 MB, kept in the browser | Paged lists as today. A match page loads the main group first and each other group when opened                                                                                                                                                                                    |
| Price updates       | Fetched and cached 5 to 10 minutes                             | Pushed as small changes, as today                                                                                                                                                                                                                                                 |
| 590 options a match | Loaded when a match is opened; size not measured               | The names of the options ship once with the app. A match sends only numbers: about 4 to 6 KB compressed (Estimate)                                                                                                                                                                |
| Storage             | Not known                                                      | **Keep the recipe, not every price.** Each pricing run stores its inputs: expected goals, the two fitted corrections, margins, the bookmaker prices used. Any price ever shown can be recomputed exactly. The price history table keeps main markets and options that were bet on |
| Why this matters    | –                                                              | Today every price change of every option writes a history row and sends a message to the phones (Code: `setSelectionOdds`). 590 options on 1,100 matches re-priced ten times a day would be about 6 million rows a day (Estimate)                                                 |

---

## 5. Budget

Buy the smallest plan that the measured use fits, and move up on a measurement.

| Step                    | Subscriptions                                              |       A month | What it buys                                                                                                          | Take it when                             |
| ----------------------- | ---------------------------------------------------------- | ------------: | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Today                   | The Odds API 100K                                          |        59 USD | 24 competitions, 67 options, 9 leagues settled automatically                                                          | –                                        |
| 1 Results everywhere    | plus API-Football Pro                                      |        78 USD | A second result source and half-time scores in every league; cups settle; the league factory can bind and import      | Phase 0 passes                           |
| **2 Recommended start** | plus TheSportsDB                                           |    **87 USD** | The third opinion: disagreements decide themselves. A second result source for NBA, NHL, NFL and MLB. 67 competitions | TheSportsDB passes the truth check       |
| 3 Speed and anchors     | The Odds API 5M (plus 60) and API-Football Ultra (plus 10) |       157 USD | Reads every 2 to 5 minutes near kickoff, more reference prices per match, goal-time and corner tiers                  | One of the three triggers of 4.2         |
| 4 More sports           | plus API-Basketball, API-Hockey, or one more               | about 190 USD | The smaller basketball and hockey leagues; period scores for derived markets                                          | Football runs with no person for a month |

Revision 1 recommended 148 USD from the start of Phase 3. Step 2 gives the same leagues, more automation and one more result source for 61 USD less, and leaves the upgrade as a choice the measurements make.

Price notes:

- **The Odds API** (Read on its page): free 500 credits; 20K 30 USD; 100K 59 USD; 5M 119 USD; 15M 249 USD. A read costs markets × regions, and only markets that return data are charged. The lists of sports and of fixtures are free.
- **API-Football** (Looked up; its pages refuse automated readers): Pro 19 USD (7,500 requests a day), Ultra 29 USD (75,000), Mega 39 USD (150,000). Every plan includes every competition and endpoint. Read the page in a browser at signup.
- **TheSportsDB** (Read): 9 USD a month for one developer, 20 USD for a small business. The business plan may be the right one for a company; it still fits.
- **API-Sports' other sports** are separate subscriptions (Looked up). Handball is listed at 15, 25 and 35; the currency was not shown and the other sports' prices were not confirmed. About 15 USD each is an assumption.
- **Free:** football-data.org (12 competitions), OpenLigaDB (Germany), openfootball. The free plans of the paid providers (500 credits; 100 requests a day) are enough for Phase 0.
- Taxes, card fees and exchange costs are not included.

---

## 6. Creative, considered, and rejected

| Idea                                                                            | Why not                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read Hulusport's own public board (two open requests give its whole price list) | It is their data under their terms, and it comes from a licensed feed whose owner would have a claim too. They can block it in a minute. It would make Nahubet a late copy of a competitor's prices, errors included. It also breaks the project's own rule against publishing scraped bookmaker odds |
| odds-api.io at 65 USD for two sharp Asian bookmakers and every market           | The cheapest route to hundreds of leagues on paper. Its terms forbid exactly this use: copying its odds into a sportsbook's own odds (Read). The account would be closed, and rightly                                                                                                                 |
| Feeds that resell bet365 or Pinnacle screens (BetsAPI, the Pinnacle mirrors)    | Same problem with a middleman, and one bookmaker is not a consensus                                                                                                                                                                                                                                   |
| Scraping live-score sites, or the unofficial ESPN and Sofascore endpoints       | Their terms forbid it, or they have no terms for it at all; pages change without notice. Paid and open APIs at 0 to 19 USD remove the reason                                                                                                                                                          |
| Pricing leagues from our own ratings where no bookmaker price exists            | Measured: the easiest prices to beat. See Class 3                                                                                                                                                                                                                                                     |
| Settling from one source at once, as most small books do                        | One wrong score would pay real money. Rung C allows one source only when it is measured as trusted, after 6 hours, with its goals adding up                                                                                                                                                           |
| Taking winnings back when a score is corrected                                  | Needs negative balances, disputes and a person. Paying the newly winning side costs less than the staff time (D10)                                                                                                                                                                                    |
| Sportmonks for breadth                                                          | 249 EUR for 120 leagues, odds extra (Read)                                                                                                                                                                                                                                                            |
| Table tennis and similar filler                                                 | Integrity risk and no reliable results in budget                                                                                                                                                                                                                                                      |
| Live betting on real matches                                                    | Needs a fast official data feed, which costs thousands a month. Prices that are two minutes late lose money to anyone watching the match                                                                                                                                                              |
| A white-label platform like Hulusport's                                         | Revenue share with monthly minimums, and the owner would give up the code already built                                                                                                                                                                                                               |

---

## 7. Phases

Who does a task follows CLAUDE.md: **Opus** for design and the money path, **Sonnet** for well-specified code, **Haiku** for checks and reports. Each task is one pull request with its tests. Every change that touches prices, opening, results or voiding runs in shadow first.

### Phase 0: prove the facts (free, no money-path code)

| #   | Check                                                                                                                                                                                                                                             | Passes when                                                                                                                      | If it fails                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0.1 | The Odds API `/v4/sports` (free call). Its coverage page lists 67 football competitions (Read, done); the call is the authority and also says which sports have scores                                                                            | We have the exact list and which sports it scores                                                                                | The list shrinks to what the call returns                           |
| 0.2 | API-Football free key: `/leagues`                                                                                                                                                                                                                 | We know how many football leagues have odds, events and statistics, and whether the Ethiopian Premier League and CAF are covered | The league target drops to what it covers                           |
| 0.3 | API-Football odds: bookmakers, page size, real refresh time, days ahead                                                                                                                                                                           | Four or more independent bookmakers a match; refresh every 3 hours as its guide says                                             | Class 2 is dropped and the count stays at 67                        |
| 0.4 | Real cup matches that went to extra time and to penalties, read from API-Football, The Odds API, football-data.org and OpenLigaDB                                                                                                                 | The spine gives the 90-minute score separately; we know what each other source reports for the same match                        | R-3b is not built; those matches go to rung C                       |
| 0.5 | Written answers from The Odds API (the draft email in `docs/theoddsapi-plan` was never sent) and from API-Sports: may a betting operator use the data to set prices and settle? The Odds API's terms allow commercial use and do not mention this | Yes in writing                                                                                                                   | Owner's decision; other providers cost more                         |
| 0.6 | History test of every Tier A family (4.1)                                                                                                                                                                                                         | A list of families with their error and margin                                                                                   | Failing families are left out                                       |
| 0.7 | TheSportsDB on 200 finished matches against football-data.org, and on a week of NBA, NHL, NFL and MLB against The Odds API. The same for BALLDONTLIE's free plan                                                                                  | 99.8% agreement, and results appear within an hour                                                                               | It is not bought; rung B exists only where a free third source does |
| 0.8 | Shadow read of one league from API-Football with the existing `generic-json` adapter and `dry-fetch`: no new code                                                                                                                                 | Fixtures, statuses and both scores parse; the by-date request returns every league                                               | The adapter of 1.1 needs more work                                  |
| 0.9 | `sources budget` replayed for the 67 competitions on the tiered schedule, with scores read on the spine's signal                                                                                                                                  | Under 85,000 credits in a busy month; the busiest day under the guard's trigger                                                  | Step 3 (the 5M plan) is taken before the leagues are added          |

A key for API-Football is saved in the cloud work environment, but API-Football answered every request with "missing application key", so 0.2, 0.3, 0.4 and 0.8 could not be run for this revision. They need a working key and one evening.

### Phase 1: results everywhere and no result waits (API-Football, then TheSportsDB)

| #    | Task                                                                                                                                                     | Who           | Done when                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| 1.1  | Adapter `apifootball`: read by date, match numbers, every status, 90-minute, half-time, extra-time and penalty scores, goal events                       | Opus          | Golden-file tests from real responses; shadow run on the 24 competitions                        |
| 1.2  | `sources truth-check`: compare a source's finished matches of this season with the settled results and the other sources; write its trust score          | Sonnet        | API-Football has 500 or more compared matches and a score; no hand step                         |
| 1.3  | Nightly job: results audit, trust scores, the weekly report. Uses `review results-audit` and `eval scorecard`                                            | Sonnet        | The report is written with no command typed                                                     |
| 1.4  | Kickoff confirmation from two sources everywhere: The Odds API's free fixture list and the spine                                                         | Sonnet        | Events open more than 72 hours ahead with no person                                             |
| 1.5  | Cup rules R-3 and R-3b, if D4 is yes and 0.4 passed                                                                                                      | Opus          | Gate tests, including a wrongly configured source and a penalty shoot-out                       |
| 1.6  | Result ladder rungs B and C, if D11 is yes. Third-opinion sources: TheSportsDB and OpenLigaDB as `generic-json` sources                                  | Opus          | Property tests: no rung applies a score that a trusted source contradicts; four weeks of shadow |
| 1.7  | The 48-hour rule, if D7 is yes: close on report, follow a moved match, void at 48 hours. CLAUDE.md and `docs/scraper.md` change in the same pull request | Opus          | Tests for each condition; a postponed match replayed inside and outside the window              |
| 1.8  | Forward-only corrections, if D10 is yes: re-settle lost bets as won, accumulators included                                                               | Opus          | Property tests: no bet is paid twice, no paid bet is reversed, ledger entries sum to zero       |
| 1.9  | House rules page in four languages: 90-minute rule, 48-hour rule, corrections                                                                            | Sonnet, owner | The owner has approved the text                                                                 |
| 1.10 | Price expiry at bet placement (P7)                                                                                                                       | Opus          | With the scraper stopped, betting on its events closes by itself within the expiry time         |
| 1.11 | Alerts to the owner's phone for the cases of 4.4                                                                                                         | Sonnet        | Each alert names what was done, not what to do                                                  |

### Phase 2: the market factory (no new subscription)

| #   | Task                                                                                                                           | Who              | Done when                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| 2.1 | Market rules in `packages/core`, one per market type. Today's 12 types keep their codes and stored rows                        | Opus             | Property tests: one winner per score; the rule that prices is the rule that settles  |
| 2.2 | Pricing from the rule table, with the draw fit and the learned first-half share as switches                                    | Opus             | With both switches off, today's 67 options come out unchanged to the last thousandth |
| 2.3 | Storage by pricing run; bulk writes; the sanity check O2 per family; new markets added without holding the others for approval | Opus (migration) | A re-price of 590 options is one transaction                                         |
| 2.4 | Match page: groups, filter chips, market search, lazy loading; labels in Amharic and English                                   | Sonnet           | Lighthouse budget on a cheap-phone profile                                           |
| 2.5 | Margins and limits per family from settings; the weekly job that suspends and returns a family                                 | Opus             | Liability caps apply per family; the job's moves appear in the weekly report         |
| 2.6 | Tier Q: half-won and half-lost in settlement, payout, cash-out and tax                                                         | Opus             | Property tests on stake splitting; payouts rounded down                              |
| 2.7 | A real price first, learned bookmaker weights, limits that follow the evidence (4.6)                                           | Opus             | The scorecard shows no loss against today's prices on the 24 competitions            |

Rollout: priced but hidden for a week, then shown with low limits, then normal limits where the scorecard is good. The scorecard decides, not a person.

### Phase 3: breadth through the league factory (no new subscription; step 3 on a trigger)

| #   | Task                                                                                               | Who                   | Done when                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| 3.1 | `leagues sync`: find and bind competitions on both providers; store the binding with its evidence  | Opus (design), Sonnet | All 67 bind, or each failure names its reason; no wrong binding on the 24 known ones |
| 3.2 | Catalogue import from the spine: competitions, clubs, seasons                                      | Sonnet                | No club is typed; the 8 clubs missing today appear                                   |
| 3.3 | Team votes: two fixtures, none against, one club per spelling; suspension on a vote against        | Opus                  | No wrong alias on the 24 known competitions; today's 48 unknown names resolve        |
| 3.4 | Generated sources and policies; scores read on the spine's signal; leagues out of season go idle   | Sonnet                | `sources budget` matches check 0.9                                                   |
| 3.5 | Stages and gates: the nightly job promotes and sends back to shadow                                | Opus                  | A league reaches stage 2 with no person; an injected wrong result sends it back      |
| 3.6 | League classes computed nightly; Class 2 rules, if 0.3 passed and D5 is yes                        | Opus                  | Class 2 leagues run a month in shadow first                                          |
| 3.7 | Fixture horizon from 14 to 21 or 28 days for stage 3 leagues                                       | Sonnet                | –                                                                                    |
| 3.8 | After step 3 of the budget: extra reference markets for the top matches, faster reads near kickoff | Opus                  | The scorecard improves on the matches that got them                                  |

### Phase 4: other sports and the extra tiers (optional, about 15 USD each)

| #   | Task                                                                                                                            | Who                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 4.1 | Winner, handicap and total for NBA, NHL, NFL and MLB on two result sources; result rules per sport (overtime counts)            | Opus (result rules per sport), Sonnet |
| 4.2 | The smaller basketball and hockey leagues with API-Basketball and API-Hockey; single-source sports once their source is trusted | Sonnet                                |
| 4.3 | Derived markets per sport                                                                                                       | Opus                                  |
| 4.4 | Tier B, then Tier C, for stage 3 leagues with coverage, settled by rung C                                                       | Opus                                  |

Order: Phase 0, then 1 and 2 side by side (they do not touch each other), then 3, then 4. Task 3.3 can come forward: it also clears today's queue.

---

## 8. How we will know it matches Hulusport

| Measure                                        | Hulusport (Report)            | Target                                                                | Read from              |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- | ---------------------- |
| Football competitions with matches             | 146                           | 67 sharp; more only as Class 2 if check 0.3 passes                    | Catalogue              |
| Football matches listed                        | 1,106                         | 800 to 1,000 in season                                                | Catalogue              |
| Options, typical football match                | 514                           | 500 or more from scores; 540 or more with quarter lines               | The "+N" button        |
| Options, top match                             | 805                           | 700 with Tiers B and C                                                | The "+N" button        |
| Price age near kickoff                         | Up to 10 minutes              | Under 10 minutes on the 59 USD plan; under 5 after step 3             | Feed page              |
| Our 1X2 against Pinnacle's close               | Not known                     | Within 1%                                                             | `eval scorecard`       |
| Price above the best bookmaker                 | Not known                     | Never                                                                 | `eval scorecard`       |
| Review items waiting for a person              | Not known                     | **0**                                                                 | `review counts`        |
| Matches settled on rung A                      | Not known                     | 95%                                                                   | `review results-audit` |
| Whistle to settled, rung A                     | Not known                     | Median 20 minutes                                                     | `review results-audit` |
| Matches settled or void 48 hours after kickoff | Not known                     | 100%                                                                  | `review results-audit` |
| Wrong results                                  | Not known                     | Fewer than 1 in 2,000 matches, each corrected forward within 72 hours | `review results-audit` |
| Hand steps to add a league                     | Its vendor's work             | 0                                                                     | `leagues sync` log     |
| Feed cost a month                              | Thousands, or a revenue share | 87 USD; 157 after step 3                                              | Invoices               |

The wrong-result target is new and deliberate. Revision 1 said "no wrong result" and kept a person for every doubt. With no person, the promise is a measured rate, a forward correction and a source that loses its trust.

---

## 9. Decisions for the owner

| #   | Decision                                                                                                                                     | My recommendation                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Buy API-Football, on the Pro plan (19 USD). This reverses the choice of 11 Nov of no paid results source (S-3)                               | Yes. It is the cheapest single step: it gives the 15 single-source competitions a second result source and the factory its spine               |
| D2  | Upgrade The Odds API from 100K to 5M (plus 60 USD)                                                                                           | Not yet. Take it when one of the three triggers of 4.2 fires                                                                                   |
| D3  | Get both providers' written answer on operator use (Phase 0.5)                                                                               | Yes, before real limits                                                                                                                        |
| D4  | Cup rules by agreement and by sums (R-3, R-3b)                                                                                               | Yes, after check 0.4                                                                                                                           |
| D5  | Class 2: open betting on a consensus with no sharp bookmaker, with low limits                                                                | Only if check 0.3 measures a refresh of 3 hours or better, and after a month of shadow                                                         |
| D6  | Goal-time, corner and card markets settle from one trusted source after a wait (rung C)                                                      | Not yet; decide after Phase 2. It follows from D11                                                                                             |
| D7  | **The 48-hour rule:** void by rule, with no person, when a match is not played within 48 hours. This changes a sentence of CLAUDE.md         | Yes, in line with the request of 12 Nov for no manual review. Revision 1 said to keep the person. Build it last in Phase 1 and shadow it first |
| D8  | Which other sports first                                                                                                                     | NBA, NHL, NFL and MLB: two result sources at no extra cost                                                                                     |
| D9  | The route to 700 (4.1)                                                                                                                       | Tier B for big leagues, later                                                                                                                  |
| D10 | **Corrections go forward only:** pay the newly winning side, take nothing back, ignore changes after 72 hours. This replaces rule R8         | Yes                                                                                                                                            |
| D11 | **Result ladder rungs B and C:** a majority of three sources decides; one trusted source decides after 6 hours. This changes rules R3 and R6 | Yes, after four weeks of shadow show what each rung would have done                                                                            |
| D12 | Buy TheSportsDB (9 USD) as the third opinion                                                                                                 | Yes, if it passes check 0.7                                                                                                                    |
| D13 | Approve the house rules text that states the 90-minute rule, the 48-hour rule and the correction rule                                        | Needed before D7 and D10 act                                                                                                                   |

If the owner prefers to keep a person for one of D7, D10 or D11, that case goes back to the review queue and everything else in the plan still stands. They are independent.

---

## 10. Risks and limits

- **Provider terms.** Neither provider has confirmed in writing that a betting operator may use its data. The Odds API's terms allow commercial use and tell the user to verify the data; they do not mention setting prices (Read). It could close the account; the owner accepted that on 1 Nov for the demo. With real limits it is a business risk, so 0.5 comes first. odds-api.io shows what a refusal looks like in writing.
- **Regulation.** The Hulusport report found no source confirming any restored Ethiopian licence. This plan is about data and code and changes nothing about that question. Automatic voiding and the correction rule are promises to players: a regulator may have its own view of both, so they belong in the licence conversation.
- **Automatic rules can be wrong.** A majority of three can share an error. A trusted source can be wrong once in a thousand. That is why the target is a measured rate (section 8), why each rung runs in shadow first, and why corrections only pay out. The cost of a wrong automatic result is one side of one match, inside the liability caps.
- **A wrong void is not reversible.** If the 48-hour rule voids a match that was in fact played, winners lose their winnings. The rule therefore needs two sources, or one with no final score anywhere, and 6 hours of standing.
- **One spine.** If API-Football is down, prices and betting continue on The Odds API; results use the remaining sources and the ladder. A long outage ends in 48-hour voids, which is safe and unpopular.
- **The 100K plan may not carry 67 competitions.** The 66,500 credits are scaled from today's 24, not replayed. Check 0.9 replays them. If it fails, step 3 comes first and the start costs 147 USD, about what revision 1 planned.
- **Model risk grows with the menu.** 590 prices from one fit means one bad fit misprices 590 options. Hence the history test, margins by family, low starting limits, the price expiry and the nightly scorecard.
- **Assumed facts.** API-Football's by-date requests, its odds refresh, its cup scores, its prices and its terms are from my knowledge and from search, not from its pages. Phase 0 exists to replace each with a measured fact, and none of the money-path tasks starts before it.
- **Community sources.** TheSportsDB and OpenLigaDB are edited by volunteers. They count only after the truth check and only as one opinion among three.
- **Effort.** Phase 1 has more money-path work than in revision 1: the ladder, the void rule and the corrections. The project keeps that work for the main Opus session. It is the slow part, not the subscriptions. The person-hours it saves come back every match day.

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

## Appendix: the 67 football competitions on The Odds API

Read on its coverage page on 12 Nov. The free `/v4/sports` call is the authority (check 0.1).

| Group               | Count | Competitions                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domestic leagues    |    41 | England (Premier League, Championship, League One, League Two), Germany (Bundesliga, 2. Bundesliga, 3. Liga, women's Bundesliga), Spain (two), Italy (two), France (two), Sweden (two), Brazil (two), Netherlands, Portugal, Scotland, Belgium, Austria, Switzerland, Denmark, Norway, Finland, Ireland, Poland, Greece, Turkey, Russia, Saudi Arabia, United States, Mexico, Argentina, Chile, Japan, South Korea, China, Australia |
| Domestic cups       |     7 | FA Cup, EFL Cup, EFL Trophy, DFB-Pokal, Coppa Italia, Copa del Rey, Coupe de France                                                                                                                                                                                                                                                                                                                                                  |
| Club internationals |     9 | Champions League, its qualification, women's Champions League, Europa League, Conference League, Copa Libertadores, Copa Sudamericana, Leagues Cup, Club World Cup                                                                                                                                                                                                                                                                   |
| National-team       |    10 | World Cup, women's World Cup, World Cup qualifiers (Europe, South America), European Championship and its qualification, Nations League, Copa América, Gold Cup, Africa Cup of Nations                                                                                                                                                                                                                                               |

They are never all in season at once: the national-team competitions are rare, and the northern summer leagues rest while the winter leagues play. About 45 to 50 are active in a typical month (Estimate).

## Sources

- Hulusport: `hulusport_report.md` (12 Nov 2026) and [competitor-notes.md](../competitor-notes.md).
- Nahubet: this repository at `661763f`; [feed-quality-plan.md](../feed-quality-plan.md), [scraper.md](../scraper.md), [theoddsapi-plan](../theoddsapi-plan/README.md), [therundown-plan](../therundown-plan/README.md), [scraper-evaluation](../scraper-evaluation/00-scorecard-and-fix-plan.md).
- The Odds API, read on 12 Nov: [plans and prices](https://the-odds-api.com/), [sports covered](https://the-odds-api.com/sports-odds-data/sports-apis.html), [V4 guide](https://the-odds-api.com/liveapi/guides/v4/) (free endpoints, cost of a request), [update intervals](https://the-odds-api.com/sports-odds-data/update-intervals.html), [terms](https://the-odds-api.com/terms-and-conditions.html), [betting markets](https://the-odds-api.com/sports-odds-data/betting-markets.html).
- API-Football, not readable by an automated reader on 12 Nov: [pricing](https://www.api-football.com/pricing), its [RapidAPI listing](https://rapidapi.com/api-sports/api/api-football/pricing) and its [beginner's guide](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide) (odds 1 to 14 days ahead, refreshed every 3 hours).
- The competing claim that API-Football odds refresh once a day: [OddsPapi](https://oddspapi.io/blog/api-football-alternative/), [GOAL API](https://goal-api.com/blog/api-football-alternative), and a [listing of the API-Sports odds tool](https://qveris.ai/tools/api_sports.odds.retrieve.v1.4a680bbc).
- API-Sports other sports: [handball](https://api-sports.io/sports/handball), [basketball](https://api-sports.io/sports/basketball).
- Result sources, read on 12 Nov: [TheSportsDB pricing](https://www.thesportsdb.com/pricing), [football-data.org pricing](https://www.football-data.org/pricing) and [coverage](https://www.football-data.org/coverage), [OpenLigaDB](https://api.openligadb.de/getmatchdata/bl1/2026/1) (a Bundesliga round with its half-time and 90-minute results).
- Alternatives, read on 12 Nov: [odds-api.io pricing](https://odds-api.io/pricing), its [bookmakers](https://odds-api.io/bookmakers) and its [terms](https://odds-api.io/terms) (the clause on copying odds); [OddsPapi](https://oddspapi.io/pricing); [Sportmonks plans](https://www.sportmonks.com/football-api/plans-pricing/); [SportsGameOdds pricing](https://sportsgameodds.com/pricing/); [BALLDONTLIE](https://www.balldontlie.io/); [Goalserve prices](https://www.goalserve.com/en/sport-data-feeds/soccer-data-feeds/prices).
- Looked up, not the providers' own pages: [Pinnacle's API closure and its resellers](https://sportsapis.dev/apis/pinnodds), [TheSportsDB review](https://sportsapis.dev/apis/thesportsdb), [football-data.org free tier limits](https://www.thestatsapi.com/blog/football-data-org-free-tier-limits-2026).
