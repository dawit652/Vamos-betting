# Counter codes, deposit recovery and service alerts (plan)

Written 21 November 2026. Status: **planned, not built.** Before every push, build on top of the
server's branch: `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor
FETCH_HEAD HEAD`. The next free migration number is **0078**.

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
| Paid only where it was bought         | A ticket is paid only at the shop that sold it (409 `ticket_other_shop`); big wins need HQ's approval.                                                                                                                          |
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

### G2. The number on the ticket

- The ticket prints **"Booking code 482 913"** under the barcode.
- The **barcode stays the ticket number**: that is what pays the ticket. One booking code can be
  bought many times by many people, so it cannot identify a ticket.
- Files: the ticket print layout in `apps/shop` (and the receipt in `packages/core` if it builds
  the lines); `retail_tickets` gets `booking_code` (nullable) at sale.

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

### G4. A 6-digit withdrawal code for logged-in players (cash at a shop)

- In the app: "Withdraw cash at a shop" → amount → a **6-digit withdrawal code**, valid 24 hours.
  The money is held at once, like any withdrawal request (limits, KYC, AML as today).
- At the shop: the player says the code; the cashier types it; the screen shows the amount and the
  player's name and masked phone; Pay. One use only, stored hashed, locked after five wrong codes
  per shop, refunded to the wallet when it expires unused.
- Builds on the existing player cash withdrawal (`cashWithdrawal`, provider `agent_cash`), which
  today starts at the counter.
- Decision O2 below: at any shop with player cash on, or only one agent the player picks.

### G5. A deposit that did not arrive (logged-in players)

1. **Re-check with the provider (Chapa, telebirr):** a button on the deposit in the back office asks
   the provider for the transaction's status (by our reference). If the provider says it was paid,
   the normal success path credits it: no hand-typed amount.
2. **Manual deposit, four eyes:** for a payment the provider cannot confirm automatically. One staff
   member proposes it (player, amount, provider, the provider's transaction id, a reason); **another**
   approves it. The transaction id is unique, so the same money is never credited twice. Posted
   through the application as a deposit (ledger, AML and limits as for any deposit), audited, and
   the player is told by SMS or Telegram.
3. **"My deposit did not arrive"** in the app (logged in): provider, amount, time, the transaction
   id or the bank SMS reference. It creates a **deposit claim** in a back-office queue, and the
   system pairs it at once with any unmatched SMS or unconfirmed provider payment (same reference,
   same amount, payer phone = the player's phone). A unique pair is one click (four eyes).
4. **Telegram:** a "Deposit problem" button on the bot. It asks for the phone number, amount and
   reference, creates the same claim and posts it to the admin chats. This makes the bot store what
   a player sends: decision O3.

### G6. Money sent but not credited, mapped to the player

A back-office page **"Money not credited"** (Finance):

- every unmatched or flagged incoming payment (SMS rail) and every provider payment without a
  credited deposit;
- each with a **suggested player** and the reason: the payer's phone is a registered player's
  phone; that player has an open or expired deposit of a near amount within a day; that player
  filed a claim (G5.3);
- staff confirm and credit (four eyes). **Never credited automatically**: the SMS rail's rule
  stays (another payer's phone or another amount is flagged for staff, never credited).
- A daily line in the owner's Telegram summary: how much money waits, and the oldest.

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

### G8. Completing the agent shop app

Built: phases 0-5 (agents, shops, devices and sign-in, selling and paying tickets, player cash,
statements, live monitor, alerts, PIN reset at a shop). Left:

1. **Switch it on** (the owner): `docs/deployment.md`, "Shop app" (DNS, env, cloudflared route).
2. **G1-G4 at the counter:** sell by the 6-digit booking code; print the booking code; ask for the
   payout code at Pay; reprints without the payout code; player cash withdrawal by code.
3. **Shift report print** (the cashier's end-of-shift slip: sales, cancels, payouts, cash in and
   out, expected drawer): if the shift screen does not print it already.
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

## Decisions for the owner

| #   | Question                                             | Recommended                                                     |
| --- | ---------------------------------------------------- | --------------------------------------------------------------- |
| O1  | When is the payout code made?                        | Printed on the ticket at sale (works with no phone and offline) |
| O2  | Logged-in cash withdrawal: which shops?              | Any shop with player cash on                                    |
| O3  | May the Telegram bot store a player's deposit claim? | Yes: phone, amount, reference only; kept 90 days                |
| O4  | How often to repeat a service-down alert?            | Every 15 minutes, plus "recovered"                              |
| O5  | Who approves a manual deposit?                       | A second admin (four eyes), never the one who proposed it       |

## Build order (one commit each, with tests; the full checks once before each push)

| Step | What                                                                  | Who                      |
| ---- | --------------------------------------------------------------------- | ------------------------ |
| 1    | G7 service health monitor, Telegram rhythm, health page               | Main session             |
| 2    | G1 numeric booking codes (web, shop) and G2 the code on the ticket    | `routine-coder` + review |
| 3    | G3 payout code (sale, Pay, reprint, lock) and the public ticket check | Main session (money)     |
| 4    | G5.1-2 provider re-check and manual deposit with four eyes            | Main session (money)     |
| 5    | G6 "Money not credited" with suggested players; G5.3 claims           | Main session             |
| 6    | G5.4 Telegram "Deposit problem" (after O3)                            | `routine-coder` + review |
| 7    | G4 withdrawal code (after O2)                                         | Main session (money)     |
| 8    | G8 shift report print; phase 6 when the POS model is chosen           | `routine-coder`          |

Steps 1 and 2 need no decision and can start at once.
