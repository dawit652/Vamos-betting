# Agent shops: sell and pay sport tickets through independent agents

Owner's request (19 Nov 2026): the admin adds admins, and cashiers for every shop; every shop
(agent) has its own name and number; each shop has an organised dashboard to sell sport bet
tickets on a connected printer (sample: a Narobet "Betting Slip"); the admin has ultimate power and
controls every branch. Interviewed on 19 Nov 2026; the answers are below.

Status (19 Nov 2026): the owner said "build it". **Phase 0 built**: the receipt printer card and
test print (`df646e4`), the Staff screen (`ac8a780`). **Phase 1a built** (`dce8e5d`
database and API, `80c103e` screens): agents with numbers, owner name and phone, shops numbered
under their agent, staff phone numbers, the Agents pages, blocking. **Next: phase 1b** (devices, agent owner accounts, the
shop app); see "Phases" for what each step holds.

## Owner's decisions (interview of 19 Nov 2026)

| Topic              | Decision                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shops              | Independent agents. Each agent prepays Nahubet; the cash in the shop is the agent's.                                                                       |
| Customers          | Anyone: a walk-in ticket is paid to whoever holds it; the customer's phone number is optional. Registered players are served too.                          |
| Devices            | PC or laptop with a USB thermal printer, or an Android POS terminal (model not chosen). A barcode scanner is optional for each agent.                      |
| Building a ticket  | Game ID + pick, booking code, and clicking matches. Matches that already started are shown, and the cashier removes them before printing.                  |
| Agent money        | Prepaid balance, topped up only by cash or bank transfer at head office: an admin records it, a second admin approves.                                     |
| Commission         | Type and percent set per agent by the admin; a weekly statement (Monday to Sunday); the admin pays it.                                                     |
| Paying winners     | The shop that sold the ticket pays it; above a limit head office approves first.                                                                           |
| Organisation       | An agent owner account (own shops, sales, balance, cashiers) plus cashiers; admins above everything.                                                       |
| Admin controls     | Limits per agent; block an agent, shop or cashier at any time; registered devices only (an admin approves each); live monitor and alerts.                  |
| Maximum win        | A maximum win per ticket, adjustable in the admin dashboard.                                                                                               |
| Cancelling         | The cashier within 5 minutes of printing, later the agent owner or an admin; always before the first match starts. The stake goes back to the agent.       |
| What shops sell    | Prematch only (no live bets, no cash-out at the counter).                                                                                                  |
| Online players     | Cash deposit and cash withdrawal for player accounts, from the agent balance; the admin switches it on or off per agent. Agents also sell and pay tickets. |
| Ticket expiry      | Adjustable in the admin dashboard.                                                                                                                         |
| Ticket text        | English and Amharic.                                                                                                                                       |
| Agent and shop IDs | Automatic numbers with names: agent 1001, its shops 1001-01, 1001-02.                                                                                      |
| Names and phones   | Every agent has its owner's full name and mobile number; every cashier has a mobile number (owner's message during the build, 19 Nov 2026).                |

## Review and test of today's dashboards (19 Nov 2026)

- End-to-end tests `e2e/tests/admin.spec.ts` and `e2e/tests/cashier.spec.ts`: **6 passed** (sign-in
  guard, a withdrawal approved by finance, trading actions, a support user refused trading, a cash
  deposit with its receipt and the shift close, a cash payout with a shop code). In a cloud
  container run them with `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium`.
- Gaps:
  1. No staff screen: staff accounts are created only with `admin-create` on the server, although
     the API `/admin/staff` (list, create, change; admin only) exists.
  2. Shops have a typed code, no owner and no number; a cashier belongs to a shop, nobody owns one.
  3. The desk's cash belongs to Nahubet (`house:psp:cash`): no agent balance, commission or limits
     per shop.
  4. No tickets sold at the counter, no barcode, no ticket payout.
  5. No printer setup on the desk: printing goes through the browser (80 or 58 mm pages), but the
     desk does not say how. A "Receipt printer" card and a test print page were drafted (not
     committed); they belong to phase 0.
  6. Events whose kick-off passed without a result stay "scheduled" with open markets (betting is
     closed by `close_lead_ms`, but they clutter Trading). A separate small task.

## Design

### Two apps

- **Back office** (`apps/admin`, admin.nahubet.com): Nahubet staff only. New pages: Staff; Agents
  (agent, its shops, people, devices, limits, switches, balance, top-ups, statements); Tickets
  (search and live monitor); Alerts.
- **Shop app** (new `apps/shop`, shop.nahubet.com): agent owners and cashiers only. Pages: Sell,
  Pay, Tickets, Player cash (when switched on), Shift, Balance, Printer. Made for a counter PC and a
  small POS screen, in English and Amharic.
