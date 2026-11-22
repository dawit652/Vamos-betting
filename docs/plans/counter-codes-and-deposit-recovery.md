# Counter codes, deposit recovery and service alerts (plan)

Written 21 November 2026. Status: **decided 21 Nov (O1-O9 below); steps 1 and 2 built, steps 3-8 to build.** Before every push, build on top of the
server's branch: `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor
FETCH_HEAD HEAD`. The next free migration number is **0079**.

## The owner's request (21 Nov 2026)

> Players without login can select odds and the system generates a 6-digit number; by telling the
> number to the cashier they can buy a ticket, and that number must be displayed on their ticket
> barcode. Also the system should generate a 6-digit number for money withdrawal; by telling that
> number they can get their money from the cashier. Non-logged-in players can only withdraw their
> money from the agent or the cashier they bought their ticket from. For players who logged in and
> deposited: if the system fails to credit their money, there must be a way on the admin dashboard
> to deposit it manually, and if it is not deposited they can send a message through Telegram so
> that admins get the information. Plus the system lists money sent but not deposited, by mapping
> it to the player who paid. If one of the APIs malfunctions, the system should notify admins
> frequently through Telegram. Make a plan to fix these gaps, add your recommendations and creative
> ways. Complete the agent shop app build.

## What already exists (do not build it again)

| Asked for                             | Already there                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code for a betslip without login    | Booking codes: `POST /booking-codes` works without login (`createSlipBookingCode`, user may be null), 6 symbols of `CODE_ALPHABET` (letters and digits), valid 72 hours. The shop's sell screen loads them (`loadBookingCode`). |
| The number on the ticket's barcode    | Each ticket has a ticket number (12 random digits + a 4-character check), printed with a Code128 barcode (`packages/core/src/code128.ts`, `apps/shop/src/components/barcode.tsx`).                                              |
| Paid only where it was bought         | A ticket is paid only at the shop that sold it (409 `ticket_other_shop`); any amount, no HQ approval (O6).                                                                                                                      |
| Cash in and out for logged-in players | Player cash deposit and withdrawal at a shop, switched on per agent (`player_cash_enabled`), from the agent's balance.                                                                                                          |
| Manual credit of a deposit            | **SMS rail only:** the review queue (`/sms`) lists unmatched and flagged incoming money, and staff press "Credit to player" (`creditSmsByStaff`).                                                                               |
| Money sent but not credited           | **SMS rail only:** `unmatched` messages in the review queue, and the reconciliation check (a message that paid with no credit behind it).                                                                                       |
| Telegram                              | A read-only bot: owner alerts (money alarms only, each at most every 6-24 hours: `OWNER_ALERT_POLICY`, owner's rule of 20 Nov) and the players' match menu.                                                                     |

## The gaps, and how to close them

### G1. A 6-digit number for a betslip (no login)

- New booking codes are **6 digits** (100000-999999), easy to say at the counter and to type on a
  POS keypad. Old letter codes keep loading until they expire (72 hours). Not secret: a code only
  loads a betslip. 900,000 numbers with a 72-hour life is plenty; retry on a clash. The existing
  rate limit (30 codes a minute per player) stays.
- The betslip shows it large, grouped "482 913", with "Tell this number to the cashier" in Amharic
  and English, and a **QR code** of it: most 2D barcode scanners read a phone screen, so the cashier
  scans instead of typing (creative, optional).
- Files: `packages/core/src/codes.ts` (a numeric code generator, unit and property tests),
  `packages/db/src/betting/booking.ts`, `apps/web/src/components/betslip/BookingCodePanel.tsx`,
  the shop's sell screen (accept both kinds).

**Built 22 Nov (step 2):** core `encodeBookingNumber`, `isBookingCode`, `formatBookingCode` (unit and
property tests); `createBookingCode` draws 100000-999999 and takes over a code whose slip has expired
(nothing prunes `booking_codes`, so the numbers are reused); `loadBookingCode` takes both kinds; the
betslip shows "482 913" with "Tell this number to the cashier to buy the ticket." (English, Amharic).
The QR code was left out (optional, O9).

### G2. The number on the ticket

- The ticket prints **"Booking code 482 913"** under the barcode.
- The **barcode stays the ticket number**: that is what pays the ticket. One booking code can be
  bought many times by many people, so it cannot identify a ticket.
- Files: the ticket print layout in `apps/shop` (and the receipt in `packages/core` if it builds
  the lines); `retail_tickets` gets `booking_code` (nullable) at sale.
- **Built 22 Nov (step 2):** migration `0079_retail_ticket_booking_code`; the sell screen remembers
  the code it loaded and sends `bookingCode` when the slip still holds exactly its matches; the API
  keeps it only then (`bookingCodeForTicket`: otherwise the ticket is sold without a code, never
  refused); the ticket prints "Booking code · የቦታ ማስያዣ ኮድ 482 913" under the barcode.

### G3. A 6-digit payout code for players without login

- At sale, each ticket gets a random **6-digit payout code**, printed on the customer's ticket
  only, stored **hashed** (never in clear, never shown on the cashier's screen).
- **Paying:** the cashier scans the barcode (or types the ticket number); the system asks for the
  payout code; the player says it; only then is "Pay" offered. Still only at the selling shop. Five
  wrong codes lock the ticket; HQ unlocks it.
- **Why it matters:** only the person holding the paper can collect. A cashier cannot pay out an
  unclaimed winning ticket to themselves, and a photo of the barcode alone is not enough.
- **Reprints never show the payout code** (otherwise a cashier could reprint to learn it). A lost
  ticket is HQ's case, against an ID.
- **Check a ticket without login:** a public page on the website (ticket number → open, won, lost,
  amount; never the code), and the same through the Telegram bot (it stays read-only).
- Money path (payout): main session, Opus. Files: `packages/db/src/retail/` (sale stores the hash,
  payout checks it with a constant-time compare, attempt counter), the shop's Pay screen, a
  migration (0078: `retail_tickets.payout_code_hash`, `payout_code_attempts`, `booking_code`).

**Built 22 Nov (step 3, migration `0081_retail_ticket_payout_code`):**

- **At sale:** a random 6-digit code (`encodePayoutCode` from CSPRNG bytes, no leading zero), kept
  only as `<salt>:<sha256>` in `retail_tickets.payout_code_hash`. `POST /shop/desk/tickets`
  returns it once in `payoutCode` (`ShopSellTicketResponse`, `cache-control: no-store`); an
  idempotent replay returns `null`, and no view, lookup or reprint ever contains it. The shop app
  hands it to the ticket page through this tab's sessionStorage, which deletes it on reading; the
  ticket prints "Payout code · የክፍያ ኮድ 482 913" in a dashed box, **on paper only** (CSS
  `print-only`: the screen never shows it), for that page view only.
- **At Pay:** a payable ticket with a code needs `payoutCode` (any spacing): 409
  `payout_code_required` without it. A wrong one is counted and committed (`payRetailTicket`
  returns `payout_code_wrong` instead of throwing; the API answers 409 with `{ attemptsLeft,
locked }`), and the fifth locks the ticket (409 `payout_code_locked`, audited
  `retail.payout_code_locked`). The code is checked only when the ticket is payable, so a lost,
  open or paid ticket never tests it. The Pay screen has the code field and shows tries left.
- **HQ:** `POST /admin/retail-tickets/:id/payout-code` (agents.manage) with `action: unlock` (the
  count starts again, the code is still asked for) or `waive` (a lost paper, after checking the
  holder's ID), a reason required, audited (`retail.payout_code_unlocked` / `_waived`). Not yet a
  button in the back office: call the route, or build the button with the public ticket check.
- **Tickets sold before the code** (no hash) are paid as before.
- **Check a ticket without login (step 3b, built 22 Nov):** `GET /tickets/:number` (public, 30 a
  minute per address, `no-store`) answers the state (open, lost, payable, paid, expired,
  cancelled), the amount and the shop that pays it; never the payout code, the phone or the
  cashier. The website's page `/ticket` (linked from Help; English and Amharic, Oromo and Tigrinya
  fall back to English) and the bot's `/ticket <number>` use it.

### G4. A 6-digit withdrawal code for logged-in players (cash at a shop)

- In the app: "Withdraw cash at a shop" → amount → a **6-digit withdrawal code**, valid 24 hours.
  The money is held at once, like any withdrawal request (limits, KYC, AML as today).
- At the shop: the player says the code; the cashier types it; the screen shows the amount and the
  player's name and masked phone; Pay. One use only, stored hashed, locked after five wrong codes
  per shop, refunded to the wallet when it expires unused.
- Builds on the existing player cash withdrawal (`cashWithdrawal`, provider `agent_cash`), which
  today starts at the counter.
- Decision O2: at any shop with player cash on.

### G5. A deposit that did not arrive (logged-in players)

1. **Re-check with the provider (Chapa, telebirr):** a button on the deposit in the back office asks
   the provider for the transaction's status (by our reference). If the provider says it was paid,
   the normal success path credits it: no hand-typed amount.
2. **Manual deposit (one admin, decision O5):** for a payment the provider cannot confirm
   automatically. An admin enters the player, amount, provider, the provider's transaction id and a
   reason, and credits it in one step. The transaction id is unique, so the same money is never
   credited twice. Posted through the application as a deposit (ledger, AML and limits as for any
   deposit), audited, and the player is told by SMS or Telegram; the safeguards under "Decisions"
   apply.
3. **"My deposit did not arrive"** in the app (logged in): provider, amount, time, the transaction
   id or the bank SMS reference. It creates a **deposit claim** in a back-office queue, and the
   system pairs it at once with any unmatched SMS or unconfirmed provider payment (same reference,
   same amount, payer phone = the player's phone). A unique pair is one click for an admin.
4. **Telegram:** a "Deposit problem" button on the bot. It asks for the phone number, amount and
   reference, creates the same claim and posts it to the admin chats. This makes the bot store what
   a player sends: decision O3, allowed (phone, amount, reference; kept 90 days).

**Built 22 Nov (step 4):**

- **Re-check:** `POST /admin/deposits/:id/recheck` (withdrawals.approve) asks the provider now
  (`queryDeposit`) and applies what it says through `applyDepositEvent`: a confirmed payment is
  credited the normal way, once. The worker's `deposit-reconcile` keeps doing it on its own
  schedule. Back office: "Re-check" next to an uncredited Chapa or telebirr deposit on the
  player's page.
- **Manual deposit (one admin, O5):** `POST /admin/users/:id/manual-deposits` with the new
  permission `deposits.credit` (admin only; `creditDepositByAdmin` in
  `packages/db/src/payments/manual-deposits.ts`). The player's own uncredited deposit is credited
  as itself at its amount (ledger key `deposit:<its id>`: a late provider confirmation changes
  nothing), or a new deposit at the amount that arrived. The provider's transaction id is usable
  once per provider (payment event `manual:<id>`; 409 `already_credited`). Ledger type `deposit`
  (O7: not withdrawable until played through), a reason required, audited
  (`payment.deposit_credited_by_admin`), the player told (DEPOSIT_SUCCEEDED), and above ETB 5,000
  (`MANUAL_DEPOSIT_ALERT_ABOVE`) the owner gets the alert `manual_deposit_credited`. Back office:
  "Credit by hand" on an uncredited deposit, and the form "Credit a deposit by hand" for a payment
  with no deposit, on the player's page.

**Built 22 Nov (step 5, G5.3):** "My deposit did not arrive" on the player's Deposit page
(`DepositClaim`): method (telebirr, CBE, Chapa, other), amount, when, the transaction id or SMS
reference, the paying phone and a note. `POST /payments/deposit-claims` (logged in, 5 a minute) and
`GET /payments/deposit-claims`; table `deposit_claims` (migration `0082_deposit_claims`). At most 3
open claims a player, one open claim per reference, payments of the last 30 days. A claim credits
nothing by itself (`packages/db/src/payments/deposit-claims.ts`).

### G6. Money sent but not credited, mapped to the player

A back-office page **"Money not credited"** (Finance):

- every unmatched or flagged incoming payment (SMS rail) and every provider payment without a
  credited deposit;
- each with a **suggested player** and the reason: the payer's phone is a registered player's
  phone; that player has an open or expired deposit of a near amount within a day; that player
  filed a claim (G5.3);
- an admin confirms and credits (one step, decision O5). **Never credited automatically**: the SMS rail's rule
  stays (another payer's phone or another amount is flagged for staff, never credited).
- A daily line in the owner's Telegram summary: how much money waits, and the oldest.

**Built 22 Nov (step 5, G6):** Back office → **Money not credited** (`sms.review`;
`GET /admin/money-not-credited`): unresolved incoming SMS (unmatched, ambiguous, flagged) and
provider deposits flagged instead of credited, oldest first, with the waiting total and the oldest;
each with its suggested players and why (the deposit it matched but flagged, the player's own
flagged deposit, the payer's phone, an SMS deposit of a near amount (ETB 1 or 1 %) opened in the day
before the money moved, a claim with the same reference or a near amount the same day), strongest
first; and the open claims with the money they pair with. Crediting uses the existing tools, which
take an optional `claimId` and answer the claim in the same transaction (409 `claim_other_player`
when the money would go to another player): "Credit to this player" (the SMS credit) and "Credit
by hand" (the manual deposit, `deposits.credit`). "Close" answers a claim without a credit, with a
note (`POST /admin/deposit-claims/:id/close`). Nothing is credited automatically. **The daily line**
(built 22 Nov): from 09:00 Addis time, while money waits, one Telegram line a day to the owner chats
(`money-not-credited` worker task, alarm `money_not_credited`, never an SMS).

### G7. Frequent Telegram alerts when a service fails

A **service health monitor** in the worker checks every minute:

- payments: Chapa and telebirr (their status endpoints or our last successful call), payment
  webhooks failing, the SMS gateway (the age of the last SMS from each collection handset);
- feeds: The Odds API (errors, credits), API-Football, mr-x's board and mr-z's `/api/health`;
- inside: the database, Redis, the outbox's age, the scraper and worker heartbeats.

Alerting (a category of its own, next to the money alarms):

- a service failing for 3 minutes in a row → Telegram to the admin chats at once;
- **repeated every 15 minutes while it stays down** (owner: "frequently");
  `SERVICE_ALERT_REPEAT_MINUTES`;
- "recovered after 42 minutes" when it comes back;
- a back-office page **Service health**: green, red and since when, per service.

**Step 1 built 21 Nov (`7f14b22`, migration `0078_service_status`):**

- Watched: Chapa and telebirr (deposit initiation in the API, the worker's deposit re-check), mr-x
  (also when it answers but has not read Hulusport: the PC, Chrome or tunnel is off), mr-z (also
  when its own poller stopped, from its local `/api/health`), API-Football results, and every
  enabled feed source (two failed runs in a row).
- The worker's `service-health` task looks every minute. Down 3 minutes → Telegram to
  `TELEGRAM_OWNER_CHAT_IDS`, repeated every 15 minutes exactly (even though
  `OWNER_ALERT_MIN_INTERVAL_MINUTES` is 30), never by SMS; then "works again" once. Each new outage
  is also an `error` log line with `alarm: service_down`.
- **Service health page built 22 Nov:** Back office → Service health (`dashboard.view`,
  `GET /admin/service-health`): each service up, down since when or not reported yet, with its last
  success and last error, judged by the worker's own rules (core `SERVICE_STALE_AFTER_MS`).
- Not yet:
  payouts' provider calls; the SMS handset keeps its own alarm (`sms_gateway_silent`, every 6 hours);
  the database or Redis being down cannot be alerted this way (the alerts go through them).
- Needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_IDS` on the server (docs/runbooks/telegram-bot.md).

