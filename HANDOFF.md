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

## Verified on the merge branch (15 Nov 2026)

- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: pass.
- `pnpm test` (all 13 packages, including the Postgres integration tests of db, api, worker, scraper): pass.
- `pnpm e2e`: **all 18 specs pass**, including the page-weight budget (159.8 KB of 160 KB).
- A licensed web build (`NEXT_PUBLIC_OPERATING_MODE=licensed`) shows no DEMO banner or badge, in English
  and Amharic; a demo build shows them. Screens checked on phone and desktop, dark and light.

## Fixed on 15 Nov 2026

- **Clicks under the bottom bar (4 e2e specs).** The signed-in header was wider than a phone (the live
  branch's search button plus the redesign's theme toggle), so mobile browsers widened the page and
  shifted it under the fixed bottom navigation. On phones the theme toggle is now in the footer, the
  DEMO badge gives way to the DEMO banner, the balance pill drops the "ETB" label; the page fits at
  320, 360 and 393 px.
- **Page-weight budget.** 159.8 KB (budget 160 KB; the live branch alone is about 157.6 KB): the
  betslip's own texts (`sportsbook.betslip.*`) now come with the betslip's lazy code
  (`@vamos/i18n/betslip`) instead of every page, the first home page lists 15 matches (was 20), and an
  unused style went. Only 0.2 KB of room is left: new home-page content has to pay for itself.

## Deploying (licensed mode, web app only)

`infra/scripts/deploy-web.sh` (on this branch) updates only the `web` service of the running compose
project, built with the live env file, so the licensed setting stays. It refuses a non-licensed env
file or a dirty checkout, stops when the compose file differs from the live one, tags the running
image first, checks the new page shows no DEMO banner, and rolls back by itself if the container is
unhealthy. The database, api, worker, admin and scraper are not touched. On the server:

```bash
cd /opt/nahubet && git fetch origin claude/happy-keller-redesign-merge
bash <(git show origin/claude/happy-keller-redesign-merge:infra/scripts/deploy-web.sh) \
  claude/happy-keller-redesign-merge /opt/nahubet-new/infra/.env.prod vamos
```

## Next steps

1. Review the branch; merge it into `claude/exciting-feynman-fxbdz3` when happy.
2. Deploy with the command above (or after the merge, with `claude/exciting-feynman-fxbdz3`).
3. Confirm the live API's mode, which was never read directly (`wget` is missing in the container):
   `docker exec vamos-api-1 node -e 'fetch("http://localhost:4000/health").then(r=>r.text()).then(console.log)'`
4. Native-speaker review of the new Amharic texts; licensed wording for Help, Terms and Responsible
   gambling (they still say demo).

Running e2e in a Claude Code cloud container: the preinstalled Chromium is newer than the pinned one,
so use a local, uncommitted Playwright config with `launchOptions.executablePath:
'/opt/pw-browsers/chromium'`, and build the web app without `NEXT_PUBLIC_OPERATING_MODE=licensed` (the
e2e stack's API runs in demo mode and the smoke spec expects the DEMO notice).

## Open concerns raised with the owner (not code tasks of this branch)

- Licensed mode on the live branch has no licence-number check, only mock KYC (no real age or identity
  verification) and optional SMS verification, while real money moves through telebirr, CBE and Chapa.
- The Help, Terms and Responsible gambling pages still contain demo wording that needs licensed text.