- Why two: the back office stays closed to 40+ shops (it keeps `STAFF_ALLOWLIST`), the counter gets
  a small fast screen, and shop sessions can never reach `/admin/*`. Same API (`apps/api`) with new
  `/shop/*` routes and their own session cookie.
- The owner adds a DNS record `shop.nahubet.com` pointing to the server; the deploy adds the site
  to Caddy.

### People and sign-in

- Roles: `admin` (everything), `finance` (approves top-ups, statements), new `agent_owner`, and
  `cashier` (moves to the shop app).
- Admins create agents and their owner accounts; owners add and block their own cashiers; admins
  can do the same anywhere.
- Cashier: phone or user name, password, and a registered device of their shop. Agent owner:
  password and an authenticator app, like staff.
- Devices: a new device asks to be registered; the request shows in the back office (agent, shop,
  device name, browser); an admin approves; the device keeps a long random secret in a cookie.
  Revoked at any time. Blocking an agent, shop, cashier or device signs them out at once (checked on
  every request).

### Numbers

- Agents are numbered from 1001; shops `<agent>-<nn>` (1001-01). Today's shop codes stay as
  internal codes. Today's "Nahubet" shop becomes agent 1000 "Nahubet HQ", whose cash is Nahubet's as
  today; HQ records top-ups and can pay big wins.
- Ticket number: 12 random digits (never sequential, cannot be guessed) plus a 4-character check
  code; the barcode carries both.

### Money (double-entry ledger, written only in `packages/db`)

New accounts: one balance per agent (what Nahubet owes the agent; never below zero) and
`house:retail_payable` (won shop tickets not yet paid).

| What happens                                | Posting                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| Top-up at HQ (cash or bank, four eyes)      | HQ cash → agent balance                                     |
| Ticket sold                                 | agent balance → stakes (as an online bet)                   |
| Ticket cancelled                            | stakes → agent balance                                      |
| Ticket won (settlement)                     | winnings → retail payable, never to the agent; tax withheld |
| Ticket paid at the shop                     | retail payable → agent balance (the agent paid out cash)    |
| Ticket paid at HQ                           | retail payable → HQ cash                                    |
| Winning ticket expired unpaid               | retail payable → house income                               |
| Player cash deposit at the shop             | agent balance → player wallet                               |
| Player cash withdrawal at the shop          | player wallet → agent balance                               |
| Agent takes money back (closing, four eyes) | agent balance → HQ cash                                     |
| Commission                                  | paid outside, or credited to the balance with four eyes     |

- Shop tickets reuse bet placement and settlement (odds checks, limits, idempotency, voids, tax).
  The bettor of a shop ticket is the agent's system account (not a player, cannot sign in); the
  settlement sends shop-ticket winnings to retail payable instead of a wallet
  (`packages/db/src/betting/`, `settlePlacedBet`). Money path: main session, Opus, high effort.
- A registered player's online balance is never spent at the counter.
- Reconciliation checks agent balances and retail payable like the other accounts.

### A ticket's life

1. **Build** with Game ID + pick (the SMS syntax and `PICK_CODES` of
   `packages/core/src/textcommand.ts`: `81492 1`, `69404 X`, `OV25`, `GG`...), a booking code, or
   by clicking matches.