### G8. Completing the agent shop app

Built: phases 0-5 (agents, shops, devices and sign-in, selling and paying tickets, player cash,
statements, live monitor, alerts, PIN reset at a shop). Left:

1. **Switch it on** (the owner): `docs/deployment.md`, "Shop app" (DNS, env, cloudflared route).
2. **G1-G4 at the counter:** sell by the 6-digit booking code; print the booking code; ask for the
   payout code at Pay; reprints without the payout code; player cash withdrawal by code.
3. **Shift report print** (the cashier's end-of-shift slip: sales, cancels, payouts, cash in and
   out, expected drawer): **built 22 Nov**: "Print the shift report" after closing a shift opens
   `/shift/<id>?print=1` in the shop app (`GET /shop/desk/shifts/:id`, the cashier's own shifts):
   opening float, player deposits and withdrawals, tickets sold, cancelled and paid, expected cash,
   counted, difference, note, and signature lines.
4. **Phase 6, Android POS:** waits for the owner's model. Recommendation: a POS with a built-in
   58 mm printer that runs Chrome (Sunmi V2s class). The shop app is a web page, so the first step
   is that page in Chrome on the POS, printing through the POS's printer service (RawBT or the
   maker's print service); a small Android wrapper only if that is not good enough.

## Recommendations and creative ways

- **Digits only for anything said aloud** (booking, payout, withdrawal codes), grouped in threes,
  read the same in Amharic and English.
- **QR on the phone, scanner at the counter:** no typing, no mistakes.
- **The payout code is anti-fraud for the owner**, not only convenience: only the paper's holder
  collects; reprints cannot leak it.
- **A deposit claim pairs itself** with the unmatched money: most cases solved in one click.
- **Tell the player** when a manual credit or a claim is resolved (SMS or Telegram).
- **One health page and one Telegram rhythm**: down → every 15 minutes → recovered, so nobody
  learns about an outage from players.
- **Weekly owner summary on Telegram:** money waiting, claims solved, top-selling shops, services
  down and for how long.

## Decisions (the owner, 21 Nov 2026)

| #   | Question                                             | Decided                                                      |
| --- | ---------------------------------------------------- | ------------------------------------------------------------ |
| O1  | When is the payout code made?                        | Printed on the ticket at sale                                |
| O2  | Logged-in cash withdrawal: which shops?              | Any shop with player cash on                                 |
| O3  | May the Telegram bot store a player's deposit claim? | Yes: phone, amount and reference only, kept 90 days          |
| O4  | How often to repeat a service-down alert?            | Every 15 minutes, plus "recovered"                           |
| O5  | Who approves a manual deposit?                       | **One admin is enough, no second approval** (owner's choice) |
| O6  | Do cashiers need approval to pay?                    | **No**: any counter withdrawal and any winning ticket, alone |
| O7  | What may a player withdraw?                          | **Winnings only**; deposited money is for betting            |
| O8  | Head office cashiers                                 | HQ has its own cashiers, apart from the agents' (built)      |
| O9  | Barcode or QR code                                   | Optional: every code can be typed (built)                    |

**O5 without a second approver**, the remaining safeguards (adjustable, nothing blocks the admin):
only staff with the admin role may credit (never a cashier); the provider's transaction id is unique,
so the same money is never credited twice; a reason is required; every credit is audited and listed
in the owner's daily Telegram summary; a credit above ETB 5,000 (a setting) also sends the owner a
Telegram message at once. G5.2 follows this: "propose" and "approve" are one step.

**O6 and O7 are built (21 Nov, second account):**

- **O6, cashiers pay alone.** A counter cash withdrawal of any amount is paid at once: no supervisor
  above the shop's threshold (deposits keep it) and no back-office review because of the amount (an
  exclusion, an AML hold or a pending settlement correction still holds it). A winning shop ticket
  of any amount is paid at once: the HQ approval, its back-office page "Ticket payouts", its routes
  and the "HQ approval above" limit field are gone (`hqApprovalAbove` stays readable in saved
  limits and is ignored). The shift totals and the owner's Telegram alerts still show big payouts.
- **O7, winnings only.** What may be withdrawn is the cash balance less the deposits not yet played
  through (core `withdrawableAmount`; `remainingWagering` is unchanged): deposit 1,000, stake 200,
  win 600, and 600 may be withdrawn at once while 800 stays for betting. Online and at the counter
  (422 `wagering_requirement_not_met`, details `{ remaining, withdrawable }`); `GET
/payments/withdrawals` returns `withdrawable`, and the withdraw page shows it. A player under an
  exclusion may still take out everything (to review), as before.
- **For the steps below:** a manual deposit (step 4, O5) must post the ledger type `deposit`, so the
  money counts as deposited (not withdrawable); any other credit type would count as winnings.

## Build order (one commit each, with tests; the full checks once before each push)

| Step | What                                                                  | Who                               |
| ---- | --------------------------------------------------------------------- | --------------------------------- |
| 1    | G7 service health monitor, Telegram rhythm, health page               | **Built 21-22 Nov**               |
| 2    | G1 numeric booking codes (web, shop) and G2 the code on the ticket    | **Built 22 Nov**                  |
| 3    | G3 payout code (sale, Pay, reprint, lock) and the public ticket check | **Built 22 Nov** (check page: 3b) |
| 4    | G5.1-2 provider re-check and manual deposit (one admin, O5)           | Main session (money)              |
| 5    | G6 "Money not credited" with suggested players; G5.3 claims           | **Built 22 Nov**                  |
| 6    | G5.4 Telegram "Deposit problem" (O3: allowed)                         | `routine-coder` + review          |
| 7    | G4 withdrawal code (O2: any shop with player cash on)                 | Main session (money)              |
| 8    | G8 shift report print; phase 6 when the POS model is chosen           | `routine-coder`                   |

Every decision is made: build the steps in this order.
