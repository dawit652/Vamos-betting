/**
 * Separation of duties on manual payouts (SMS rail). Ported from Melabingo's
 * `withdrawal-flow.ts` and mapped onto the Vamos payout states.
 *
 * Deciding that a withdrawal is genuine and sending the money are different
 * actions held by different permissions, and the person who sends it may not
 * be the person who approved it:
 *
 *     requested --approve(withdrawals.approve)--> approved
 *     approved  --settle(payouts.settle_manual)--> paid    (settler ≠ approver)
 *
 * The most expensive fraud here is an insider paying themselves, and it needs
 * exactly one person able to do both halves. The database repeats the rule
 * (payouts_manual_four_eyes) so a second write path cannot skip it.
 * Auto-approved payouts (approver `system:auto`) still need one human to
 * settle them.
 */

export type ManualPayoutAction = 'approve' | 'settle' | 'reject';

export type ManualPayoutDenial = 'wrong_status' | 'same_actor_approved_and_settled';

export type ManualPayoutVerdict =
  { ok: true; next: 'approved' | 'paid' | 'rejected' } | { ok: false; reason: ManualPayoutDenial };

const TRANSITIONS: Record<
  ManualPayoutAction,
  { from: readonly string[]; to: 'approved' | 'paid' | 'rejected' }
> = {
  approve: { from: ['requested'], to: 'approved' },
  settle: { from: ['approved', 'processing'], to: 'paid' },
  reject: { from: ['requested', 'approved'], to: 'rejected' },
};

/**
 * Whether `actor` may take `action` on a manual payout in `status` that
 * `approvedBy` approved (null when nobody has). Permission checks (RBAC) are
 * the caller's; this decides the state and identity rules.
 */
export function assessManualPayout(input: {
  status: string;
  action: ManualPayoutAction;
  actor: string;
  approvedBy: string | null;
}): ManualPayoutVerdict {
  const rule = TRANSITIONS[input.action];
  if (!rule.from.includes(input.status)) return { ok: false, reason: 'wrong_status' };
  if (input.action === 'settle' && input.approvedBy !== null && input.approvedBy === input.actor) {
    return { ok: false, reason: 'same_actor_approved_and_settled' };
  }
  return { ok: true, next: rule.to };
}
