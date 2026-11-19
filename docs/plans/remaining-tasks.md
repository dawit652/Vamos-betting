# Remaining tasks (read this first; updated 19 Nov 2026)

Latest work: branch `claude/eager-cerf-ox9vkq` (18 Nov: it now holds `claude/happy-keller-i7cvrh`
too, merged by the first account). A new session may be given another
branch name: start it from `origin/claude/eager-cerf-ox9vkq` (or whichever is newer). It holds the server's own branch
(`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. Live
server runs `9a4e399` or the other account's later deploy; pushed and NOT deployed: everything up to
`ed60961` and this file (team logos, the whole cashier desk, the failed-login alarm X6b, rule O1h,
Next.js 16.4.5). Migrations 0056 to 0063 run on the deploy; the next free number is **0064**.
Deploy is done by the owner (PowerShell command in the last session: `ssh -t root@<server>` +
`infra/scripts/deploy-full.sh`, licensed env file `/opt/nahubet-new/infra/.env.prod`, project
`vamos`). Never touch the live server yourself; never paste secrets.

## Next, in order

0. **Agent shops (owner's interview of 19 Nov 2026):** independent agents with a prepaid balance
   sell and pay walk-in sport tickets on a printer; the admin controls every agent. Plan and the
   owner's answers: `docs/plans/agent-shops.md`. Waiting for the owner's go; phase 0 (staff screen,
   printer card) first. The mr-y request (Narobet game links) was declined on 19 Nov: it runs on the
   owner's own Narobet account and bypasses the ledger.
1. **After the owner deploys `ed60961` or later, check on live** (read-only queries, the owner runs
   them): migrations 59 + 8 applied; the Telegram PIN reset; team logos (need
   `SCRAPER_SECRET_API_FOOTBALL`; scraper log `team logos`); rule O1h (open `odds_approval` and
   `ratings_uncalibrated` fall); the X6b alarm lines (`"alarm":"login_failures_`); the cashier desk:
   add the shops, `admin-create --role cashier --shop <code>`, a test shift with a deposit.
2. **Desk PIN reset redesign** (Opus, high; security), then switch `CASHIER_PIN_RESET=on`: the code
   must only work from the player's own device. The design is in `docs/plans/cashier-dashboard.md`
   "Assisted PIN reset" (player starts on the phone, a browser secret, the cashier types the desk code
   and the ID number, a supervisor approves, only that browser sets the PIN; no code ever shown at the
   desk). Also: a per-player budget of wrong ID numbers and one identical answer for "no verified ID"
   and "wrong ID". The built parts (migration 0063, `pin-reset.ts`, the routes, the screens) stay.
3. **Half-time score missing at settlement** (owner decision needed, then Opus, money path): the
   scraper log shows `cannot result market ... (h2_btts): the half-time score is required` when
   API-Football gives no half-time score. With the factory's markets on many matches this recurs;
   those markets stay open for a person (Feed page lists the match). Options: void the half-time-
   dependent markets automatically with stakes refunded, or keep waiting for a person. Live server
   deployed `80c8a73` on 18 Nov 10:35 (67 migrations).
4. **Walk-in tickets** (cashier phase 7): waits for the owner's decision (anonymous bets at a shop
   touch KYC and licensing rules).
5. Smaller: cash limits per cashier per day (owner's numbers); a reassigned cashier's open shift is
   not closed (review note, minor).

Done on 18 Nov by the first account (no need to re-read): Next.js 16.4.5; X6b; X11 rule O1h; cashier
phases 1 (failed deposit at the desk), 3 (variance posting, migration 0062, reconciliation aware), 4
(original receipt once, 0061), 5 (uncollected cash withdrawals back after 7 days,
`CASH_WITHDRAWAL_COLLECT_DAYS`), 6 (grouped shift totals); many shops (adding shops, a shop per
cashier with 0060, every shop on one day with CSV, `--shop`); the second-model review and its fixes.

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
