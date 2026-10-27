# Plan: Melabingo-style deposits and withdrawals (manual transfer)

Status: draft, not started. Scope: deposit and withdrawal only. No bingo or other games
(casino-style games stay excluded by policy).

## 0. Assumption to confirm first

The Melabingo site and its Telegram channel could not be reached while writing this plan. It assumes
Melabingo uses the pattern most Ethiopian bingo apps use:

- **Deposit.** The player picks telebirr or CBE and enters an amount. The app shows the operator's
  receiving number or account and the holder's name, with copy buttons. The player sends the money
  from their own telebirr or CBE app, then pastes the confirmation SMS or the transaction ID
  (telebirr `CHK…`/`DAx…`, CBE `FT…`). The app checks it and credits the balance.
- **Withdrawal.** The player enters an amount and a destination (telebirr number or CBE account). An
  operator pays it by hand from the operator account and marks it paid. The player gets a notice.

If Melabingo differs (for example a USSD push, a hosted checkout, or games played before withdrawal),
change sections 2–5 to match. Screenshots of each Melabingo screen would settle this.

## 1. What we reuse and what is new

Phase 6 already has intents, the ledger, idempotency, deposit limits, wagering, AML holds, KYC, the
withdrawal review queue and the admin withdrawals page. This plan does not touch those flows. It adds a
**manual-transfer provider family** that feeds the same functions:

| Need                    | Reuse                                                   | New                                       |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------- |
| Credit a deposit        | `applyDepositEvent` (ledger, outbox, wagering, limits)  | receipt submission and matching           |
| Disputed or odd deposit | flagged intents and `resolveFlaggedDeposit`             | flag reasons for receipt mismatches       |
| Withdrawal request      | `requestWithdrawal` (hold, review, AML, KYC)            | the destination account for CBE           |
| Paying out              | `markPayoutPaid` / `markPayoutFailed`                   | "paid by hand" with the staff-entered ref |
| Provider plumbing       | `PaymentProvider`, registry, webhooks, `payment_events` | `telebirr-p2p`, `cbe-p2p` adapters        |

Provider names `telebirr-p2p` and `cbe-p2p` fit the PSP clearing-account rule (`^[a-z0-9_-]{2,32}$`).

## 2. Work packages

### 2.1 `packages/core`: parsing receipts (pure)

- `parseTelebirrConfirmation(text)` and `parseCbeConfirmation(text)` turn a pasted SMS (English and
  Amharic) or a bare transaction ID into `{ ref, amount: Santim | null, payer, receiver, paidAt }`.
  Amounts are parsed straight to bigint santim (`"1,250.50"` → `125050n`), never through a float.
- `matchTransferToIntent(receipt, intent, account, now)` returns `ok` or a reason: `wrong_receiver`,
  `amount_mismatch`, `outside_window`, `payer_mismatch`.
- Unit tests on real SMS samples (anonymised), plus fast-check property tests: the amount round-trips,
  and random text is either refused or yields a well-formed ref.

### 2.2 `packages/db`: schema and functions (migration `0032_manual_transfer_payments`)

- Add `'transfer'` to `deposit_initiation_kind`.
- `receiving_accounts`: provider, account number, holder name, active flag, daily cap. Edited only by
  staff; every change is audited.
- `transfer_receipts`: provider, `ref` (**unique per provider**, so a receipt can never be used twice),
  `intent_id` (unique), amount, payer name and phone, receiver, paid_at, raw text, status
  (`submitted | matched | needs_review | rejected`), source (`player | sms_gateway | statement`).
- `player_payout_accounts`: the player's own CBE account. It is only accepted after a matched deposit
  from that account under the player's KYC name (this proves ownership). Changing it starts a 72 h
  cool-off.
- `submitTransferReceipt(exec, { userId, intentId, text, idempotencyKey, now })` runs `lockUser`, parses,
  inserts the receipt and matches it. On a match it calls `applyDepositEvent` in the **same
  transaction**, so the credit, its ledger transaction and outbox rows commit together. Any mismatch
  flags the intent for staff instead of crediting.
- `markPayoutPaidManually(exec, { payoutId, actor, providerRef, now })` wraps `markPayoutPaid`, with a
  unique `(provider, provider_ref)` and an audit row.
- Integration tests on a real Postgres (`createTestDatabase`): two players racing for the same ref,
  ledger entries summing to zero, a replayed idempotency key, deposit limits, a late receipt on an
  expired intent, and paying the same payout twice.

### 2.3 `packages/payments`: the adapters

`ManualTransferProvider` (`telebirr-p2p`, `cbe-p2p`), with `capabilities = { deposits: true,
payouts: true }`:

- `initiateDeposit` returns `kind: 'transfer'` with the active receiving account, the exact amount and
  the expiry. It makes no outside call.
