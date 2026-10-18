# Compliance and regulator reporting

Everything here is a **demo-mode design** and a set of **placeholders to confirm with counsel**. Nothing
in this file is legal advice.

## 1. Legal context

- Ethiopia revoked all sports betting licences on 15 Dec 2025; Vamos Entertainment PLC was one of the
  22 suspended operators. The Ethiopian Lottery Service (ELS) is preparing a stricter relaunch with
  real-time transaction monitoring. ELS has not published a reporting specification yet.
- The platform therefore runs as a play-money demo (`OPERATING_MODE=demo`, the default). Real money needs an
  ELS licence. `OPERATING_MODE=licensed` refuses to start unless an ELS licence number, ELS reporting,
  real payment and KYC providers, `TAX_CONFIG_CONFIRMED=true`, `NODE_ENV=production` and a non-default
  `SESSION_SECRET` are all set. The guard is in `packages/config/src/config.ts`.
- Phase 10 only strengthens that guard: in licensed mode `ELS_REPORTING_MODE=off` and `=http` are refused
  (the HTTP reporter sends nothing until ELS publishes a spec) and `file` needs an absolute
  `ELS_REPORT_DIR`.
- Excluded by policy: casino, crash and virtual games; crypto; agent/cash channels; payouts to a third
  party's wallet.

## 2. What is reported and how

### 2.1 ELS transaction stream

Reportable outbox events go through the Phase 4 dispatcher into a dedicated `els` queue and are written by
an `ElsReporter` (`ELS_REPORTING_MODE=file|http|off`, default `file`; `ELS_REPORT_DIR`, default `./var/els`).

| Event type                                                                                    | Meaning                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------ |
| `bet.placed`, `bet.accepted`, `bet.rejected`, `bet.settled`, `bet.cashed_out`, `bet.reopened` | Bet lifecycle, including corrections |
| `jackpot.entered`, `jackpot.settled`                                                          | Jackpot entries and results          |
| `payment.deposit_succeeded`, `payment.withdrawal_paid`                                        | Completed deposits and withdrawals   |
| `compliance.daily_summary_finalized`                                                          | A business day became final          |

- **Files:** `<dir>/stream/<date>.jsonl` (one line per event) and `<dir>/daily/<date>.csv` (daily summaries).
  Folders are created `0700` and files `0600` (personal data); the status warns when the folder is readable by
  other users.
- **Exactly once:** the durable `els_reports` table records each outbox id with a hash of the line. Replays
  and restarts do not duplicate lines; a sweep re-emits rows that were not written.
- **Data minimisation (PDPP):** only whitelisted fields are written. A record carries the pseudonymous
  `playerRef` (the account UUID), ids, odds in milli and amounts in **santim** (1 ETB = 100 santim). No names,
  phone numbers, recipient names or free text from players.
- **Status:** `GET /admin/compliance/els` and the Daily summaries page show the reporter, written and pending
  counts, the oldest pending event and the last error.

### 2.2 Daily summary

A business day is a calendar day in Africa/Addis_Ababa (UTC+3): `[D-1 21:00Z, D 21:00Z)`. Figures come from
ledger postings by their own timestamp.

| Figure          | Definition                                                                            |
| --------------- | ------------------------------------------------------------------------------------- |
| Turnover        | bet stakes (minus live bets rejected that day) + jackpot entries                      |
| Payouts (gross) | winnings paid + cash-outs + refunds (void bets, void jackpot rounds) + jackpot prizes |
| GGR             | turnover - payouts                                                                    |
| Tax withheld    | postings to `house_tax_payable`                                                       |
| Bonuses         | promotion cost postings                                                               |
| Refunds/voids   | refund postings                                                                       |
| Cash-outs       | cash-out payout postings                                                              |
| Deposits        | money in through the payment providers (amount and count)                             |
| Withdrawals     | money out through the payment providers (amount and count)                            |
| Active players  | distinct players with a bet, jackpot entry, deposit or withdrawal that day            |
| ELS commission  | `floor(GGR x rateBps / 10000)`, and 0 when GGR <= 0                                   |

- A correction's reversal counts negative on the day it is posted. GGR is a stakes-in, payouts-out view of
  each day. The Phase 9 dashboard GGR (what `house_revenue` gained) differs by the change in open stakes and
  the jackpot pool.
- Rows live in `daily_summaries` (one per day). A **provisional** day may be recomputed and each change
  records a version in `daily_summary_versions`. A worker task finalises the previous day after a grace period
  (2 hours); a **final** day is immutable (database trigger). Reconciliation re-checks the last 7 final days.
- The commission rate is the `els_commission` setting `{rateBps}`, default 1500 (15%). **Confirm with counsel.**
- Download: `GET /admin/compliance/daily-summaries.csv?from&to` (at most 366 days, amounts in santim).

## 3. Reconciliation

A worker job runs daily and on demand (admin: Reconciliation, "Run now"). It reads one repeatable-read
snapshot and stores the result in `reconciliation_runs` with each difference in `reconciliation_mismatches`.

1. **Ledger integrity:** every transaction sums to zero; each account balance equals the sum of its entries;
   `balance_after` is continuous.
2. **Wallets:** each player's cash and bonus balance equals the ledger.
3. **House accounts:** `house_stakes` equals the open bets' stakes; `house_jackpot` equals entry costs minus
   prizes and refunds; `house_withdrawals_pending` equals open payouts.