2. **Check before printing:** started or suspended matches in red with "Remove" (and "Remove all
   started"); changed odds shown and accepted; limits checked.
3. **Print:** the stake leaves the agent balance; the ticket shows the logo, agent and shop number
   and name, cashier, date and time, each match (league, teams, market, pick, odds, kick-off), total
   odds, stake, possible win, tax, net pay, the barcode, and the footer rules (English and Amharic,
   editable by the admin).
4. **Cancel:** the cashier within 5 minutes of printing, later the agent owner or an admin; always
   before the first kick-off.
5. **Pay:** scan or type the ticket, see its state (open, won, lost, void, paid, expired, waiting
   for HQ), pay at the selling shop; above the HQ limit an admin approves first (or HQ pays it). A
   payout slip is printed. Paid once only (row lock and idempotency key).
6. **Expiry:** an unpaid winning ticket expires a set number of days after its last match.

### Limits and controls (global default, changed per agent by an admin)

- Maximum stake per ticket, minimum stake, **maximum win per ticket**, most matches per ticket,
  minimum odds, sales per day, HQ approval above, cancel window, ticket expiry, player cash on or
  off, blocked. Agent owners may set lower limits for their own cashiers, never higher.
- Live monitor: tickets as they are sold in all shops (filter by agent, shop, cashier); sales,
  payouts and balance per agent today.
- Alerts (a list in the back office and `alarm` log lines): a big possible win, the same picks sold
  many times across shops, many cancels by one cashier, tickets printed just before kick-off, a low
  agent balance, a payout waiting for HQ, a new device request.

### Printing

- PC with a USB printer: install the Windows driver; the browser prints 80 or 58 mm pages (built).
  The shop app has a "Printer" page with a test print, and a guide for printing without the dialog
  (start Chrome or Edge with `--kiosk-printing`).
- Barcode: Code128 drawn in the page (SVG), no extra service; scanners type like a keyboard.
- Amharic prints because the browser draws the text; raw ESC/POS printer commands cannot print
  Amharic.
- Android POS: browser printing works when the terminal's printer appears in Android's print menu;
  otherwise a small Android app (web view plus the maker's printer kit) once a model is chosen. Buy
  one test unit first.

### Weekly statements and commission

- Monday to Sunday, per agent: sales, cancels, payouts, player cash in and out, net (GGR),
  commission (percent of stake, or percent of GGR with nothing for a week below zero), balance at
  the start and end. CSV export.
- The admin marks the commission paid (with a reference), or credits it to the balance with four
  eyes.

## Phases (each one deployable, with its tests)

0. **Staff screen and printer** (small, no money): **built** (`df646e4`, `ac8a780`).
1. **Agents, shops and people.**
   - **1a, built:** migration `0064_agents` (table `agents`, HQ = 1000 holding every existing
     shop, `cashier_shops.agent_id` and `number`, `admin_users.phone`); `packages/db/src/retail/`
     (createAgent, listAgents, updateAgent, setAgentBlocked, listAgentCashiers); `createShop`
     numbers shops per agent; `assertShopOperates` (closed shop or blocked agent: 409) and
     `assertPlayerCashAllowed` (player cash only at HQ shops until phase 2: 409
     `agent_player_cash_off`); routes `/admin/agents*` (`agents.view`, `agents.manage`); a cashier
     needs a phone (API and `admin-create --phone`); back-office Agents pages; tests in
     `packages/db/test/retail-agents.test.ts`, `apps/api/test/admin-agents.test.ts`,
     `e2e/tests/agents.spec.ts`.
   - **1b, next:** the `agent_owner` role and an owner account per agent (created from the
     agent's page, phone required); `shop_devices` (a device asks, an admin approves, revoke; the
     device keeps a random secret in a cookie; cashiers sign in only on an approved device of their
     shop); blocking an agent or shop ends its staff sessions; the shop app `apps/shop`
     (shop.nahubet.com: sign-in, the desk moved there, Printer page) with its compose service,
     Caddy site and deploy-script entry.
2. **Agent balance:** accounts, top-ups with four eyes, balance pages; player cash at the shop
   moved to the agent balance with the per-agent switch. Money path.
3. **Selling:** sell screen (three ways), removing started matches, limits, the ticket placed from
   the agent balance, printing with the barcode, cancelling. Money path.
4. **Paying:** settlement to retail payable, the pay screen (scan or type), HQ approval, the expiry
   job, the payout slip. Money path.
5. **Control:** live monitor, alerts, weekly statements and commission, exports.
6. **Android POS**, once the model is chosen.

## Phase 1b design (for the next session)

Build in this order; each step is committed and pushed on its own.

1. **Agent owner accounts.** Migration 0065: `ALTER TYPE admin_role ADD VALUE 'agent_owner'` and
   `agents.owner_staff_id uuid NULL REFERENCES admin_users(id)` (one owner account per agent, unique).
   `POST /admin/agents/:id/owner-account {email}` (agents.manage) calls `createStaffUser` with role
   `agent_owner`, the agent's owner name as display name and the owner phone, links it, and shows
   the one-time password and authenticator secret on the agent page (reuse
   `apps/admin/src/components/staff-secret.tsx`). `agent_owner` holds no back-office permission
   (`PERMISSION_ROLES`): owners work in the shop app only. Adding `agent_owner` to the contracts'
   `STAFF_ROLES` touches `packages/contracts/src/admin.test.ts` and `apps/admin/src/lib/nav.test.ts`
   ("every role but the cashier sees the dashboard": the owner neither) and the Staff screen's role
   selects (leave the owner out: owners are made from the agent page). **Ship this step with step
   4:** an owner can sign in only to the shop app, and a generated password stops working 72 hours
   after creation unless it is changed at the first sign-in, so owner accounts made before the shop
   app exists would expire unused.
2. **Shop devices. Back-office side built** (migration `0065_shop_devices`,
   `packages/db/src/retail/devices.ts`, `POST /admin/shop-devices/:id/approve|revoke`, the agent
   page's Devices section, `packages/db/test/retail-devices.test.ts`); the request route
   `POST /shop/devices/request` and the cookie come with step 3. Table `shop_devices` (id, shop_id, label, secret_hash unique (sha256 of a
   32-byte random secret), status `pending|approved|revoked`, requested_by, approved_by,
   approved_at, revoked_at, last_seen_at, user_agent, created_at); `REVOKE DELETE` from vamos_app.
   A device asks after its cashier's password is checked (`POST /shop/devices/request {email,
password, label}`; the API sets the httpOnly cookie `vamos_device` with the secret, path `/shop`,
   SameSite=Strict, Secure in production). Back office: the agent page lists devices per shop with
   Approve / Revoke (agents.manage, audited). A cashier signs in to the shop app only with an
   approved device of their own shop; every shop request re-checks the device, the shop, the agent
   and the account, so blocking or revoking takes effect at once.
3. **Shop sessions and routes.** **3a built** (`6795a21`): the sign-in and the sessions in
   `packages/db`, as described here. **3b next**: the API's `/shop` scope and routes. Do not write a
   second sign-in: extend `loginStaff` in `packages/db/src/backoffice/staff-auth.ts` with a
   `channel` (`admin` | `shop`) and a second factor (`totp` code | `device` secret hash), so the
   address throttle, the account backoff, the audit and the re-check under the row lock
   (`commitAttempt`, `recheckAttempt`) stay one code path. For a device: `verifyAttempt` checks
   `findApprovedStaffDevice` and the shop (`assertShopOperates`) instead of the code, a wrong
   device counts as a failure (`device` reason in `COUNTED_FAILURES`), and `totpLastStep` is not
   touched. `admin_sessions` gets `channel` and `device_id`; `authenticateStaffSession` takes the
   channel it serves and refuses the other one; a shop session also re-checks its device, shop and
   agent on every request. A separate session scope `/shop/*` (cookie `vamos_shop`, CSRF header
   `x-shop-csrf-token`), reusing the staff session store with a `channel = 'shop'` marker.
   Cashier sign-in: email or phone + password + approved device; agent owner: password +
   authenticator (+ device if the owner wants it later). `GET /shop/me` returns the staff member,
   agent and shop (label, paper width). The desk routes move to `/shop/desk/*` on the same
   `packages/db` services (shift, player cash at HQ shops, receipts); `/admin/cashier/*` stays for
   HQ supervisors (finance, admin), and the `cashier` role leaves `cashier.desk` once the shop app
   is live.
4. **The shop app** `apps/shop` (Next.js, port 3002), built like `apps/admin` (`src/lib/api.ts`,
   `config.ts` with `NEXT_PUBLIC_SHOP_API_URL`, session provider, login page): pages Sign in, Desk
   (shift, player cash), Receipt, Printer (the test print and the guide now on the admin desk), in
   English and Amharic (`packages/i18n`). Infra: a build target in `infra/docker/Dockerfile`, a
   `shop` service in `infra/docker-compose.prod.yml` (healthcheck like `admin`), a
   `{$SHOP_DOMAIN}` site in `infra/caddy/Caddyfile` (and the scale/streams variants), `SHOP_DOMAIN`
   in `infra/env.prod.example`, and the service in `infra/scripts/deploy-full.sh`. The owner adds
   the DNS record and `SHOP_DOMAIN=shop.nahubet.com` to `/opt/nahubet-new/infra/.env.prod`.
5. **Tests:** db (devices, owner link, blocked agent ends the shop session), API (`/shop/*` with and
   without an approved device, revoked device, blocked agent), e2e (a cashier asks a device, the
   admin approves, the cashier signs in to the shop app and opens a shift).
6. **Small leftovers of 1a:** the desk's shift heading and the "Shops on <day>" table on Cash
   shifts still show the shop name or code without its number: add `shopLabel` to
   `CashierShiftView` and `label` to `ShopDayView` (contracts, `shiftView` / `shopDaySummary`),
   then show them. The e2e agents spec closes the shop it adds (an open second shop would stop the
   demo cashier without a shop from opening a shift in `cashier.spec.ts`).

## Defaults chosen here (all adjustable by an admin)

Maximum win per ticket ETB 500,000 (as online today); maximum stake ETB 100,000 (as online); HQ
approval above ETB 10,000 (the desk's four-eyes limit); cancel window 5 minutes; ticket expiry 30
days after the last match; player cash at shops off for a new agent.

## Open for the owner

- DNS record `shop.nahubet.com`.
- The winnings tax: a placeholder of 20% of net winnings above ETB 100 (Proclamation 1395/2025, to
  confirm), the same for shop tickets as online.
- Agent licensing with the regulator before real money (licensed mode).
- The Android POS model.
- Later: may a registered player's winning ticket be paid into their online account instead of
  cash?

## Rules for every session of this work

- **Build on top of the server's branch.** Before every push:
  `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`
  (exit 0 = fine; otherwise merge it in first and run the checks again).
- **Model and effort by task** (CLAUDE.md): the money path (ledger postings, placement, settlement,
  payouts, migrations, security) in the main session on Opus, high effort; routine pages and forms
  to `routine-coder`; running checks to `quick-task`.
- Never touch the live server; the owner deploys.
