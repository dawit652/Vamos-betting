# Player app redesign: plan and remaining tasks

Redesign of `apps/web` (the player PWA), using the best ideas from the Hulusport front-end
analysis and Vamos's own rules (demo mode, no casino games, 150 KB page-weight budget,
server-rendered lists, Amharic first).

**Status key:** `[x]` done · `[~]` in progress · `[ ]` not started

_Last updated: 14 Nov 2026, end of the first working session. Anything not ticked below is still
to do; the open items are marked **Open**._

## What is taken from Hulusport, and what is left out

| Hulusport feature                                           | Decision                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Dark slate canvas with one green accent, theme switch       | **Taken.** Dark is the default, light is one tap away (cookie, no flash on reload)          |
| Three-column desktop: sports sidebar, list, permanent slip  | **Taken.** Phones keep the single column with bottom nav                                    |
| Match list grouped by league, collapsible, with counts      | **Taken**                                                                                   |
| Slip bar above the bottom nav (count, total odds)           | **Taken.** Replaces the floating button                                                     |
| Top leagues, sport list with match counts                   | **Taken** (sidebar on desktop, scroll rails on phones)                                      |
| Market category tabs on the match page                      | **Taken**, done in CSS only (no JavaScript)                                                 |
| Promotion banner                                            | **Taken** as a featured-match poster plus multi-bonus and jackpot cards                     |
| Balance pill with a Deposit shortcut in the header          | **Taken**                                                                                   |
| Load a slip from a code                                     | Already in Vamos (booking codes); restyled                                                  |
| Casino, crash and instant games, game strips, game launcher | **Left out.** Excluded by policy (`CLAUDE.md`)                                              |
| 3 Way / Double Chance toggle on list rows                   | **Not yet.** Needs the API to send a second market per list row (see "Needs back-end work") |
| Day chips and a date picker                                 | **Not yet.** The API only filters by highlights / today / upcoming / live                   |
| Country filter dropdown, match search                       | **Not yet.** Needs a search endpoint                                                        |
| Three parallel bet slips                                    | **Left out.** Adds state and risk to bet placement for little gain                          |
| Hulusport / Nahubet feed API                                | **Not used.** See "The shared feed" below                                                   |

## Tasks

### 1. Foundation: done

- [x] New design tokens in `apps/web/src/app/globals.css`: dark default, light override, `raised`
      and `chrome` colours, poster cards, crests, tags, live dot, panel, CSS-only market filter
- [x] Theme cookie (`vamos_theme`) in `src/lib/cookies.ts`, rendered as `<html data-theme>`
- [x] `ThemeToggle` in the header

### 2. Shell: done

