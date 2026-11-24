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

| Topic              | Decision                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shops              | Independent agents. Each agent prepays Nahubet; the cash in the shop is the agent's.                                                                                                                                   |
| Customers          | Anyone: a walk-in ticket is paid to whoever holds it; the customer's phone number is optional. Registered players are served too.                                                                                      |
| Devices            | **Many kinds, not one model** (owner, 22 Nov 2026): PC or laptop with a USB thermal printer, Android POS terminals, phones and tablets. A barcode scanner is optional for each agent. See "Phase 6: many POS devices". |
| Building a ticket  | Game ID + pick, booking code, and clicking matches. Matches that already started are shown, and the cashier removes them before printing.                                                                              |
| Agent money        | Prepaid balance, topped up only by cash or bank transfer at head office: an admin records it, a second admin approves.                                                                                                 |
| Commission         | Type and percent set per agent by the admin; a weekly statement (Monday to Sunday); the admin pays it.                                                                                                                 |
| Paying winners     | The shop that sold the ticket pays it, any amount, with no head office approval (owner, 21 Nov 2026, O6).                                                                                                              |
| Organisation       | An agent owner account (own shops, sales, balance, cashiers) plus cashiers; admins above everything.                                                                                                                   |
| Admin controls     | Limits per agent; block an agent, shop or cashier at any time; registered devices only (an admin approves each); live monitor and alerts.                                                                              |
| Maximum win        | A maximum win per ticket, adjustable in the admin dashboard.                                                                                                                                                           |
| Cancelling         | The cashier within 5 minutes of printing, later the agent owner or an admin; always before the first match starts. The stake goes back to the agent.                                                                   |
| What shops sell    | Prematch only (no live bets, no cash-out at the counter).                                                                                                                                                              |
| Online players     | Cash deposit and cash withdrawal for player accounts, from the agent balance; the admin switches it on or off per agent. Agents also sell and pay tickets.                                                             |
| Ticket expiry      | Adjustable in the admin dashboard.                                                                                                                                                                                     |
| Ticket text        | English and Amharic.                                                                                                                                                                                                   |
| Agent and shop IDs | Automatic numbers with names: agent 1001, its shops 1001-01, 1001-02.                                                                                                                                                  |
| Names and phones   | Every agent has its owner's full name and mobile number; every cashier has a mobile number (owner's message during the build, 19 Nov 2026).                                                                            |

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
6. **Many POS devices** (owner, 22 Nov 2026: support several devices, not one model): see "Phase 6:
   many POS devices" below.

## Phase 1b design (for the next session)

Build in this order; each step is committed and pushed on its own.

