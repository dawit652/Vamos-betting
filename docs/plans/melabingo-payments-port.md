# Plan: port Melabingo's deposits and withdrawals into Vamos

Status: draft, not started. Scope: deposits and withdrawals only. Melabingo's bingo game, rooms, bot
and cashier network are not ported (casino-style games are excluded by policy).

Source: `dawit652/melabingo` at `4774910` (v0.2.0), mainly `packages/payments`, `packages/core/src/withdrawal-flow.ts`,
migrations `0002`, `0004`–`0007`, `apps/api/src/routes/{deposits,sms,withdrawals,payout-accounts,admin}.ts`,
`apps/worker/src/jobs/{receipt-verify,balance-reconcile}.ts` and the miniapp's `Wallet`,
`DepositMethods`, `AddBank` and `Copyable` components.

## 1. What Melabingo does

**Deposits: the SMS rail.**

1. The player picks a method (telebirr, CBE…). The screen shows the collection account, the USSD code
   (`*127#`, `*847#`) as a `tel:` link and copy buttons.
2. The player enters an amount, e.g. 100 birr. The server reserves a **unique amount** such as
   `100.37` (1–50 extra cents, unique among pending intents through a partial unique index). The
   cents are the payment reference.
3. The player sends exactly that amount. The collection SIM receives the confirmation SMS, and an
   Android forwarder POSTs it to `/webhooks/sms` (shared secret).
4. Parsers for 33 institutions read the direction, amount, reference, sender and balance. **Debits
   never credit.** A duplicate reference is a no-op (unique `received_sms.transaction_id`).
5. The matcher looks for an exact amount first, then falls back to the sender's phone. If it finds
   two intents (ambiguous) or none, the SMS goes to the review queue. It credits **what arrived**.
6. **"I paid but no balance":** the player pastes the SMS or the reference. The pasted text is only a
   lookup key into messages the gateway actually delivered, and it matches only the pasting player's
   own intents. If the gateway has no row, the server asks telebirr's own receipt page.
7. **Independent checks.** Receipt verification for telebirr checks four things: completed, reference
   matches, receiver is ours, amount present (`RECEIPT_VERIFY=off|audit|enforce`, circuit breaker,
   allowlisted host). Balance-chain reconciliation checks that the balance stated on each SMS moves by
   exactly what we credited; this is the only check for CBE.

**Withdrawals: the manual rail with four eyes.**

1. **Beneficiaries ("Add bank").** The player saves an institution, account and name, confirmed by an
   OTP that is bound to that exact destination. A withdrawal names a saved beneficiary, never a typed
   account.
2. The money is held at request time. A risk gate decides (≤ 500 birr, account age ≥ 48 h, wagered
   ≥ 1.5× deposited).
3. An **admin clears** the withdrawal, then a **different operator** sends the money by hand and
   **settles** it with a reference. Database constraints `withdrawal_four_eyes` and
   `withdrawal_settle_needs_clearance` enforce this. The operator only sees cleared rows.
4. The operator's own outgoing debit SMS **proposes** the withdrawal it paid, as one-tap evidence. It
   never settles anything itself (`PAYOUT_REQUIRE_PROOF` is optional).
5. A rejection returns the hold.

## 2. What changes when it moves into Vamos

| Melabingo                                     | Vamos rule                                                   | Port as                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Real money from day one                       | `OPERATING_MODE=demo` = play money                           | In demo the rail only takes SMS from a dev simulator. Real collection accounts need licensed mode. The guard is not weakened.   |
| Any beneficiary name, any account             | No payouts to third-party wallets                            | Wallets: the registered phone only. Banks: name = KYC name **and** a credited SMS deposit from that account (Melabingo's TODO). |
| OTP over Telegram                             | SMS OTP (`otp_challenges`)                                   | New purpose `payout_account`, keeping Melabingo's binding check.                                                                |
| Own ledger (`postTransaction`, `ledger_idem`) | `applyDepositEvent` / `requestWithdrawal` / `markPayoutPaid` | Keep Vamos's functions, so limits, wagering, AML, KYC and settlement-correction blocks still apply.                             |
| Credit what arrived, even if different        | A different amount flags the intent                          | An exact match credits. A phone-fallback match at a different amount is flagged for staff (decision 3).                         |
| Shared `admin` / `operator` keys              | Staff accounts, TOTP, RBAC, audit                            | `withdrawals.approve` clears; a new `payouts.settle_manual` settles; settler ≠ approver, also as a DB check.                    |
| Pure logic inside `packages/payments`         | Domain math in `packages/core`, with property tests          | Parsers, matchers, amount allocation and balance chain go to `packages/core/src/sms-rail/`.                                     |
| `vitest` unit tests only                      | Unit + property tests                                        | Port the tests and add fast-check properties.                                                                                   |
| Double quotes, `.ts` imports, `Math.random`   | Prettier style, injected deps                                | Reformat. Allocation takes an injected CSPRNG; the receipt fetch uses `ProviderDeps`.                                           |

Not ported: the Chapa rail (Vamos has its own adapter), the cashier/shop credit-line network, the
bot's internal deposit endpoint and the HTML staff console.

## 3. Work packages

### 3.1 `packages/core/src/sms-rail/` (pure)

- Ported from `packages/payments/src/`:
  - `parsers/` (types, institutions, generic, index, fixtures);
  - `sms-matcher.ts` (`matchPayment`, `allocateMatchAmount`, `MAX_CENT_OFFSET = 50`);
  - `payout-matcher.ts` (`proposeSettlement`);
  - `balance-chain.ts`;
  - `deposit-methods.ts` (USSD codes, `ussdHref`);
  - `payout-destinations.ts`;
  - `withdrawal-flow.ts`'s `assessTransition`, adapted to Vamos statuses (`requested → approved` =
    clear, `approved → paid` = settle).
