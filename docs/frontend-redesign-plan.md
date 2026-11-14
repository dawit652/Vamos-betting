# Player app redesign: plan and remaining tasks

Redesign of `apps/web` (the player PWA), using the best ideas from the Hulusport front-end
analysis and Vamos's own rules (demo mode, no casino games, 150 KB page-weight budget,
server-rendered lists, Amharic first).

**Status key:** `[x]` done · `[~]` in progress · `[ ]` not started

_Last updated: 14 Nov 2026, third working session (day chips, double chance rows, match search,
top matches, signed-in screens checked, back office on the new palette). Anything not ticked below
is still to do; the open items are marked **Open**._

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
| 3 Way / Double Chance toggle on list rows                   | **Taken.** A link switch (`?market=dc`) on football lists; one market per row at a time     |
| Day chips and a date picker                                 | **Taken** as chips for today and the next six days on the Today tab; no free date picker    |
| Country filter dropdown, match search                       | **Search taken** (`/search`: team, league or Game ID). No country dropdown: the league list |
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
      `sportsbook.leagues.top`, `sportsbook.markets.filter.*`, `account.jackpot.promo.jackpot`,
      `sportsbook.controls.*`, `sportsbook.search.*`
- [x] Keys of the list controls and the search page (`sportsbook.controls.*`, `sportsbook.search.*`,
      `en` and `am`); they are server-only messages, not sent to the browser
- Only Amharic and English are launched. Oromo (`om/`) and Tigrinya (`ti/`) stay prepared but
  untranslated (they show the English text, as in the rest of the app); nothing to do there now

### 6. Other pages on the new tokens

- [x] Login, register, jackpot, help, competition and leagues pages checked in the dark theme
- [x] Signed-in screens looked at one by one in both themes on a phone (account, KYC, limits,
      security, self-exclusion, wallet, deposit, withdraw, My Bets, bet detail, cash-out sheet,
      betslip and placed bet, jackpot, the demo phone and SMS/USSD simulators, password reset,
      verify, terms, privacy, responsible gambling): nothing assumed a white background, no fix needed
- [x] The back office (`apps/admin`) uses the same palette: dark by default, a light theme behind a
      switch in the sidebar (`vamos_admin_theme` cookie, `<html data-theme>`)

### 7. Verification

- [x] `pnpm lint`, `pnpm typecheck`, web unit tests (201 pass), i18n tests
- [x] New unit tests: league grouping, market category, monogram, relative day label, theme cookie
- [x] Screenshots: phone and desktop, dark and light, Amharic and English
- [x] Page weight against a production build: **156.8 KB** (budget 159 KB, target 150 KB; the
      previous UI is about 153 KB on the same data)
- [ ] **Open:** bring the page weight back toward 150 KB (see "Page weight" below)
- [x] End-to-end tests for the new behaviour itself (`e2e/tests/redesign.spec.ts`): the theme switch
      keeps its choice over a reload, market filter chips, slip bar and drawer on a phone (English
      and Amharic text), docked betslip on a desktop viewport, day chips, double chance rows,
      search, the featured poster of a top match

### 8. Docs: done

- [x] `apps/web/README.md` (layout, frame, tokens, themes, weight) and the budget spec's comment

## Page weight

The first home load was 158.4 KB transferred after the redesign, 5.4 KB more than the previous UI on
the same data: about 3 KB of HTML (sport and league links, poster, promo cards, league headers),
1.4 KB of CSS and 0.9 KB of JS (theme toggle, dock, slip bar). Loading the betslip drawer's text
with the drawer brought it to 157.7 KB; the list controls and the search link then added about
0.5 KB, and 16 rows on the first Highlights page took 1.4 KB off: **156.8 KB**. The test budget is
now 159 KB. The rest of the gap to 150 KB is JavaScript (130.8 KB, of which about 110 KB is the
React and Next runtime), not page content. What was tried or is left:

- [x] Show 16 rows instead of 20 on the first Highlights page (1.4 KB measured); other tabs and
      pages keep 20
- [ ] Send the browser only the active locale of team and market names in list rows (the slip
      keeps both languages today); needs care with the saved slip format. Looked at on 14 Nov:
      the repeated names compress well, so expect well under 1 KB, and a saved slip would no
      longer follow a language switch
- [x] Send the drawer-only `sportsbook.betslip.*` messages with the drawer instead of with every
      page: 0.7 KB measured on the same data (0.8 KB of HTML less, 0.1 KB of JS more). The keys other
      screens reuse (errors, total odds) stay in the page (`SHARED_BETSLIP_KEYS`)
- [ ] **Open:** the remaining 6.8 KB. It needs less client JavaScript on the home page (for
      example the odds buttons without the live-stream code until a match is live), or accepting
      157 KB as the target for this design

## Back-end work

- [x] Double chance on list rows: `GET /events?market=dc` returns the double chance market as the
      row market of football events (one market per row, so the page weight does not grow)
- [x] Date filter: `GET /events?date=YYYY-MM-DD` (an Addis Ababa calendar day)
- [x] Match search: `GET /events/search?q=` (team, competition or Game ID; English or Amharic;
      live or starting within 14 days; every sport)
- [x] Top matches: `events.top_match` (migration 0032), `GET /events?filter=top`, and
      `POST /admin/trading/events/:id/top` (trading.status, audited) with a button on the back
      office's event page. The featured poster shows the soonest top match, else the first highlight
- [ ] **Open:** country or competition artwork (flags, crests). It needs artwork Vamos has the
      right to use; the app shows initials until then

## The shared feed (Hulusport and Nahubet)

Both sites read the same catalogue API (`api.hulusport.com`: `sport-data/coredata`,
`sport-data/matches`). Vamos does not call it: it is another operator's private API, there is no
agreement to use it, and `OPERATING_MODE=demo` only allows simulated odds. What the analysis is
used for is the **shape** of that feed (`sport → country or category → league → match`, with shared
market and outcome dictionaries), which already matches Vamos's own catalogue
(`sport → category → competition → event`), so a licensed odds provider with the same shape can be
plugged in behind `packages/feed` later without changing these screens.
