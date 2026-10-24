# Payouts stuck or flagged

Withdrawals go: `requested` (waits for review, or for AML) -> `approved` (finance) -> `processing` (sent by
the worker) -> `paid`, or `rejected`/`failed` (the hold returns to the player). The invariant that governs
everything below: **a hold goes back to the player only when the provider has definitely not paid.**
Ambiguous outcomes (unreadable 2xx, timeouts, 5xx, stale attempts) keep the hold and are polled; they are
never refunded automatically. Money out is therefore never duplicated, and staff decide the unclear cases.

Who: staff with `withdrawals.approve` (admin, finance) act; `withdrawals.view` (also compliance) reads.
Back office: **Withdrawals** (queues: review, flagged) and flagged deposits.

## Symptoms and meaning

| You see                                                                           | Meaning                                                                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `requested` for long, reason `above_auto_approve_threshold` or `active_exclusion` | Waiting for finance: the amount is at or above the auto-approval limit, or the player is under an exclusion (check it before approving) |
| `requested`, reason `aml_review`                                                  | Held by an AML flag: only `aml.review` staff may release it ([AML runbook](aml-flag-review.md))                                         |
| `requested`, reason `settlement_correction`                                       | A corrected result on one of the player's bets would overdraw them (`bet.correction_blocked`): see below                                |
| `approved`/`processing` for long, not flagged                                     | Worker down or provider slow: check `docker compose ps worker`, `curl localhost:4100/ready`, provider status                            |
| Flag `ambiguous_result`                                                           | The provider's answer was unreadable/timed out: money may or may not have left                                                          |
| Flag `attempts_exhausted`                                                         | Several unanswered attempts: the worker stopped retrying                                                                                |
| Flag `pending_too_long`                                                           | Pending over 24 h; nobody confirmed the outcome                                                                                         |
| Flag `provider_conflict`                                                          | The provider's data contradicts ours (reference, amount, status)                                                                        |
| Flag `staff_review`                                                               | A staff member took it over                                                                                                             |
| Flagged **deposit**                                                               | An intent reversed at the provider or never confirmed: no credit yet                                                                    |

## Procedure: a flagged or stuck withdrawal

1. **Open it** (Withdrawals -> the payout): note provider, provider reference, amount, attempts, flag reason
   and the history. The reference is stored _before_ sending, so there is almost always a reference to look up.
2. **Do not reject or "retry" blindly.** First find out whether the provider paid:
   - Look the reference up in the provider's merchant dashboard (Chapa / telebirr) or call their support with
     the reference and amount. Check the player's phone number matches the payee (payouts go only to the
     player's own wallet).
   - Check that the worker is healthy: a down worker explains `approved`/`processing` without any flag.
3. **If the provider shows it paid:** staff `flag` the payout if it is still `processing` (it must be flagged
   before it can be settled), then **Settle -> paid**, entering the provider reference (it must equal one
   already stored). The hold moves to the provider's clearing account.
4. **If the provider shows it was not paid and will not be** (failed, reversed, never created): **Settle ->
   failed** with a reason. The hold returns to the player (`withdrawal_reversal`). Only do this on proof;
   write the proof (dashboard screenshot id, ticket number) in the note.
5. **If you cannot tell yet:** leave it flagged, add a note, ask the provider, and revisit within the same
   business day. Never settle `failed` "to keep the player happy".
6. **If it is unflagged and merely waiting:** fix the cause (worker, provider outage). The worker retries by
   _querying_ the provider first, then re-sending, so recovery is safe. Known limit: providers without a
   deterministic payout reference (telebirr, mock) can re-send after a lost answer; for these always check
   the provider before clearing a flag.
7. **Clear the flag** ("Clear flag") only when you want the worker to resume the payout, after confirming
   with the provider that nothing was sent.

## Procedure: a flagged deposit

Open Flagged deposits. Confirm with the provider whether the money was collected.

- Collected -> **Resolve: credit** (the wallet is credited once; wagering rules apply).
- Not collected -> **Resolve: close**.
  A note is required. While a deposit reversed at the provider awaits staff, the player's withdrawals are refused
  (`deposit_under_review`): resolve these quickly.

## Procedure: a blocked settlement correction

A result was corrected after the player had already moved the old winnings (into other bets or a withdrawal),
so reversing them would take the balance below zero. The bet keeps its old settlement and the worker retries
the correction every 5 minutes (`settlement_retry_at`); the first block writes `bet.correction_blocked`.
Until it goes through: the player cannot request a withdrawal (`settlement_correction_pending`), nobody can
approve one, and approved withdrawals not yet sent went back to review with reason `settlement_correction`.

- It resolves itself when the player's balance covers the difference (an open bet wins, a deposit). The
  retry then posts the correction; review the held withdrawals again afterwards (reject any the balance no
  longer justifies).
- If it stays blocked, decide with compliance: reject the held withdrawals (the hold returns to the balance,
  which lets the next retry succeed), or void/correct by hand under the trading runbook. Never approve a
  withdrawal of a player with a blocked correction around the rule.

## Afterwards

- Run reconciliation for the day; the PSP check should be clean (`house_psp_clearing` equals succeeded
  intents and paid payouts). A payout settled by hand shows up there if a step was wrong.
- Upload the provider's statement (Compliance -> PSP statements) at least monthly: lines are matched
  one-to-one by reference, amount and direction.
- If several payouts hit the same cause, treat it as an incident ([basics](incident-basics.md)).