- Money is `Santim` throughout; `birrToMinor` already avoids floats.
- Tests: port `sms.test.ts`, `payout-matcher.test.ts`, `balance-chain.test.ts`,
  `payout-destinations.test.ts` and `deposit-methods.test.ts`. Add these properties:
  - an amount survives a round trip;
  - a debit never matches;
  - allocation never collides and stays within 1–50 cents;
  - balance drift equals the sum of forged amounts.

### 3.2 `packages/db`: migration `0032_sms_rail`

- `payment_intents`: add `base_amount` and `match_amount` (`amount` becomes the exact amount to send),
  with a partial unique index on `match_amount` where the provider is `sms` and the status is
  `created` or `pending`.
- `received_sms`: Melabingo's `0002`, `0006` and `0007` combined. Columns: institution, sender,
  direction, amount, `transaction_id` (partial unique), counterparty name and phone, balance, times,
  status (`unparsed | unmatched | ambiguous | matched | ignored_debit | settlement_proposed |
receipt_mismatch | awaiting_receipt`), `matched_intent_id`, source (`gateway | receipt | manual |
simulator`), the `receipt_*` columns, `proposed_payout_id` (unique) and the raw text.
- `payout_accounts`: Melabingo's `0004`, plus `verified_by_deposit_id` (the ownership proof).
- `payouts`: add the beneficiary id, plus destination institution, account and name **copied** at
  request time. Also `settled_by`, `settlement_reference` and `settlement_sms_id`. CHECK
  `settled_by IS NULL OR settled_by <> approved_by` (Melabingo's `0005`).
- Functions:
  - `createSmsDepositIntent`: allocate the amount, retrying on a unique violation.
  - `recordReceivedSms`.
  - `creditFromSms`: match, then `applyDepositEvent` in the **same transaction**.
  - `checkDepositForPlayer`.
  - `creditSmsByStaff`.
  - `addPayoutAccount` / `verifyPayoutAccount`.
  - `requestWithdrawal({ payoutAccountId })`.
  - `settleManualPayout` (wraps `markPayoutPaid`).
  - `proposePayoutSettlement`.
  - Queries for the review queue, the operator queue and settlement proposals.
- `claimDuePayouts` skips providers that pay out by hand.
- Integration tests (`createTestDatabase`):
  - a webhook replayed 100 times credits once;
  - two players with the same base amount;
  - a pasted reference from another player's deposit gets `in_review`, never a credit;
  - ledger entries sum to zero;
  - four eyes is enforced by the DB;
  - two operators settling at once produces one payout.

### 3.3 `packages/payments`

- `SmsRailProvider` (name `sms`, clearing `house_psp_clearing:sms`). `initiateDeposit` returns the new
  kind `'transfer'` with the accounts and the exact amount. It reports manual payouts and never sends
  money.
- `receipts/`: verifier, `telebirr-html`, `account-match`, breaker, `resolve-intent`, fixtures and
  tests, ported with `ProviderDeps` (fetch, clock, timeout). No URL is ever taken from SMS text.

### 3.4 `packages/config` and `packages/contracts`

- Config: add `sms` to `PAYMENT_PROVIDERS`, plus:
  - `SMS_GATEWAY_SECRET` (≥ 32 characters, distinct from the other secrets);
  - `COLLECTION_ACCOUNTS` (JSON, zod);
  - `RECEIPT_VERIFY`, `RECEIPT_VERIFY_TIMEOUT_MS`;
  - `PAYOUT_REQUIRE_PROOF`.
- Config guard: in demo the gateway route only takes simulator input. In licensed mode the existing
  licence checks apply unchanged.
- Contracts: `DepositView.transfer`, `DepositCheckRequest/Response`, the payout-account schemas,
  `CreateWithdrawalRequest.payoutAccountId`, and the admin SMS and settle schemas.

### 3.5 `apps/api`

| Route                                                                   | From Melabingo                  |
| ----------------------------------------------------------------------- | ------------------------------- |
| `GET /payments/options`, adding methods with USSD codes and accounts    | `GET /api/deposits/methods`     |
| `POST /payments/deposits` (`provider: 'sms'`; 409 `try_another_amount`) | `POST /api/deposits`            |
| `POST /payments/deposits/check` (rate-limited, lookup key only)         | `POST /api/deposits/check`      |
| `POST /payments/webhooks/sms` (header or body secret, fast 200)         | `POST /webhooks/sms`            |
| `GET/POST /me/payout-accounts`, `…/otp`, `…/:id/remove`                 | `payout-accounts.ts`            |
| `POST /payments/withdrawals` (`payoutAccountId`)                        | `POST /api/withdrawals`         |
| `GET /admin/payments/sms`, `POST /admin/payments/sms/:id/credit`        | `/admin/sms…`                   |
| `POST /admin/withdrawals/:id/settle` (`reference` or `smsId`)           | `/admin/withdrawals/:id/settle` |
| Health: SMS age, receipt mismatches, breaker, balance drift             | `/admin/health`                 |
| `POST /dev/payments/sms`: compose an incoming SMS (demo only)           | new (replaces the real handset) |

### 3.6 `apps/worker`

- `receipt-verify`, in audit mode: mismatches go to the top of the queue, and nothing is ever
  reversed.
- `balance-reconcile`: hourly, over a 24 h window.
- An alert when no SMS has arrived for 30 minutes during active hours.
- Cleanup of expired OTPs.

### 3.7 `apps/web`

Port the miniapp's wallet UX into `DepositView`/`WithdrawView`:

- **Deposit:**
  - skip the method picker when only one method exists;
  - read the instructions before committing an amount;
  - destination card where the copy button puts the 9-digit subscriber number on the clipboard;
  - `tel:` link with `%23`;
  - the exact amount, cents highlighted;
  - a polling wait state;
  - the "I paid but my balance hasn't updated" paste box.
- **Withdraw:** saved beneficiaries, Add bank with OTP, the amount with min and max.
- Port the am/en strings from `packages/i18n/catalogs`.

### 3.8 `apps/admin`

- **SMS review queue:** credit to a user or intent, or close.
- **Operator settle queue:** approved rows only, the one-tap SMS proposal, a reference field.
- **Health panel.**

### 3.9 e2e and docs

- The payments-flow e2e on the rail:
  1. KYC;
  2. deposit 100 → told 100.xx;
  3. simulator SMS → credited;
  4. wager;
  5. add a beneficiary with OTP;
  6. withdraw;
  7. approve as one staff member;
  8. settle as a second staff member, which succeeds (the same staff member is refused).
- Refusal cases: a debit SMS, a replayed SMS.
- `docs/runbooks/sms-rail.md`, from `SMS-RAIL.md` and `RECEIPTS.md`.

## 4. Order and size

1. Core port and tests (2 days).
2. Migration and DB functions with integration tests (3 days).
3. Provider, receipts, config and contracts (2 days).
4. API routes and the dev simulator (2 days).
5. Web screens (2–3 days).
6. Admin queues, worker jobs, health (2 days).
7. e2e, runbook, review (2 days).

Total: about 3 weeks. Each step ships green on `pnpm lint`, `pnpm typecheck` and `pnpm test`.

## 5. Risks

- **The handset is the trust anchor.** Whoever holds it can inject SMS. Mitigations: receipt audit
  (telebirr), balance-chain reconciliation (CBE), a device under company control, and secret rotation
  on staff changes.
- **Licensing.** Melabingo's own docs say it: the rail "does not make an unlicensed operation
  licensed". Collecting into a personal SIM is what the NBE/INSA crackdown targets. Real use needs the
  ELS licence and collection accounts in the company's name.
- **Fragile parsing.** Telco SMS formats and receipt HTML change. Both fail into the review queue,
  never into a wrong credit. Capture real fixtures before go-live.
- **Cent space.** 50 concurrent deposits per base amount, with a 30-minute TTL. Past that, the player
  is asked to pick another amount.

## 6. Decisions needed

1. Methods at launch: telebirr + CBE only (recommended), or more institutions?
2. Withdrawal destinations: own phone and own-name banks only (policy), or banks before any deposit
   from them?
3. A phone-fallback deposit at a different amount: flag it for staff (recommended, Vamos rule), or
   credit what arrived (Melabingo)?
4. Should the cashier/shop network (counter loads and OTP cash-outs on a credit line) be planned
   separately?
