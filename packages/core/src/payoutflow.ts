/**
 * Separation of duties on manual payouts (SMS rail). Ported from Melabingo's
 * `withdrawal-flow.ts`, mapped onto the Vamos payout states, plus a claim
 * step so two operators never both send the same payout.
 *
 * Deciding that a withdrawal is genuine and sending the money are different
 * actions held by different permissions, and the person who sends it may not
 * be the person who approved it:
 *
 *     requested  --approve (withdrawals.approve)-->  approved
 *     approved   --claim   (payouts.settle_manual)-> processing   claimer ≠ approver
 *     processing --settle  (the claimer)---------->  paid         settler = claimer
 *     processing --release (the claimer)---------->  approved     (nothing was sent)
 *     processing --fail    (the claimer)---------->  failed       (the transfer bounced)
 *
 * The most expensive fraud here is an insider paying themselves, and it needs
 * exactly one person able to do both halves. The database repeats the rule
 * (payouts_manual_four_eyes) so a second write path cannot skip it.
 * Auto-approved payouts (approver `system:auto`) still need one human to
 * claim them and send the money.
 *
 * One automatic step (design: docs/plans/c2-double-proof-design.md):
 *
 *     processing --auto_settle (system:double_proof)--> paid   recorded under the claimer
 *
 * The double-proof worker may record a claimed payout as paid once the debit
 * SMS and the institution's receipt agree (core decideDoubleProof). Only
 * that actor may take `auto_settle`, never from another state, never when
 * the claimer is the approver or not a person; and no `system:` actor may
 * use the human `settle` (whose proof rules are weaker). The worker never
 * claims, releases or fails a manual payout.
 */

import { AUTO_SETTLE_ACTOR } from './payoutproof';

export type ManualPayoutAction =
  'approve' | 'claim' | 'settle' | 'auto_settle' | 'release' | 'fail' | 'reject';

export type ManualPayoutStatus =
  'requested' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected';

export type ManualPayoutDenial =
  | 'wrong_status'
  | 'approver_cannot_pay'
  | 'claimed_by_someone_else'
  /** `auto_settle` by anyone but the double-proof system actor. */
  | 'not_automatic'
  /** The human `settle` by a `system:` actor, or an `auto_settle` whose claimer is not a person. */
  | 'not_a_person';

export type ManualPayoutVerdict =
  { ok: true; next: ManualPayoutStatus } | { ok: false; reason: ManualPayoutDenial };

const TRANSITIONS: Record<ManualPayoutAction, { from: readonly string[]; to: ManualPayoutStatus }> =
  {
    approve: { from: ['requested'], to: 'approved' },
    claim: { from: ['approved'], to: 'processing' },
    settle: { from: ['processing'], to: 'paid' },
    auto_settle: { from: ['processing'], to: 'paid' },
    release: { from: ['processing'], to: 'approved' },
    fail: { from: ['processing'], to: 'failed' },
    reject: { from: ['requested', 'approved'], to: 'rejected' },
  };

const SYSTEM_ACTOR_PREFIX = 'system:';

/**
 * Whether `actor` may take `action` on a manual payout. `approvedBy` is who
 * approved it (null until then), `payingBy` who claimed it (null unless
 * processing). Permission checks (RBAC) are the caller's; this decides the
 * state and identity rules.
 */
export function assessManualPayout(input: {
  status: string;
  action: ManualPayoutAction;
  actor: string;
  approvedBy: string | null;
  payingBy: string | null;
}): ManualPayoutVerdict {
  const rule = TRANSITIONS[input.action];
  if (!rule.from.includes(input.status)) return { ok: false, reason: 'wrong_status' };
  if (input.action === 'auto_settle') return assessAutoSettle(input, rule.to);
  if (input.action === 'settle' && input.actor.startsWith(SYSTEM_ACTOR_PREFIX)) {
    return { ok: false, reason: 'not_a_person' };
  }
  const paysMoney = input.action === 'claim' || input.action === 'settle';
  if (paysMoney && input.approvedBy !== null && input.approvedBy === input.actor) {
    return { ok: false, reason: 'approver_cannot_pay' };
  }
  const claimerOnly =
    input.action === 'settle' || input.action === 'release' || input.action === 'fail';
  if (claimerOnly && input.payingBy !== input.actor) {
    return { ok: false, reason: 'claimed_by_someone_else' };
  }
  return { ok: true, next: rule.to };
}

/**
 * `auto_settle` (status already checked): only the double-proof actor, only
 * for a payout someone approved and a person claimed, and never one its
 * approver claimed. The settlement is recorded under the claimer, so the
 * claimer must be a person. A claimed payout with no recorded approver or no
 * claimer is an impossible row: refused as `wrong_status`, never settled.
 */
function assessAutoSettle(
  input: { actor: string; approvedBy: string | null; payingBy: string | null },
  next: ManualPayoutStatus,
): ManualPayoutVerdict {
  if (input.actor !== AUTO_SETTLE_ACTOR) return { ok: false, reason: 'not_automatic' };
  if (input.approvedBy !== null && input.approvedBy === input.actor) {
    return { ok: false, reason: 'approver_cannot_pay' };
  }
  if (input.approvedBy === null || input.payingBy === null) {
    return { ok: false, reason: 'wrong_status' };
  }
  if (input.payingBy === input.approvedBy) return { ok: false, reason: 'approver_cannot_pay' };
  if (input.payingBy.startsWith(SYSTEM_ACTOR_PREFIX)) return { ok: false, reason: 'not_a_person' };
  return { ok: true, next };
}
