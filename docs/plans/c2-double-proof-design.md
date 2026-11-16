# C2: settle manual payouts on double proof (design)

Status: design for review (15 Nov 2026). C2a (the pure rule) is built (section 11, 16 Nov 2026);
nothing else here is. Plan reference:
[`scale-and-payments-plan.md`](scale-and-payments-plan.md) section 6, option C2; owner decisions D4 and D8.
Read first: CLAUDE.md "Rules that matter" and "Payments", [`docs/runbooks/sms-rail.md`](../runbooks/sms-rail.md).

## 0. Today, in one paragraph

A manual payout (`payouts.manual = true`, provider `sms`) goes `approved` (by a person with
`withdrawals.approve`, or `system:auto`) → `processing` when an operator claims it
(`claimManualPayout`, `paying_by` = operator, `processing_at` = claim time) → the operator sends the money
by hand from a company collection account → `paid` when the same operator clicks Settle
(`settleManualPayout` → `pay()` in `packages/db/src/payments/manualpayouts.ts`: ledger
`withdrawal` posting, `settled_by` = operator, `paying_by` cleared, `settlement_reference`,
`settlement_sms_id`, the SMS row set to `settled`, outbox `payment.withdrawal_paid`, audit). The
collection handset forwards the outgoing (debit) SMS; `applyDebit` in `packages/db/src/payments/smsrail.ts`
calls core `proposePayoutForSms` and marks the SMS `settlement_proposed` for one payout. The receipt
verifier (`packages/payments/src/receipts/verifier.ts`) only audits **credits** (`runReceiptAudit` in
`apps/worker/src/tasks/smsrail.ts`, rows with `status = 'matched'`).

## 1. Goal and non-goals

**Goal.** When, for a claimed telebirr wallet payout, (1) the debit SMS the collection handset forwarded
and (2) telebirr's own receipt page for the same transaction reference agree on every field in section 3,
the worker settles the payout itself. The operator only sends the money.

**Stays human (unchanged):**

| Step                     | Who                                                                        |
| ------------------------ | -------------------------------------------------------------------------- |
| Approve                  | `withdrawals.approve` or `system:auto` (unchanged rules)                   |
| Claim                    | An operator with `payouts.settle_manual`, never the approver               |
| Send the money           | The claimer, by hand                                                       |
| Release / Fail           | The claimer only                                                           |
| Settle when proofs wait  | The claimer, by the existing click (always available as fallback)          |
| Bank payouts, CBE, other | Fully manual, as today (no readable receipt page; holder-name attestation) |
| Proofs disagree          | Staff investigate; the system never fails, releases or reverses anything   |

**Non-goals.** Sending money by code (C4/C8), auto-fail or auto-release, settling unclaimed payouts,
settling on one proof, bank or CBE payouts, changing how the debit SMS is proposed for deposits.

## 2. Four eyes is preserved

The rule "the person who approves never pays" is about who can _move_ money. C2 changes only who
_records_ the fact that money moved, and only after an independent source (the telco) confirms it.

- **Who sends:** the claimer, a human, as today. The approver can never claim
  (`assessManualPayout`, `payouts_manual_four_eyes`).
- **Who the settlement is recorded under:** `payouts.settled_by` = **the claimer** (`paying_by` at the
  moment of settlement), with a new column `payouts.settlement_method = 'double_proof'`. The ledger
  posting and the audit row carry the system actor `system:double_proof` (ledger
  `actor: { type: 'system', id: 'system:double_proof' }`; audit `actorType: 'system'`), with
  `sentBy: <claimer>` in the audit metadata. Reasons: `paying_by` is cleared on settlement, so writing
  `system:...` into `settled_by` would erase the only row-level record of who sent the money, and
  `payouts_manual_four_eyes` (`settled_by <> approved_by`) would become trivially true. Recording the claimer
  keeps that constraint meaningful; recording the system as actor keeps the audit honest about what clicked.
- **What `assessManualPayout` must allow** (`packages/core/src/payoutflow.ts`): a new action
  `auto_settle`, `from: ['processing'] → 'paid'`, accepted only when
  `actor === AUTO_SETTLE_ACTOR` (`'system:double_proof'`) and `payingBy !== null` and
  `payingBy !== approvedBy`. Two new denials:
  - `auto_settle` with any other actor → `not_automatic`;
  - `settle` (the click) with an actor starting `system:` → `not_a_person` (closes the reverse path:
    nothing automatic may use the click path, whose proof rules are weaker).
    `release` / `fail` / `claim` are untouched. The new action is reachable only from the new DB
    function in section 5; no API route calls it.
- **What the database must allow and newly enforce** (the next free migration number (0055 when
  this was written; 0053 and 0054 are taken by the SMS rail work), section 5): a trigger on
  `payouts` that, for a manual payout entering `paid`, requires `OLD.status = 'processing'`,
  `NEW.settled_by = OLD.paying_by` and `NEW.settled_by NOT LIKE 'system:%'`; and, when
  `settlement_method = 'double_proof'`, an evidence row for exactly that payout and SMS. The existing human
  path already satisfies all three, so this tightens both paths and opens none.

## 3. Acceptance rule

New pure module `packages/core/src/payoutproof.ts` (no I/O). The masked-account comparison it needs
(`receiptAccountMatches`, today in `packages/payments/src/receipts/accountmatch.ts`) is pure: move it to
core and re-export it from payments.

