# Player app redesign: plan and remaining tasks

Redesign of `apps/web` (the player PWA), using the best ideas from the Hulusport front-end
analysis and Vamos's own rules (demo mode, no casino games, 150 KB page-weight budget,
server-rendered lists, Amharic first).

**Status key:** `[x]` done · `[~]` in progress · `[ ]` not started

_Last updated: 14 Nov 2026, during the first working session. This file is updated as work lands;
anything not ticked below is still to do._

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

### 1. Foundation

- [x] New design tokens in `apps/web/src/app/globals.css`: dark default, light override, `raised`
      and `chrome` colours, poster cards, crests, tags, live dot, panel, CSS-only market filter
- [x] Theme cookie (`vamos_theme`) in `src/lib/cookies.ts`, rendered as `<html data-theme>`
- [x] `ThemeToggle` in the header

### 2. Shell

- [x] Header: logo, desktop nav links, theme and language toggles, balance pill with deposit shortcut
- [x] Bottom nav restyled (phones only), shared nav items with the desktop header links
- [x] DEMO banner restyled (kept permanent, still the page's only `role="note"`)
- [x] Footer card
- [~] Root layout: wide `<main>`; account and static pages keep a narrow column
- [ ] Remove the now-unused `sportFromPath` helper and its test

### 3. Sportsbook pages

- [ ] `SportsbookFrame`: sport rail with counts, desktop sidebar (sports, leagues), betslip column
- [ ] Sport home: featured-match poster, promo cards, pill tabs, top-leagues rail
- [ ] Match list: league groups (collapsible), new rows, "Today / Tomorrow" kick-off labels
- [ ] Odds buttons: new tiles, wide variant for two-way markets, price colouring
- [ ] Event page: poster header with crests and score, market filter chips, market cards
- [ ] Competition page header, live list, loading skeleton

### 4. Betslip

- [ ] Slip bar (count + total odds) replacing the floating button
- [ ] Drawer restyle (legs, stake with ETB prefix, quick stakes, summary, placed state)
- [ ] Docked betslip column on wide screens (loads only on wide screens)

### 5. Text and translations

- [ ] New keys in `packages/i18n` (`en` and `am`): theme toggle, deposit, tomorrow, featured,
      top leagues, market filter names, jackpot promo line
- [ ] Amharic wording of the new keys needs a native-speaker review (as the rest of `am/` does)

### 6. Other pages on the new tokens

- [ ] Check account, wallet, deposit, withdraw, My Bets, jackpot, auth forms and static pages in
      both themes; fix anything that assumed a white background

### 7. Verification

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`
- [ ] New unit tests: league grouping, market category, relative day label, theme cookie
- [ ] `pnpm e2e` (Pixel 5 profile): bet flow, smoke, live cash-out, payments, jackpot
- [ ] Page-weight budget against a production build (`e2e/tests/budget.spec.ts`, 150 KB target)
- [ ] Screenshots: phone and desktop, dark and light, Amharic and English

### 8. Docs

- [ ] Update `apps/web/AGENTS.md` and `apps/web/README.md` (layout, tokens, theme, frame)

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
