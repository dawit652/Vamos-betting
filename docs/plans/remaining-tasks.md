# Remaining tasks (read this first; updated 18 Nov 2026)

Latest work: branch `claude/eager-cerf-ox9vkq` (18 Nov: it now holds `claude/happy-keller-i7cvrh`
too, merged by the first account). A new session may be given another
branch name: start it from `origin/claude/eager-cerf-ox9vkq` (or whichever is newer). It holds the server's own branch
(`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. Live
server runs `47c3126`; pushed and not yet deployed: team logos, cashier desk phases 1 and 2
(migrations 0056 to 0059 run on deploy), and on 18 Nov the failed-login alarm (X6b), rule O1h
(locked odds) and Next.js 16.4.5 (`0998108`).
Deploy is done by the owner (PowerShell command in the last session: `ssh -t root@<server>` +
`infra/scripts/deploy-full.sh`, licensed env file `/opt/nahubet-new/infra/.env.prod`, project
`vamos`). Never touch the live server yourself; never paste secrets.

## Next, in order

1. **Check the Telegram PIN reset after the owner deploys `c14e2c9`** (fix: a website "Send code"
   no longer kills the Telegram code, `apps/api/src/lib/otp.ts`). If the owner's number hit the
   10 wrong codes a day budget, it clears 24 h after the first wrong try.
2. **Team logos: check on live after the owner deploys** (built 17 Nov, `docs/plans/team-logos.md`
   "As built"). Logos appear only with `SCRAPER_SECRET_API_FOOTBALL` set on the server; the
   scraper logs `team logo download failed` or `team logos skipped` when something is wrong.
3. **Cashier dashboard**: phases 1 and 2 built and reviewed by a second model (desk, shifts, cash
   deposits, cash withdrawals with a player-made shop code, receipts, player blocking; cash is the
   payment provider `cash`). Next, in order: `docs/plans/cashier-dashboard.md` "Next phases"
   (failed automatic deposit, assisted PIN reset, variance posting, original receipt once, uncollected approved cash
   withdrawals, grouped shift totals, walk-in tickets). Money path: Opus high. Owner decisions
   still open (shops, limits, printer, walk-in tickets); today's defaults are settings. On the live
   server a cashier account is made with `admin-create.js --role cashier` (deployment.md).
4. **X6b failed-login alarm: done 18 Nov** (`apps/api/src/lib/login-alarm.ts`): 60 failed player
   logins, 30 numbers, or 10 numbers from one address in 15 minutes write one `error` line with
   `alarm: login_failures_total | _numbers | _address` per window (numbers hashed). Not yet an owner
   alert (Telegram/SMS): add one in the worker's owner-alert list if the owner wants it.
5. **X11 rule O1h, locked odds: done 18 Nov** (docs/scraper.md "O1h"): uncalibrated matches with a fresh
   Hulusport board are priced entirely from the board, handed over and opened like a strong market,
   suspended when the board goes stale. After the deploy, watch `odds_approval` and
   `ratings_uncalibrated` fall; a league's "Auto open" switch decides whether F7b opens them alone.
6. **Next.js security upgrade: done 18 Nov** (16.4.5, owner's yes, `d2c5f42`); CI's dependency audit
   passes again.

## Owner decisions still open

- PIN rule: keep refusing 1111-style, 1234-style and the phone's last 4 (31 of 10,000), or allow all.
- A real SMS gateway (`SMS_PROVIDER=http`) before real players; until then PIN resets go by Telegram.
- In @BotFather `/setcommands`: add `reset - Forgot PIN` and `share - Share with friends`.
- Native-speaker review of the Amharic: `packages/core/src/amharic-names.data.ts` and the UI texts.

## Facts that save time

- Local checks: `pnpm services:start` (Postgres/Redis stop when the container restarts), then
  `e2e/scripts/stack.sh build && e2e/scripts/stack.sh start`; e2e with
  `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test <spec> --trace off`.
- Home page weight 167.4 KB, budget 168 KB (`e2e/tests/budget.spec.ts`): new UI needs room first.
- Migrations: Drizzle runs one only if its journal `when` is later than the last applied one
  (handover, "migration" notes); next free number after 0057.
- Done on 16-17 Nov (no need to re-read): Telegram bot (alerts, menu, /status, Forgot PIN,
  share), Amharic names (`amharic-names.ts`), Top leagues fixed list, competition logos, featured
  row of big matches, team flags for national teams, merged country chips, tap feedback and the
  navigation bar, relaxed PIN rule, 21+ tick box removed, team logos (17 Nov).