```ts
export const DOUBLE_PROOF_RULE_VERSION = 1;
export const AUTO_SETTLE_ACTOR = 'system:double_proof';

export interface ProofPayout {
  id: string;
  manual: boolean;
  provider: string; // must be 'sms'
  status: string; // must be 'processing'
  amount: Santim;
  destinationInstitution: string; // payouts.destination_institution
  destinationAccount: string; // E.164 for wallets (copied at request time)
  playerCurrentPhone: string | null; // users.phone now (CLAUDE.md: the currently registered wallet)
  approvedBy: string | null;
  payingBy: string | null; // the claimer
  claimedAt: Date | null; // payouts.processing_at (reset on every claim)
  amlHold: boolean; // amlHoldsWithdrawals(user)
  openReceiptAlarm: boolean; // any of the player's credited SMS with receipt_status 'rejected', unresolved
  referenceSettledElsewhere: boolean; // another payout has settlement_reference = sms.reference
}

export interface ProofSms {
  id: string;
  source: string; // must be 'gateway'
  institution: string | null;
  direction: 'credit' | 'debit' | null;
  amount: Santim | null;
  reference: string | null;
  counterpartyPhone: string | null; // E.164 parsed from the SMS
  occurredAt: Date | null; // institution's time in the SMS
  receivedAt: Date; // OUR server clock (received_sms.received_at)
  status: string; // must be 'settlement_proposed'
  proposedPayoutId: string | null; // must be payout.id
}

export interface DebitReceiptFacts {
  reference: string | null;
  principalAmount: Santim | null; // the labelled transferred amount, NOT "any figure on the page"
  payerAccount: string | null; // possibly masked
  receiverAccount: string | null; // possibly masked
  completed: boolean | null;
  occurredAt: Date | null; // minute precision, EAT
}

export type DebitReceiptResult =
  | {
      status: 'verified' | 'rejected';
      reason: string | null;
      facts: DebitReceiptFacts;
      fetchedAt: Date;
    }
  | { status: 'not_found'; fetchedAt: Date } // telebirr's "This request is not correct" page
  | {
      status: 'indeterminate';
      reason: 'unparseable' | 'unavailable' | 'timeout' | 'breaker_open';
      fetchedAt: Date;
    }
  | { status: 'skipped'; fetchedAt: Date };

export interface ProofPolicy {
  institutions: readonly string[]; // PAYOUT_AUTO_SETTLE_INSTITUTIONS, ['telebirr']
  collectionAccounts: readonly string[]; // ours at payout.destinationInstitution
  maxPerPayout: Santim;
  remainingToday: Santim; // daily cap minus today's auto-settled total (EAT day), read under lock
  remainingTodayForClaimer: Santim; // per-operator daily cap, same
  windowMs: number; // claim → SMS received, default 4 h
  maxReceiptAgeMs: number; // default 5 min
  notFoundGraceMs: number; // default 15 min: the page may lag a fresh transfer
  minRevealedDestinationDigits: number; // default 6, set from the real fixture
}

// WaitCode and MismatchCode: string unions of the codes in the decision table below.
export interface ProofWait {
  code: WaitCode;
  retry: boolean; // false: hand to a human, stop checking
}
export type ProofDecision =
  | { decision: 'settle'; ruleVersion: number; settledBy: string }
  | { decision: 'wait'; reasons: ProofWait[]; ruleVersion: number }
  | { decision: 'mismatch'; reasons: MismatchCode[]; ruleVersion: number };

export function decideDoubleProof(input: {
  payout: ProofPayout;
  sms: ProofSms;
  receipt: DebitReceiptResult;
  policy: ProofPolicy;
  now: Date;
}): ProofDecision;
```

**Evaluation.** Every check runs; reasons are collected. Any mismatch reason → `mismatch` (all
reasons). Else any wait reason → `wait`. Else `settle` with `settledBy = payout.payingBy`. Every check is
a positive assertion: a null or unreadable field can never satisfy it. The function is total (never
throws) and deterministic.

### Decision table

`claim⁻` = `floorToMinute(claimedAt) − SMS_INSTITUTION_CLOCK_SKEW_MS` (5 min, `smsmatch.ts`), because
the receipt shows minutes only.

| #   | Check                                                       | Pass when                                                                                                                    | Otherwise                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Manual SMS-rail payout                                      | `manual && provider === 'sms'`                                                                                               | wait `not_manual` (human)                                                                                                                                                                                                                                                              |
| E2  | Institution allowlisted, wallet kind                        | `destinationInstitution ∈ institutions`, `payoutDestination(..).kind === 'wallet'`                                           | wait `institution_not_allowed` (human)                                                                                                                                                                                                                                                 |
| E3  | Per-payout cap                                              | `amount ≤ maxPerPayout`                                                                                                      | wait `over_payout_cap` (human)                                                                                                                                                                                                                                                         |
| E4  | Daily caps                                                  | `amount ≤ remainingToday && amount ≤ remainingTodayForClaimer`                                                               | wait `over_daily_cap` (human)                                                                                                                                                                                                                                                          |
| E5  | No hold on the player                                       | `!amlHold && !openReceiptAlarm`                                                                                              | wait `player_on_hold` (human)                                                                                                                                                                                                                                                          |
| E6  | Destination is the player's current phone                   | `destinationAccount === playerCurrentPhone`                                                                                  | wait `destination_not_current_phone` (human)                                                                                                                                                                                                                                           |
| S1  | Payout is claimed                                           | `status === 'processing' && payingBy !== null && claimedAt !== null`                                                         | wait `not_processing` (stop)                                                                                                                                                                                                                                                           |
| S2  | Four eyes                                                   | `payingBy !== approvedBy`                                                                                                    | mismatch `four_eyes_violation` (the DB forbids it: alarm)                                                                                                                                                                                                                              |
| S3  | SMS is the live proposal for this payout                    | `status === 'settlement_proposed' && proposedPayoutId === payout.id`                                                         | wait `sms_not_proposed` (stop)                                                                                                                                                                                                                                                         |
| P1  | SMS came from the handset                                   | `source === 'gateway'` (never `simulator`, never `receipt`)                                                                  | wait `sms_not_from_gateway` (human)                                                                                                                                                                                                                                                    |
| P2  | SMS is a debit of the same institution                      | `direction === 'debit' && institution === destinationInstitution`                                                            | mismatch `sms_not_debit` / `sms_institution_differs`                                                                                                                                                                                                                                   |
| P3  | SMS names the destination in full                           | `counterpartyPhone !== null`                                                                                                 | wait `sms_without_destination` (human: `amount_only` proposal)                                                                                                                                                                                                                         |
| P4  | SMS destination                                             | `counterpartyPhone === destinationAccount`                                                                                   | mismatch `sms_destination_differs`                                                                                                                                                                                                                                                     |
| P5  | SMS amount, exact santim                                    | `sms.amount === payout.amount`                                                                                               | mismatch `sms_amount_differs`                                                                                                                                                                                                                                                          |
| P6  | SMS received after this claim (our clock)                   | `sms.receivedAt > claimedAt`                                                                                                 | wait `sms_before_claim` (human; also alarm if payout was re-claimed)                                                                                                                                                                                                                   |
| P7  | Within the window                                           | `sms.receivedAt − claimedAt ≤ windowMs`                                                                                      | wait `outside_window` (human)                                                                                                                                                                                                                                                          |
| R1  | Receipt fetched                                             | status `verified`                                                                                                            | `indeterminate` → wait `receipt_indeterminate` (retry); `skipped` → wait `receipt_unsupported` (human); `not_found` → wait `receipt_not_found_yet` (retry) while `now − sms.receivedAt < notFoundGraceMs`, else mismatch `receipt_not_found`; `rejected` → mismatch `receipt_<reason>` |
| R2  | Receipt fresh                                               | `now − fetchedAt ≤ maxReceiptAgeMs`                                                                                          | wait `receipt_stale` (retry)                                                                                                                                                                                                                                                           |
| R3  | Completed                                                   | `completed === true`                                                                                                         | `false` → mismatch `receipt_not_completed`; `null` → wait `receipt_status_unreadable` (retry)                                                                                                                                                                                          |
| R4  | Same transaction reference on both proofs                   | `facts.reference !== null && facts.reference === sms.reference`                                                              | `null` → wait `receipt_reference_unreadable`; differs → mismatch `reference_differs`                                                                                                                                                                                                   |
| R5  | Receipt amount, exact santim                                | `principalAmount === payout.amount`                                                                                          | `null` → wait `receipt_amount_unreadable`; differs → mismatch `receipt_amount_differs`                                                                                                                                                                                                 |
| R6  | Payer is OUR collection account                             | `receiptAccountMatches(payerAccount, a)` for some `a ∈ collectionAccounts`                                                   | `null` → wait; else mismatch `payer_not_ours`                                                                                                                                                                                                                                          |
| R7  | Receiver is the payout's destination                        | `receiptAccountMatches(receiverAccount, destinationAccount)` with ≥ `minRevealedDestinationDigits` revealed incl. the last 3 | `null` or too masked → wait `receiver_unreadable` (human); else mismatch `receiver_differs`                                                                                                                                                                                            |
| T1  | Transfer after the claim                                    | `facts.occurredAt ≥ claim⁻`                                                                                                  | `null` → wait `receipt_time_unreadable` (human); else mismatch `transfer_before_claim`                                                                                                                                                                                                 |
| T2  | SMS not received before the transfer happened               | `facts.occurredAt ≤ sms.receivedAt + 5 min`                                                                                  | mismatch `sms_precedes_transfer` (forgery signature)                                                                                                                                                                                                                                   |
| T3  | SMS time agrees with the receipt (when the SMS carries one) | `sms.occurredAt === null` or `abs(sms.occurredAt − facts.occurredAt) ≤ 2 min`                                                | mismatch `times_disagree`                                                                                                                                                                                                                                                              |
| U1  | Reference used once                                         | `!referenceSettledElsewhere`                                                                                                 | mismatch `reference_already_used`                                                                                                                                                                                                                                                      |

