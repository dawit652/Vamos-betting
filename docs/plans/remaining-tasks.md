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

1. **After the owner deploys `16c58bb` or later, check on live** (read-only queries, owner runs them):
   the Telegram PIN reset (fix `313271b`); team logos (need `SCRAPER_SECRET_API_FOOTBALL`; the
   scraper logs `team logo download failed` / `team logos skipped`); rule O1h (open
   `odds_approval` and `ratings_uncalibrated` items fall, locked matches with a fresh Hulusport
   board open in leagues with "Auto open" on); the X6b alarm lines (`"alarm":"login_failures_`).
2. **Cashier dashboard, next phases** (`docs/plans/cashier-dashboard.md` "Next phases"; money path:
   Opus high, reviewed by a second model): 1 failed automatic deposit (done 18 Nov), 2 assisted PIN reset with ID
   check and four eyes (in progress: database and API done, screens next), 3 variance posting into the ledger (done 18 Nov, migration 0062: a shop loss or gain on
   `house:cash_variance`), 4 original receipt printed once (done 18 Nov, migration
   0061; the next free number is 0063), 5 uncollected approved cash withdrawals (done 18 Nov: 7 days, `CASH_WITHDRAWAL_COLLECT_DAYS`), 7 walk-in
   tickets (owner decision). Phase 6 (grouped shift totals) is done, and many shops (the owner runs
   more than 40: adding shops, a shop per cashier with migration 0060, every shop on one day) is
   built: `docs/plans/cashier-dashboard.md` "As built (18 Nov 2026): many shops".
3. Done on 18 Nov (first account): Next.js 16.4.5 (CI green again), X6b failed-login alarm, X11
   rule O1h (locked odds), grouped shift totals; `claude/happy-keller-i7cvrh` merged into this
   branch.

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
