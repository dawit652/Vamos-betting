# Handoff

## Start here (16 Nov 2026, evening)

**Working branch:** `claude/eager-cerf-ox9vkq` (pull request 5 to the default branch, not merged: ask the
owner first). It holds the redesign, the "scale and payments" work and the owner's requests of 16 Nov.
**The ordered list of what is left, with the model and effort for each, is section 9 of
[`docs/plans/scale-and-payments-handover.md`](docs/plans/scale-and-payments-handover.md)**; its section 0
is the prompt to paste into a new session.

**On the branch, not deployed yet:** registration without a date of birth; flags on every league;
the Leagues tab ordered (top leagues, Ethiopia, international, countries A to Z); a Hulusport-style
left column on wide screens; match rows that count options ("64+", about "650+" with the market
factory on); a **4-digit player PIN**, login limits per number (6 per 15 minutes, 15 per day) and
players staying signed in until they sign out (trade-offs in `docs/deployment.md`, "Player sign-in");
the SMS rail per collection account (B2a to B2d, migration 0053), the `sms_credits` reconciliation check
and re-read of unread SMS (B6, migration 0054), the float forecast alarm (C10), worker metrics,
catalogue cache, live streams on their own processes and web replicas (opt-in overlays).

**To deploy it (the owner, at the server):**

1. Put the server's own changes on GitHub first (they exist only in `/opt/nahubet-live-save`, branch
   `live/nahubet-new-2026-11-15`, and the server's GitHub key is read-only): on the server,
   `git -C /opt/nahubet-live-save show --stat --oneline HEAD` (no `.env` file or key may be in it) and
   `git -C /opt/nahubet-live-save bundle create /root/nahubet-live.bundle live/nahubet-new-2026-11-15`;
   copy it to the PC with `scp`, `git fetch` the bundle into the PC's clone and `git push origin
