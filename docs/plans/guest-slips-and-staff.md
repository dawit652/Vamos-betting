# Guest slips, coupons, bet details and staff rules (plan)

Owner's request of 23 Nov 2026 (with Narobet screenshots as samples): "make a plan and implement
them; if the 5-hour limit reaches 95%, hand the task over to the second Claude Code account". Build
on top of the server's branch: before every push,
`git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.

What exists already:

- Booking codes: 6 digits. The betslip's "Share" makes one and "Load code" fills the slip from
  one (`apps/web/src/components/betslip/BookingCodePanel.tsx`). A shop sells a ticket from the
  code. The code holds the selections only, no stake (`booking_codes`).
- The public check of a shop ticket at `/ticket` (`apps/web/src/app/ticket/page.tsx`).
- My Bets for logged-in players.
- The owner reports for day, week, month and year (`docs/plans/owner-reports.md`).

## The items, in the order they are built

| #    | What                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GS1  | **Football · Today by default.** The site opens on Today instead of Highlights (`DEFAULT_TAB`).                                                                                                                                                                                                                                                                                                      | `apps/web/src/components/sportsbook/tabs.ts`                                |
| GS2  | **No padlocked rows.** A match is listed only while its main market (1X2 for football, the sport's first market) is open. Today a match with a suspended 1X2 but other open markets still shows padlocks (AC Monza v ACF Fiorentina on 23 Nov).                                                                                                                                                      | `openForBetting`, `apps/api/src/modules/catalog/queries.ts`                 |
| GS3  | **A slip ID for a guest.** A visitor who is not logged in presses Place bet: the slip gets a 6-digit slip ID (a booking code that now also keeps the stake, migration 0085), and the screen shows the selections, stake, total odds, potential win and "Awaiting cash payment: give the slip ID to any Nahubet shop". The shop sells it at the odds of the moment, with the stake already filled in. | `booking_codes.stake`, booking code API, `BetslipDrawer.tsx`, shop sell     |
| GS4  | **Load coupon and Check coupon** at the top of the betslip for everyone, as on the sample. Load coupon fills the slip from a slip ID, so the bet can be edited and placed again. Check coupon takes a slip ID or a ticket number and shows its state: not yet paid, sold as a ticket, won, lost or expired.                                                                                          | `BookingCodePanel.tsx`, `/ticket`, booking code status API                  |
| GS5  | **Several slips** (Slip 1, Slip 2, Slip 3) kept on the device, so a visitor can prepare several tickets.                                                                                                                                                                                                                                                                                             | betslip store (`apps/web/src/lib/betslip`)                                  |
| GS6  | **Slip history on the device** for guests: the slip IDs made on this device and their state (via Check coupon). Logged-in players keep My Bets.                                                                                                                                                                                                                                                      | web, local storage                                                          |
| GS7  | **Bet details.** Every placed bet, slip and ticket shows per selection the country, league, market and pick, the fixture and its kickoff time, and the live score while it is played where a source gives one.                                                                                                                                                                                       | contracts, My Bets, ticket check                                            |
| GS8  | **One person, several staff accounts** (admin, cashier, agent owner), each with its own email. Find what refuses it today (a unique phone, "the desk refuses owners") and allow it.                                                                                                                                                                                                                  | `packages/db/src/staff`, `retail`                                           |
| GS9  | **One admin is enough.** No second admin approves: manual payouts (today the approver never claims or settles), agent top-ups, collection accounts, PIN resets. Every such action is shown clearly in a new report section, "Admin money actions" (who, what, amount, when; CSV).                                                                                                                    | `payments/withdrawals.ts`, `retail/topups.ts`, collection accounts, reports |
| GS10 | **Every financial figure by day, week, month and year**: stakes (sales, online and shops), payouts, GGR, deposits, withdrawals, bonuses, the balances of players, agents and shops, and GS9's admin actions. Check what the owner reports already show and add what is missing, from the ledger only (CLAUDE.md, owner reports).                                                                     | `docs/plans/owner-reports.md`, reports                                      |

Open question for the owner (GS8/GS9): which actions are "very sensitive" and keep a second
person? Until the owner names them, the proposal is: none, everything audited and on the report.

## Also waiting (owner said "proceed", 23 Nov)

Steps 4a and 4b of `docs/plans/review-queue-automation.md`: mr-z is the main source (owner, 23
Nov).

- **4a.** Count a fresh mr-z kickoff of a linked match as an independent kickoff statement (C1):
  `loadKickoffEvidence` in `packages/db/src/scrape/kickoff.ts` and `assessKickoff` in
  `packages/scraper/src/gates/kickoff.ts`.
- **4b.** A fresh mr-z price backs opening for teams without ratings: `openOne` and
  `backedByMarket` in `apps/scraper/src/pipeline/auto-open.ts`. Such a match keeps the ETB 20,000
  payout cap of a board match.

## Also built 23 Nov

- **GS11. Agent owners' passwords** (owner, 23 Nov: "the system must generate and reset password
  for registered agents until they change to their password").
  - An agent owner's generated password now works until the owner changes it at the first
    sign-in, at creation and at a reset: no 72-hour limit for owners (`passwordUntilChanged`,
    `untilChanged` in `packages/db/src/backoffice/staff-auth.ts`).
  - Agent page → Owner account → "New password and authenticator" generates both, shows them once,
    clears a lockout and ends the owner's sessions (`resetAgentOwnerSignIn` in
    `packages/db/src/retail/owners.ts`, `POST /admin/agents/:id/owner-account/reset`).
  - Test: `packages/db/test/retail-owners.test.ts`.
- **The shop's device page explains itself.** Device registration accepts cashier accounts only.
  An admin's or owner's correct password was answered with a bare "Wrong email or password". The
  page now says who registers a device; the error says it may not be a cashier's account. It still
  never reveals which.
- **GS8, built** (first account, 24 Nov; the owner asked for one person's accounts under one email,
  not aliases). An email is unique per kind of account, not overall: one back-office account (any
  role but the two below), one agent owner's and one cashier's (migration 0087: the index
  `admin_users_email_kind_uq` over `admin_account_kind(role)`, an IMMUTABLE function because a fresh
  database adds those roles in the same migration run).
  - Sign-in looks for its own kind (`loginStaff`): the back office the back-office account, else the
    cashier's (head-office cashiers work its desk), never an owner's; the shop app the agent owner
    when the authenticator code is typed, else the cashier; a device request the cashier.
  - Creating a second account of a kind, or a role change into a kind the email already has, is 409
    `staff_email_taken`. Each account keeps its own password, authenticator and lockouts.
  - `pnpm admin:unlock` and `pnpm admin:reset` take `--account staff|agent_owner|cashier` (default
    the back-office account).
  - Test: `packages/db/test/shop-signin.test.ts` ("one person, several accounts").
- **GS3, built.** A visitor's Place bet makes a slip ID: `booking_codes.stake` (migration 0085),
  the booking code API with `stake`, the betslip's slip ID screen and the device's list of slip
  IDs (`nahubet:guest-slips`). The shop's sell-from-code fills in the stake. "Load code" now reads
  "Load coupon".
  - Tests: `packages/db/test/betting-booking.test.ts`, `e2e/tests/guest-slip.spec.ts`.

- **GS4, built** (first account, 23 Nov).
  - Load coupon and Check coupon sit at the top of the betslip, next to Share. Check coupon takes a
    slip ID or a shop ticket's number and opens `/ticket?number=`, which checks it at once.
  - `/ticket` ("Check coupon") reads both:
    - a ticket number as before (G3: state, what it pays, the shop);
    - a slip ID through `GET /booking-codes/:code/status` (`bookingCodeStatus` in
      `packages/db/src/betting/booking.ts`): awaiting cash payment (with its stake and expiry),
      sold as a shop ticket (when), or expired.
  - A slip ID can be guessed (6 digits), so its check never names the ticket, the shop or the
    result: the ticket number printed under the barcode checks those.
  - Only tickets sold since the slip was made count, because an expired number is reused for a new
    slip; a cancelled ticket does not count.
  - Migration 0086 indexes `retail_tickets (booking_code, sold_at)`, so the check never scans every
    ticket. The limit is 60 checks a minute per address, for GS6's list.
  - On a phone the betslip opens once something is picked; GS6 gives guests a way to it without a
    pick.
  - Tests: `packages/db/test/betting-booking.test.ts`, `apps/api/test/shop-tickets.test.ts`
    ("Check coupon"), `apps/web/src/lib/coupon.test.ts`, `e2e/tests/guest-slip.spec.ts`.

## State

- **Built:** GS1, GS2, GS3, GS4, GS8, GS11, the device page text, the matchweek gap (24 Nov: a
  band between rounds of a league in every match list, `startsNewRound` in
  `apps/web/src/components/sportsbook/groups.ts`).
- **Next:**
  1. GS5 several slips, GS6 the device's slip list (the IDs are already stored in
     `nahubet:guest-slips`; their states come from `GET /booking-codes/:code/status`), GS7 bet
     details.
  2. GS9 and GS10 (money controls: main session). GS9 waits for the owner's answer: which actions
     keep a second person (advice given: money leaving Nahubet, or an authenticator code typed again
     plus a Telegram line when the owner is the only admin).
  3. 4a/4b.
