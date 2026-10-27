# Plan: port Melabingo's deposits and withdrawals into Vamos

Status: draft, not started. Scope: deposits and withdrawals only. Melabingo's bingo game, rooms, bot
and cashier network are not ported (casino-style games are excluded by policy).

**Target: production.** The rail is built to run with real money in `OPERATING_MODE=licensed`, with
real collection accounts and a real SMS gateway. Demo mode keeps only an SMS simulator, for
development, CI and the public demo. Licensed mode still starts only when the existing licence guard
passes (ELS licence and the rest of the checklist in `docs/deployment.md` §4). This plan adds rail
checks to that guard (§3.4) and removes none.

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
| Real money from day one                       | Real money only in `licensed` mode                           | Production build: real collection accounts and gateway in licensed mode. In demo only the simulator feeds the rail.             |
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
- Config guard. `licensedModeViolations` gets these extra checks when `sms` is enabled:
  - `SMS_GATEWAY_SECRET` is set, at least 32 characters, and differs from every other secret;
  - `COLLECTION_ACCOUNTS` is non-empty. Each entry names an institution that has a parser spec and
    carries `ownerName` equal to `OPERATOR_LEGAL_NAME` (a new config value), because collection accounts must be in the
    company's name;
  - `RECEIPT_VERIFY` is `audit` or `enforce`, never `off`;
  - `PAYOUT_REQUIRE_PROOF=true`, or an explicit `PAYOUT_PROOF_WAIVED=true` that the start-up log names;
  - the dev simulator is off.

  Demo mode refuses real `COLLECTION_ACCOUNTS`: only the simulator account is accepted. The existing
  licence checks stay as they are.

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

The webhook in production:

- It answers 200 only after the SMS row is committed. Parsing and matching run in the same
  transaction, so a lost answer just means a redelivery that the unique reference absorbs.
- It is rate-limited per source IP, and its body is capped at 4 KB.
- It is served on the api host and can be restricted to the gateway's IP (`SMS_GATEWAY_ALLOWLIST`).
- The dev route is never mounted when `NODE_ENV=production`.

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

### 3.10 Production hardening

- **Observability.**
  - Prometheus metrics:
    - `vamos_sms_received_total{institution,direction,status}`;
    - `vamos_sms_match_total{confidence}`;
    - `vamos_receipt_verifications_total{status}`;
    - `vamos_balance_drift_santim{institution}`;
    - `vamos_payout_settle_seconds`.
  - Alerts:
    - no SMS for 30 minutes during active hours;
    - review queue over 10 or older than 15 minutes;
    - any `receipt_mismatch`;
    - balance drift ≠ 0;
    - the receipt breaker open for more than 10 minutes;
    - a cleared payout older than 2 h.
- **Compliance.**
  - SMS-rail deposits and manual payouts produce the same outbox events as other providers, so ELS
    reporting, daily totals and the AML rules cover them without new code.
  - `received_sms` joins the reconciliation as PSP movements (per institution).
  - Raw SMS and receipt HTML are kept 7 years, like the ELS reports.
- **Security.**
  - Run the adversarial review that Phase 6 had (money, security, reliability) over the rail before
    go-live, and fix every confirmed finding with a regression test.
  - Cover the replay, forgery and four-eyes cases with tests.
  - Add `SMS_GATEWAY_SECRET` to the secret-rotation runbook, and rotate it on every staff change.
- **Data.** Backups and the restore drill cover the new tables. Phone numbers and names in
  `received_sms` follow the existing privacy retention, and the player data export includes payout
  accounts.
- **Load.** Extend `pnpm load:bets` with a deposit burst: 500 intents on the same base amount plus a
  forwarded-SMS storm. The cent space must refuse cleanly and nothing may double-credit.
- **Handset operations** (`docs/runbooks/sms-rail.md`):
  - a company-owned Android on mains power and wifi, with a second SIM-less spare already set up;
  - forwarder app settings and allowed senders;
  - what to do when the handset is offline (the player paste path keeps deposits working);
  - the daily check that the telco balance equals the ledger balance.

## 4. Order and size

1. Core port and tests (2 days).
2. Migration and DB functions with integration tests (3 days).
3. Provider, receipts, config and contracts (2 days).
4. API routes and the dev simulator (2 days).
5. Web screens (2–3 days).
6. Admin queues, worker jobs, health (2 days).
7. e2e, runbook, review (2 days).
8. Production hardening (§3.10), the adversarial review and its fixes (4–5 days).

Total: about 4 weeks. Each step ships green on `pnpm lint`, `pnpm typecheck` and `pnpm test`.

### Go-live checklist (production, real money)

- [ ] ELS licence held, and `OPERATING_MODE=licensed` starts with zero guard violations, including the
      rail checks in §3.4.
- [ ] Collection accounts opened in the company's name (telebirr merchant or business wallet, CBE
      business account). No personal SIMs.
- [ ] A real SMS and a real receipt page captured for every collection institution. They are in the
      fixtures and the tests pass.
- [ ] `RECEIPT_VERIFY=audit` running for a week on staff test deposits with zero unexplained mismatches.
      Then decide whether to use `enforce`.
- [ ] Balance-chain drift has been 0 for 7 days on test traffic.
- [ ] Staff accounts in place: at least two approvers and two operators, with TOTP. The four-eyes
      rule has been tested in production with 1-birr payouts.
- [ ] All the alerts in §3.10 fire in a drill and reach the on-call phone.
- [ ] Runbook rehearsed: handset offline, review-queue backlog, a forged-SMS drill, secret rotation.
- [ ] Staged rollout: 1. staff accounts only; 2. 100 invited players with a 1,000 birr deposit cap; 3. raise the caps; 4. open to everyone.
      Each stage holds for at least 3 days with a clean reconciliation.

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