1. **Agent owner accounts. Built 19 Nov** (migration `0067_agent_owners`; database and API in
   `e447fe4` and `0217525`; pages with the next commit): `createAgentOwnerAccount`
   (`packages/db/src/retail/owners.ts`) makes the account linked to the agent in one transaction;
   the shop app's authenticator sign-in is for owners only, its device sign-in for cashiers, and
   owners never sign in to the back office; an owner's shop session has no device and works while
   the agent is not blocked; `GET /shop/owner` (their agent, shops, cashiers, devices); the desk
   refuses owners (`cashier_only`); the Staff screen cannot give the role and it never changes
   (`owner_role_fixed`). **Built 20 Nov:** owners add a cashier to one of their shops and block or
   unblock their own cashiers on the owner page (`POST /shop/owner/cashiers`,
   `/shop/owner/cashiers/:id/block|unblock`; never another agent's; blocking ends the cashier's
   sessions; an owner unblocks only a cashier the owner blocked, head office's blocks stay with
   head office (`blocked_by_head_office`); e2e `e2e/tests/shop-owner-cashiers.spec.ts`).
   The original design follows. Migration 0065: `ALTER TYPE admin_role ADD VALUE 'agent_owner'` and
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
   `packages/db`, as described here. **3b built** (`7cf8186`): the `/shop` scope (`apps/api/src/plugins/shop-session.ts`,
   `apps/api/src/modules/shop/routes.ts`): device request, sign-in, me, password, sign-out,
   CORS for `SHOP_WEB_URL`. **3c built** (`680308c`): `GET /shop/desk`, `POST /shop/desk/shifts`, `POST
/shop/desk/shifts/:id/close`. Do not write a
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
4. **The shop app: built** (`e653a9c`), except its production infra (the Dockerfile target,
   compose service, Caddy site, env and deploy-script entries listed here). `apps/shop` (Next.js, port 3002), built like `apps/admin` (`src/lib/api.ts`,
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
6. **Small leftovers of 1a (done in `0a155f3`):** the desk's shift heading and the "Shops on <day>" table on Cash
   shifts still show the shop name or code without its number: add `shopLabel` to
   `CashierShiftView` and `label` to `ShopDayView` (contracts, `shiftView` / `shopDaySummary`),
   then show them. The e2e agents spec closes the shop it adds (an open second shop would stop the
   demo cashier without a shop from opening a shift in `cashier.spec.ts`).

## Phase 2 design (agent balance; money path, main session on Opus, high effort)

**Status 19 Nov:** steps 1, 2 and 3 built (migration `0068_agent_balance`; database `6b813e1`,
API `5911deb`, screens next): the account `agent:<id>:balance` (kind `agent_balance`,
`ledger_accounts.agent_id`, never below zero), top-ups and take-backs in `agent_topups`
(`packages/db/src/retail/topups.ts`; four eyes in the service and a database check; one bank
reference once), balances on the Agents pages and the owner's overview. **Changed from the design
below:** top-ups post against `house:agent_funding`, not `house:psp:cash`, because the PSP
clearing accounts reconcile against player deposits and payouts only (a top-up there would show
as a reconciliation mismatch). **Step 4 built 19 Nov** (`078dbfa`, `9e5c943`; full checks
passed), exactly as in "Step 4 design detail" below: provider `agent_cash`, the admin's switch on
the agent page, the reconciliation check `agent_cash_records`. **The shop app's desk for player
cash built 19 Nov** (API `54d8aca`; screens and the receipt page in the shop app, e2e
`e2e/tests/shop-desk-cash.spec.ts`): `/shop/desk/players`, `deposits`,
`withdrawals`, `receipts` (print, reprint), on the same functions as the back office's desk
(`apps/api/src/modules/admin/desk-operations.ts`, both desks now call them). The shop app's
cashier is never a supervisor (above the shop's threshold the back office takes it; only their own
receipts), works only their own open shift at their own shop (409 `shift_other_shop`), shares the
back office's per-cashier rate limits, and sees whether player cash is on and the agent's balance
(`GET /shop/desk`: `playerCash`, `agentBalance`). **Next:** the reconciliation of agent balances
against top-ups once tickets move them (phases 3 and 4).

Read `packages/db/src/ledger/` first (`accountKey`, `HOUSE_KEYS`, `postTransaction`, the
`ledger_accounts` checks) and `packages/db/src/cashier/desk.ts` (`cashDeposit`: how a desk deposit
posts today with `house:psp:cash`).

1. **Account.** A ledger account per agent: `AccountRef { kind: 'agent_balance'; agentId }`, key
   `agent:<uuid>:balance`, `allowNegative: false` (prepaid: never below zero). The
   `ledger_accounts` owner check allows `user` or `house` today: either add an `agent` owner type
   with an `agent_id` column (migration; the cleaner choice) or keep `house` with the agent in the
   key. Nahubet HQ (agent 1000) has no balance account: its shops keep `house:psp:cash`.
2. **Top-ups (four eyes; owner: cash or bank at HQ only).** Table `agent_topups` (agent, amount,
   method `cash` | `bank`, bank reference, requested_by, approved_by, status `requested` |
   `approved` | `rejected`, timestamps; `REVOKE UPDATE, DELETE` except the status columns, or an
   append-only decision row). An admin records it (`agents.manage`); a second admin or finance
   approves (`withdrawals.approve`, never the one who recorded it); the approval posts
   `house:psp:cash` → `agent:<id>:balance` with the idempotency key `agent-topup:<id>` in the same
   transaction, plus an outbox event. Rejection posts nothing. All audited.
3. **The agent takes money back** (closing, or too much prepaid): the same four-eyes flow the
   other way, refused above the balance.
4. **Player cash at an agent's shop** (switch `player_cash_enabled` per agent, `agents.manage`):
   `assertPlayerCashAllowed` lets an agent shop through only when the switch is on; a deposit
   posts `agent:<id>:balance` → `user:<id>:cash` (refused above the balance: 409
   `agent_balance_low`), a cash withdrawal pays out of the player's withdrawal hold into
   `agent:<id>:balance`; HQ shops keep posting to `house:psp:cash` as today. The receipts, shift
   totals and the reconciliation's `movementProblem` must know the new account.
5. **Back office:** the agent page shows the balance, the top-up list with Record / Approve /
   Reject, and the ledger lines of the agent; the Agents list shows each balance and a low-balance
   mark. The shop app's desk shows the balance (read-only).
6. **Tests:** postings sum to zero and the balance never goes negative (property test on the core
   rule), four eyes refused for the same admin, idempotent approval, player cash refused with the
   switch off or the balance too low, reconciliation clean after a day of agent operations.

### Step 4 design detail (player cash at an agent's shop; written 19 Nov from the code)

Reconciliation (`packages/db/src/compliance/reconciliation.ts`, `checkPayments`) requires every
succeeded payment intent and paid payout to have exactly one PSP clearing entry of its provider
(`psp_records`, `psp_daily_totals`). Player cash at an agent's shop moves the agent's balance, not a
PSP clearing account, so it gets its own provider name **`agent_cash`** (add it to
`PaymentRecordProviderSchema` in `packages/contracts/src/payments.ts`):

- **Deposit** (`cashDeposit` in `packages/db/src/cashier/desk.ts`): at an agent's shop with
  `player_cash_enabled` (else 409 `agent_player_cash_off`, as today), the intent has provider
  `agent_cash` and posts `agent:<id>:balance −amount, user:<id>:cash +amount` (type `deposit`, so
  deposit limits count it); `InsufficientFundsError` → 409 `agent_balance_low`; DEPOSIT_SUCCEEDED
  as today (AML, notices). HQ shops keep provider `cash` and `house:psp:cash`.
- **Withdrawal** (`cashWithdrawal` in `packages/db/src/cashier/withdrawals.ts`): `requestWithdrawal`
  with provider `agent_cash` at an agent's shop; paying it posts
  `house_withdrawals_pending −amount, agent:<id>:balance +amount` (the agent paid the cash out of
  their drawer). `markPayoutPaid` gets an optional `paidTo: AccountRef` used instead of the
  provider's clearing account (only with `cashDesk: true`); `cash_payout_desk_only` and
  `claimDuePayouts` treat `agent_cash` like `cash`. A waiting approved payout is paid only at a shop
  of its kind (`cash` at HQ shops, `agent_cash` at agent shops).
- **Reconciliation:** exclude provider `agent_cash` from `psp_records` and `psp_daily_totals`, and add
  a check `agent_cash_records`: every succeeded `agent_cash` intent has exactly one
  `agent_balance` entry of −amount in its transaction, every paid `agent_cash` payout one of
  +amount, and every `agent_balance` posting belongs to an approved top-up, such an intent or such
  a payout.
- **Tests:** deposit refused with the switch off and above the balance; deposit and withdrawal move
  the balance; replay; reconciliation clean after a day of agent player cash.

## Phase 3 design (selling tickets; money path, main session on Opus, high effort)

Written 19 Nov from the code. A shop ticket **is a bet** (`bets`, `placeBet`, `settlePlacedBet`),
so odds checks, limits, liability caps, idempotency, voids, tax and result corrections are the
online ones. What differs is who stands behind it and where the money comes from and goes to.

**Who bets.** Each agent (Nahubet HQ 1000 included) has one counter bettor: a `users` row that
`agents.counter_user_id` points to (made with the agent's first ticket). It is never a player:
phone `shop:<agent number>` (no digits a person can type), a password hash nothing matches,
status active. Its bets serialise on its user lock (one agent's shops queue on one row). Result
messages to it go nowhere (it never signs in; SMS texts only go to SMS and USSD bets).

**Money** (accounts in `packages/db/src/ledger/`):

| What happens            | Type                   | Entries                                                          |
| ----------------------- | ---------------------- | ---------------------------------------------------------------- |
| Ticket sold, agent shop | `bet_stake`            | agent:<id>:balance −stake, house:stakes +stake (409 balance low) |
| Ticket sold, HQ shop    | `bet_stake`            | house:retail_cash −stake, house:stakes +stake                    |
| Ticket cancelled        | `retail_ticket_cancel` | house:stakes −stake, the same account +stake                     |
| Settled won             | `bet_payout`           | house:retail_payable +net, tax payable +tax, stakes, revenue     |
| Settled void            | `bet_refund`           | house:stakes −stake, house:retail_payable +stake                 |
| Settled lost            | `bet_payout`           | as online (stakes → revenue)                                     |

`house:retail_cash` (new, may go negative) is the ticket cash in HQ's own drawers: the PSP
clearing account `house:psp:cash` reconciles against player deposits and payouts only. Nothing a
ticket wins ever reaches a wallet or the agent's balance at settlement: it waits in
`house:retail_payable` (new) until the shop pays the holder (phase 4: retail payable → the agent's
balance or HQ's retail cash). Settlement must therefore route shop tickets this way **from
phase 3 on**, even though paying comes in phase 4; corrections reverse and repost as online.

**Step 1, database** (migration `0070_retail_tickets`; `packages/db/src/retail/tickets.ts`):

- Enum values: `bet_channel` `shop`; `bet_status` `cancelled`; `ledger_account_kind`
  `house_retail_payable`, `house_retail_cash`; `ledger_transaction_type` `retail_ticket_cancel`
  (checks in the same migration compare `::text`).
- `agents.counter_user_id` (above); `agents.ticket_limits` jsonb (an admin's overrides of the
  defaults in `packages/core/src/retailtickets.ts`: max win ETB 500,000, max stake ETB 100,000
  (never above the max win), min stake and most matches and min odds as online, sales per day
  none, cancel window 5 minutes, HQ approval above ETB 10,000, expiry 30 days).
- `retail_tickets`: id, `bet_id` (unique), agent, shop, cashier, shift, optional customer phone,
  stake, status (`sold`, `cancelled`; phase 4 adds paid and expired), who and when cancelled and
  why, print count and the original's time. Never deleted. The ticket number and barcode are the
  bet's short id.
- `placeBet` gains a funding option (default: the player's wallet, unchanged): `retail` names
  the account the stake comes from, refuses any live or started leg (409 `selection_unavailable`,
  reason `started`: shops sell prematch only), uses channel `shop`, writes the cashier as the
  audit actor, and maps a low balance to 409 `agent_balance_low`.
- `sellRetailTicket`: the cashier's own open shift at an operating shop of an active agent; the
  agent's limits merged into the bet rules (so the max win is in the bet's terms and settlement
  caps by it); sales per day per agent; then `placeBet` and the `retail_tickets` row, audited,
  outbox `retail.ticket_sold`.
- `cancelRetailTicket`: the cashier within the cancel window after the sale, later the agent owner
  or an admin; always before the first kick-off and while the bet is open; posts the stake back,
  bet → `cancelled`, ticket → `cancelled`; once only (row lock, the same answer again).
- Settlement (`settle.ts`): channel `shop` uses the retail posting above; the result notification
  is skipped for counter bettors.
- Shift totals and the close count include tickets sold minus cancelled; reconciliation checks
  `retail_payable` (settled shop tickets' net payouts, minus paid from phase 4) and `retail_cash`.
- Tests (real Postgres): sale from the balance and refusal when low; limits; prematch only;
  replay; cancel window, kick-off and roles; won/void/lost settlement and a correction; shift
  totals; reconciliation clean; a property that balance + stakes + payable is conserved.

**Step 1 built 20 Nov** (migration `0070_retail_tickets`; `packages/db/src/retail/tickets.ts`,
`packages/core/src/retailtickets.ts`; tests `packages/db/test/retail-tickets.test.ts`). A match
counts as started at its kick-off or as soon as it is no longer scheduled (live early). Not done
yet: the admin's settings screen for the global defaults (they are constants until step 2).

**Step 2 built 20 Nov** (contracts `packages/contracts/src/retail-tickets.ts`; routes in
`apps/api/src/modules/shop/routes.ts` and `admin/agents.ts`; views `shop/ticket-views.ts`; tests
`apps/api/test/shop-tickets.test.ts`): `POST /shop/desk/tickets/check` (live or started matches
come back unavailable with reason `event_started`), `/shop/desk/tickets/picks` (Game ID + pick),
`GET /shop/desk/booking-codes/:code`, `POST /shop/desk/tickets` (sell), `GET /shop/desk/tickets`
(the shift's) and `/:id` (own only), `/:id/print` (original once, then counted copies; never a
cancelled one), `/:id/cancel`; `POST /shop/owner/tickets/:id/cancel`;
`GET|PUT /admin/agents/:id/ticket-limits` (view: agents.view; set: agents.manage) and
`POST /admin/retail-tickets/:id/cancel` (agents.manage). A ticket's bet view never offers a
cash-out. **Next: step 3** (the shop app's sell screen and printed ticket).

**Step 3 built 20 Nov** (shop app: `/sell` with Game ID + pick and booking codes, the check
before printing with "Remove all started" and "Accept new odds", `/ticket/[id]` printable at the
shop's paper width with the Code128 barcode (`packages/core/src/code128.ts`,
`apps/shop/src/components/barcode.tsx`), cancel while the window is open, the shift's tickets on
the desk; back office: the "Ticket limits" card on the agent page; e2e
`e2e/tests/shop-tickets.spec.ts`). **Added 20 Nov:** the sell screen's match list (upcoming
football of the next 48 hours from `GET /shop/desk/matches`, search by team, a pick adds the leg)
and the printed footer in Amharic too (a native speaker still has to review the wording).
**Phase 3 is complete.**

**Step 2, API (as designed):** `/shop/desk/tickets/check` (each leg's state: started or suspended in red,
changed odds), `POST /shop/desk/tickets` (sell, idempotency key), `GET /shop/desk/tickets/:id`,
`POST /shop/desk/tickets/:id/cancel`; building by Game ID + pick (`packages/core/src/textcommand.ts`
`PICK_CODES`) and by booking code (`loadBookingCode`); the owner and admin cancel routes; an
admin's limits per agent and the `retail_tickets` settings.

**Step 3, shop app:** the sell screen (Game ID + pick, booking code, a match list), the check
before printing (remove started matches, accept changed odds), the printed ticket in English and
Amharic with a Code128 barcode drawn as SVG (a pure encoder in `packages/core` with tests),
cancel. **Step 4:** e2e, docs.

## Phase 4 design (paying tickets; money path, main session on Opus, high effort)

Written 20 Nov from the code, after phase 3 steps 1 and 2. Settlement already sends what a shop
ticket wins (or a void stake) to `house:retail_payable` (phase 3); paying takes it out to the cash
account of the shop that pays.

| What happens                  | Type                   | Entries                                            |
| ----------------------------- | ---------------------- | -------------------------------------------------- |
| Paid at the agent's shop      | `retail_ticket_payout` | house:retail_payable −net, agent:<id>:balance +net |
| Paid at an HQ shop            | `retail_ticket_payout` | house:retail_payable −net, house:retail_cash +net  |
| Winning ticket expired unpaid | `retail_ticket_expiry` | house:retail_payable −net, house:revenue +net      |

The agent paid the holder cash from its drawer, so Nahubet owes the agent that much: its balance
grows (the mirror of a sale). HQ's retail cash is cash in hand (negative), so paying out moves it
back up.

**Step 1, database** (migration `0071_retail_payouts`; `packages/db/src/retail/payouts.ts`):

- Enum values: `retail_ticket_status` `paid`, `expired`; `ledger_transaction_type`
  `retail_ticket_payout`, `retail_ticket_expiry` (checks compare `::text` in the same migration).
- `retail_tickets` columns: `paid_at`, `paid_by`, `paid_shift_id`, `paid_amount`,
  `payout_transaction_id`; HQ approval: `approval_requested_at`, `approved_by`, `approved_at`
  (four eyes: the approver is never the cashier who asks); `expired_at`. Checks: paid ⇔ paid_at,
  paid_by, paid_shift_id and payout_transaction_id set; approved_by ≠ paid_by.
- `findTicketByNumber(exec, number)` (the bet's short id, case and spaces ignored) → the ticket and
  its state for the pay screen: open (not settled), lost, won or void (payable: the net to pay),
  paid, expired, cancelled, waiting for HQ.
- `payRetailTicket(tx, { number, staffId, shiftId, idempotencyKey, now })`: the cashier's own open
  shift at **the shop that sold it** (409 `ticket_other_shop`: "paid at the shop that sold it");
  the bet `won` or `void` (409 `ticket_not_payable` with its state); not paid or expired (paid
  once: the ticket's row lock; the same key again answers with the same payout); above the agent's
  `hqApprovalAbove` it needed an approval first (**removed 21 Nov 2026**, owner: cashiers pay any
  winning ticket alone; docs/plans/counter-codes-and-deposit-recovery.md, O6); posts the payout above for the bet's `settled_net_payout`, sets paid fields, audited,
  outbox `retail.ticket_paid`. A correction that later turns a paid ticket into a loser is blocked
  by settlement (retail payable never below zero) and reported, as for players.
- ~~`decideRetailPayout`~~: removed 21 Nov 2026 with the HQ approval (O6).
- `expireRetailTickets(tx, { now })` (worker, daily): won or void tickets not paid within the
  agent's `expiryDays` after their last match → `retail_ticket_expiry`, status `expired`.
- Shift totals: payouts paid in the shift leave the drawer (expected cash − paid). Reconciliation:
  `retail_payable` = settled net of won/void shop tickets − paid − expired; the agent-balance check
  accepts `retail_ticket_payout` postings that match a paid ticket.

**Step 1 built 20 Nov** (migration `0071_retail_payouts`; `packages/db/src/retail/payouts.ts`:
`findTicketByNumber`, `payRetailTicket` (the selling shop only, paid once, `approval_required`
above the agent's HQ limit), `decideRetailPayout` (four eyes), `listWaitingRetailPayouts`,
`expireRetailTickets`; settlement blocks a correction of a paid ticket; shift totals and
reconciliation count payouts; tests in `packages/db/test/retail-tickets.test.ts`). **Step 2
built 20 Nov:** `GET /shop/desk/tickets/lookup?number=` (only the cashier's own agent's tickets),
`POST /shop/desk/tickets/payouts` (paid, or `approval_required`), the ticket view's `payState`,
`payAmount`, `paidAt` (the payout slip prints from it), `GET /admin/retail-payouts` and
`POST /admin/retail-payouts/:id/approve|refuse` (withdrawals.approve), and the worker's hourly
`retail-ticket-expiry` task (`apps/worker/src/tasks/retail-expiry.ts`); tests in
`apps/api/test/shop-tickets.test.ts`. **Next: step 3** (the pay screen and slip, the back
office's waiting payouts page) and e2e. **Step 3 built 20 Nov** (shop app `/pay`: scan or type
the number, the state banner, Pay with confirm, `/payout/[id]` slip with barcode; back office
`/retail-payouts`: approve or refuse; e2e `e2e/tests/shop-payouts.spec.ts` sells a ticket, waits
for the simulator's result and pays it or shows it lost). **Phase 4 is complete.** Not covered by
e2e: the HQ-approval path through the screens (API and database tests cover it).

**Step 2, API:** `GET /shop/desk/tickets/lookup?number=` (any ticket of the shop's agent: its
state), `POST /shop/desk/tickets/payouts` (pay, idempotency key), the payout slip
(`/shop/desk/tickets/:id/payout-slip` data for printing), `/admin/retail-payouts` (waiting list,
approve, refuse). **Step 3:** the pay screen (scan or type; barcode scanners type the number and
Enter), the payout slip, the back office's waiting list. **Step 4:** the worker's expiry task, e2e.

## Phase 5 design (statements and commission, live monitor, alerts; written 20 Nov from the code)

The owner's answers settle the money side: commission is set per agent, counted weekly, and **paid
by the admin outside the system** (the top-up question's "commission into balance" was not chosen;
top-ups are cash or bank at HQ only). So a statement is a report plus a "paid" record: no ledger
posting. Weeks are Monday 00:00 to Monday 00:00, Addis Ababa time (UTC+3), like the cash reports.

1. **Statements (database and worker).** Table `agent_statements` (agent, `week_start` date, unique
   together; the figures below, fixed when made; the agent's commission kind and basis points at
   that moment; the commission; `paid_at`, `paid_by`, `paid_reference`; never deleted, only the
   paid columns change, once). Figures, all santim, for the agent's shops in the week:
   - tickets sold (count, stakes) by `retail_tickets.sold_at`; cancelled (count, stakes) by
     `cancelled_at`;
   - settled: the stakes and the gross payouts (`bets.settled_gross_payout`) of the agent's tickets
     whose bet settled in the week (`bets.settled_at`), voids left out of both; **GGR** = settled
     stakes - settled gross payouts (can be negative);
   - paid at the counter (count, `paid_amount`) by `paid_at`; expired winners (count, net payout) by
     `expired_at`;
   - player cash at the agent's shops (`cash_operations`, deposits and withdrawals) by `created_at`;
   - the agent balance at the week's start and end (the ledger entries of `agent:<id>:balance`
     before each moment).
     Commission (pure, `packages/core`, unit and property tests): `stake` kind: (sold stakes -
     cancelled stakes) x bps / 10000; `ggr` kind: max(0, GGR) x bps / 10000; rounded down. A worker
     task makes last week's statements for every independent agent (not HQ) every hour from Monday
     01:00 Addis time on (idempotent: one per agent and week), so a missed run catches up.
2. **Back office.** `agents.view` reads, `agents.manage` marks paid: a Statements page (a week
   picker, one row per agent with the figures and the commission, CSV export, "Mark paid" with the
   payment reference, audited) and the agent page's last weeks. The owner's overview in the shop
   app shows the owner's own statements (read-only).
3. **Live monitor.** A back-office page polling every 15 s: the newest tickets of every shop
   (filter by agent, shop, cashier: number, shop, cashier, stake, possible win, status, time) and
   today's sales, cancels, payouts and balance per agent. Read-only queries on the indexes that
   exist (`retail_tickets_agent_sold_idx`, `retail_tickets_shop_sold_idx`).
4. **Alerts.** Table `retail_alerts` (kind, agent, shop, ticket or staff, details, a dedup key per
   kind and subject and day, `acknowledged_at`/`by`); a worker task every 5 minutes raises: a
   possible win above a threshold (setting, default ETB 100,000), the same selections sold 3 or more
   times across shops within 2 hours, 5 or more cancels by one cashier in a day, a ticket sold within
   2 minutes of its first kick-off, an agent balance below a threshold (setting, default ETB 1,000),
   a payout waiting for HQ longer than 30 minutes, a device waiting for approval. Each new alert is
   also one `error` log line with an `alarm` field (the repository's alarm convention). A
   back-office Alerts page lists them with Acknowledge.

Build order: 1, 2, 3, 4; each step committed with its tests. **Built 20 Nov:** the backend (the
first account's steps 1-4: `ae65e0d`, `683dc51`, `7de5bc7`, `12c1bbe`) and the screens (back
office `/statements`, `/retail-monitor`, `/retail-alerts`, the agent page's weekly statements, the
owner's statements in the shop app; e2e `e2e/tests/agent-statements.spec.ts`). The big-win and
low-balance thresholds (defaults ETB 100,000 and ETB 1,000) are settings since 20 Nov: settings
key `retail_alerts`, `GET`/`PUT /admin/retail/alert-thresholds` (agents.manage, audited), the form
on `/retail-alerts`; the worker reads them on every scan. The HQ payout approval has its own e2e
(`e2e/tests/shop-payout-approval.spec.ts`).

## Defaults chosen here (all adjustable by an admin)

Maximum win per ticket ETB 500,000 (as online today); maximum stake ETB 100,000 (as online); HQ
approval above ETB 10,000 (the desk's four-eyes limit); cancel window 5 minutes; ticket expiry 30
days after the last match; player cash at shops off for a new agent.

## Open for the owner

- DNS record `shop.nahubet.com`.
- The winnings tax: a placeholder of 20% of net winnings above ETB 100 (Proclamation 1395/2025, to
  confirm), the same for shop tickets as online.
- Agent licensing with the regulator before real money (licensed mode).
- ~~The Android POS model~~: decided 22 Nov 2026, many devices (phase 6).
- Later: may a registered player's winning ticket be paid into their online account instead of
  cash?

## Phase 6: many POS devices (owner, 22 Nov 2026)

The owner decided that the shop app supports several POS devices, not one model. One shop app (the
web app the shops use today) runs on all of them; only printing and scanning differ by device:

| Need   | Way                                                                                                             | Devices                                                                                                                     | State    |
| ------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| Print  | The system print dialog (or silent with Chrome's `--kiosk-printing`), 58 or 80 mm pages                         | PCs and laptops with a printer driver; Android terminals whose printer is in Android's print menu                           | Built    |
| Print  | Direct thermal printing from Chrome (Web Bluetooth, WebUSB): the ticket drawn as an image, so Amharic prints    | Bluetooth 58/80 mm printers next to a phone or tablet; terminals whose built-in printer is a Bluetooth device; USB printers | To build |
| Print  | A small Android app (a web view plus the maker's printer kit), only for a model the two ways above cannot reach | One model at a time, when an agent has one                                                                                  | Later    |
| Scan   | Scanners that type like a keyboard (USB, Bluetooth, the scanner built into many terminals)                      | All                                                                                                                         | Built    |
| Scan   | The camera (Chrome's barcode reader) on phones and terminals without a scanner                                  | Android phones and terminals                                                                                                | To build |
| Screen | The shop app on 5 to 6 inch screens                                                                             | POS terminals and phones                                                                                                    | To check |

The shop app's Printer page chooses the way per device (remembered on the device). Buy one or two
test units before building the direct printing: an Android terminal with a built-in 58 mm printer
and a cheap Bluetooth 58 mm printer, next to the PC with a USB 80 mm printer that works today.

## Sell page, top-up balance and print settings (owner, 24 Nov 2026)

The owner's report from the live shop: "insert booking code or slip id, insert stake and when I hit
Sell and print the button gets busy and deactivated; the printer works (test print). Also it does
not show which matches and odds are selected. The cashier should adjust print font, bold and other
parameters. The desk should show the top-up from HQ, tell the cashier to ask the agent owner to
refill before it runs out, and when it is empty the shop cannot sell."

- **Why the button looked busy.** "Sell and print" stayed disabled until the ticket was checked
  again with the typed stake (the separate Check button), and every disabled button showed the
  busy cursor (`cursor: wait`). Nothing was sold or stuck. The ticket (the loaded matches) sat at the
  very bottom, under a list of 20 or more matches, so on a phone it was never seen.
- **Sell and print in one press.** Enabled as soon as the ticket has a match and a stake; it checks
  the odds with that stake and, when nothing changed, sells and opens the ticket to print. A change
  (odds, a closed match, a stake rule) stops it and shows on the ticket, with Accept new odds. The
  ticket is also checked by itself half a second after the last change, so the possible win shows
  and the press usually sells at once. Under the button: why it cannot sell yet ("Add a match",
  "Type the stake"). A disabled button shows "not allowed", only a working one the busy cursor.
- **The ticket where it is seen.** Order: booking code or slip ID, the ticket, Game ID, the match
  list. On a wide screen the ticket stays beside them (sticky); on a phone a bar at the foot
  ("Ticket: 2 matches · odds 4.36 · Show ticket") leads back to it. Each match shows its league,
  Game ID, kick-off, the match, the market, the pick and the odds (`QuoteLeg.competitionName`,
  `startTime`, sent by the API with every quote).
- **A slow answer.** After 8 seconds the page says it is still waiting. No answer, or a server error:
  pressing again is safe (the same idempotency key replays the sale). The sold ticket opens through
  the app's own navigation, and the browser loads it directly if that takes more than 4 seconds.
- **The payout code** reaches the ticket page in memory and in sessionStorage (it is printed once).
  When it did not arrive (a replayed sale, whose answer has no code), the original is not printed:
  the page says so and the cashier cancels and sells again. Opening a ticket page again later
  prints nothing by itself; the Print button makes a counted copy.
- **Top-up balance** at the top of the desk and the Sell page (agent shops; HQ's own shops have
  none): the amount, and at or below HQ's low-balance threshold (Back office → Agents → Alerts,
  ETB 1,000 by default) "tell the agent owner to top up at Nahubet HQ before it runs out"; at zero
  "no ticket can be sold until the agent owner tops up". The ledger already refuses a ticket above
  the balance (409 `agent_balance_low`), and the Sell page warns when the stake is above it. The
  owner's overview shows the same warnings. `GET /shop/desk` has `agentBalanceLowAt`,
  `GET /shop/owner` has `balanceLowAt`.
- **Print settings on each device** (Printer page): text size (10 to 22 px), bold, line spacing,
  font (monospace, sans-serif for clear Amharic, serif), paper width (the shop's, or 58 / 80 mm for
  this printer), side margin (0 to 6 mm) and barcode size. They are kept in the browser
  (`nahubet:print-settings`) and applied as CSS variables to every ticket, receipt, payout slip and
  shift report; the preview and the test print show them before saving.
- Tests: `apps/shop/src/lib/topup.test.ts`, `print-settings.test.ts`, `tickets.test.ts`,
  `apps/api/test/shop-desk.test.ts`, `shop-owner.test.ts`, `betting.test.ts`,
  `e2e/tests/shop-tickets.spec.ts` (empty top-up, the slip ID sold in one press, no reprint on a
  reload, print settings kept after a reload).

## Rules for every session of this work

- **Build on top of the server's branch.** Before every push:
  `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`
  (exit 0 = fine; otherwise merge it in first and run the checks again).
- **Model and effort by task** (CLAUDE.md): the money path (ledger postings, placement, settlement,
  payouts, migrations, security) in the main session on Opus, high effort; routine pages and forms
  to `routine-coder`; running checks to `quick-task`.
- Never touch the live server; the owner deploys.