Uniqueness (one SMS and one receipt per payout) is held by the database, not only by the rule:
`received_sms_reference_uq` (one row per reference), `received_sms_proposed_payout_uq` (one SMS per
payout), `payouts_settlement_reference_uq` (one payout per reference), the `received_sms_guard` trigger
(a `settled` proof is final), and the new `payout_settlement_proofs_settled_uq` (section 5). R4 ties the
receipt to the SMS's reference, so the receipt inherits the SMS's uniqueness.

The DB function re-runs `decideDoubleProof` inside the settling transaction on freshly locked rows
(section 4, TOCTOU); only a `settle` from that second run settles.

## 4. Threat model

The handset is the trust anchor of the SMS rail (runbook). **Assume the claimer can operate the
collection handset**: operators send from the collection account, which is likely the same phone. So the
debit SMS is _not_ independent of the person whose honesty it checks; the receipt page is the independent
proof, and the caps bound what is left.

| Threat                                                                        | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged debit SMS (handset or `SMS_GATEWAY_SECRET` compromised), no money sent | The receipt must exist for that reference with our account as payer, the destination as receiver and the exact amount (R1–R7). A forger cannot make Ethio Telecom serve it. Not-found after the grace → mismatch + alarm.                                                                                                                                                                                                                                                                           |
| Forged SMS carrying a real reference of another transfer                      | R4–R7: the receipt for that reference must still name our payer, this destination and this amount; U1 and the reference unique indexes stop reusing a reference that settled another payout; T1/P6 stop a transfer made before this claim.                                                                                                                                                                                                                                                          |
| Forged or replayed receipt                                                    | The URL is built from the institution registry and the reference only (`institutionById(...).receiptUrl`), host allowlist `transactioninfo.ethiotelecom.et`, redirects refused, body capped (`verifier.ts`). Nothing from SMS text or a player reaches the URL. A replayed (old) receipt fails T1. TLS to the telco is the trust boundary.                                                                                                                                                          |
| A receipt for a different payout of the same amount                           | Two payouts of ETB 500 are routine: P3/P4 require the full destination in the SMS (`amount_only` proposals never auto-settle), R7 requires the receipt receiver to match this payout's destination, R4 binds both proofs to one reference.                                                                                                                                                                                                                                                          |
| Operator collusion: sends **less**                                            | P5 and R5 exact santim. R5 must read the **labelled principal** (C2c): today `judgeReceipt` accepts the amount if it appears _anywhere_ on the page, which includes "total paid" with fees, so a 498 transfer with a 2 birr fee could show 500. Unreadable principal → wait.                                                                                                                                                                                                                        |
| Operator collusion: sends to **another number**                               | P4 (full number in SMS) and R7 (receipt receiver). Residual: a forged SMS showing the player's number plus a real transfer to an accomplice whose number matches the receipt's mask. Bounded by `minRevealedDestinationDigits` (set from the real fixture), by the caps, and by the player complaining; `settled_by` names the claimer. Owner question Q1.                                                                                                                                          |
| Amount or destination tweaked (the payout row, the payout account)            | The destination is copied at request time and the `payout_accounts` guard trigger forbids edits; E6 requires it to still be the player's registered phone; the DB function re-reads the row under lock.                                                                                                                                                                                                                                                                                             |
| Receipt page unreachable, slow, or changed shape                              | `indeterminate` (unavailable, timeout, breaker open, unparseable) and every unreadable field → **wait**. Never settle, never fail. After the window the payout falls to the human click, and the existing `manual_payout_claim_idle` alarm (30 min) prompts it. A page that changed shape shows as a rise in `receipt_*_unreadable` waits (metric, section 7).                                                                                                                                      |
| Time-of-check/time-of-use (receipt fetched outside the transaction)           | Network I/O never holds a row lock. Phase 1: fetch and decide without a transaction. Phase 2: one transaction locks the payout and the SMS `FOR UPDATE`, re-reads every input (status, `paying_by`, `processing_at`, destination, holds, SMS status, reference use, caps), re-runs `decideDoubleProof` with the phase-1 receipt (R2 bounds its age) and settles only on `settle`. A claim, release or re-claim in between changes `processing_at` or `status` and fails S1/P6/T1.                   |
| Double settlement by two workers                                              | Row lock + status re-check (`processing` only), the ledger idempotency key `withdrawalPaidLedgerKey(payout.id)`, the SMS `settled` final state, `payout_settlement_proofs_settled_uq`. A Redis `tryLock` (`apps/worker/src/lib/lock.ts`) on each round only saves duplicate receipt fetches; correctness does not depend on it.                                                                                                                                                                     |
| Auto-settle racing a human settle                                             | Same row lock: whoever commits first wins; the other sees `paid` (`manual_payout_wrong_status` for the human, a logged no-op for the worker). Both paths write the same posting key, so at most one posting exists.                                                                                                                                                                                                                                                                                 |
| Auto-settle racing a release or fail                                          | Release/fail first → status is no longer `processing`, auto refuses; the worker then sees a debit proof for a released/failed payout and raises `payout_proof_after_release` / `payout_proof_after_fail` (money may have left twice, or the hold went back although money left). Auto first → release/fail get `manual_payout_wrong_status`. Proposed hardening: `failManualPayout` refuses (409 `payout_proof_exists`) while a debit SMS received after the claim is proposed for the payout (Q3). |
| Race on the daily cap (two payouts each under, together over)                 | The DB function takes `pg_advisory_xact_lock(hashtext('payout_auto_settle_day'))` before summing today's `double_proof` total (pattern used in `apps/worker/src/tasks/compliance.ts`).                                                                                                                                                                                                                                                                                                              |
| Bank payouts                                                                  | Never candidates (E2): no readable receipt page (CBE's refuses outside connections; no others are parsed), and the holder-name confirmation is a human attestation. They stay fully manual.                                                                                                                                                                                                                                                                                                         |
| Proofs disagree                                                               | `mismatch`: the payout stays `processing` with its claimer; the evidence row is written; `error` log `alarm: payout_proof_mismatch` + owner alert; auto-settle **suspends itself** (falls back to shadow) until a person resumes it. Never auto-fail, never auto-release, never reverse.                                                                                                                                                                                                            |
| Upstream compromise signals                                                   | Auto-settle also suspends on `sms_receipt_rejected` and on `sms_balance_drift` with direction `credited_more_than_arrived` (both point at a forged-SMS handset).                                                                                                                                                                                                                                                                                                                                    |
| Staff over-trust ("the system checked it")                                    | Bank and over-cap payouts stay manual; in shadow the verdict is hidden from operators (so the comparison stays honest); the runbook says what the automation does not check.                                                                                                                                                                                                                                                                                                                        |

## 5. Data model

**What must be stored as evidence per decision:** payout id, SMS id, the claimer and claim time used,
mode (shadow/on), decision and reasons, rule version, receipt reference, receipt status/reason, every
parsed receipt field, SHA-256 of the full fetched body, a bounded text excerpt (the flattened page, ≤ 4000
characters, not the first 4 KB of HTML which is mostly `<head>`), when it was fetched, when decided, and
which worker.

**Existing columns do not fit:**

- `received_sms.receipt_*` is one result per SMS with credit-audit semantics: `receipt_payer` stores the
  payer _name_ (`runReceiptAudit` passes `facts.payerName`), there is no payer account, amount, completed,
  time or hash, a `rejected` value puts the row at the top of the review queue as a "credited SMS" alarm,
  and `receipt_raw` keeps the first 4 KB of HTML only for rejections. Leave these columns to the credit
  audit; C2 does not write them.
- `payouts.settlement_*` holds the reference and SMS id only, which stay as they are.

**Migration `NNNN_payout_double_proof.sql`** at the next free migration number (0055 when this was
written; 0053 and 0054 are taken by the SMS rail work). If another session takes the same number first,
whoever merges second renumbers theirs and regenerates the drizzle snapshot and journal. Additive only:

```sql
ALTER TABLE payouts ADD COLUMN settlement_method text;             -- NULL = settled by the click
ALTER TABLE payouts ADD CONSTRAINT payouts_settlement_method
  CHECK (settlement_method IS NULL OR settlement_method = 'double_proof');
ALTER TABLE payouts ADD CONSTRAINT payouts_double_proof_has_sms
  CHECK (settlement_method IS NULL OR (manual AND settlement_sms_id IS NOT NULL));

CREATE TABLE payout_settlement_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE RESTRICT,
  sms_id uuid NOT NULL REFERENCES received_sms(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('shadow', 'on')),
  decision text NOT NULL CHECK (decision IN ('settle', 'wait', 'mismatch')),
  reasons text[] NOT NULL DEFAULT '{}',
  rule_version smallint NOT NULL,
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL,
  receipt_reference text,
  receipt_status text,           -- verified | rejected | not_found | indeterminate | skipped
  receipt_reason text,
  receipt_facts jsonb,           -- DebitReceiptFacts, amounts as decimal strings
  receipt_body_sha256 text,
  receipt_excerpt text CHECK (receipt_excerpt IS NULL OR length(receipt_excerpt) <= 4000),
  receipt_fetched_at timestamptz,
  settled boolean NOT NULL DEFAULT false,   -- this row's transaction settled the payout
  decided_by text NOT NULL,      -- 'system:double_proof@<host>/<pid>'
  decided_at timestamptz NOT NULL,
  CHECK (NOT settled OR (mode = 'on' AND decision = 'settle'))
);
CREATE UNIQUE INDEX payout_settlement_proofs_settled_uq ON payout_settlement_proofs (payout_id) WHERE settled;
CREATE UNIQUE INDEX payout_settlement_proofs_settled_ref_uq ON payout_settlement_proofs (receipt_reference) WHERE settled;
CREATE INDEX payout_settlement_proofs_payout_idx ON payout_settlement_proofs (payout_id, decided_at);
CREATE INDEX payout_settlement_proofs_mismatch_idx ON payout_settlement_proofs (decided_at) WHERE decision = 'mismatch';
```

Hand-written guards in the same file (repo pattern of `0044_sms_rail_guards.sql`):

- `payout_settlement_proofs` append-only: `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` →
  `vamos_reject_mutation()`; `REVOKE UPDATE, DELETE ON payout_settlement_proofs FROM vamos_app`.
- `vamos_guard_manual_settle()`, `BEFORE UPDATE ON payouts`: when `OLD.manual` and `NEW.status = 'paid'`
  and `OLD.status <> 'paid'`: raise unless `OLD.status = 'processing'`, `NEW.settled_by = OLD.paying_by`,
  `NEW.settled_by NOT LIKE 'system:%'`; and when `NEW.settlement_method = 'double_proof'`, raise unless a
  row exists in `payout_settlement_proofs` with `payout_id = NEW.id`, `settled`, and
  `sms_id = NEW.settlement_sms_id` (the function inserts the evidence row first). Raise when
  `settlement_method` changes outside that transition.

Write only a new evidence row when the decision or its reasons change, or when it settles (a wait is
re-checked every 30 s and must not grow the table).

**Rollback safety.** An older application image ignores the nullable column and the new table. The new
trigger is satisfied by today's `settleManualPayout` (it requires `processing` and sets
`settled_by = staffId = paying_by`) and nothing else sets a manual payout to `paid`
(`markPayoutPaid` calls `assertNotManual`). Payouts already auto-settled stay valid rows. The drizzle
migrator of an older image applies nothing newer than its own journal. No backfill.

