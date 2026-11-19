import type {
  DepositView,
  PaymentProviderName,
  WithdrawalStep,
  WithdrawalView,
} from '@vamos/contracts';
import type { CollectionAccount } from '@vamos/config';
import { payoutDestination, toWire } from '@vamos/core';
import type { PaymentIntent, Payout } from '@vamos/db';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * The collection accounts of the SMS rail provider, when it runs (for the deposit's account): the
 * known ones, so a deposit given an account that was deleted since still shows where it was sent.
 */
export interface CollectionAccountLookup {
  knownCollectionAccounts: readonly CollectionAccount[];
}

/** A deposit intent as the player sees it; `sms` names the account of an SMS deposit. */
export function depositView(
  intent: PaymentIntent,
  sms?: CollectionAccountLookup | null,
): DepositView {
  const account =
    intent.collectionAccount === null
      ? undefined
      : sms?.knownCollectionAccounts.find((a) => a.id === intent.collectionAccount);
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
    transfer:
      intent.initiationKind === 'transfer'
        ? {
            requestedAmount: toWire(intent.requestedAmount ?? intent.amount),
            sendAmount: toWire(intent.amount),
            account:
              account === undefined
                ? null
                : {
                    institution: account.institution,
                    account: account.account,
                    name: account.name,
                    hint: account.hint ?? null,
                  },
          }
        : null,
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

/**
 * The review reasons a player may see. Anything else (an AML review in
 * particular: telling the player would be tipping-off) reads as the generic
 * `manual_review`; staff views keep the real reason.
 */
const PLAYER_REVIEW_REASONS: ReadonlySet<string> = new Set([
  'above_auto_approve_threshold',
  'active_exclusion',
]);

/** The review reason as the player sees it. */
export function playerReviewReason(reason: string | null): string | null {
  if (reason === null) return null;
  return PLAYER_REVIEW_REASONS.has(reason) ? reason : 'manual_review';
}

/** A payout as the player sees it (flags, AML reviews and staff notes stay internal). */
export function withdrawalView(payout: Payout): WithdrawalView {
  return {
    id: payout.id,
    provider: payout.provider as PaymentProviderName,
    amount: toWire(payout.amount),
    currency: 'ETB',
    phone: payout.phone,
    manual: payout.manual,
    destination:
      payout.destinationInstitution === null || payout.destinationAccount === null
        ? null
        : {
            institution: payout.destinationInstitution,
            institutionName:
              payoutDestination(payout.destinationInstitution)?.name ??
              payout.destinationInstitution,
            account: payout.destinationAccount,
          },
    settlementReference: payout.status === 'paid' ? payout.settlementReference : null,
    status: payout.status,
    reviewReason: payout.status === 'requested' ? playerReviewReason(payout.reviewReason) : null,
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
