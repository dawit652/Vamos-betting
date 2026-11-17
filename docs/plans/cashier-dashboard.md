# Cashier dashboard with a receipt printer

Owner's request of 17 Nov 2026: a cashier dashboard where operators pay players' withdrawals in
cash, deposit cash for players (also when an automatic deposit failed to arrive), control players,
and print receipts on a betting (thermal) printer, with the other features and parameters a betting
shop needs. Status: **phase 1 built 17 Nov 2026** (desk, shifts, cash deposits, receipts; see
"As built"); cash withdrawals next. It moves money: Opus, high effort, reviewed by a second model
before any deploy.

## As built (phase 1, 17 Nov 2026)

Owner decisions were not answered; built with the recommended defaults, each one a setting:
one shop (`main`, name and address editable), supervisor above ETB 10,000 per shop, 80 mm
receipts (58 mm as a setting), walk-in tickets later.

- **Cash is the payment provider `cash`.** A desk deposit is a `cash` payment intent credited at
  once with the ordinary deposit posting (`house:psp:cash` -amount, player cash +amount) and the
  ordinary `DEPOSIT_SUCCEEDED` event. So deposit limits, exclusions, AML, the player's history and
  SMS notice, the wallet push and reconciliation all treat it like any deposit (tested,
  reconciliation included). A withdrawal will be an ordinary payout of provider `cash` paid at the
  desk (same rules as online: KYC, wagering, daily cap, AML hold).