live/nahubet-new-2026-11-15`. A session then merges it into the working branch (handover section 9,
   code task 1) so the deploy keeps the server's settings.
2. For about 500 options per match, add `SCRAPER_FACTORY_MARKETS=on` and `FEATURE_FACTORY_MARKETS=true`
   to `/opt/nahubet-new/infra/.env.prod`, and after the deploy switch "Market factory markets" on per
   league in the back office (Feed).
3. For the **Telegram bot**, create it with @BotFather and add `TELEGRAM_BOT_TOKEN=...` to the env file
   (then `/id` in the bot gives the chat id for `TELEGRAM_OWNER_CHAT_IDS`): `docs/runbooks/telegram-bot.md`.
4. Deploy the whole stack with `infra/scripts/deploy-full.sh` (command below in "Continue here"): it keeps
   the licensed env file, the compose project `vamos` and its volumes, dumps the database first and
   puts the previous images back if the smoke test fails.

The sections below are the history of the earlier sessions (14 and 15 Nov); where they disagree with
this one, this one is newer.

# History: redesign merged onto the live branch

Written at the end of a Claude Code session on 14 Nov 2026 so another session (or account) can continue.
Read this first, then `docs/frontend-redesign-plan.md` (the full plan, with done and open items).

## Scale and payments: a separate stream (15 Nov 2026)

A plan for 10,000 people at a time and for deposits and withdrawals without manual work is on branch
`claude/eager-cerf-ox9vkq` (the default branch plus a dark and light theme for the back office). Start
from [`docs/plans/scale-and-payments-handover.md`](docs/plans/scale-and-payments-handover.md): it has
the prompt to paste into a new session, the setup and the ordered tasks. Nothing of that plan is built
yet, and it touches neither the server nor the deploy steps below.

## Continue here (updated 15 Nov 2026, afternoon)

**Branch:** the default branch (`claude/quirky-ramanujan-xb7e2u`) is the latest: PR #3 merged it on 15 Nov
(CI green). Work continues on `claude/happy-keller-redesign-v030` and reaches the default branch by pull
request once CI passes (see "Branches" in README.md).

**Done on the branch, not deployed yet** (the server still runs the web app of `e56c80a`):

- **Registration without a date of birth** (`acb37cf`): the form asks phone, password and the 21+ and
  terms checkbox; KYC still checks the age on the ID. Needs the **API and migration 0052**
  (`users.date_of_birth` nullable). `deploy-web.sh` refuses a web-only deploy of it on purpose: an older
  API refuses sign-ups without a date, so registration would break.
- **Flags per league and competition** (`28d28e8`): England, Scotland, Wales, UEFA (EU), CAF, CONMEBOL,
  CONCACAF, AFC, FIFA and friendlies; web only.
- **"Starts within" 1h / 3h / 6h / 12h / 24h chips** at the top of the lists (`f4cc732`): new
  `startsWithinHours` on `GET /events`; the web also cuts the window itself, so it works with the
  older API too.

**Next, in order** (model and effort as in CLAUDE.md):

1. **Bring the server's own changes into git** (Opus, high: review). They exist only on the server, as
   commit `ce7761b` on branch `live/nahubet-new-2026-11-15` in `/opt/nahubet-live-save` (the Hulusport
   board in the scraper and its compose settings). The server's GitHub key is read-only: pack it with
   `git bundle create /root/nahubet-live.bundle 661763f..live/nahubet-new-2026-11-15`, copy it with
   `scp`, check it for secrets and large files, push it, and merge it into this branch.
2. **Full-stack deploy** (Opus, high: migrations 0047 to 0052 run, money path) with
   `infra/scripts/deploy-full.sh` (on the default branch), from the server's checkout:
   `cd /opt/nahubet && git fetch origin <branch> && bash <(git show origin/<branch>:infra/scripts/deploy-full.sh) <branch> /opt/nahubet-new/infra/.env.prod vamos`.
   It refuses a non-licensed env file, a dirty checkout, and any setting of the live compose file
   the branch lacks (the server-only Hulusport lines, until step 1 is done). It dumps the database
   (`infra/scripts/backup.sh dump`, to `/root/vamos-backups`), tags the running images, builds and
   starts the stack (the migrate job first), smoke-tests it, and puts the previous images back if
   anything fails. The migrations from v0.2.0 on are additive, so the previous images keep working
   after a rollback. If the server's own changes contain a migration, check its number against
   0047 to 0052 first. The whole stack includes the web app, so no separate web deploy is needed.
3. **About 500 options per match** (Sonnet, medium, after step 2): already built in v0.3.0 (the market
   factory prices 587 to 635 options per match from the odds feed data); switch it on with
   `SCRAPER_FACTORY_MARKETS=on` and `FEATURE_FACTORY_MARKETS=true` in the env file and the "Market
   factory markets" switch per league in the back office. Amharic labels of the factory markets are
   still missing (docs/plans/hulusport-parity-progress.md, task 2.4).
4. **Confirm the live API's mode** (Haiku, low): `docker exec vamos-api-1 node -e
'fetch("http://localhost:4000/health").then(r=>r.text()).then(console.log)'`.
5. **Licensed texts** for Help, Terms and Responsible gambling (they still say demo), and a
   native-speaker review of the new Amharic texts (Sonnet, medium).

## Deployed (15 Nov 2026, 05:00 server time)

The **web app only** of `claude/happy-keller-redesign-v030` (`e56c80a`) runs on the server, deployed with
`infra/scripts/deploy-web.sh` into the compose project `vamos`, built with `/opt/nahubet-new/infra/.env.prod`
(licensed). The container came up healthy and the script found no DEMO banner. The api, worker, admin,
scraper and database still run the older code (release v0.2.0 plus the server's local changes).
`/opt/nahubet` is now checked out at that commit (detached HEAD). The previous web image is kept as
`vamos-web:before-20261115-050057`; to go back:

```bash
docker tag vamos-web:before-20261115-050057 vamos-web:local
cd /opt/nahubet && COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=/opt/nahubet-new/infra/.env.prod \
  COMPOSE_PROJECT_NAME=vamos docker compose up -d --no-deps --force-recreate web