**The settling function** (`packages/db/src/payments/manualpayouts.ts`):
`autoSettleManualPayout(tx, { payoutId, smsId, receipt: DebitReceiptResult & { bodySha256, excerpt }, policy, mode: 'on', decidedBy, now })`:
lock payout (`lockPayout`) and SMS `FOR UPDATE`; `assessManualPayout({ action: 'auto_settle', actor: AUTO_SETTLE_ACTOR, ... })`;
advisory lock and today's totals; build `ProofPayout`/`ProofSms` from the locked rows;
`decideDoubleProof`; insert the evidence row (with `settled` = whether it settles); on `settle`, call the
shared `pay()` refactored to take `{ settledBy, actor, settlementMethod }` (holder name `false`;
wallets only). One transaction: evidence, posting, payout, SMS `settled`, outbox, audit.

## 6. Switches and caps

All new, all off or strict by default, in `packages/config/src/config.ts`:

| Setting                                        | Default     | Meaning                                                                   |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| `PAYOUT_AUTO_SETTLE`                           | `off`       | `off` \| `shadow` (decide and record, never settle) \| `on`               |
| `PAYOUT_AUTO_SETTLE_INSTITUTIONS`              | `telebirr`  | CSV; only institutions with a `receiptUrl` (today: telebirr) are accepted |
| `PAYOUT_AUTO_SETTLE_MAX_SANTIM`                | unset       | Per-payout cap. Required (> 0) for `on`                                   |
| `PAYOUT_AUTO_SETTLE_DAILY_MAX_SANTIM`          | unset       | Total auto-settled per EAT day. Required for `on`, ≥ the per-payout cap   |
| `PAYOUT_AUTO_SETTLE_OPERATOR_DAILY_MAX_SANTIM` | = daily cap | Per claimer per EAT day (limits one colluding operator)                   |
| `PAYOUT_AUTO_SETTLE_WINDOW_MINUTES`            | `240`       | Claim → SMS received                                                      |

