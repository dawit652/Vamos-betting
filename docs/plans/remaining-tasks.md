# Remaining tasks (read this first; updated 23 Nov 2026)

**Start here (23 Nov, first account, end of its session; the second account continues).**
The newest work is on `claude/eager-cerf-ox9vkq` (`d1d25ee` and later); `claude/happy-keller-i7cvrh`
is behind at `7a15b27`: bring it up with
`git fetch origin claude/eager-cerf-ox9vkq && git merge --ff-only FETCH_HEAD`. **Work with one
account at a time.** Next free migration: **0085**.

- **Deployed 22 Nov 22:36:** `b94684f`: the SMS rail reads the live telebirr (Amharic) and CBE
  credits (CBE's mbreciept and BranchReceipt links). The SMS forwarder on the owner's phone is
  connected (`cbe:1000438086378`, `telebirr:0911678426`; `SMS_GATEWAY_SECRET` rotated on 23 Nov).
  Deposits of 10.79 and 10.06 credited by themselves.
- **Pushed, not deployed** (deploy with the PowerShell line under "Deploy"): `1f9f4ea` (a transfer
  deposit says "Waiting for your payment"), `8ea2ab5` (telebirr's Amharic "money sent" message is a
  debit; the account's own number is never a payer or recipient), `b2c231f` (Today = today only:
  no day chips, started matches leave, stale "live" ones after 4 h; Upcoming = 30 days with a
  sideways row of 30 days; fixture horizon 30 days; e2e green), `d1d25ee` (`scripts/review-study.sh`),
  `18d99c8` (the review queue plan), `9b17600` (re-price rule A-2: a strong market replaces the
  stored prices whatever the move; held re-prices of such matches apply on the next pass),
  `c53b4f2` (sweeper Q2c: closes kickoff / fixture items of played, cancelled or gone matches) and
  the auto-open `held` counts (why each waiting match stays closed, in the `auto open run` log).
  After the deploy, staff press **Read again** in Back office → SMS rail on the three unparsed
  messages (CBE 00:26 for the ETB 10.40 deposit; telebirr 00:35 and 00:42).
- **Server state the owner set on 23 Nov:** switches `narobet_pricing` on (since 21 Nov) and
  `narobet_events` on (30 days ahead, 325 matches listed); mr-z `DETAIL_BUDGET=60` in
  `/opt/mr-z/.env` (was 40; still at most 1,200 requests an hour, stops on any refusal).
- **Next (owner's request of 23 Nov): the review queue** (665 open items, many matches with
  betting closed): plan with the server's numbers, decisions D1-D7 and build order in
  [review-queue-automation.md](review-queue-automation.md). **The owner said go ("implement the
  plan"): steps 1, 2 and the step 4 diagnostics are built; next step 3 (earliest fresh kickoff),
  then 4a / 4b after the owner deploys and the study runs again (D4, D5).** D1 (extra time off for
  leagues, back office only, the owner's job) is the biggest win: with
  `extra_time` on everywhere no result is applied by itself. Warnings there: The Odds API credits
  run out in about 5 days; 129 matches priced above the best bookmaker price.
- Smaller leftovers: the home page is 0.2 KB over its page-weight budget (168.2 / 168.0 KB, e2e
  `budget.spec.ts`; move the claim and withdrawal-code texts out of the shared bundle); phase 6
  (many POS devices) when the owner says go.

**22 Nov, evening (first account):** both accounts built counter codes steps 5-7 at the same time.
The first account dropped its own copies (never pushed) and took the second account's, so
`claude/eager-cerf-ox9vkq` equals `claude/happy-keller-i7cvrh` at `7a15b27` plus this note (full
checks green on it). **Work with one account at a time.** The owner's deploy line is under
"Deploy" below.

**Start here (22 Nov, newest):** the second account continues: the newest work is on
`claude/happy-keller-i7cvrh` (it contains all of `claude/eager-cerf-ox9vkq` up to `55f91d0`; bring
eager-cerf up to it with `git fetch origin claude/happy-keller-i7cvrh && git merge --ff-only
FETCH_HEAD` before working there). **Counter codes step 5 is built (22 Nov, pushed, NOT deployed):**
"My deposit did not arrive" claims on the Deposit page and Back office → Money not credited with
suggested players (migration `0082_deposit_claims`). Also built and pushed (22 Nov): the owner's
daily "money not credited" Telegram line, Back office → Service health, the shop's printed shift
report, and step 6, the Telegram "Deposit problem" (migration `0083_deposit_claim_source`; **next
free migration: 0084**), and step 7, the G4 withdrawal code (amount in the app, a 24-hour code,
paid by the code alone at any shop with player cash on; migration `0084_withdrawal_codes`; **next free
migration: 0085**). The counter codes plan is complete. Next: the owner deploys (migrations
0077-0084); phase 6 waits for the owner's POS.
**Before that (22 Nov):** the first account's work on `claude/eager-cerf-ox9vkq`. **Counter codes steps 3, 3b and 4 are built (22 Nov, pushed, NOT deployed):** the payout code
printed on each shop ticket and asked for at Pay (migration `0081_retail_ticket_payout_code`), the
public ticket check (website `/ticket`, Telegram `/ticket`), and manual deposits by one admin
(`deposits.credit`) with a re-check button ([counter-codes-and-deposit-recovery.md](counter-codes-and-deposit-recovery.md)).
**Next free migration: 0082.** Next: steps 5-8 there (the "Money not credited" page with suggested
players and deposit claims, the Telegram "Deposit problem", the cash withdrawal code, the shift
report print), and the Service health page (step 1's page). Earlier on 21 Nov the first account
also built: **Step 2 of the counter codes is built (22 Nov):**
6-digit booking codes and the code printed on the shop ticket (migration
`0079_retail_ticket_booking_code`; next free migration **0080**); next is step 3, the payout code.
**Owner, 22 Nov:** owner reports (day, week, month, year) built: from the ledger, checking
themselves, Back office → Reports ([owner-reports.md](owner-reports.md), migration
`0080_report_days`; next free migration **0081**). Odds of matches more than 72 hours away are unlocked (kickoff rule C2's window is
30 days, `packages/scraper/src/constants.ts`, pushed, not deployed); phase 6 supports many POS devices
(plan in [agent-shops.md](agent-shops.md), "Phase 6: many POS devices"). **Built there 21 Nov, pushed, NOT deployed:** the
owner's decisions O6 (cashiers pay any counter withdrawal and any winning ticket alone: no
supervisor, no HQ approval; the "Ticket payouts" page is gone) and O7 (players withdraw winnings
only, never deposited money), in [counter-codes-and-deposit-recovery.md](counter-codes-and-deposit-recovery.md),
"O6 and O7 are built". The live server runs `69f71a8` (deployed by the owner 21 Nov, migrations up
to 0076: Narobet prices through mr-z, switch `narobet_pricing` off; `SCRAPER_NAROBET_URL` set; the
shop app itself is not switched on yet). mr-z runs with gentle polling (`7f129c6`, owner: "mr-z
dont pull data aggresively"; on the server 900 requests an hour, 40 details per cycle). The 30-day top leagues
work was stopped by the owner (20 Nov) and not committed. **Built 21 Nov, pushed, NOT deployed (full checks green at `d83959e`: format, lint, typecheck,
every test):**
Narobet-only matches through mr-z, for more leagues on the site, with the ETB 20,000 cap per board
match (a setting) and results by API-Football fixture id ([narobet-events.md](narobet-events.md):
migration `0077_narobet_events`, switch `narobet_events` off, 30 days ahead; deploy and switch-on
steps there). Narobet is not affected: Nahubet reads only mr-z's copy. Not built: listing our own
seeded Ethiopian Premier League from Narobet (an owner decision). The next free migration number is
**0079**.

**Next (owner's request of 21 Nov; step 1 built: service-down alerts on Telegram every 15 minutes,
migration 0078, `7f14b22`; next free migration 0079):**
[counter-codes-and-deposit-recovery.md](counter-codes-and-deposit-recovery.md): 6-digit booking
codes for players without login and the code on the ticket; a 6-digit payout code printed on each
shop ticket; a 6-digit cash withdrawal code for logged-in players; provider re-check and manual
deposit with four eyes; "My deposit did not arrive" claims (app and Telegram); a "Money not
credited" page with suggested players; frequent Telegram alerts when a service is down (every 15
minutes, then "recovered"); completing the shop app. Build order in that file; the owner decided O1-O5 on 21 Nov (payout code printed at sale; cash
withdrawal at any shop with player cash on; the bot may store deposit claims; alerts every 15
minutes; **one admin credits a manual deposit, no second approval**). Then: the owner deploys and switches on the Narobet
work, phase 6 once the owner picks a POS model, or what the owner asks. The branch holds the server's own branch
(`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. Deploy is
done by the owner (`ssh -t root@<server>` + `infra/scripts/deploy-full.sh`, licensed env file
`/opt/nahubet-new/infra/.env.prod`, project `vamos`). Never touch the live server yourself; never
paste secrets.

**Also built 19 Nov, not deployed: Deposit accounts** (owner's request: admins add, edit and delete
the bank and wallet accounts players deposit to, as many as they need): migration
`0069_collection_accounts`, `packages/db/src/payments/collectionaccounts.ts`, routes
`/admin/collection-accounts`, page `/collection-accounts`; runbook `docs/runbooks/sms-rail.md`
"Deposit accounts". A new account needs a second person's approval before players see it; numbers
never change; deleting keeps crediting money already sent for 7 days; the owner is texted on each
change. The first start after the deploy fills the list from `SMS_COLLECTION_ACCOUNTS`; after that
the page is the list. The server stays in **licensed mode** (owner's rule, 19 Nov): licensed mode
never shows or stores the demo accounts. Also: every password form (back office, shop app, player
site) posts instead of putting the password in the URL when its script has not loaded yet.

**Owner alerts (20 Nov, owner: "just notify when it's important"):** Telegram and SMS alerts
about deposits and withdrawals came every few minutes. `OWNER_ALERT_POLICY`
(`packages/core/src/owner-alert.ts`, runbook `docs/runbooks/sms-rail.md` "Alarms") now texts only
money alarms, each at most every 6-24 hours, and one summary for contradicted deposits; staff's
alarms stay log lines and panels. Live after the next deploy.

## Deploy (the owner does it; never from a session)

From the owner's PC (PowerShell), one line: it logs in, starts the deploy in the background on the
server and shows its log (Ctrl+C stops only the log, not the deploy):

```powershell
ssh -t root@13.140.208.4 "cd /opt/nahubet && git fetch origin claude/eager-cerf-ox9vkq && (nohup bash -c 'bash <(git show origin/claude/eager-cerf-ox9vkq:infra/scripts/deploy-full.sh) claude/eager-cerf-ox9vkq /opt/nahubet-new/infra/.env.prod vamos' > /root/deploy.log 2>&1 &) ; sleep 3 ; tail -f /root/deploy.log"
```

The deploy backs up the database, applies the new migrations (0077 to 0084 after the live
`69f71a8`), runs the smoke test and rolls back by itself if it fails. Nothing new to set in the env
file; the switches `narobet_events` and `hulusport_pricing` stay off until the owner turns them on
in the back office; Telegram alerts need `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_IDS`.

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
        checks passed). Owners add and block their own cashiers too (20 Nov).
     2. Switching the shop app on in production, with the owner (`docs/deployment.md`, "Shop
        app"): build the shop image once (never built: no docker daemon in the cloud container),
        add `shop` to `SERVICES` in `infra/scripts/deploy-full.sh`.
     3. Phase 2, the agent balance (plan, "Phase 2 design"; money path: main session, Opus,
        high): **steps 1–3 built and pushed 19 Nov, full checks passed** (migration
        `0068_agent_balance`; database `6b813e1`, API `5911deb`, screens `33c0c52`, e2e
        `e2e/tests/agent-topups.spec.ts`): the agent's ledger account, top-ups and take-backs with
        four eyes, balances on the Agents pages and the owner's overview. **Step 4 built and
        pushed 19 Nov** (`078dbfa`, `9e5c943`; full checks passed): player cash at an agent's shop
        (provider `agent_cash`, an admin's switch per agent, reconciliation `agent_cash_records`).
        **The shop app's desk for player cash built 19 Nov** (API `54d8aca`, screens and e2e
        `e2e/tests/shop-desk-cash.spec.ts`; full checks passed): lookups, deposits, withdrawals
        with the shop code, receipts, the agent balance on the desk; one code path with the back
        office's desk (plan, "Phase 2 design", status). **Phase 2 is complete.**
     4. **Phase 3, selling tickets: built 20 Nov** (plan, "Phase 3 design"; steps 1-3: database,
        API, the shop app's sell screen and printed ticket with a Code128 barcode, cancel, the
        admin's ticket limits; e2e `e2e/tests/shop-tickets.spec.ts`). The match list and the
        Amharic footer added 20 Nov.
        **Phase 4, paying tickets: built 20 Nov** (plan, "Phase 4 design"; database, API, the
        shop app's pay screen and payout slip, the back office's waiting payouts with four eyes,
        the worker's hourly expiry task; e2e `e2e/tests/shop-payouts.spec.ts`). Phases 1-4 of the
        agent shops are complete and pushed; none is deployed.
     5. **Phase 5 (plan, "Phase 5 design"): built 20 Nov** — weekly statements and commission
        (migration 0072; back office `/statements` with CSV and "Mark paid", the agent page's
        weekly statements, the owner's statements in the shop app), the live monitor (0073
        indexes; `/retail-monitor`, refreshed every 15 s), alerts (0074, worker `retail-alerts`;
        `/retail-alerts` with Acknowledge); e2e `e2e/tests/agent-statements.spec.ts`.
        **The small gaps are closed (20 Nov):** owners add and block their own cashiers; the
        Sell page's match list (`GET /shop/desk/matches`); the Amharic ticket footer; an e2e of
        the HQ payout approval; the alert thresholds as settings (`/retail-alerts` form). Next:
        phase 6 (Android POS, once the owner picks a model).
   - **Waiting for the owner:** the DNS record shop.nahubet.com, the POS model, the winnings tax
     rate, agent licensing with the regulator.
   - The mr-y request (Narobet game links) was declined on 19 Nov: it runs on the owner's own
     Narobet account and bypasses the ledger.
1. **After the owner deploys the next build, check on live** (read-only queries, the owner runs
   them; `80c8a73` was deployed and checked on 18 Nov: 67 migrations, the team-logos task
   registered): migration 0064 applied (`SELECT number, name FROM agents` shows 1000 Nahubet HQ);
   the Staff and Agents pages open for an admin; add an agent, its shop and a cashier with a phone;
   a test shift with a deposit at an HQ shop; the Deposit accounts page lists exactly the accounts of
   `SMS_COLLECTION_ACCOUNTS` (filled on the first start) and the deposit screen still shows them; team logos after their 6-hour run (scraper log `team
logos`); the X6b alarm lines (`"alarm":"login_failures_`).
2. **Desk PIN reset redesign: built 20 Nov, off until the owner switches it on.** Only the
   player's own phone sets the PIN (desk code from the phone, ID check, supervisor approval; plan
   `docs/plans/cashier-dashboard.md`, phase 2; migration 0075; e2e `shop-pin-reset.spec.ts`). To
   switch on: `CASHIER_PIN_RESET=on` in the licensed env file, then deploy (the API and the web
   both read it). Owner's choice; nothing else is needed.
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
