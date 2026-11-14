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
- A licensed web build (`NEXT_PUBLIC_OPERATING_MODE=licensed`) shows no DEMO banner or badge; a demo build
  shows them. Screens checked on phone and desktop, dark and light, English and Amharic.

## Not done yet (next steps, in order)

1. **End-to-end suite** (`pnpm e2e`, needs the stack: see `e2e/README.md`). Not run on the merge branch yet.
   In a Claude Code cloud container the preinstalled Chromium is newer than the pinned one: run with a
   local, uncommitted config that sets `launchOptions.executablePath: '/opt/pw-browsers/chromium'`.
   Build the web app **without** `NEXT_PUBLIC_OPERATING_MODE=licensed` for e2e (the stack's API runs in
   demo mode and the smoke spec expects the DEMO notice).
2. **Page-weight budget** (`e2e/tests/budget.spec.ts`, production build): the redesign alone measured
   158.4 KB against a 160 KB budget on the old base; re-measure on the merge branch, which has more
   home-page content (day and country chips, search).
3. **Review** the branch, then merge it into `claude/exciting-feynman-fxbdz3` when happy.
4. **Deploy** only after review. The running stack is the compose project `vamos` from
   `/opt/nahubet-new`, which is **not** a git checkout; `/opt/nahubet` is the checkout (on
   `claude/exciting-feynman-fxbdz3`, behind the remote). Build from a checkout of the reviewed branch with
   `NEXT_PUBLIC_OPERATING_MODE=licensed`, keeping `/opt/nahubet-new/infra/.env.prod`.
5. **Not confirmed:** the live API's mode. Its env file says `licensed`, but `/health` was not read
   (`wget` is missing in the container). Check with:
   `docker exec vamos-api-1 node -e 'fetch("http://localhost:4000/health").then(r=>r.text()).then(console.log)'`

## Open concerns raised with the owner (not code tasks of this branch)

- Licensed mode on the live branch has no licence-number check, only mock KYC (no real age or identity
  verification) and optional SMS verification, while real money moves through telebirr, CBE and Chapa.
- The Help, Terms and Responsible gambling pages still contain demo wording that needs licensed text.