- [x] Header: logo, theme and language toggles, balance pill with deposit shortcut
- [x] Main navigation rendered once (`MainNav`): bottom bar on phones, header links on desktop
- [x] DEMO banner restyled (kept permanent, still the page's only `role="note"`)
- [x] Footer card
- [x] Root layout: wide `<main>`; account and static pages keep a narrow column
- [x] Removed the unused `SportChips` component and `sportFromPath` helper

### 3. Sportsbook pages: done

- [x] `SportsbookFrame`: sport rail with counts, leagues rail, desktop sidebar, betslip column
- [x] Sport home: featured-match poster (with live score), jackpot and multi-bonus cards, pill tabs
- [x] Match list: league groups (collapsible), new rows, "Today / Tomorrow" kick-off labels
- [x] Odds buttons: new tiles, wide variant for two-way markets, price colouring, code prefixes
- [x] Event page: poster header with crests and score, market filter chips, market cards
- [x] Competition page header, live list, loading skeleton

### 4. Betslip: done

- [x] Slip bar (count + total odds) replacing the floating button
- [x] Drawer restyle (legs, stake, quick stakes, summary, placed state)
- [x] Docked betslip column on wide screens (loads only on wide screens)

### 5. Text and translations

- [x] New keys in `packages/i18n` (`en` and `am`): theme toggle, deposit, tomorrow, featured,
      top leagues, market filter names, jackpot promo line
- [ ] **Open:** native-speaker review of the new Amharic wording (as for the rest of `am/`):
      `common.theme.*`, `common.header.deposit`, `sportsbook.list.tomorrow|featured`,
      `sportsbook.leagues.top`, `sportsbook.markets.filter.*`, `account.jackpot.promo.jackpot`
- [ ] **Open:** Oromo (`om/`) and Tigrinya (`ti/`) show the English text for the new keys

### 6. Other pages on the new tokens

- [x] Login, register, jackpot, help, competition and leagues pages checked in the dark theme
- [ ] **Open:** signed-in screens (account, KYC, limits, security, wallet, deposit, withdraw,
      My Bets, bet detail, cash-out sheet, self-exclusion) are covered by the end-to-end tests but
      have not been looked at screen by screen in both themes
- [ ] **Open:** the back office (`apps/admin`) is untouched and still has the old look

### 7. Verification

- [x] `pnpm lint`, `pnpm typecheck`, web unit tests (201 pass), i18n tests
- [x] New unit tests: league grouping, market category, monogram, relative day label, theme cookie
- [x] Screenshots: phone and desktop, dark and light, Amharic and English
- [x] Page weight against a production build: **158.4 KB** (budget 160 KB, target 150 KB; the
      previous UI is about 153 KB on the same data)
- [ ] **Open:** bring the page weight back toward 150 KB (see "Page weight" below)
- [ ] **Open:** end-to-end tests for the new behaviour itself (theme toggle keeps its choice,
      market filter chips, docked betslip on a desktop viewport; the suite runs a phone profile only)

### 8. Docs: done

- [x] `apps/web/README.md` (layout, frame, tokens, themes, weight) and the budget spec's comment

## Page weight

The first home load is 158.4 KB transferred, 5.4 KB more than the previous UI on the same data:
about 3 KB of HTML (sport and league links, poster, promo cards, league headers), 1.4 KB of CSS and
0.9 KB of JS (theme toggle, dock, slip bar). It passes the 160 KB test budget with 1.6 KB to spare,
so longer team names could tip it over. Ways to win it back, cheapest first:

- [ ] Show 16 rows instead of 20 on the first Highlights page (about 1.3 KB)
- [ ] Send the browser only the active locale of team and market names in list rows (the slip
      keeps both languages today); needs care with the saved slip format (about 1 to 2 KB)
- [ ] Send the `sportsbook.betslip.*` messages with the drawer instead of with every page
      (about 1.5 KB)
- [ ] Or raise the budget on purpose, with the reason written in `e2e/tests/budget.spec.ts`

## Operating mode and the DEMO banner

- [x] The DEMO banner, the header badge, the play-money line on the static pages and the payment
      notice follow the API's mode (`GET /health`, `apps/web/src/lib/api/mode.ts`): hidden only when
      the API reports `licensed`, shown in demo mode and whenever the mode cannot be read
- [ ] **Open:** check on the deployed site that `/health` reports `"mode":"licensed"`; if it says
      `demo`, the banner stays by design
- [ ] **Open:** build and test the licensed path against a stub `/health` (not done yet: the API
      refuses to start in licensed mode without a licence and real providers)
- [ ] **Open:** the Help, Terms and Responsible gambling pages still say "Vamos is a demo, all money
      is play money"; they need real licensed wording from the operator
- [ ] **Open:** the back office hides its banner with the separate build setting
      `NEXT_PUBLIC_OPERATING_MODE=licensed`

## Needs back-end work (not part of this redesign)

- [ ] A second market per list row (double chance) so rows can switch 3 Way / Double Chance
- [ ] Date filter on `GET /events` for day chips and a date picker
- [ ] Match search endpoint (team or league name) for a search drawer
- [ ] "Top matches" flag in the catalogue (today the featured poster uses the first highlight)
- [ ] Country or competition artwork (flags, crests); the redesign uses initials instead

## The shared feed (Hulusport and Nahubet)

Both sites read the same catalogue API (`api.hulusport.com`: `sport-data/coredata`,
`sport-data/matches`). Vamos does not call it: it is another operator's private API, there is no
agreement to use it, and `OPERATING_MODE=demo` only allows simulated odds. What the analysis is
used for is the **shape** of that feed (`sport → country or category → league → match`, with shared
market and outcome dictionaries), which already matches Vamos's own catalogue
(`sport → category → competition → event`), so a licensed odds provider with the same shape can be
plugged in behind `packages/feed` later without changing these screens.
