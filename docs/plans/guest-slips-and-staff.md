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

## State

- **Built:** GS1 and GS2 (see the commits after this plan).
- **Next:** GS3 and GS4, then the rest in order.
