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
 * claim and settle them.
 */

export type ManualPayoutAction = 'approve' | 'claim' | 'settle' | 'release' | 'fail' | 'reject';

export type ManualPayoutStatus =
  'requested' | 'approved' | 'processing' | 'paid' | 'failed' | 'rejected';

export type ManualPayoutDenial = 'wrong_status' | 'approver_cannot_pay' | 'claimed_by_someone_else';

export type ManualPayoutVerdict =
  { ok: true; next: ManualPayoutStatus } | { ok: false; reason: ManualPayoutDenial };

const TRANSITIONS: Record<ManualPayoutAction, { from: readonly string[]; to: ManualPayoutStatus }> =
  {
    approve: { from: ['requested'], to: 'approved' },
    claim: { from: ['approved'], to: 'processing' },
    settle: { from: ['processing'], to: 'paid' },
    release: { from: ['processing'], to: 'approved' },
    fail: { from: ['processing'], to: 'failed' },
    reject: { from: ['requested', 'approved'], to: 'rejected' },
  };

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
