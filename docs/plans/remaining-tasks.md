# Remaining tasks (read this first; updated 19 Nov 2026)

Latest work: branch `claude/eager-cerf-ox9vkq`. A new session may be given another branch name:
start it from `origin/claude/eager-cerf-ox9vkq` (or whichever is newer). It holds the server's own
branch (`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. The live
server runs `80c8a73` (deployed 18 Nov, migrations up to 0063). Pushed and NOT deployed: the
receipt printer card (`df646e4`), the Staff screen (`ac8a780`) and agent shops phase 1a (`dce8e5d`
database and API, `80c103e` the Agents pages and staff phones; docs `8d12201`). Migration `0064_agents` runs on the next deploy (every
existing shop becomes a shop of agent 1000 "Nahubet HQ", numbered 1000-01...); the next free
number is **0065**. Deploy is done by the owner (`ssh -t root@<server>` +
`infra/scripts/deploy-full.sh`, licensed env file `/opt/nahubet-new/infra/.env.prod`, project
`vamos`). Never touch the live server yourself; never paste secrets.

## Next, in order

0. **Agent shops** (owner's interview and "build it", 19 Nov 2026). The plan, the owner's answers
   and the status of every phase: `docs/plans/agent-shops.md` (read its "Phases" first). Built:
   phase 0 (Staff screen, printer card) and phase 1a (agents numbered from 1001 with the owner's
   name and phone, shops numbered `1001-01` under their agent, a phone for every new cashier, the
   Agents pages, blocking an agent; player cash at an independent agent's shop is refused until
   phase 2). **Next: phase 1b** (agent owner accounts, shop devices approved by an admin, the shop
   app `apps/shop` at shop.nahubet.com; the owner must add that DNS record), then phases 2 to 4
   (agent balance, selling tickets, paying tickets: the money path, Opus high effort), 5 (live
   monitor, alerts, weekly commission) and 6 (Android POS once the owner picks a model). The mr-y
   request (Narobet game links) was declined on 19 Nov: it runs on the owner's own Narobet account
   and bypasses the ledger.
1. **After the owner deploys the next build, check on live** (read-only queries, the owner runs
   them; `80c8a73` was deployed and checked on 18 Nov: 67 migrations, the team-logos task
   registered): migration 0064 applied (`SELECT number, name FROM agents` shows 1000 Nahubet HQ);
   the Staff and Agents pages open for an admin; add an agent, its shop and a cashier with a phone;
   a test shift with a deposit at an HQ shop; team logos after their 6-hour run (scraper log `team
logos`); the X6b alarm lines (`"alarm":"login_failures_`).
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
