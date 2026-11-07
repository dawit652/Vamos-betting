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
- So the competitor column below is **general knowledge, not observed**, and marked _verify_.
  Melbet runs a platform of the 1xBet family, whose features are well known; Hulusport is a local
  operator (Hulegeb Online Solution) and iGaming Business reported a deal with Kiron Interactive, a
  virtual-sports supplier. **Next step: screenshots from a phone in Ethiopia** (section 5).

Rule for everything below: take **features and UX patterns**, never their code, images, logos,
colours or text.

## 1. Where Nahubet stands

| Area             | Nahubet today (verified in code)                                                                                                      | Market leaders (_verify_)                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Leagues          | 13 seeded; matches only where a source exists (top 5 + Champions League, Costa Rica)                                                  | Hundreds of leagues, Ethiopian Premier League prominent                                    |
| Football markets | 1X2, double chance, over/under, BTTS, correct score, draw no bet, half-time 1X2 (~10 per match)                                       | Melbet: handicaps (Asian and 3-way), HT/FT, odd/even, team totals, corners, cards, scorers |
| Live             | Live list and live match with score and clock                                                                                         | Match tracker, statistics; streaming on some                                               |
| Betslip          | Drawer, booking code, odds-change policy, multi bonus, tax                                                                            | One-click bet, accumulator of the day, bet builder (Melbet)                                |
| Cash out         | Yes (`CashOut.tsx`)                                                                                                                   | Yes; partial on some                                                                       |
| Jackpot          | Yes                                                                                                                                   | Common in Ethiopia                                                                         |
| Payments         | telebirr, Chapa                                                                                                                       | telebirr, CBE Birr, M-Pesa, bank transfer (per site)                                       |
| Channels         | USSD and SMS betting (`core/ussd.ts`, `core/smstext.ts`)                                                                              | Varies                                                                                     |
| Languages        | Amharic, English, Afaan Oromo, Tigrinya                                                                                               | Mostly Amharic and English                                                                 |
| Account          | KYC, limits, self-exclusion, sessions, PWA                                                                                            | Similar; app download (APK)                                                                |
| **Missing**      | **Search, favourites, results page, form/H2H, top-league shortcuts, promotions page, odds-movement arrows, referral, lite data mode** | Present on most                                                                            |
| Not doing        | —                                                                                                                                     | Casino, crash games (Aviator), virtual sports, crypto: excluded by policy (CLAUDE.md)      |

The biggest gap is not the front end: it is **how many matches there are to bet on**. Phase 1
comes first for that reason.

## 2. Leagues

Data sources the scraper already speaks: football-data.org (free tier, 12 competitions),
The Odds API (paid 20K plan; fixtures, prices, scores), API-Football (draft, Costa Rica).
The Odds API keys below were checked against its published sports list on 2026-11-07.

| #   | League                                                                            | Fixtures and results                                                                                                                                                                                           | Automation                                                                               |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L1  | **Ethiopian Premier League** (seeded, no source)                                  | API-Football if it covers it (one `/leagues?country=Ethiopia` request with a free key decides); otherwise fixtures entered by a trader in the back office                                                      | Results by a person (one source); auto open off until ratings exist                      |
| L1  | CAF Champions League, CAF Confederation Cup (seeded, no source)                   | Same API-Football check                                                                                                                                                                                        | Same                                                                                     |
| L2  | EFL Championship, Eredivisie, Primeira Liga, Brasileirão Série A                  | football-data.org free tier (ELC, DED, PPL, BSA; confirm on its coverage page) + The Odds API `soccer_efl_champ`, `soccer_netherlands_eredivisie`, `soccer_portugal_primeira_liga`, `soccer_brazil_campeonato` | Two upstreams: kickoffs (C1) and results (R2) without a person; F7b auto open available  |
| L3  | UEFA Europa League, Conference League                                             | `soccer_uefa_europa_league`, `soccer_uefa_europa_conference_league`                                                                                                                                            | One upstream: kickoffs confirm from 72 h (C2); results go to a person until a 2nd source |
| L3  | FA Cup, EFL Cup, Copa del Rey, DFB-Pokal, Coppa Italia, Coupe de France           | `soccer_fa_cup`, `soccer_england_efl_cup`, `soccer_spain_copa_del_rey`, `soccer_germany_dfb_pokal`, `soccer_italy_coppa_italia`, `soccer_france_coupe_de_france`                                               | Same as L3; extra time on (knockouts)                                                    |
| L4  | Saudi Pro League, Turkish Süper Lig, Scottish Premiership, League One, League Two | `soccer_saudi_arabia_pro_league`, `soccer_turkey_super_league`, `soccer_spl`, `soccer_england_league1`, `soccer_england_league2`                                                                               | Same as L3                                                                               |
| L4  | Egyptian Premier League, South African Premiership                                | Not on The Odds API; same API-Football check as L1                                                                                                                                                             | Same as L1                                                                               |
| L5  | Africa Cup of Nations (next edition 2027)                                         | `soccer_africa_cup_of_nations`                                                                                                                                                                                 | Add a month before it starts                                                             |

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

