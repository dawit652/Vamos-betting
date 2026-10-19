# Reconciliation mismatch

The worker reconciles yesterday every day (and catches up to 7 missed days) under a database advisory lock;
staff can also start a run (Compliance -> Reconciliation -> "Run now", permission `reconciliation.run`) and
upload provider statements. A run ends `clean`, `mismatches` or `failed`; each difference is a row in
`reconciliation_mismatches` with its check name, shown with the run. A mismatch raises an alert (outbox event)
and an audit record. See [compliance.md](../compliance.md#3-reconciliation) for the checks.

**Severity:** ledger integrity or wallet mismatches are SEV1 (the books are wrong or someone bypassed the
application); PSP or daily-summary mismatches are SEV2 until explained.

## 1. Read the run

Open the run: which checks failed, how many rows, the business date. Then triage by check:

| Check                                                                        | Likely causes                                                                                         | First look                                                                                                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger integrity (zero-sum, balances, continuity)                            | A bug, a manual SQL change, a restored/partial database, a trigger disabled                           | **Stop.** SEV1. Do not run anything that posts. Preserve logs and take a dump at once (`backup.sh dump`). Compare with the previous clean run's time. |
| Wallets (cash/bonus vs ledger)                                               | A write outside the application, a failed deploy mid-migration                                        | Which users; their last ledger entries and audit records                                                                                              |
| `house_stakes` / `house_jackpot` / `house_withdrawals_pending`               | Open bets, jackpot entries or payouts changed state without a posting (or vice versa)                 | The listed bet/entry/payout ids; settlement and payout logs                                                                                           |
| PSP (per provider and day)                                                   | A payout/deposit settled by hand; a late webhook; a provider fee; an amount rounding; a duplicate     | The listed intent/payout/statement line; the provider's dashboard                                                                                     |
| PSP statement lines (`unmatched`, `duplicate`, `direction_mismatch`, amount) | Statement of another period/provider; a returned payout (`duplicate`); a deposit counted as money out | Re-check the statement's period and provider; see [payouts runbook](payouts-stuck-or-flagged.md)                                                      |
| Daily summaries (final days)                                                 | A correction after a day was finalised (reversal counts on the day it posts)                          | The recompute diff; a final day is immutable, a _provisional_ day can be recomputed                                                                   |

## 2. Fix by cause (never by editing history)

- **Late or missing real-world event** (webhook not yet processed, statement not imported): wait for/import
  it, then **Run now** again; the run is idempotent per day.
- **A flagged/settled-by-hand payout or deposit**: correct through the Withdrawals/Deposits actions so a
  proper posting exists.
- **Provisional daily summary out of date**: Compliance -> the day -> "Recompute" (creates a version).
- **A real application defect** (wrong or missing posting): do not hand-post. Stop the affected flow
  (incident basics), reproduce in a test, ship the fix, and let the application reverse/repost through its
  own correction path (e.g. bet settlement reversal). Keep the original entries: the ledger is append-only.
- **Ledger integrity failure with no explanation**: treat as tampering or corruption. Keep the instance
  running read-only if possible, snapshot the volume, restore the last good backup to a scratch host
  ([restore](restore-from-backup.md)) and compare, find the first bad `ledger_entries.id`, and escalate to the
  licence holder (a regulator notification may be required, to confirm with counsel).

## 3. Close

Run reconciliation again until it is `clean`, with the original business date. Record in the incident log:
run ids (before/after), cause, fix, who. The daily summary figures that go to ELS must match: compare the CSV
(`/admin/compliance/daily-summaries.csv`) with the ledger after any correction.

## Run failures (`failed`)

`failed` means the run itself broke (database timeout, lock held, worker crash), not that numbers differ.
Check `docker compose logs worker | grep -i reconcil`, `curl localhost:4100/ready`, then run it again. Long
runs on a large ledger: schedule manual runs outside peak hours; the scan reads one snapshot.