```

The server's uncommitted changes are committed on the server as `ce7761b` (branch
`live/nahubet-new-2026-11-15` in `/opt/nahubet-live-save`) but **not pushed**: the server's GitHub key is
read-only. Next: bring it over as a git bundle, review it for secrets and large files, push it.

## Where things are (updated 15 Nov 2026)

| Branch                               | What it is                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude/happy-keller-redesign-v030`  | **Deploy this one.** Release v0.3.0 (`claude/fervent-bardeen-axglt2`) with the redesign merged on top. Its web app also works with an older API (v0.3.0's new market fields are optional). |
| `claude/happy-keller-redesign-merge` | The redesign on `claude/exciting-feynman-fxbdz3` (before v0.2.0 and v0.3.0). Superseded by the v030 branch.                                                                                |
| `claude/fervent-bardeen-axglt2`      | Release v0.3.0. Not changed by this work.                                                                                                                                                  |
| `claude/happy-keller-i7cvrh`         | The redesign alone on the old base `a577587`. Reference only.                                                                                                                              |

**What the server runs.** The compose project `vamos` was started from `/opt/nahubet-new`, which is not a
git checkout. Its compose file matches **release v0.2.0** (`661763f`) plus three lines that are on no branch
(`SCRAPER_HULUSPORT_URL`, `SCRAPER_HULUSPORT_INTERVAL_SECONDS` and their comment): **local, uncommitted
changes that exist only on the server.** Back that folder up before anything else, e.g.
`tar czf /root/nahubet-new-$(date +%F).tgz --exclude=node_modules --exclude=.next /opt/nahubet-new`, and
commit those changes to a branch. `/opt/nahubet` is a git checkout (`claude/exciting-feynman-fxbdz3`, behind).

## What the redesign branches contain

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
- `pnpm e2e`: **all 18 specs pass**, including the page-weight budget (159.5 KB of 160 KB on the v030 branch).
- A licensed web build (`NEXT_PUBLIC_OPERATING_MODE=licensed`) shows no DEMO banner or badge, in English
  and Amharic; a demo build shows them. Screens checked on phone and desktop, dark and light.

## Fixed on 15 Nov 2026

- **Clicks under the bottom bar (4 e2e specs).** The signed-in header was wider than a phone (the live
  branch's search button plus the redesign's theme toggle), so mobile browsers widened the page and
  shifted it under the fixed bottom navigation. On phones the theme toggle is now in the footer, the
  DEMO badge gives way to the DEMO banner, the balance pill drops the "ETB" label; the page fits at
  320, 360 and 393 px.
- **Page-weight budget.** 159.5 KB on the v030 branch (budget 160 KB; the live branch alone is about 157.6 KB): the
  betslip's own texts (`sportsbook.betslip.*`) now come with the betslip's lazy code
  (`@vamos/i18n/betslip`) instead of every page, the first home page lists 12 matches (was 20; "Next page" shows the rest), and an
  unused style went. Only 0.5 KB of room is left: new home-page content has to pay for itself.

## Deploying (licensed mode, web app only)

`infra/scripts/deploy-web.sh` (on this branch) updates only the `web` service of the running compose
project, built with the live env file, so the licensed setting stays. It refuses a non-licensed env
file or a dirty checkout, stops when the compose file differs from the live one, tags the running
image first, checks the new page shows no DEMO banner, and rolls back by itself if the container is
unhealthy. The database, api, worker, admin and scraper are not touched. On the server:

```bash
cd /opt/nahubet && git fetch origin claude/happy-keller-redesign-v030
ALLOW_COMPOSE_DIFF=1 bash <(git show origin/claude/happy-keller-redesign-v030:infra/scripts/deploy-web.sh) \
  claude/happy-keller-redesign-v030 /opt/nahubet-new/infra/.env.prod vamos
```

The compose difference it prints (and allows) is expected: v0.3.0's new settings (owner alerts, factory
markets, price expiry) and the server's own Hulusport-board lines. None of them belong to the `web`
service, the only one recreated.

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
