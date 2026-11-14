# Handoff: redesign merged onto the live branch

Written at the end of a Claude Code session on 14 Nov 2026 so another session (or account) can continue.
Read this first, then `docs/frontend-redesign-plan.md` (the full plan, with done and open items).

## Where things are

| Branch                               | What it is                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `claude/exciting-feynman-fxbdz3`     | The live branch: what the server's checkout `/opt/nahubet` tracks. Licensed mode by default. **Not changed by this work.** |
| `claude/happy-keller-i7cvrh`         | The front-end redesign alone, built on the old base `a577587`. Superseded by the merge branch below; keep for reference.   |
| `claude/happy-keller-redesign-merge` | **Work in progress for review**: the newest live branch with the redesign merged on top. Nothing from it is deployed.      |

## What the merge branch contains

- All features of the live branch kept: search, day chips, country chips with flags, 1X2 / double chance
  switch, featured leagues, flags, price-move flash, mini slip bar with net pay, consecutive league
  grouping (`apps/web/src/components/sportsbook/groups.ts`), Nahubet branding.
- **Licensed mode kept as on the live branch:** the build-time switch `IS_DEMO`
  (`apps/web/src/lib/mode.ts`, from `NEXT_PUBLIC_OPERATING_MODE`) hides the DEMO banner, badge and
  static-page notice in a licensed build. `apps/web/scripts/licensed-static.mjs` is unchanged. The
  operating-mode guard in `packages/config` was not touched.
- The redesign on top: dark/light theme (`vamos_theme` cookie), three-column desktop with the betslip
  docked on the right (`BetslipDock`), `SportsbookFrame` (sport and league links), league cards, featured
  poster, promo cards, pill tabs, event page market filter chips (CSS only).
- One test fix outside the web app: `packages/db/test/scrape-events.test.ts` bets at the fixtures' clock
  (`now: T0`); it failed on the live branch too because its fixed kick-off date (8 Nov 2026) is now past.

## Verified on the merge branch

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: pass.
- `pnpm test` (all 13 packages, including the Postgres integration tests of db, api, worker, scraper): pass.
- `pnpm e2e`: **10 of 15 pass, 5 fail** (see below).
- A licensed web build (`NEXT_PUBLIC_OPERATING_MODE=licensed`) shows no DEMO banner or badge; a demo build
  shows them. Screens checked on phone and desktop, dark and light, English and Amharic.

## End-to-end run on the merge branch (14 Nov 2026): 10 passed, 5 failed

Run against the e2e stack (demo web build, Pixel 5 profile). Passed: admin sign-in, bet flow (register,
top up, 3-leg multi, settled), SMS channel, compliance, feed review, live cash-out, smoke (3), SMS rail.

Failed, to fix before merging into the live branch:

| Spec                                               | What happened                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.spec.ts:95` (finance approves a withdrawal) | Click on "Withdraw ETB 5,000.00" times out: first the provider `<select id="withdraw-provider">` subtree, then a bottom-nav link (`/my-bets`) "intercepts pointer events". |
| `payments-flow.spec.ts:107`                        | Same as above, same button.                                                                                                                                                |
| `channels.spec.ts:138` (USSD phone emulator)       | Click on the emulator's "Call" button times out: its own `<section>`, then the bottom-nav link `/account`, intercept the click.                                            |
| `jackpot.spec.ts:47`                               | A jackpot pick button never turns `aria-pressed="true"` (`e2e/support/ui.ts:25`); most likely the same intercepted click.                                                  |
| `budget.spec.ts`                                   | First home load 162.4 KB, over the 160 KB budget (JS 132.3, HTML 20.7, CSS 7.6). The live branch's own chips and search plus the redesign.                                 |

Leads for the click failures (none confirmed):

- The redesign moved the bottom navigation into the header (`apps/web/src/components/shell/MainNav.tsx`,
  `fixed inset-x-0 bottom-0`, inside the `sticky top-0 z-30` wrapper in `app/layout.tsx`). On the old
  redesign base all 16 specs passed, but there the withdraw page had one payment provider (no `<select>`);
  the live branch's stack runs `PAYMENT_PROVIDERS=mock,sms`, so the `<select>` and the new payout/transfer
  panels are new to the redesign. First check: run `payments-flow.spec.ts` against a web build of plain
  `claude/exciting-feynman-fxbdz3` to see whether the failures exist there too.
- If they are new: compare the withdraw page with the old `BottomNav` placement (rendered after `<main>`,
  outside the sticky wrapper); check `scroll-padding-bottom` on `html` equal to the nav height so elements
  scrolled into view are not left under the fixed bar; check that no element of the form overlaps the
  submit button (the `<select>` interception).
- Budget: the cheapest wins are in `docs/frontend-redesign-plan.md` ("Page weight"); or raise the budget
  on purpose, with the reason written in `e2e/tests/budget.spec.ts`.

## Not done yet (next steps, in order)

1. **Fix the 5 e2e failures above** and rerun `pnpm e2e` until all specs pass. In a Claude Code cloud
   container the preinstalled Chromium is newer than the pinned one: run with a local, uncommitted config
   that sets `launchOptions.executablePath: '/opt/pw-browsers/chromium'` (and `trace: 'off'`). Build the
   web app **without** `NEXT_PUBLIC_OPERATING_MODE=licensed` for e2e (the stack's API runs in demo mode
   and the smoke spec expects the DEMO notice). Start: `pnpm services:start`, `pnpm db:migrate`,
   `pnpm db:seed`, `e2e/scripts/stack.sh build`, `e2e/scripts/stack.sh start`.
2. **Review** the branch, then merge it into `claude/exciting-feynman-fxbdz3` when happy.
3. **Deploy** only after review. The running stack is the compose project `vamos` from
   `/opt/nahubet-new`, which is **not** a git checkout; `/opt/nahubet` is the checkout (on
   `claude/exciting-feynman-fxbdz3`, behind the remote). Build from a checkout of the reviewed branch with
   `NEXT_PUBLIC_OPERATING_MODE=licensed`, keeping `/opt/nahubet-new/infra/.env.prod`.
4. **Not confirmed:** the live API's mode. Its env file says `licensed`, but `/health` was not read
   (`wget` is missing in the container). Check with:
   `docker exec vamos-api-1 node -e 'fetch("http://localhost:4000/health").then(r=>r.text()).then(console.log)'`

## Open concerns raised with the owner (not code tasks of this branch)

- Licensed mode on the live branch has no licence-number check, only mock KYC (no real age or identity
  verification) and optional SMS verification, while real money moves through telebirr, CBE and Chapa.
- The Help, Terms and Responsible gambling pages still contain demo wording that needs licensed text.