Suggested first values for `on` (owner decides, Q2): ETB 1,000 per payout, ETB 20,000 per day, ETB 5,000
per operator per day.

**Config guards** (thrown as `ConfigError` only when the new switch is not `off`; they never relax an
existing check). Today the SMS-rail checks in `smsRailLicensedViolations` are only `console.warn`ed;
these new ones are hard errors:

- `shadow` or `on`: `OPERATING_MODE=licensed`, `sms` in `PAYMENT_PROVIDERS`, `SMS_RAIL_MODE=live`,
  `RECEIPT_VERIFY=audit`, at least one collection account at each allowlisted institution, the
  institutions limited to receipt-verifiable ones.
- `on` also: `PAYOUT_REQUIRE_PROOF=true` (a waiver does not count), both caps set, per-payout ≤ daily,
  `SMS_GATEWAY_SECRET` passing the 32-character/distinct test.

**Runtime kill switch** in the `settings` table, key `payouts.auto_settle`:
`{ suspended: boolean, reason, since, by }`. The env caps are ceilings; settings may only lower them.
Anyone with `payouts.settle_manual` or `sms.review` may suspend; resuming needs a new permission
`payouts.auto_settle` (admin role only) and a note; both audited. The worker suspends it itself on
`payout_proof_mismatch`, `sms_receipt_rejected`, `sms_balance_drift (credited_more_than_arrived)`,
`payout_proof_after_release` / `after_fail`. While suspended, `on` behaves as `shadow`.

**Shadow first.** In `shadow` the worker runs the full rule (including the receipt fetch) for every
claimed telebirr payout with a proposed debit SMS, writes evidence rows (`mode = 'shadow'`), and never
writes payouts or SMS. Operators do not see the verdict. A daily job (or report query) compares each
shadow decision with what the human then did:

| Outcome                                                                                | Class             | Allowed         |
| -------------------------------------------------------------------------------------- | ----------------- | --------------- |
| Shadow `settle`, human settled with the same SMS and reference                         | agreement         | target          |
| Shadow `settle`, payout then released or failed, or settled with another SMS/reference | **false settle**  | **0**           |
| Shadow `wait`/`mismatch`, human settled                                                | missed automation | explained each  |
| Shadow `mismatch`, investigation shows the money did not arrive as recorded            | caught            | report to owner |

**Gate to `on`:** at least 14 consecutive days and at least 200 human-settled telebirr payouts within the
caps; zero false settles; every `mismatch` explained in writing; agreement ≥ 95 % of eligible payouts;
the real fixtures of section 8 committed and the parser passing them; the security review done; owner D4
and counsel D8 signed. Start `on` with the low caps; raise them after 30 more clean days.

## 7. Failure and observability

**Worker job** `payout-auto-settle` (`apps/worker/src/tasks/payoutproof.ts`, registered beside
`smsRailTasks`): every 30 s, only when mode is not `off` and the provider is live; `tryLock` per round;
candidates = `payouts` manual, `processing`, destination in the allowlist (over-cap ones included: their
receipt is checked and a mismatch alarms, they just never settle), joined to their `settlement_proposed`
gateway debit SMS received after `processing_at`; up to 20 per round; stops the round on `breaker_open`.
It shares `ctx.receipts` (the same breaker and concurrency as the credit audit). The statement "the
worker never touches manual payouts" in the runbook and in `payoutflow.ts` changes to "the worker
only settles a claimed telebirr payout on double proof, never claims, releases or fails one".

**Alarms** (`error` log lines with an `alarm` field; each raises an owner alert through
`raiseOwnerAlert` with new `OwnerAlertInput` variants in `packages/core/src/owner-alert.ts`; the alert text
names no player, phone, amount or reference):

| `alarm`                          | When                                                           | Owner text (≤ 160 chars)                                                                                        |
| -------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `payout_proof_mismatch`          | A decision is `mismatch` (shadow or on)                        | "Payout proofs disagree on a telebirr payout. It stays unpaid with its operator; automatic settling is paused." |
| `payout_auto_settle_suspended`   | Suspended by the worker (reason in the log line)               | "Automatic payout settling paused after an alarm. Operators settle by hand."                                    |
| `payout_proof_after_release`     | A post-claim debit proof exists for a payout that was released | "Money left for a payout that was handed back unpaid. It may be paid twice; check before anyone claims it."     |
| `payout_proof_after_fail`        | A post-claim debit proof exists for a payout that was failed   | "Money left for a payout marked failed, and the hold went back to the player."                                  |
| `payout_auto_settle_cap_reached` | Daily cap reached (once per EAT day)                           | "Today's limit for automatic payout settling is reached. Operators settle by hand."                             |

**Metrics** (`apps/api/src/plugins/metrics.ts`, read from the database in `readBusinessGauges`, so no
worker exporter is needed): `manual_payout_auto_settle_mode` (0 off, 1 shadow, 2 on, 3 suspended),
`manual_payout_auto_settled_today` (count) and `manual_payout_auto_settled_today_birr`,
`manual_payout_proof_mismatches_open` (mismatch on payouts still `processing`),
`manual_payout_proof_waiting` by reason class (`receipt_indeterminate`, `receipt_unreadable`, `human`),
`manual_payout_shadow_false_settles_14d` (must stay 0).

**Runbook** (new section in `docs/runbooks/sms-rail.md`, "Automatic settle (double proof)"):

> When `PAYOUT_AUTO_SETTLE=on`, a telebirr payout you claimed is settled by the system once your outgoing
> SMS and telebirr's receipt page agree on amount, number and reference. You still claim it and send it;
> you no longer click Settle. The row shows "Settled automatically: sent by you". If the row says
> "Waiting for receipt" for more than 30 minutes, settle it by hand as before. Bank payouts and payouts
> above the limit are always settled by hand.
>
> **Proof mismatch** (alarm `payout_proof_mismatch`, top of Manual payouts): do not release or fail it.
> Open the row: it lists what disagreed (amount, number, payer, reference, time) and the stored receipt
> excerpt. Look the reference up in the telebirr app or merchant portal. If the money went to the player
> correctly and the receipt was misread, settle by hand with a note and capture the receipt as a fixture.
> If it went elsewhere or for another amount, this is SEV1 ([incident basics](incident-basics.md)): keep
> the payout in processing, secure the handset, rotate `SMS_GATEWAY_SECRET`. Only an admin resumes
> automatic settling, with a note.
>
> **Proof after release / fail**: someone handed back or failed a payout whose money had left. Stop
> claims on that player, find the transfer, and correct through engineering (never SQL).