- **Data** (migration `0057_cashier_desk`): role `cashier`; `cashier_shops` (receipt header,
  width, approval threshold, active); `cashier_shifts` (one open shift per staff member; float,
  count, expected cash fixed at the close); `cash_operations` (the receipts: number, shift, shop,
  staff, player, amount, the intent or payout, the desk's idempotency key, copies). The app role
  cannot delete shifts or receipts.
- **Services** `packages/db/src/cashier/desk.ts`: `openShift`, `closeShift` (under the shift's
  lock), `cashDeposit` (replay-safe, also for two requests with one key; refuses above the shop
  threshold unless finance/admin; `assertDepositAllowed` for limits and exclusions),
  `findDeskPlayer`, `getReceipt`, `recordReprint`, `updateShop`, `listShifts`.
- **API** `apps/api/src/modules/admin/cashier.ts` under `/admin/cashier/*`: permissions
  `cashier.desk` (cashier, finance, admin), `cashier.reports` (finance, compliance, admin), shop
  settings with `settings.edit` (admin). The cashier role holds only the desk (no dashboard, no
  player list).
- **Back office**: `/cashier` (open shift, find player, cash deposit, receipts of the shift, close
  with count and a printable Z report), `/cashier/receipt/<id>` (80 or 58 mm, auto print; a copy
  says COPY and is counted and audited), `/cashier/shifts` (all shifts with variance; shop
  settings), `/cashier/shifts/<id>` and its printable report. Printing is the browser's print with
  `@page` named sizes: any thermal printer with a driver (Xprinter, Epson TM).
- **Demo**: `cashier@demo.vamos.test` (demo mode only, like the other demo staff). On the live
  server a cashier account is made with `pnpm admin:create` and role `cashier`.

## Next phases (in order)

1. **Cash withdrawal at the desk.** The player makes a one-time withdrawal code on their own phone
   (logged in: "Withdraw at a shop"), so the cashier never learns a PIN; at the desk: phone + code
   - amount → `requestWithdrawal` with provider `cash` (all online rules) → paid at once when
     auto-approved and under the shop threshold, else refused with the reason. The payout worker
     must never take a `cash` payout (`claimDuePayouts`: exclude provider `cash`). Receipt with a
     signature line.
2. **Failed automatic deposit**: link the desk to the existing tools (SMS rail review queue,
   flagged deposits) rather than a new credit path; a supervisor-only "credit by provider
   reference" if still needed.
3. **Player control** at the desk (block/unblock with reason, audited) and assisted PIN reset
   with ID check and four eyes.
4. **Variance posting**: a supervisor approves a closed shift's variance into the ledger
   (`adjustment`, house cash vs revenue); today the variance is recorded and shown, not posted.
5. **Original receipt printed once** (server-side flag) and silent ESC/POS printing if wanted.
6. Retail walk-in tickets (largest; later).

## Rules for every session of this work

- **Build on top of the server's branch.** The live server deploys from
  `live/nahubet-new-2026-11-15`; every commit of this work must contain it. Before every push:
  `git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`
  (no output and exit 0 = fine; otherwise merge it in first and run the checks again).
- **Model and effort by task** (CLAUDE.md): the money path (ledger postings, deposits,
  withdrawals, shift totals, migrations, security) stays in the main session on Opus, high effort;
  routine pages and forms go to the `routine-coder` agent; running checks and reporting goes to the
  `quick-task` agent.

## Where it lives

- The back office `apps/admin` (Next.js, :3001) already has staff sign-in, roles and pages for
  users, withdrawals, manual payouts (four eyes), KYC, risk, audit, settings and the SMS rail.
- Roles: `STAFF_ROLES` and `PERMISSION_ROLES` in `packages/contracts/src/admin.ts`. Add a
  `cashier` role (and permissions `cashier.desk`, `cashier.deposit`, `cashier.withdraw`,
  `cashier.ticket`, `cashier.shift`; supervisors approve with the existing `finance`/`admin`).
- Money is written only by services in `packages/db` (double-entry ledger, one transaction with
  the business row and its outbox event; see `packages/db/src/betting/postings.ts`,
  `packages/db/src/payments/deposits.ts`, `packages/db/src/payments/smsrail.ts`). Never by hand.

## Features (phases)

1. **Desk and shifts.** A cashier opens a shift with a counted float and closes it with a cash
   count; the system shows the expected cash; a difference is a variance posting that a supervisor
   approves (four eyes). X report (during) and Z report (closing), printable.
2. **Player lookup and control.** Find a player by phone or account id; see balance, KYC status,
   limits, self-exclusion and cool-off, recent bets and transactions. Block or unblock (audited,
   reason required). An excluded or blocked player cannot be served. Assisted PIN reset only with an
   ID check and four eyes (closes the "no staff reset" gap noted in the handover).
3. **Cash deposit.** Cashier takes cash and credits the wallet: ledger cash drawer (house asset,
   one account per shop or cashier) → player wallet; idempotency key per receipt; receipt printed.
4. **Failed automatic deposit.** Credit a telebirr/CBE/Chapa payment that did not arrive: the
   provider reference and amount are required, checked against the SMS rail review queue and the
   provider's receipt verifier when possible, never credited twice (unique reference), above a
   threshold a supervisor approves. Reuses the SMS rail's manual credit where it fits.
5. **Cash withdrawal.** The player proves the account (a code to the registered phone or Telegram,
   or the PIN) at the desk; wallet → cash drawer; limits; receipt with the player's signature line.
6. **Receipts and printing.** Every operation prints a receipt: shop, cashier, time, operation,
   amount in ETB, player (masked phone), receipt number, a QR code to verify it. First version:
   the browser's print with an 80 mm or 58 mm receipt layout (`@page { size: 80mm auto }`), which
   works with any thermal printer that has a driver (Xprinter, Epson TM). Reprints say COPY. If the
   owner wants silent printing: raw ESC/POS through Web Serial/WebUSB (Chrome) or a small local
   print agent like `apps/payout-agent`.
7. **Retail betting (walk-in customers).** The cashier places a bet for cash and prints a ticket
   with a barcode; winning tickets are paid at the desk by scanning; ticket expiry; winnings tax
   from `packages/core`. Largest phase; may wait.
8. **Reports and parameters.** Per shift, cashier and shop totals; exports. Settings: limits per
   transaction and per day per cashier, the four-eyes threshold, shop name and address on receipts,
   receipt width, the float, which operations a shop may do.

## Owner decisions needed first

Shops: one or several (and their names)? Cash limits per transaction and per day? The four-eyes
threshold? Can cashiers serve players who are not KYC verified, up to what amount? Which printer
model and paper width? Retail tickets for walk-in customers now or later? Licensed-mode conditions
for cash (regulator rules on cash deposits and payouts)?

## Tests

Ledger postings balance per operation; idempotency (the same receipt twice credits once); a
blocked or excluded player refused; limits and four eyes; shift close and variance; receipt
content; e2e in the admin app (Playwright) for deposit, withdrawal and shift close.
