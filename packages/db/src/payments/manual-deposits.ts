import { randomUUID } from 'node:crypto';
import type { OwnerAlertTargets } from '@vamos/config';
import { birr, formatBirr } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import { postTransaction } from '../ledger/post';
import type { DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { enqueueOwnerAlert } from '../platform/owner-alerts';
import { lockUser } from '../rg/limits';
import { users } from '../schema/accounts';
import { paymentEvents, paymentIntents } from '../schema/payments';
import { DEPOSIT_SUCCEEDED } from './events';
import { depositEntries, depositLedgerKey } from './postings';
import type { PaymentIntent } from './types';

/**
 * A deposit an admin credits by hand (owner's decision O5 of 21 Nov 2026, docs/plans/
 * counter-codes-and-deposit-recovery.md, G5.2): the money reached Nahubet's account but the
 * system did not credit it (a webhook lost, an SMS that never arrived). One admin is enough, no
 * second approval; the remaining safeguards:
 *
 * - only staff with `deposits.credit` (the admin role) reach this;
 * - the provider's transaction id can be used once per provider (payment event
 *   `manual:<transaction id>`, unique per provider), so one payment is never credited twice;
 * - an existing deposit of the player (created, pending, expired or failed) is credited as itself
 *   (ledger key `deposit:<its id>`): if the provider's confirmation arrives later it finds the
 *   deposit credited and changes nothing;
 * - a reason is required, the credit is audited, the player is told (DEPOSIT_SUCCEEDED), and a
 *   credit above MANUAL_DEPOSIT_ALERT_ABOVE also alerts the owner.
 *
 * The posting is a `deposit` (counts as deposited money: not withdrawable until played through,
 * owner's decision O7). Responsible-gambling deposit limits are not applied: the money already
 * left the payer.
 */

export const MANUAL_DEPOSIT_PROVIDERS = ['chapa', 'telebirr', 'sms'] as const;
export type ManualDepositProvider = (typeof MANUAL_DEPOSIT_PROVIDERS)[number];

/** Above this, the owner is told of each manual credit (owner's safeguard for decision O5). */
export const MANUAL_DEPOSIT_ALERT_ABOVE = birr(5_000);

export const DEPOSIT_CREDITED_BY_ADMIN = 'payment.deposit_credited_by_admin';

/** The payment event that makes a provider transaction id usable once. */
const manualEventId = (transactionId: string) => `manual:${transactionId}`;

export async function creditDepositByAdmin(
  tx: DbTransaction,
  input: {
    userId: string;
    /** The player's own deposit to credit (its amount is used); omit when there is none. */
    intentId?: string | null;
    provider: ManualDepositProvider;
    /** The provider's id of the payment (telebirr's transaction number, the bank SMS reference). */
    providerTransactionId: string;
    /** Only for a new deposit (no `intentId`): what arrived, in santim. */
    amount?: bigint | null;
    reason: string;
    adminId: string;
    ownerAlerts?: OwnerAlertTargets;
    now: Date;
    ip?: string | null;
  },
): Promise<{ intent: PaymentIntent; created: boolean }> {
  const { now } = input;
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw domainUnprocessable('reason_required', 'Write down why (at least 3 characters).');
  }
  const transactionId = input.providerTransactionId.trim().replace(/\s+/g, '');
  if (transactionId.length < 4 || transactionId.length > 64) {
    throw domainUnprocessable(
      'transaction_id_invalid',
      "Enter the provider's transaction id of this payment (4 to 64 characters).",
    );
  }
  if (!(MANUAL_DEPOSIT_PROVIDERS as readonly string[]).includes(input.provider)) {
    throw domainUnprocessable('provider_invalid', 'Choose chapa, telebirr or sms.');
  }
  const [user] = await tx
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user) throw domainNotFound('User');
  // One payment, one credit: refused before anything is written (the unique event is the guard).
  const [used] = await tx
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.provider, input.provider),
        eq(paymentEvents.providerEventId, manualEventId(transactionId)),
      ),
    )
    .limit(1);
  if (used) {
    throw domainConflict(
      'already_credited',
      'A deposit was already credited by hand with this transaction id.',
    );
  }

  await lockUser(tx, user.id);
  let intent: PaymentIntent;
  let created = false;
  if (input.intentId !== undefined && input.intentId !== null) {
    const [existing] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.intentId))
      .for('update');
    if (!existing || existing.userId !== user.id) throw domainNotFound('Deposit');
    if (existing.status === 'succeeded') {
      throw domainConflict('already_credited', 'This deposit is already credited.');
    }
    if (existing.provider !== input.provider) {
      throw domainUnprocessable('provider_invalid', `This deposit is a ${existing.provider} one.`);
    }
    const posting = await postTransaction(tx, {
      type: 'deposit',
      idempotencyKey: depositLedgerKey(existing.id),
      refType: 'payment_intent',
      refId: existing.id,
      description: `Deposit via ${existing.provider} (credited by an admin)`,
      actor: { type: 'admin', id: input.adminId },
      entries: depositEntries(existing.provider, user.id, existing.amount),
    });
    const [updated] = await tx
      .update(paymentIntents)
      .set({
        status: 'succeeded',
        ledgerTransactionId: posting.transactionId,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(paymentIntents.id, existing.id))
      .returning();
    if (!updated) throw new Error('payment intent update returned no row');
    intent = updated;
  } else {
    const amount = input.amount ?? null;
    if (amount === null || amount <= 0n) {
      throw domainUnprocessable('amount_invalid', 'Enter the amount that arrived.');
    }
    const intentId = randomUUID();
    const posting = await postTransaction(tx, {
      type: 'deposit',
      idempotencyKey: depositLedgerKey(intentId),
      refType: 'payment_intent',
      refId: intentId,
      description: `Deposit via ${input.provider} (credited by an admin)`,
      actor: { type: 'admin', id: input.adminId },
      entries: depositEntries(input.provider, user.id, amount),
    });
    const [inserted] = await tx
      .insert(paymentIntents)
      .values({
        id: intentId,
        userId: user.id,
        provider: input.provider,
        amount,
        requestedAmount: amount,
        phone: user.phone,
        status: 'succeeded',
        providerRef: `manual:${transactionId}`,
        initiationKind: 'transfer',
        idempotencyKey: `manual:${input.provider}:${transactionId}`,
        ledgerTransactionId: posting.transactionId,
        expiresAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error('payment intent insert returned no row');
    intent = inserted;
    created = true;
  }

  await tx.insert(paymentEvents).values({
    provider: input.provider,
    providerEventId: manualEventId(transactionId),
    kind: 'deposit',
    providerRef: intent.providerRef ?? intent.id,
    status: 'succeeded',
    amount: intent.amount,
    currency: 'ETB',
    intentId: intent.id,
    outcome: 'credited_by_admin',
    payload: { transactionId, adminId: input.adminId, reason },
    receivedAt: now,
  });
  await enqueueOutbox(tx, {
    type: DEPOSIT_SUCCEEDED,
    aggregateType: 'payment_intent',
    aggregateId: intent.id,
    payload: {
      intentId: intent.id,
      userId: user.id,
      provider: intent.provider,
      amount: intent.amount,
      providerRef: intent.providerRef ?? intent.id,
    },
  });
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: DEPOSIT_CREDITED_BY_ADMIN,
    targetType: 'payment_intent',
    targetId: intent.id,
    metadata: {
      userId: user.id,
      provider: intent.provider,
      amount: intent.amount,
      transactionId,
      existingDeposit: !created,
      reason,
    },
    ip: input.ip ?? null,
  });
  if (input.ownerAlerts !== undefined && intent.amount > MANUAL_DEPOSIT_ALERT_ABOVE) {
    await enqueueOwnerAlert(
      tx,
      input.ownerAlerts,
      {
        alarm: 'manual_deposit_credited',
        intentId: intent.id,
        amountEtb: formatBirr(intent.amount),
        provider: intent.provider,
      },
      now,
    );
  }
  return { intent, created };
}
