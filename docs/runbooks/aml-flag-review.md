# AML flag review

Rules (velocity, structuring, deposit-then-withdraw, cash-out churn) run in the worker on relevant events and
in a daily sweep; thresholds are the `aml_rules` setting ([compliance.md](../compliance.md#4-aml-rules)). A
hit creates one flag per player, rule and window. Only staff with `aml.review` (roles **admin** and
**compliance**) see and decide flags: Back office -> Compliance -> AML.

**Severity:** medium flags are SEV3 (review within 1 business day). High-severity flags (structuring,
deposit-then-withdraw) hold the player's withdrawals and are SEV2: review the same business day, because a
legitimate player is waiting for money.

## What the system already did

- High severity + `holdWithdrawalsOnHighSeverity` (default on): new withdrawals of that player go to
  `requested` with review reason `aml_review`; approved payouts not yet sent go back to review; payouts
  already waiting are re-tagged `aml_review`.
- While the flag is `open` or `escalated`, **only `aml.review` staff** can approve those withdrawals
  (finance with `withdrawals.approve` alone gets 409 `aml_review_pending`).
- The player sees only the generic reason `manual_review`. **Never tell the player or front-line support the
  AML reason** (no tipping-off). Support says "your withdrawal is being reviewed and will be processed or
  you will be contacted."

## Procedure

1. **Open the flag**: rule, severity, window, the evidence figures (counts, sums, timestamps), and the
   player's links (profile, KYC, wallet, bets, deposits and withdrawals).
2. **Check the picture, not just the rule**
   - KYC: verified? name on the payment wallet matches? (payouts go only to the player's own wallet.)
   - Deposits vs betting: for deposit-then-withdraw, were the stakes really under 50% of the deposits since the
     last withdrawal, with a sum of at least 1,000 ETB? A player who deposited and bet normally on a long
     accumulator can trip it harmlessly.
   - Pattern history: earlier flags, exclusions, limit changes, multiple deposits near the 100,000 ETB threshold
     (structuring), repeated quick cash-outs (churn: could be abuse of the cash-out margin or a trader error).
   - Provider side: any returned/reversed deposits ([payouts runbook](payouts-stuck-or-flagged.md)).
3. **Decide and record** (a note is required; every review is audited):
   - **Dismiss**: false positive. Closes the flag; finance can then approve the held withdrawals normally.
   - **Review** (reviewed, no action): the activity was examined and is acceptable. Closes the flag.
   - **Escalate**: suspicious. The flag stays active (withdrawals stay held, only `aml.review` can release),
     and goes to the compliance officer / money-laundering reporting officer for a decision about reporting.
4. **Release or reject the held withdrawals**: after dismiss/review, finance approves as usual; after
   escalation only an `aml.review` holder may approve (with a written reason) or reject (the hold returns to
   the player). Do not release a withdrawal while a high-severity flag you cannot explain is open.
5. **Report if required.** Whether and how to file a suspicious-transaction report with the competent
   authority and ELS is a legal obligation of the licence holder (**to confirm with counsel**; no ELS
   interface is published yet). Keep the case file: flag id, evidence, decision, reporter, date.

## Tuning and false positives

Thresholds change in Back office -> Settings (`settings.edit`, setting `aml_rules`). Change them only with
compliance sign-off; record the old and new values and the reason. A burst of flags after a promotion or a
big event is normal: look at counts per rule before blaming a rule.

## Never

- Do not clear flags to "make the queue shorter".
- Do not discuss AML reasons with the player, in the app, by SMS, or through support.
- Do not delete or edit `aml_flags` rows or audit records; reviews are the only way to close a flag.