## 8. Tests

**Pure rule (C2a, `packages/core/src/payoutproof.test.ts`, vitest + fast-check):**

- One example test per decision-table row (pass and each failure value, including `null`).
- Property: from an arbitrary valid `settle` input, mutating **exactly one** field (amount ±1..n santim
  on SMS, receipt or payout; one digit of the destination in SMS or receipt; payer account; one
  character of either reference; `completed` false/null; each time moved outside its bound; source;
  direction; institution; status; `proposedPayoutId`; `payingBy` null or equal to `approvedBy`; each hold
  flag; `referenceSettledElsewhere`) never yields `settle`.
- Property: setting any receipt field to `null`, or the receipt to any non-`verified` status, never
  yields `settle`.
- Property: total and deterministic for arbitrary inputs (never throws); `settledBy` always equals
  `payout.payingBy` and is never the approver nor `system:*`.
- `assessManualPayout`: `auto_settle` only from `processing`, only for `AUTO_SETTLE_ACTOR`; `settle`
  refused for `system:*`; existing cases unchanged (port the table test).
- `receiptAccountMatches` (moved to core): masked/unmasked forms, the minimum-revealed rule, a property
  that a value with fewer revealed digits never matches.

**DB integration (C2b, `packages/db/test/manual-payout-auto-settle.test.ts`, `createTestDatabase`):**

- Happy path: one transaction writes evidence (`settled`), posting (entries sum to zero), payout `paid`
  with `settled_by` = claimer and `settlement_method = 'double_proof'`, SMS `settled`, outbox, audit with
  system actor.
- Two concurrent `autoSettleManualPayout` calls on two connections → one settles, one no-op, one posting.
- Auto vs human settle concurrently → exactly one; the human gets `manual_payout_wrong_status`.
- Release (and fail) committed first → auto refuses; auto first → release/fail get 409.
- Release + re-claim by another operator between fetch and transaction → refused (P6/T1).
- Daily and per-operator caps under concurrency (two payouts, together over the cap) → one settles.
- Triggers: a direct `UPDATE` setting `settled_by` ≠ `paying_by`, `settled_by = 'system:x'`, `paid`
  from `approved`, or `double_proof` without an evidence row → `check_violation`; evidence rows cannot be
  updated or deleted.
- The existing manual-payout suites (`payments-smsrail.test.ts`, `manual-payout-batch.test.ts`) pass
  unchanged with the new trigger (rollback compatibility of the old path).

**Receipt verifier debit mode (C2c, `packages/payments/src/receipts/receipts.test.ts`):** principal amount
read from its label and never from the total or fee; a page with fee > 0 and total = payout amount gives
`receipt_amount_differs` or unreadable, never a match; missing payer/receiver/reference/status → unreadable
fields; `bodySha256` and excerpt produced; the URL comes only from the registry; not-found page → `not_found`.

**Worker (C2d, `apps/worker/test/payoutproof.test.ts`, fake `ReceiptVerifier`):** `off` fetches nothing;
`shadow` writes evidence and never changes a payout or SMS; `on` settles; `indeterminate` and
`breaker_open` wait (no settle, no fail, retried next round); `not_found` waits during the grace then
mismatches; `mismatch` logs the alarm, raises the owner alert and suspends; suspended `on` acts as
`shadow`; cap reached stops settling and alarms once; two worker instances do not double-fetch (lock).
Config tests: every guard in section 6.

**Only verifiable with real captures** (today's fixtures are reconstructed: `receipts/fixtures.ts` says
so, and the telebirr debit SMS fixture `debitEnglish` is synthetic). The owner captures, from a staff test
transfer out of the real collection account to a staff phone, scrubbing names and phones but keeping
every byte of layout and the masking pattern:

1. The outgoing SMS as the handset receives it (English, and Amharic if the SIM gets Amharic): does it
   carry the recipient's full number or a masked one, the time with seconds, the reference, the balance?
2. The receipt page for that transfer's reference, saved as raw HTML (`transactioninfo.ethiotelecom.et/receipt/<ref>`):
   that a P2P transfer has a receipt at all; the labels; how payer and receiver numbers are masked (how
   many digits shown); which label holds the transferred amount versus fee, VAT and total; the status
   word; the date format.
3. The same for a transfer with a non-zero fee, and for one that failed or was reversed, if possible.
4. How long after the transfer the receipt page answers (five samples) → `notFoundGraceMs`.
5. From the production server (not a laptop): does the receipt page answer at all (the handover notes it
   refuses foreign addresses)?

## 9. Breakdown

Per CLAUDE.md's model policy (money path and security on the main session, Opus high). Agents never
commit; the main session verifies and commits.

| Task    | What                                                                                                                                                                                                                                                                                                                          | Model / effort                                                     | Done when                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **C2a** | `packages/core/src/payoutproof.ts` (`decideDoubleProof`, types, constants); move `receiptAccountMatches` to core (payments re-exports); `assessManualPayout` gains `auto_settle` and the two denials                                                                                                                          | Opus, high                                                         | Every decision-table row and the one-field-forgery properties pass; `pnpm lint typecheck test` green; no other package changed behaviour |
| **C2c** | Receipt verifier debit mode: `verifyDebit({ institution, reference, payerAccounts, destination, amount })` returning `DebitReceiptResult` + `bodySha256` + flattened excerpt; labelled `principalAmount` in `parseTelebirrReceipt`; strict gates (reference and status required); reconstructed debit fixtures marked as such | Sonnet (`routine-coder`), medium; Opus reviews                     | Debit tests pass, credit audit tests unchanged; fixtures flagged "reconstructed, replace before `on`"                                    |
| **C2b** | Migration at the next free migration number (0055 when this was written; 0053 and 0054 are taken by the SMS rail work) (column, table, indexes, guards), drizzle schema, `autoSettleManualPayout`, `pay()` refactor, optional `failManualPayout` guard (Q3), integration tests                                                | Opus, high                                                         | All section-8 DB tests pass, existing manual-payout suites pass unchanged, `pnpm db:generate` clean, rollback reasoning re-checked       |
| **C2d** | Config switches and guards; worker job (shadow and on), kill switch in `settings`, owner-alert variants, alarms, API gauges, shadow comparison query/job                                                                                                                                                                      | Opus, high (gauges and owner-alert texts may go to Sonnet, medium) | Worker and config tests pass; deployed with `PAYOUT_AUTO_SETTLE=shadow` only                                                             |
| **C2e** | Admin: proof status on each claimed row, "Settled automatically: sent by X", Proof mismatches list with reasons and excerpt, mode/caps/today panel, Suspend/Resume (new permission), shadow report; API routes + contracts; runbook section; e2e for the admin screens with seeded evidence rows                              | Sonnet (`routine-coder`), medium; Opus reviews                     | Screens work on a phone width; e2e green; runbook merged                                                                                 |
| **C2f** | Gate: real fixtures in (section 8), parser fixed against them, ≥ 14 days of shadow meeting section 6, security review, D4/D8                                                                                                                                                                                                  | Owner + Opus, high                                                 | Written sign-off; switch to `on` with low caps                                                                                           |

