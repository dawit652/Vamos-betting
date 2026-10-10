import type {
  DepositView,
  PaymentProviderName,
  WithdrawalStep,
  WithdrawalView,
} from '@vamos/contracts';
import { toWire } from '@vamos/core';
import type { PaymentIntent, Payout } from '@vamos/db';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** A deposit intent as the player sees it. */
export function depositView(intent: PaymentIntent): DepositView {
  return {
    id: intent.id,
    // Rows are only created for providers of the registry (PAYMENT_PROVIDER_NAMES).
    provider: intent.provider as PaymentProviderName,
    amount: toWire(intent.amount),
    currency: 'ETB',
    phone: intent.phone,
    status: intent.status,
    initiation:
      intent.initiationKind === null
        ? null
        : {
            kind: intent.initiationKind,
            redirectUrl: intent.redirectUrl,
            instructions: intent.instructions,
          },
    failureReason: intent.failureReason,
    underReview: intent.flaggedAt !== null,
    expiresAt: intent.expiresAt.toISOString(),
    createdAt: intent.createdAt.toISOString(),
    completedAt: iso(intent.completedAt),
  };
}

const STEP_KEYS = ['requested', 'approved', 'processing', 'paid'] as const;
const STOPPED = new Set<Payout['status']>(['failed', 'rejected', 'cancelled']);

/**
 * The status tracker (requested → approved → processing → paid). Every step
 * before the furthest one reached is done (staff may settle a payout that was
 * never sent, so `processingAt` can be null on a paid payout). The next step
 * is `current`, or `failed` when the withdrawal was rejected, cancelled or
 * failed; the rest are upcoming.
 */
export function withdrawalSteps(payout: Payout): WithdrawalStep[] {
  const reachedAt: Record<(typeof STEP_KEYS)[number], Date | null> = {
    requested: payout.requestedAt,
    approved: payout.approvedAt,
    processing: payout.processingAt,
    paid: payout.status === 'paid' ? (payout.completedAt ?? payout.updatedAt) : null,
  };
  let furthest = 0;
  STEP_KEYS.forEach((key, index) => {
    if (reachedAt[key] !== null) furthest = index;
  });
  const stopped = STOPPED.has(payout.status);
  return STEP_KEYS.map((key, index): WithdrawalStep => {
    if (index <= furthest) return { key, state: 'done', at: iso(reachedAt[key]) };
    if (index === furthest + 1) {
      return stopped
        ? { key, state: 'failed', at: iso(payout.completedAt) }
        : { key, state: 'current', at: null };
    }
    return { key, state: 'upcoming', at: null };
  });
}

/** A payout as the player sees it (flags and staff notes stay internal). */
export function withdrawalView(payout: Payout): WithdrawalView {
  return {
    id: payout.id,
    provider: payout.provider as PaymentProviderName,
    amount: toWire(payout.amount),
    currency: 'ETB',
    phone: payout.phone,
    status: payout.status,
    reviewReason: payout.status === 'requested' ? payout.reviewReason : null,
    rejectionReason: payout.status === 'rejected' ? payout.reviewReason : null,
    failureReason: payout.status === 'failed' ? payout.failureReason : null,
    cancellable: payout.status === 'requested',
    requestedAt: payout.requestedAt.toISOString(),
    approvedAt: iso(payout.approvedAt),
    processingAt: iso(payout.processingAt),
    completedAt: iso(payout.completedAt),
    steps: withdrawalSteps(payout),
  };
}
