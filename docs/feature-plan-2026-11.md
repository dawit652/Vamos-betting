# Feature plan: competitors and more leagues (2026-11)

Goal: close the gap with the Ethiopian market leaders (Melbet Ethiopia, Hulusport) on the things a
mobile bettor notices first (how many matches and leagues, how many markets, how fast the site
is), without the verticals our policy excludes.

## 0. What was checked and what was not

- **nahubet.com** (read 2026-11-07): live, demo mode ("የሙከራ ሁነታ – በእውነተኛ ገንዘብ አይደለም"),
  Amharic by default, four sports (football, basketball, tennis, volleyball), bottom bar
  Home / Live / My bets / Jackpot / Account, tabs Highlights / Today / Upcoming / Leagues,
  Serie A and LaLiga matches with 1X2 and "+10" more markets.
- **The code** (this repository, branch `claude/exciting-feynman-fxbdz3`): inventory in section 1.
- **melbet-et.mobi** redirects to melbet.org, which resets the connection from our (non-Ethiopian)
  servers. **hulusport.com** answers "Only available in Ethiopia … Turn off your VPN". Geo-blocks
  were not bypassed. Public reviews are thin and promotional.
- **Both sites were then observed** through the owner's browser in Ethiopia (2026-11-07, Claude in
  Chrome, no login on Melbet, no bet, no deposit): details in [competitor-notes.md](competitor-notes.md).

Rule for everything below: take **features and UX patterns**, never their code, images, logos,
colours or text.

## 1. Where Nahubet stands

| Area             | Nahubet today (verified in code)                                                                | Hulusport (observed)                                                                                                | Melbet (observed, not logged in)                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Leagues          | 13 seeded; matches only where a source exists (top 5 + Champions League, Costa Rica)            | 947 football events; 12 top leagues; some African leagues; no Ethiopian league that day                             | 1,964 football events; CAF competitions, AFCON qualifiers (45), 12+ African national leagues; Ethiopia only a women's league           |
| Other sports     | Basketball, tennis, volleyball                                                                  | 13 sports; table tennis 248, ice hockey 200 events                                                                  | Table tennis 557, basketball 414, ice hockey 248, volleyball 175, tennis 161, cricket 69                                               |
| Football markets | 1X2, double chance, over/under, BTTS, correct score, draw no bet, half-time 1X2 (~10 per match) | ~125: handicaps, HT/FT, exact goals, odd/even, team totals, corners, goalscorers, 1X2+O/U and 1X2+BTTS combinations | Very deep: tabs for halves, corners, cards, shots, offsides, fouls, player stats; 1X2+BTTS, DC+BTTS; next goal                         |
| Match page       | Market list                                                                                     | Filter chips (Main, Total, Combination, Half, Handicap), market search, favourite markets                           | Market tabs, "search by market", Bet Builder and Betting on players tabs                                                               |
| Match list       | Tabs Highlights / Today / Upcoming / Leagues                                                    | Day tabs + calendar, country filter, 1X2 / double chance switch, league headers with star and count, side drawer    | Sport tabs, search, favourites, filter; odds cards in a swipe strip; selected odds highlighted                                         |
| Live             | Live list and live match with score and clock                                                   | **None found**                                                                                                      | Top Live cards (minute, score, 1X2, "+N"), live accumulators of the day                                                                |
| Betslip          | Drawer, booking code, odds-change policy, multi bonus, tax; singles and multis                  | Three parallel slips, floating mini slip bar, max win and net pay, default stake 100 ETB                            | Quick slip bar; single, accumulator, system, singles, constructor; quick stakes (+100, +250); accumulator booster; one-click generator |
| Cash out         | Yes (`CashOut.tsx`)                                                                             | **None found**                                                                                                      | Not visible before login                                                                                                               |
| Jackpot          | Yes                                                                                             | **None found**                                                                                                      | Toto-15: 15 picks, auto-complete, pool and minimum jackpot shown, countdown, % of players per pick                                     |
| Promotions       | Multi bonus                                                                                     | 100% first deposit up to 1,000 ETB (6+ picks at 1.50+, total 12+, 5x), referral 10 ETB, fantasy EPL                 | 200% first deposit up to 37,000 ETB, weekly free bets, safe bet, bank cashback, friends bonus                                          |
| Results          | None                                                                                            | Not seen                                                                                                            | Results page in the menu                                                                                                               |
| Payments         | telebirr, Chapa                                                                                 | Not shown before a deposit (wallet page not opened)                                                                 | Behind login; a bank promotion and crypto pages (crypto excluded for us); agents                                                       |
| Channels         | USSD and SMS betting (`core/ussd.ts`, `core/smstext.ts`)                                        | Web and installable app                                                                                             | Web, Android app, cash agents                                                                                                          |
| Languages        | Amharic, English, Afaan Oromo, Tigrinya                                                         | English, Amharic, French                                                                                            | Amharic and English seen                                                                                                               |
| **Missing**      | **Search, favourites, results page, filters, market search, multi-slips, system bets**          | —                                                                                                                   | —                                                                                                                                      |
| Not doing        | —                                                                                               | Casino tabs lead the home page (Aviator, JetX, Keno, slots, Chicken): excluded by policy                            | Casino, fast games, lotto, crypto deposits: excluded                                                                                   |