| Task | What                                                                                       | Where                                                                                                                          | Who     |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 2.1  | Asian handicap and 3-way handicap                                                          | `packages/core/src/markets.ts`, pricing in `packages/feed/src/pricing`, settlement rules, O2 cover in `packages/scraper` gates | main    |
| 2.2  | HT/FT, odd/even goals, home/away team totals, win to nil                                   | same                                                                                                                           | main    |
| 2.3  | Market groups on the event page (Main, Goals, Halves, Handicap, Correct score), 1X2 pinned | `EventMarkets.tsx`                                                                                                             | routine |

Settlement is money logic: unit and property tests in `packages/core`, payouts rounded down.
Corners and cards wait for a source that reports them.

### Phase 3: front end (weeks 5–6)

| Task | What                                                                                                | Where                                           | Who                        |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| F1   | Home: top-league chips, live-now count, sticky sport bar                                            | `SportHome.tsx`, shell                          | routine                    |
| F2   | Search teams and leagues (Amharic and English, aliases included)                                    | catalog API route + contract, header component  | routine                    |
| F3   | Favourites (leagues, teams): table + migration, guests in local storage                             | `packages/db` schema, `me` module, star buttons | main (migration) + routine |
| F4   | Odds movement arrows and flash on change                                                            | `MarketOdds.tsx`, `live-store.ts`               | routine                    |
| F5   | Results page (finished matches, scores) and simple form (last 5)                                    | new `(sportsbook)/results`, catalog API         | routine                    |
| F6   | One-tap bet mode (setting) next to the existing odds-change policy                                  | `BetslipDrawer.tsx`                             | main (betting path)        |
| F7   | Lite mode for cheap phones and slow networks: performance budget, no images, Lighthouse check in CI | `apps/web`, `e2e`                               | routine                    |
| F8   | Promotions page: multi-bonus table, jackpot rules                                                   | new page, settings                              | routine                    |

### Phase 4: payments and engagement (later)

- **Payments:** CBE Birr, M-Pesa, bank transfer. First check which of them Chapa already offers;
  new providers go in `packages/payments/src/providers` (money path: main). Real money only in
  licensed mode.
- **Accumulator of the day** picked by a trader in the back office, shown on Highlights.
- **SMS when a bet settles** (SMS channel exists), **referral** (needs a bonus design on the ledger: main).
- **Bet builder** (same-match multi) needs correlated pricing: large, after Phase 2.
- Not planned: streaming and match trackers (paid data), and the excluded verticals.

## 4. Order of work

1.1 → 1.2 → 1.5 → 1.3 → 2.1 → 2.3 → F2 → F4 → F5 → 1.4 waves → 2.2 → F1 → F3 → F6 → F7 → F8 → Phase 4.
At most two agents at a time; the main session reviews every agent's change before it is committed.

## 5. Needed from the owner

1. **Screenshots** from a phone in Ethiopia, for both sites: home, a league page, one match with
   all markets open, the betslip with three selections, live, jackpot, deposit methods,
   promotions. They replace the _verify_ column.
2. **An API-Football key** (free plan is enough for task 1.1), saved through the session's
   credential form, never in chat.
3. **Decisions:** Ethiopian Premier League first (recommended); the Odds API credit budget per
   month for new leagues.