Order: C2a → C2c and C2b (independent after C2a) → C2d (ship in shadow) → C2e → C2f. At most two agents
at a time.

## 10. Open questions and risks

**Questions for the owner**

1. **Who sends from where?** Do operators send from the collection handset itself (USSD or app on the same
   phone that forwards the SMS) or from another device or the telebirr business portal? If the same
   phone, the SMS proof is not independent of the claimer and the receipt is the only independent proof.
2. **Caps:** per payout, per day, per operator (suggested ETB 1,000 / 20,000 / 5,000)?
3. **Refuse "Fail"** while a debit SMS received after the claim is proposed for the payout (409
   `payout_proof_exists`)? Recommended.
4. **Recorded under:** agree that an auto-settle is recorded as `settled_by` = the claimer, actor
   `system:double_proof`?
5. **Who resumes** after an automatic suspension: admin role only?
6. **Fixtures:** can a staff test transfer be made from the real collection account, and the five items
   of section 8 captured?
7. **Counsel (D8):** retention period for receipt excerpts (they hold the player's name and masked number).

**Largest risks**

1. **The receipt page is unknown territory.** Every receipt fixture is reconstructed; no debit receipt
   has been seen. The masking width (R7's strength), the label of the transferred amount (R5), and whether
   P2P transfers even have a receipt page are unconfirmed. A parser that is wrong in the permissive
   direction settles payouts that were not paid as recorded. Mitigation: strict positive assertions, the
   shadow period, real fixtures before `on`.
2. **Proof 1 may not be independent.** If the claimer operates the collection handset, collusion plus a
   forged SMS reduces C2 to the receipt alone, whose masked receiver leaves a residual (a real transfer to
   a number matching the mask). Caps, the per-operator cap, `settled_by` accountability and player
   complaints bound it; they do not remove it.
3. **Reachability and dependence on a page we do not control.** The handover says the receipt page
   refuses foreign addresses; if the production server cannot reach it, everything waits (safe, but no
   gain). Ethio Telecom may rate-limit, change or withdraw the page; the breaker and "wait" keep this safe,
   and humans stay the fallback.

**What the code contradicts or could not settle**

- **PAYOUT_REQUIRE_PROOF is not enforced in licensed mode.** `smsRailLicensedViolations` problems are only
  `console.warn`ed by `licensedModeViolations` (CLAUDE.md says so too); the runbook's "required in licensed
  mode unless explicitly waived" is not what the code does. Same for `RECEIPT_VERIFY=audit`. C2's own guards
  are hard errors for this reason.
- **The click path is weaker than C2's rule.** `settleManualPayout` with a typed reference accepts an
  `ignored_debit` SMS of the same amount without checking its destination or that it arrived after the
  claim. Worth tightening independently of C2.
- **`applyDebit` proposes debits to unclaimed (`approved`) payouts** and ignores claim time, so a proposal
  can predate the claim; C2 handles it with P6, the click path does not.
- **`judgeReceipt` is lenient** for credits: it accepts a missing reference or status and an amount found
  anywhere on the page (including totals with fees). Debit mode must not reuse those gates.
- **No record of the source collection account** on a payout: "payer is ours" means any configured
  collection account at that institution.
- **"The worker never touches manual payouts"** (runbook, `payoutflow.ts`) stops being true under `on`.

## 11. C2a built

16 Nov 2026. The pure rule only: no migration, no database function, no worker, API or config change.
`auto_settle` is not called from anywhere yet. Finished from a partial patch an earlier session left
when it hit a usage limit (reviewed line by line against sections 2, 3, 4 and 8 before it was kept).

**What is where**

| What                                                                                                     | Where                                                                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `decideDoubleProof`, the types of section 3, `DOUBLE_PROOF_RULE_VERSION`, `AUTO_SETTLE_ACTOR`            | `packages/core/src/payoutproof.ts`                                                           |
| `WaitCode`, `MismatchCode`, `DOUBLE_PROOF_WAIT_RETRY` (which waits retry, which go to a human)           | same                                                                                         |
| `doubleProofEarliestTransfer` (`claim⁻`), `DOUBLE_PROOF_CLOCK_SKEW_MS`, `DOUBLE_PROOF_TIME_AGREEMENT_MS` | same                                                                                         |
| Masked-account matcher moved to core, plus a three-way `compareReceiptAccount`                           | `packages/core/src/receiptaccount.ts`                                                        |
| payments re-exports `receiptAccountMatches` / `receiptMatchesAnyAccount` from core                       | `packages/payments/src/receipts/accountmatch.ts`                                             |
| `auto_settle` action, denials `not_automatic` and `not_a_person`                                         | `packages/core/src/payoutflow.ts`                                                            |
| Texts for the two new denials (no behaviour change)                                                      | `packages/db/src/payments/manualpayouts.ts` (`DENIAL_MESSAGES`)                              |
| Tests                                                                                                    | `payoutproof.test.ts`, `payoutflow.test.ts`, `receiptaccount.test.ts` in `packages/core/src` |

**How the rule is tested.** One example test per decision-table row (E1–E6, S1–S3, P1–P7, R1–R7,
T1–T3, U1), each with its pass value, its boundary and every failure value including `null` and
ill-typed values (a `number` where a `bigint` amount belongs never passes). Properties (fast-check):
an arbitrary valid input always settles under the claimer; changing exactly one field never settles
(each amount by one santim or more, one digit of the destination in the payout, the player's phone,
the SMS and the receipt, one shown digit of the payer or of our collection account, either reference by
one character, every timestamp past its bound, receipt status and `completed`, SMS source, direction,
institution and status, payout status and institution, `proposedPayoutId`, payout id, the claimer null /
the approver / a `system:` actor, each flag, each cap, the institution allowlist, the window, the
receipt age and the revealed-digit minimum); nulling or deleting any single field (or a whole object)
never settles; no non-verified receipt settles; arbitrary inputs never throw; the same input gives the
same decision and is not mutated (also run on deep-frozen input). `assessManualPayout`: `auto_settle`
from each status, for each actor, with each claimer/approver combination, plus a property that it
succeeds exactly when the rule allows; the human `settle` refused for every `system:` actor. The matcher:
digits shown, too few digits shown (with and without the subscriber-only count), one mask matching two
different numbers, properties that a value revealing fewer digits than required never matches, and a
property that `receiptAccountMatches` gives the same answer as the implementation it replaced (kept
verbatim in the test as an oracle) on random masked and plain values; the payments receipt tests run
unchanged. The only fields whose absence may still settle: `sms.occurredAt = null` (T3: the SMS carries
no time), a verified receipt's `reason`, and `policy.notFoundGraceMs` (read only for a not-found receipt,
which never settles).

**Decisions** (each the stricter reading where the design left room)

1. **Every check is positive and typed.** Amounts must be `bigint`, times valid `Date`s, durations
   finite non-negative numbers, texts non-blank strings, flags exactly `false`. Anything else fails its
   check. A value one check needs that another check owns (claim time, SMS receive time, the payout's
   amount or destination) reports the owning check's reason, so a released payout or a malformed row
   reads as a wait rather than a forgery alarm. Settling also requires that every verdict is an explicit
   pass, not merely that no wait or mismatch was collected.
2. **E3 also requires `amount > 0`** (a zero or negative payout waits as `over_payout_cap`).
3. **E6 also requires the destination to be canonical E.164** (`normalizeEthiopianMsisdn(d) === d`), so
   P4's exact string comparison with the parsed SMS number (always E.164) is meaningful.
4. **S2: no recorded approver is a `four_eyes_violation` mismatch**, and so is a claimer starting
   `system:`. The design's literal `payingBy !== approvedBy` would pass with `approvedBy = null`; a claimed
   payout nobody approved is an impossible row and must alarm, not settle. Likewise `assessManualPayout`
   refuses `auto_settle` with `approvedBy = null` (`wrong_status`) or a `system:` claimer (`not_a_person`),
   and when the approver is `system:double_proof` itself (`approver_cannot_pay`).
5. **R2: the receipt age must be between 0 and `maxReceiptAgeMs`.** A `fetchedAt` later than `now` is a
   clock or caller error, not a fresh receipt: it waits (`receipt_stale`, retry). **C2b and C2d must take
   `now` and `fetchedAt` from the same clock** (the worker's), or every receipt will wait.
6. **R6 counts revealed digits in the subscriber part only** when our collection account is a mobile
   number (minimum 4, the last 3 included). With the credit audit's rule, which counts the `251` prefix,
   `251******111` would prove "the money left from us" for any number ending in 111. A too-masked or
   unreadable payer waits as `payer_unreadable` (retry), a name the design left open.
7. **R7 counts subscriber digits only, never fewer than 4** whatever `minRevealedDestinationDigits` says
   (a non-integer minimum makes every receiver too masked). "Including the last 3" is enforced.
8. **T1 and T2 use their own 5-minute constant** (`DOUBLE_PROOF_CLOCK_SKEW_MS`) rather than
   `SMS_INSTITUTION_CLOCK_SKEW_MS`: same value as the design, but widening the deposit matcher's
   tolerance can no longer silently widen what settles a payout.
9. **T3 passes only on an SMS time that is exactly `null`** (the SMS carries none). An invalid or missing
   (`undefined`) value is a `times_disagree` mismatch: such a row can only come from a mapping bug in the
   caller, and a bug should be loud (alarm and suspend), not a silent pass.
10. **R1:** a `rejected` reason becomes `receipt_<reason>` only when it is a short snake_case word
    (`/^[a-z][a-z0-9_]{0,47}$/`), else `receipt_rejected`, so verifier text never reaches a code or a
    log label. An unknown receipt status is treated as `indeterminate` (wait, retry). Facts on a
    `not_found`, `indeterminate` or `skipped` result are ignored: only `verified` or `rejected` carry facts.
11. **R4 is exact**: case and whitespace differences are `reference_differs`. A missing SMS reference is
    also `reference_differs` (the design names only the receipt's null as a wait).
12. **Empty `collectionAccounts` is a `payer_not_ours` mismatch** (alarm), not a wait. Section 6's config
    guard should make it impossible; if it happens, a loud stop is right.
13. **Retry flags** (`DOUBLE_PROOF_WAIT_RETRY`): only `receipt_indeterminate`, `receipt_not_found_yet`,
    `receipt_stale` and the unreadable receipt fields except receiver and time are retried; every
    eligibility, claim, SMS and window wait goes to a person, as the table says.

**Ambiguities and how they were resolved**

- _"Null → wait" without a code_ (R6): named `payer_unreadable`, retry true.
- _P2 with a null SMS institution, P5 with a null SMS amount, P2 with a null direction_: the table's
  "Otherwise" is a mismatch, kept literally. An SMS proposed for a payout without these is an anomaly.
- _S1 vs S2 when `payingBy` is null_: S1's `not_processing` wait, never a four-eyes alarm.
- _The masked-account matcher "moved and re-exported"_: `receiptAccountMatches` and
  `receiptMatchesAnyAccount` keep their exact behaviour (proved against the old implementation); the
  stricter options (`minRevealed`, `subscriberDigitsOnly`) exist only on the new `compareReceiptAccount`,
  which also says `unreadable` (absent, not account-shaped, too masked) apart from `differs` (a shown
  digit or the length contradicts), so a page that changed shape waits instead of alarming.
- _`claim`, `release` and `fail` by a `system:` actor_: left untouched, as section 2 says. Nothing calls
  them with one; a `system:` claimer could never be settled by either path (`not_a_person`).

**What I think is unsafe or must not be forgotten in the design**

- **The default masking rule is too weak to prove that money left us.** Section 3 says
  `receiptAccountMatches(...)` for R6. That function counts the `251` prefix as revealed digits, so if
  telebirr masks the payer as `251******111`, it matches every number ending in 111. Scenario: an operator
  and a player collude; an accomplice whose number ends in the same three digits as our collection account
  sends the player the payout amount after the claim; the operator forges the debit SMS with that
  transfer's reference. Every other check passes (receiver, amount, reference, times), the rule read
  literally says the payer is "ours", and the payout is recorded paid although our money never left. The
  books now say that money is gone while it still sits in the collection account, which covers a later
  unrecorded transfer of it to the gang (only the balance-drift checks would notice). Fixed here (decision
  6); C2c must not "simplify" the debit path back to `receiptAccountMatches`.
- **One mask matches many numbers** (tested in core). With `minRevealedDestinationDigits = 6`, a receiver
  shown as `251922***455` is satisfied by a thousand numbers. This is the residual of section 4 (Q1); it
  must be set from a real capture, and if telebirr shows fewer than 6 subscriber digits, every receiver
  waits (safe, no gain) rather than the minimum being lowered.
- **R2 and clocks** (decision 5): if C2b passes the database's `now()` with a worker-clock `fetchedAt`,
  a worker clock ahead of the database makes every receipt wait.
- **`referenceSettledElsewhere`, `amlHold`, `openReceiptAlarm` and the caps are inputs**: the rule is only
  as good as the locked re-read in C2b. Computing any of them outside the settling transaction reopens
  the TOCTOU window of section 4.
- **A rejected receipt's reason can collide with a named code** (`not_found` → `receipt_not_found`).
  Harmless to the decision (still a mismatch), but C2d's metrics must not classify mismatches by name
  alone.