4. **PSP:** per provider and day, succeeded payment intents and paid payouts equal the `house_psp_clearing`
   movements. A PSP statement uploaded in admin (CSV: provider, reference, amount in birr, date, optional
   type) is matched line by line: each line must match exactly one intent or payout and vice versa, with the
   same amount and direction (a deposit is money in, a payout money out; otherwise `direction_mismatch`). A
   second line for a record already matched is a `duplicate`, so a payout returned by the provider is not
   clean. A statement has at most 20,000 lines (blank lines count) and 32 fields per line.
5. **Daily summaries:** final days of the last 7 still match the ledger.

A mismatch creates an alert (outbox event) and an audit record and shows in admin. Statement uploads are
deduplicated by file hash.

## 4. AML rules

Evaluated by the worker on relevant outbox events and in a daily sweep. Thresholds live in the `aml_rules`
setting (editable by staff with `settings.edit`). Each hit creates one `aml_flags` row per player, rule and
window (a business day, or one deposit for deposit-then-withdraw).

| Rule                  | Default                                                                                                           | Severity |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| Deposit velocity      | more than 5 deposits in a rolling hour or 10 in a day                                                             | medium   |
| Withdrawal velocity   | more than 3 withdrawals in a rolling hour or 5 in a day                                                           | medium   |
| Structuring           | at least 2 deposits of 90% or more of the 100,000 ETB threshold within 24 h, or a sum above it                    | high     |
| Deposit then withdraw | withdrawal requested when stakes are under 50% of the deposits since the last withdrawal, if they reach 1,000 ETB | high     |
| Cash-out churn        | at least 5 cash-outs within 24 h, each within 10 minutes of placement                                             | medium   |

- **Deposit then withdraw** judges every deposit since the player's previous withdrawal request, so a small
  top-up after a large deposit does not hide it. The flag is keyed on the earliest deposit that breaks the rule.
- **Hold:** with `holdWithdrawalsOnHighSeverity` (default on), a player with an open or escalated high
  severity flag has new withdrawals sent to staff (review reason `aml_review`). When such a flag is raised,
  approved payouts not yet sent go back to review, and payouts already waiting for review are re-tagged
  `aml_review`.
- **Release:** while the flag is open or escalated, only staff with `aml.review` (compliance, admin) can approve
  a held withdrawal (`withdrawals.approve` alone gets 409 `aml_review_pending`). Once the flag is reviewed or
  dismissed, finance can approve it as usual.
- **No tipping-off:** the player never sees an AML reason. Player views and the web app show the generic
  review reason `manual_review`; only staff views show `aml_review`.
- **Review:** staff with `aml.review` (compliance, admin) set a flag to reviewed, dismissed or escalated with a
  required note. Every review is audited. Reviewed and dismissed flags are closed.
- Many accounts on one device or IP is out of scope (no device data is collected).

## 5. Permissions

| Permission           | Roles                      | Gives                                                            |
| -------------------- | -------------------------- | ---------------------------------------------------------------- |
| `reports.view`       | admin, compliance, finance | summaries, ELS status, reconciliation runs, statements, settings |
| `reconciliation.run` | admin, compliance, finance | run now, recompute a provisional day, upload a statement         |
| `aml.review`         | admin, compliance          | AML flags list, detail and review                                |

## 6. Data retention

Placeholders to confirm with counsel:

- Ledger transactions and entries, audit log, ELS reports, daily summaries and reconciliation runs are kept
  for **7 years**. The ledger, audit log and final summaries are append-only or immutable by database trigger.
- Player PII is minimised: the ELS stream carries only the pseudonymous account id. Names, phone numbers and
  KYC documents stay in operational tables with access limited by role, and are removed or anonymised on
  account closure once retention duties allow.
- PDPP data residency (where the database and ELS files may be stored) is **to confirm**.

## 7. Business defaults to confirm with counsel

| Setting                     | Default                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Minimum stake               | 5 ETB                                                                                     |
| Max legs per bet            | 40                                                                                        |
| Max payout per bet          | 500,000 ETB                                                                               |
| Live bet delay              | 6 s                                                                                       |
| Cash-out margin             | 5%                                                                                        |
| Minimum age                 | 21                                                                                        |
| Winnings tax                | 20% of net winnings (rate, base and exemption configurable)                               |
| Multi-bonus ladder          | 3 legs 3% ... 30 legs 200% of winnings; each leg >= 1.30 odds; bonus capped at 50,000 ETB |
| Daily jackpot (`daily9`)    | 9 games, 10 ETB per combination, max 1,024 combinations, 100k pool                        |
| Weekly jackpot (`weekly13`) | 13 games, 10 ETB per combination, max 4,096 combinations, 1M pool, consolation tiers      |
| ELS commission              | 15% of positive daily GGR (`els_commission`, 1500 bps)                                    |
| AML reporting threshold     | 100,000 ETB (structuring rule)                                                            |
| AML velocity                | deposits 5/h and 10/day; withdrawals 3/h and 5/day                                        |
| AML deposit-then-withdraw   | stakes under 50% of the deposits since the last withdrawal (sum at least 1,000 ETB)       |
| AML cash-out churn          | 5 cash-outs in 24 h, each within 10 minutes of placement                                  |
| Retention                   | 7 years (ledger, audit, ELS reports)                                                      |
| Summary finalisation grace  | 2 hours after the business day ends                                                       |