The biggest gap is not the front end: it is **how many matches and markets there are**. Phase 1
comes first for that reason. **Neither site lists the men's Ethiopian Premier League**: task 1.3
would be a clear first. Nahubet is **already ahead** of Hulusport on live betting, jackpot and cash
out, and of both on USSD/SMS betting and Afaan Oromo and Tigrinya: keep them visible.

## 2. Leagues

Data sources the scraper already speaks: football-data.org (free tier, 12 competitions),
The Odds API (paid 20K plan; fixtures, prices, scores), API-Football (draft, Costa Rica).
The Odds API keys below were checked against its published sports list on 2026-11-07.

| #   | League                                                                                                      | Fixtures and results                                                                                                                                                                                           | Automation                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L1  | **Ethiopian Premier League** (seeded, no source)                                                            | API-Football if it covers it (one `/leagues?country=Ethiopia` request with a free key decides); otherwise fixtures entered by a trader in the back office                                                      | Results by a person (one source); auto open off until ratings exist                      |
| L1  | CAF Champions League, CAF Confederation Cup (seeded, no source)                                             | Same API-Football check                                                                                                                                                                                        | Same                                                                                     |
| L2  | EFL Championship, Eredivisie, Primeira Liga, Brasileirão Série A                                            | football-data.org free tier (ELC, DED, PPL, BSA; confirm on its coverage page) + The Odds API `soccer_efl_champ`, `soccer_netherlands_eredivisie`, `soccer_portugal_primeira_liga`, `soccer_brazil_campeonato` | Two upstreams: kickoffs (C1) and results (R2) without a person; F7b auto open available  |
| L3  | UEFA Europa League, Conference League                                                                       | `soccer_uefa_europa_league`, `soccer_uefa_europa_conference_league`                                                                                                                                            | One upstream: kickoffs confirm from 72 h (C2); results go to a person until a 2nd source |
| L3  | FA Cup, EFL Cup, Copa del Rey, DFB-Pokal, Coppa Italia, Coupe de France                                     | `soccer_fa_cup`, `soccer_england_efl_cup`, `soccer_spain_copa_del_rey`, `soccer_germany_dfb_pokal`, `soccer_italy_coppa_italia`, `soccer_france_coupe_de_france`                                               | Same as L3; extra time on (knockouts)                                                    |
| L4  | Saudi Pro League, Turkish Süper Lig, Scottish Premiership, League One, League Two                           | `soccer_saudi_arabia_pro_league`, `soccer_turkey_super_league`, `soccer_spl`, `soccer_england_league1`, `soccer_england_league2`                                                                               | Same as L3                                                                               |
| L4  | Belgian Pro League, Swiss Super League (in Hulusport's top leagues)                                         | `soccer_belgium_first_div`, `soccer_switzerland_superleague`                                                                                                                                                   | Same as L3                                                                               |
| L4  | Leagues of Morocco, Kenya, Algeria, Nigeria, Ghana, Tunisia, Senegal, Cameroon, Rwanda (seen on both sites) | Not on The Odds API; same API-Football check as L1                                                                                                                                                             | Same as L1                                                                               |
| L5  | Africa Cup of Nations qualifiers (45 events on Melbet)                                                      | Not on The Odds API's list (only the finals); API-Football check                                                                                                                                               | Same as L1                                                                               |
| L4  | Egyptian Premier League, South African Premiership                                                          | Not on The Odds API; same API-Football check as L1                                                                                                                                                             | Same as L1                                                                               |
| L5  | Africa Cup of Nations (next edition 2027)                                                                   | `soccer_africa_cup_of_nations`                                                                                                                                                                                 | Add a month before it starts                                                             |

Each league follows the existing pattern (`infra/scripts/add-top-leagues.sh`,
`add-champions-league.sh`): catalogue entries and clubs in `packages/db/src/seed/catalog.ts`,
spellings in `docs/scraper-plan/data/aliases-*.csv`, one `source-*.json` per upstream, ratings
(learned from results, or set by hand and marked reviewed), then the competition switched on in
the back office. **Budget:** every Odds API league adds credits per read (scores reads cost 2);
enable in waves and watch `cli usage` before the next wave. More single-source leagues also mean
more results for a trader to confirm.

Front end for leagues: the `featured` flag already drives Highlights; add a **top-leagues chip
row** on the home page (see F1) and country flags in the Leagues tab.

## 3. Phases

Each task is one pull request with tests. Who does it follows CLAUDE.md: _quick_ = `quick-task`
(Haiku), _routine_ = `routine-coder` (Sonnet), _main_ = main session on Opus (design, migrations,
money path, review).

### Phase 1: more matches (weeks 1–2)

| Task | What                                                                   | Where                                            | Who              | Done when                                                       |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------- | --------------------------------------------------------------- |
| 1.1  | API-Football coverage check for Ethiopia, Egypt, South Africa, CAF     | one request each; result in `docs/scraper-plan/` | quick            | We know which of L1/L4 have a source                            |
| 1.2  | L2 leagues (four), script `add-more-leagues.sh` like the existing ones | seed, aliases, sources, script                   | routine + review | Next 14 days of matches appear; results settle with two sources |
| 1.3  | Ethiopian Premier League: API-Football source, or trader fixture entry | source JSON, or admin form + API route           | main             | This week's Ethiopian matches are bettable                      |
| 1.4  | L3/L4 leagues in waves of four, budget checked between waves           | seed, aliases, sources                           | routine          | Each wave live, credits within plan                             |
| 1.5  | Top-league chips on home, flags in Leagues                             | `SportHome.tsx`, catalog API                     | routine          | One tap from home to any featured league                        |

### Phase 2: deeper markets (weeks 3–4)

| Task | What                                                                                                                    | Where                                                                                                                          | Who     |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 2.1  | Asian handicap and 3-way handicap                                                                                       | `packages/core/src/markets.ts`, pricing in `packages/feed/src/pricing`, settlement rules, O2 cover in `packages/scraper` gates | main    |
| 2.2  | HT/FT, odd/even goals, home/away team totals, win to nil                                                                | same                                                                                                                           | main    |
| 2.3  | Market groups on the event page with filter chips (Main, Total, Combination, Half, Handicap), market search, 1X2 pinned | `EventMarkets.tsx`                                                                                                             | routine |
| 2.4  | Combinations 1X2 + over/under and 1X2 + BTTS, exact goals, goal range                                                   | same as 2.1 (correlated outcomes priced from one score model)                                                                  | main    |

Settlement is money logic: unit and property tests in `packages/core`, payouts rounded down.
Corners and cards wait for a source that reports them.

### Phase 3: front end (weeks 5–6)

| Task | What                                                                                                                                                                 | Where                                           | Who                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| F1   | Home: top-league chips, live-now count, sticky sport bar                                                                                                             | `SportHome.tsx`, shell                          | routine                          |
| F2   | Search teams and leagues (Amharic and English, aliases included)                                                                                                     | catalog API route + contract, header component  | routine                          |
| F3   | Favourites (leagues, teams): table + migration, guests in local storage                                                                                              | `packages/db` schema, `me` module, star buttons | main (migration) + routine       |
| F4   | Odds movement arrows and flash on change                                                                                                                             | `MarketOdds.tsx`, `live-store.ts`               | routine                          |
| F5   | Results page (finished matches, scores) and simple form (last 5)                                                                                                     | new `(sportsbook)/results`, catalog API         | routine                          |
| F6   | One-tap bet mode (setting) next to the existing odds-change policy                                                                                                   | `BetslipDrawer.tsx`                             | main (betting path)              |
| F7   | Lite mode for cheap phones and slow networks: performance budget, no images, Lighthouse check in CI                                                                  | `apps/web`, `e2e`                               | routine                          |
| F8   | Promotions page: multi-bonus table, jackpot rules                                                                                                                    | new page, settings                              | routine                          |
| F9   | Match list controls: day tabs (Today, Tomorrow, next day) + calendar, country filter, 1X2 / double chance switch, league headers with flag, count, star and collapse | `SportHome.tsx`, `MatchList.tsx`, catalog API   | routine                          |
| F10  | Floating mini slip bar (picks, total odds, net pay) above the bottom bar; max win and net pay in the slip                                                            | `BetslipButton.tsx`, `BetslipDrawer.tsx`        | routine                          |
| F11  | Up to three parallel slips                                                                                                                                           | betslip state, `BetslipDrawer.tsx`              | main (betting path)              |
| F12  | Side drawer for sports and top leagues                                                                                                                               | shell                                           | routine                          |
| F13  | Quick-stake buttons (+50, +100, +250) and selected odds highlighted in every list                                                                                    | `BetslipDrawer.tsx`, `MarketOdds.tsx`           | routine                          |
| F14  | Jackpot page: pool and guaranteed minimum, countdown to close, share of players per pick, auto-pick                                                                  | `components/jackpot`, jackpots API              | routine (+ main if rules change) |
| F15  | System bets (e.g. 2 of 3, 3 of 4)                                                                                                                                    | `packages/core` bet rules and settlement, slip  | main (money path)                |

### Phase 4: payments and engagement (later)

- **Payments:** CBE Birr, M-Pesa, bank transfer. First check which of them Chapa already offers;
  new providers go in `packages/payments/src/providers` (money path: main). Real money only in
  licensed mode.
- **Accumulator of the day** picked by a trader in the back office, shown on Highlights (Melbet
  also has a live version and a one-click slip generator).
- **Bonuses** (first-deposit bonus, weekly free bet, safe bet): one bonus wallet design on the
  ledger with wagering rules, then each offer as settings (main). Hulusport's sports-only
  first-deposit rules (6+ picks at 1.50+) are a good template.
- **SMS when a bet settles** (SMS channel exists), **referral** (needs a bonus design on the ledger: main).
- **Bet builder** (same-match multi) needs correlated pricing: large, after Phase 2.
- Not planned: streaming and match trackers (paid data), and the excluded verticals.

## 4. Order of work

1.1 → 1.2 → 1.5 → 1.3 → F9 → F10 → F13 → 2.1 → 2.3 → F2 → F4 → F5 → 1.4 waves → 2.2 → 2.4 → F1 → F12 → F3 → F11 → F14 → F6 → F15 → F7 → F8 → Phase 4.
At most two agents at a time; the main session reviews every agent's change before it is committed.

## 5. Needed from the owner

1. **An API-Football key** (free plan is enough for task 1.1), saved through the session's
   credential form, never in chat.
2. **Decisions:** Ethiopian Premier League first (recommended); the Odds API credit budget per
   month for new leagues.
