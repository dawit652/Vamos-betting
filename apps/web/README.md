# @vamos/web: player app (lite PWA)

Next.js 16 (App Router, Turbopack) and React 19. Mobile first (360 px) with a three-column layout
from 1024 px, dark theme by default (light on request), Amharic by default, play money only.
The plan and open tasks of the redesign are in [`docs/frontend-redesign-plan.md`](../../docs/frontend-redesign-plan.md). Read `node_modules/next/dist/docs/` before using a Next API: v16 differs from older
versions (`cookies()`, `headers()`, `params` and `searchParams` are all async; error boundaries get
`retry`).

```bash
pnpm --filter @vamos/web dev        # :3000, needs the API on :4000 (pnpm dev starts both)
pnpm --filter @vamos/web build
pnpm --filter @vamos/web typecheck
pnpm --filter @vamos/web test       # vitest, pure helpers only (src/**/*.test.ts)
pnpm lint                           # repo ESLint covers apps/web
```

## Layout

| Path                                                             | What                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/app/layout.tsx`                                             | App shell: header (with the main nav), DEMO banner, footer, slip bar; theme       |
| `src/app/**/page.tsx`                                            | Pages. Render inside the shell's `<main>`; never add another shell                |
| `src/components/shell/*`                                         | Shell pieces (header, main nav, banner, footer, theme and locale switchers)       |
| `src/components/sportsbook/SportsbookFrame.tsx`                  | Frame of every sportsbook page: sport and league links, docked betslip column     |
| `src/components/betslip/BetslipDrawer.tsx`                       | Betslip panel: a drawer on phones (lazy, on first open), `BetslipDock` on desktop |
| `src/components/<feature>/*`                                     | Feature components (`sportsbook/`, `account/`, …)                                 |
| `src/i18n/server.ts`, `client.tsx`, `ClientMessages.tsx`         | `getT()`, `useT()`, scoped client messages                                        |
| `src/lib/api/{client,server,catalog,session,errors,idempotency}` | API access                                                                        |
| `src/lib/betslip/state.ts`, `src/providers/BetslipProvider.tsx`  | Betslip rules (pure) and store                                                    |
| `src/providers/SessionProvider.tsx`                              | Signed-in player: `useSession()`                                                  |
| `src/lib/{format,localized,routes,cookies}.ts`                   | Formatting, catalogue names, route map, cookie names                              |
| `public/`                                                        | `manifest.webmanifest`, `icons/`, `sw.js`, `offline.html`                         |

## Routes

All paths come from `routes` in `src/lib/routes.ts`; link with it instead of writing strings.

| Route                                      | Page                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `/`, `/sport/[sport]`                      | Sport home (football is `/`); tabs as `?tab=`                              |
| `/sport/[sport]/[competition]`             | Competition                                                                |
| `/live`, `/live/[sport]`                   | Live list                                                                  |
| `/event/[id]`                              | Event page (market accordions)                                             |
| `/my-bets`                                 | My Bets                                                                    |
| `/account`, `/wallet`                      | Account (KYC, limits, self-exclusion, language), wallet                    |
| `/wallet/deposit`, `/wallet/withdraw`      | Deposit (push/USSD/checkout, polled) and withdraw (rules, tracker, cancel) |
| `/dev/phone`                               | Demo-only simulated phone: approve (PIN) or decline pending pushes         |
| `/login`, `/register`, `/forgot-password`  | Auth                                                                       |
| `/help`, `/terms`, `/responsible-gambling` | Static pages                                                               |

Sports are `SPORTS` in `routes.ts` (football, basketball, tennis, volleyball).

## Layout of a sportsbook page

Every sportsbook page (sport home, live list, competition, event) wraps its content in
`<SportsbookFrame sport={…}>`; account and static pages keep a narrow column (`mx-auto max-w-2xl`).

- **Phones and tablets (below `lg`, 1024 px):** one column. The frame puts a sport rail (with match
  counts) and, on the sport home (`leagueRail`), a leagues rail above the page. The main navigation
  is the fixed bottom bar; the slip bar sits above it once the slip has picks.
- **Wide screens:** three columns: sports and leagues on the left, the page in the middle, the
  betslip docked on the right (`BetslipDock`, which loads the panel only on a wide screen). The main
  navigation moves into the header and the slip bar is hidden.

The sport and league links and the main navigation are each rendered **once** and restyled with CSS
(`.rail` in `globals.css`, `lg:` utilities in `MainNav`), so a phone never downloads a second copy.
Pass `live` on the live lists (links stay on the live side, counts are live counts) and
`competition` to highlight the league being viewed.

The sport home opens its Highlights tab with the featured-match poster (the first highlight with an
open main market) and two promo cards; lists are grouped into one collapsible card per league
(`groupByCompetition`, native `<details>`), `grouped={false}` gives a flat card. The event page
filters its market cards with radio chips and CSS only (`.market-filter`; categories come from
`marketCategory` in `components/sportsbook/events.ts`).

## Pages: server first, small client islands

- Pages and lists are **server components**. Fetch public data with `src/lib/api/catalog.ts`
  (`getSports`, `getCompetitions`, `getEvents`, `getEvent`, `getEventByGameId`) or `serverGet` /
  `serverGetOrNull` from `src/lib/api/server.ts`. They never cache (`no-store`) and time out after 5 s.
  `getEvent` returns `null` on 404: call `notFound()`.
- Typed params (`PageProps` and `LayoutProps` are generated by `next typegen`):

  ```tsx
  export default async function EventPage(props: PageProps<'/event/[id]'>) {
    const { id } = await props.params;
  }
  ```

- Only interactive parts are client components (`'use client'`): odds buttons, the betslip, forms,
  live-odds patches. Keep them small; pass them plain data, not whole API responses.
- Signed-in data (wallet, bets, profile, limits) is fetched **in the browser**: the session cookie
  belongs to the API host and may not reach this server.

## i18n (`packages/i18n`)

- Messages live in `packages/i18n/src/messages/<locale>/<namespace>.ts`, namespaces `common`,
  `sportsbook` and `account`. English (`en/`) defines the shape (the `Messages` type).
- Add a key: put it in `en/<namespace>.ts`, then the same key in `am/<namespace>.ts` (Amharic is the
  default and must be complete; the type check fails otherwise). `om/` and `ti/` are prepared but
  unreviewed: a missing key shows the English text, so adding it there is optional.
- Keys are `namespace.area.key`, e.g. `t('sportsbook.markets.more', { count: 12 })`. Placeholders are
  `{name}` and must be the same in every locale (a test checks this). No empty strings.
- Server components: `const t = await getT();` (`@/i18n/server`), also `getLocale()`.
- Client components: `const t = useT(); const locale = useLocale();` (`@/i18n/client`). The root layout
  sends the `common` and `sportsbook` namespaces to the browser. A route whose client components need
  `account` wraps them: `<ClientMessages namespaces={['account']}>{children}</ClientMessages>` (e.g.
  in `app/account/layout.tsx`, `app/(auth)/layout.tsx`). Otherwise the key itself is shown.
- The betslip drawer's own text (`sportsbook.betslip.*`, about 40% of the namespace) is not in that
  payload: it loads with the drawer, one small chunk per locale (`BetslipMessages`,
  `@vamos/i18n/betslip`). A betslip key that another screen needs (the slip bar's total odds, the
  error texts the jackpot and the API error mapper reuse) must be listed in `SHARED_BETSLIP_KEYS`
  there, or that screen shows the key itself.
- In client code import locale constants from `@vamos/i18n/locales` and `MessageKey` from
  `@vamos/i18n/translate`, never values from `@vamos/i18n` (that would ship every translation).
- The locale is the `vamos_locale` cookie (default `am`). `LocaleSwitcher` sets it, refreshes, and
  saves it to the profile when signed in. Catalogue names (`LocalizedName`) go through
  `localName(name, locale)` (`@/lib/localized`).

## Calling the API

- Browser: `api.get/post/put/patch/delete` from `@/lib/api/client`. It sends cookies
  (`credentials: 'include'`), the `x-csrf-token` header from the `vamos_csrf` cookie on unsafe methods,
  and an optional `idempotency-key`:

  ```ts
  import type { WalletResponse } from '@vamos/contracts'; // types only: no zod in the bundle
  const key = useRef(newIdempotencyKey('topup')); // one key per intent, reused on retry
  await api.post<WalletResponse>('/wallet/demo-topup', body, { idempotencyKey: key.current });
  ```

  A key must outlive whatever may unmount before the answer is known (a drawer, a page). Bet
  placement keeps its key outside the drawer (`src/lib/betslip/placement-store.ts`, module state +
  sessionStorage) until a bet comes back for it, whatever the network, the odds or the player did
  in between; `placeOnce` in `src/lib/betslip/placement.ts` explains why that rules out a double bet.

- Failures reject with `ApiClientError` (`status`, `code`, `message`, `details`; `status 0` with
  `network_error` / `timeout` when there was no answer). Show it with `t(errorMessageKey(error, overrides))`, where `overrides` maps your codes to keys,
  e.g. `{ insufficient_funds: 'sportsbook.betslip.insufficientFunds' }`. A 401 anywhere signs the session out.
- Put feature calls in your own file (`src/lib/api/betting.ts`, `src/lib/api/account.ts`) built on
  `api`, typed with `@vamos/contracts`.
- Base URL: `NEXT_PUBLIC_API_URL` (browser, inlined at build; `next.config.ts` falls back to
  `PUBLIC_API_URL`, then `http://localhost:4000`). The server uses `API_INTERNAL_URL` when set.
- Production needs the API on the same site with the cookies readable by this origin (e.g. a shared
  cookie domain or an `/api` reverse proxy): the client reads `vamos_csrf` from `document.cookie`.

## Session

`const { status, me, wallet, refresh, refreshWallet, logout } = useSession()` from
`@/providers/SessionProvider`. `status` is `loading | anonymous | authenticated`. Call `refresh()` after
login or OTP verification, and `refreshWallet()` after anything that moves money (bet placed,
demo top-up). No `vamos_csrf` cookie means anonymous without any request. `logout()` resolves `false`
when the API did not confirm it (no connection, 5xx, 403): the session is still valid then, so the
UI stays signed in and shows an error instead of a false signed-out state. When the browser has no
`vamos_locale` cookie, a signed-in player's profile language is applied.

## Money and odds

Money is a santim decimal string from the API: show it with `formatSantim(wire)` / `formatMoney(wire)`
(`@/lib/format`, built on `formatBirr`), and parse input with `parseBirr` from `@vamos/core`. Never
`Number()` or `parseFloat` money. Odds are milli integers: `formatOddsMilli(1850)` → `1.85`; total
odds strings: `formatTotalOdds`. Times: `formatTime(iso, locale)` (East Africa Time).

## Betslip store

`const slip = useBetslip()` from `@/providers/BetslipProvider`:

- Odds button: `onClick={() => { if (slip.toggle(leg) === 'limit') showLimitMessage(); }}` and
  `aria-pressed={slip.has(selection.id)}`. `toggle` adds, replaces the pick on the same event,
  removes the same selection, or returns `'limit'` at 40 legs. `leg` is a `NewSlipLeg`
  (`src/lib/betslip/state.ts`).
- Drawer: `slip.legs`, `count`, `stake` (santim string), `setStake`, `oddsChangePolicy` (default
  `higher`), `setOddsChangePolicy`, `remove`, `clear`, `updateOdds(changes)` (live prices; sets
  `previousOddsMilli`), `oddsChanged`, `acceptOddsChanges`, `replaceLegs` (booking codes),
  `isOpen` / `open()` / `close()`. `hydrated` is false until localStorage has been read.
- Saved in localStorage (`vamos_betslip_v1`), synced across tabs. The slip bar (`BetslipButton`:
  pick count and combined odds) shows when the slip has legs; the drawer component is loaded only
  when it opens. `BetslipPanel` (in `BetslipDrawer.tsx`) is the slip itself, shared by the drawer
  and the desktop dock.

## Styling

Tailwind CSS v4; tokens in `src/app/globals.css` (`@theme`): `bg-brand` (action green: links, active
states, picked odds), `bg-accent` (gold: the one call to action), `bg-page`, `bg-surface`,
`bg-raised` (one step above the surface: odds tiles, chips, inputs), `bg-chrome` / `text-chrome-ink`
(header), `text-ink`, `text-muted`, `border-line`, `text-up` / `text-down`, `text-live`, `text-xxs`,
`h-header`, `h-bottom-nav`. Shared classes: `.odds-btn` (+ `.odds-label`, `.odds-price`,
`aria-pressed`; `.odds-btn-market` and `.odds-btn-wide` on the event page), `.chip`
(`aria-current="page"`, `aria-pressed`, or a checked radio inside), `.list-row`, `.card`, `.panel`
(a card of rows), `.poster` (+ `.poster-gold`: always-dark feature cards), `.crest`, `.tag`,
`.live-dot`, `.rail`, `.btn .btn-primary|accent|outline`, `.input`, `.no-scrollbar`. Use the system
font stack (Ethiopic-capable); no web fonts, no icon fonts (sport icons are system emoji; team and
country marks are initials from `monogram`).

**Themes.** Dark is the default; the light theme overrides the same variables under
`:root[data-theme='light']`, so use the tokens and never a raw colour (the exception is content on a
`.poster`, which is always dark: `text-white/70` and the like). The choice is the `vamos_theme`
cookie (`parseTheme` in `src/lib/cookies.ts`), which the root layout renders as `<html data-theme>`,
so there is no flash on load; `ThemeToggle` in the header sets both. Check a new screen in both.

**Keep the CSS small.** Each new opacity variant (`text-white/60`), arbitrary value or one-off
responsive utility adds bytes to every first load: reuse the ones already in the file before
adding another.

## PWA

`public/manifest.webmanifest` and `public/icons/*`. `public/sw.js` caches only `/_next/static/*` and
`/icons/*`, serves `/offline.html` when a navigation fails, and never caches HTML or API responses.
It is registered in production only (`ServiceWorkerRegister`); bump `VERSION` in `sw.js` to drop old
caches.

## Weight budget and the production server

Target: ≤ 150 KB transferred on the first home load, checked by `e2e/tests/budget.spec.ts`. About
110 KB of it is the React and Next runtime even with brotli, and Next compresses with gzip only
(179 KB measured). So production runs `server.mjs` (`pnpm start`): `next start` plus brotli, with
static JS/CSS compressed once at maximum quality and kept in memory, and pages compressed at a fast
level (149.8 KB measured on 10 Oct 2026; 158.4 KB on 14 Nov 2026 after the redesign, against about
153 KB for the previous UI on the same data: the navigation with leagues, the poster and the league
headers add about 3 KB of HTML, the new styles 1.4 KB of CSS and the theme toggle, dock and slip bar
0.9 KB of JS; 157.7 KB once the betslip drawer's text moved out of the page and into the drawer's
chunk). That is over the 150 KB target and close to the 160 KB test budget, so new home-page
content has to pay for itself. Behind a CDN that does brotli itself, plain `next start` works too.
The app's own shell JS is about 10 KB. Keep new client code small (code only the drawer needs goes in
the drawer's lazy chunk), keep lists server-rendered, and avoid client-side libraries (no zod, date
libraries or icon packs in the browser). Links in view prefetch their route; use `prefetch={false}`
for rarely used links.

## Payments (`src/components/payments`, `src/lib/api/payments.ts`)

- `payments.ts` holds the pure rules (amount check in santim, idempotency keys per intent, deposit and
  withdrawal status, tracker labels, error mapping); `payments.test.ts` covers them.
- Deposit and withdraw each keep one idempotency key per intent at module level (`createIntentKeys`):
  a retry after a timeout or 5xx reuses it, a definite 4xx refusal or success clears it.
- Deposits poll `GET /payments/deposits/:id` (2 s easing to 5 s, stops after 10 min) until final, then
  `refreshWallet()`. A redirect checkout comes back to `/wallet/deposit?id=<id>`.
- Withdrawals send no phone: the API pays the registered phone only. Open ones refresh every 8 s.
- `/dev/phone` renders the simulator only when `GET /payments/options` says `demo: true`. Every payment
  screen shows the play-money notice (`account.payments.demoNotice`).