- A pluggable **confirmation source**. Pick one in config:
  1. **SMS gateway (recommended source of truth).** A phone holding the receiving SIM forwards each
     incoming credit SMS to `POST /payments/webhooks/telebirr-p2p`, HMAC-signed (secret ≥ 32 chars, as
     for other webhooks). The existing `payment_events` table drops duplicate deliveries. A player's
     claim only matches money this source has actually seen.
  2. **Receipt lookup (optional).** Fetch the official receipt page for the ref. This is brittle and
     needs a terms-of-use check; in licensed mode it is https only.
  3. **Demo.** The DevPhone simulator generates a realistic SMS for the player to paste.
- `initiatePayout` never sends money. It returns `pending` and the payout waits in the admin "pay by
  hand" queue.

### 2.4 `packages/contracts` and `apps/api`

- `DepositView` gains `transfer: { accountNumber, accountName, amount, expiresAt }` when
  `kind = 'transfer'`.
- `POST /payments/deposits/:id/receipt` takes `{ text }` and an idempotency key, through `parseInput`.
  It is rate-limited (5 per minute, 20 per hour per user). Errors: `receipt_already_used`,
  `receipt_not_seen_yet` (retryable: the SMS has not arrived), `amount_mismatch`, `wrong_receiver`,
  `intent_expired`, `under_review`.
- Withdrawals keep `POST /payments/withdrawals`. For `cbe-p2p` the destination is the player's verified
  payout account. For `telebirr-p2p` it is the registered phone. Neither is free text.
- Admin routes:
  - `GET /admin/payments/receipts?status=needs_review`, with approve and reject;
  - `POST /admin/payouts/:id/paid { providerRef }`, with an optional second approver above a threshold;
  - receiving-accounts CRUD;
  - unclaimed incoming money (SMS seen, no player claim after 2 h).

### 2.5 `apps/web` (mobile first, Amharic and English)

- **Deposit:** method tiles → quick amount chips → a "Send exactly 250 ETB to" card (number and name,
  copy buttons, countdown, three numbered steps) → "Paste the SMS or transaction ID" box → status
  chip (checking → credited, or under review).
- **Withdraw:** method → amount (shows the withdrawable balance and the wagering left) → read-only
  destination → the existing step tracker (requested → approved → paid, showing the ref once paid).
- Add the new strings to the i18n catalogue in both languages.

### 2.6 `apps/admin`

- On the withdrawals page, a **Pay by hand** drawer: destination and amount with copy buttons, a field
  for the transaction ref, and Mark paid / Mark failed. RBAC: a new `payments.payout_manual`
  permission.
- Queues for receipts and unclaimed money; a receiving-accounts page with the daily cap and usage.

### 2.7 `apps/worker`

- Expire stale transfer intents (reuse `expireStaleDepositIntents`).
- Alert when unclaimed incoming money is older than 2 h, or a receiving account nears its daily cap.
- Daily reconciliation: SMS-gateway credits and statement imports against matched receipts and manual
  payouts. Plug these into the existing compliance reconciliation as PSP movements.

### 2.8 e2e

Add a variant of `payments-flow.spec.ts`. KYC → transfer deposit → paste the demo SMS → credited →
wager → withdraw → staff pays by hand with a ref → the player sees it paid. A second case pastes the
same ref twice and expects a refusal.

## 3. Order and size

1. Core parsers and matching (1–2 days)
2. Migration and db functions with integration tests (2–3 days)
3. Provider, demo source and API routes (2 days)
4. Web deposit and withdraw screens (2 days)
5. Admin pay-by-hand and the queues (2 days)
6. SMS-gateway webhook, worker jobs, reconciliation (2 days)
7. e2e, review, runbook `docs/runbooks/manual-payments.md` (1–2 days)

Each step ships green (`pnpm lint`, `pnpm typecheck`, `pnpm test`).

## 4. Rules and risks

- **Demo first.** In `OPERATING_MODE=demo` only the demo confirmation source runs, with play money.
  Real receiving accounts need licensed mode and its existing guard in `packages/config`. Do not weaken
  that guard.
- **Regulatory.** Collecting into a personal or merchant wallet without a licence is exactly what the
  NBE and INSA crackdown targets. Real use needs the ELS licence and a merchant account in the
  company's name.
- **No third-party payouts.** Payouts only go to the registered phone, or to a CBE account that has
  proven it belongs to the player. Funding from someone else's wallet (payer ≠ KYC name) goes to review
  and counts toward the AML rules.
- **Staff fraud.** Paying by hand is the weakest point. Use a second approver above a threshold, an
  audit row for every action, daily reconciliation against the statement, and keep the people who edit
  receiving accounts separate from the people who pay out.
- **Money.** Amounts stay bigint santim end to end, with no float even when parsing SMS. Payouts round
  down. Every balance change is one ledger transaction that sums to zero.

## 5. Open questions

1. A working Melabingo link or screenshots of its deposit and withdraw screens.
2. Which methods: telebirr only, or CBE as well (or others)?
3. Confirmation source for licensed mode: SMS gateway, receipt lookup, or staff only?
4. Auto-credit on a match, or always have staff approve deposits above some amount?
