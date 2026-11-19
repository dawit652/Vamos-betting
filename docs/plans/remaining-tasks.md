# Remaining tasks (read this first; updated 19 Nov 2026)

Latest work: branch `claude/happy-keller-i7cvrh` (19 Nov; it continues
`claude/eager-cerf-ox9vkq`). A new session may be given another branch name: start it from
whichever of the two is newer. It holds the server's own
branch (`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. The live
server runs `80c8a73` (deployed 18 Nov, migrations up to 0063). Pushed and NOT deployed: the
receipt printer card (`df646e4`), the Staff screen (`ac8a780`) and agent shops phase 1a (`dce8e5d`
database and API, `80c103e` the Agents pages and staff phones; docs `8d12201`). Migrations `0064_agents`, `0065_shop_devices`, `0066_shop_sessions`, `0067_agent_owners` and `0068_agent_balance` run on the next deploy
(every existing shop becomes a shop of agent 1000 "Nahubet HQ", numbered 1000-01...); the next
free number is **0069**. Deploy is done by the owner (`ssh -t root@<server>` +
`infra/scripts/deploy-full.sh`, licensed env file `/opt/nahubet-new/infra/.env.prod`, project
`vamos`). Never touch the live server yourself; never paste secrets.

## Next, in order

0. **Agent shops** (owner's interview and "build it", 19 Nov 2026). The plan, the owner's
   answers and every phase's design and status: `docs/plans/agent-shops.md`.
   - **Built, pushed, not deployed:** phase 0 (Staff screen `ac8a780`, printer card `df646e4`);
     phase 1a (agents numbered from 1001 with the owner's name and phone, shops `1001-01`, a phone
     for every new cashier, the Agents pages, blocking: `dce8e5d`, `80c103e`, `0a155f3`); phase 1b
     so far: shop devices an admin approves (`37636ca`), the sign-in on an approved device and
     shop sessions (`6795a21`), the `/shop` API with the desk's shifts (`7cf8186`, `680308c`), the
     shop app `apps/shop` (`e653a9c`; e2e `e2e/tests/shop-app.spec.ts`, started by
     `e2e/scripts/stack.sh`) and its production infra, off by default (`2ae3742`). Player cash at
     an independent agent's shop is refused until phase 2.
   - **Next, in order:**
     1. Agent owner accounts: **built and pushed 19 Nov** (migration `0067_agent_owners`; database
        `e447fe4`, API `0217525`, pages `24b1562`, `fd707ae`; e2e `e2e/tests/shop-owner.spec.ts`; full
        checks passed). Still open, small: owners adding and blocking their own cashiers (today
        admins do it on the agent page).
     2. Switching the shop app on in production, with the owner (`docs/deployment.md`, "Shop
        app"): build the shop image once (never built: no docker daemon in the cloud container),
        add `shop` to `SERVICES` in `infra/scripts/deploy-full.sh`.
     3. Phase 2, the agent balance (plan, "Phase 2 design"; money path: main session, Opus,
        high): **steps 1–3 built and pushed 19 Nov, full checks passed** (migration
        `0068_agent_balance`; database `6b813e1`, API `5911deb`, screens `33c0c52`, e2e
        `e2e/tests/agent-topups.spec.ts`): the agent's ledger account, top-ups and take-backs with
        four eyes, balances on the Agents pages and the owner's overview. **Next: step 4**, player
        cash at an agent's shop, exactly as in the plan's "Step 4 design detail" (provider
        `agent_cash`, `markPayoutPaid` `paidTo`, the reconciliation check `agent_cash_records`).
     4. Phase 3, selling tickets at the counter, and phase 4, paying them (money path).
     5. Phase 5 (live monitor, alerts, weekly commission) and phase 6 (Android POS).
   - **Waiting for the owner:** the DNS record shop.nahubet.com, the POS model, the winnings tax
     rate, agent licensing with the regulator.
   - The mr-y request (Narobet game links) was declined on 19 Nov: it runs on the owner's own
     Narobet account and bypasses the ledger.
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
