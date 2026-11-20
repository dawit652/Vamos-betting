import type { StaffWithdrawalView } from '@vamos/contracts';

/**
 * An amount in santim as plain decimal birr for pasting into a banking app:
 * `123450` becomes `1234.50`, with a dot, two decimals and no thousands
 * separators. Bigint arithmetic only; null when `santim` is not a whole number.
 */
export function plainBirr(santim: string): string | null {
  if (!/^-?\d+$/.test(santim)) return null;
  const value = BigInt(santim);
  const abs = value < 0n ? -value : value;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${value < 0n ? '-' : ''}${abs / 100n}.${cents}`;
}

export interface PickListGroup {
  /** The wallet institution or bank name; `Other` when a payout has no destination. */
  institution: string;
  items: StaffWithdrawalView[];
}

/** When the operator took the payout (falls back to the approval time, then the request time). */
const claimedAt = (w: StaffWithdrawalView): number =>
  Date.parse(w.processingAt ?? w.approvedAt ?? w.requestedAt);

/**
 * The payouts claimed by `staffId` (still `processing`), grouped by
 * institution, oldest claim first inside a group; groups are ordered by their
 * oldest payout, so what has waited longest comes first.
 */
export function pickList(items: readonly StaffWithdrawalView[], staffId: string | undefined) {
  if (staffId === undefined) return [];
  const byInstitution = new Map<string, StaffWithdrawalView[]>();
  const mine = items
    .filter((w) => w.manual && w.status === 'processing' && w.payingBy === staffId)
    .sort((a, b) => claimedAt(a) - claimedAt(b) || a.id.localeCompare(b.id));
  for (const w of mine) {
    const institution = w.destination?.institutionName ?? 'Other';
    const group = byInstitution.get(institution);
    if (group === undefined) byInstitution.set(institution, [w]);
    else group.push(w);
  }
  // Map keeps insertion order, and `mine` is sorted, so groups are ordered by their oldest row.
  return [...byInstitution].map(([institution, rows]): PickListGroup => ({
    institution,
    items: rows,
  }));
}

const REFUSALS: Record<string, string> = {
  manual_payout_approver_cannot_pay: 'You approved it, so another operator must pay it.',
  manual_payout_wrong_status: 'Not available any more (another operator took it, or it moved on).',
  manual_payout_claimed_by_someone_else: 'Another operator is paying it.',
  aml_review_pending: 'Compliance is reviewing this player.',
  settlement_correction_pending: 'A bet correction for this player is pending.',
  not_a_manual_payout: 'Not a manual payout.',
  not_found: 'Not found.',
};

/** A batch claim's refusal code in words an operator can act on. */
export function claimRefusalText(reason: string | undefined): string {
  return (reason !== undefined && REFUSALS[reason]) || reason || 'Refused.';
}
