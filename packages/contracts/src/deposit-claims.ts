import { z } from 'zod';
import { IsoDateTime, Santim } from './common';

/**
 * Deposits that did not arrive (docs/plans/counter-codes-and-deposit-recovery.md, G5.3 and G6).
 */

export const DepositClaimMethodSchema = z.enum(['telebirr', 'cbe', 'chapa', 'other']);
export type DepositClaimMethod = z.infer<typeof DepositClaimMethodSchema>;
export const DepositClaimStatusSchema = z.enum(['open', 'credited', 'closed']);

/**
 * POST /payments/deposit-claims (logged in): "My deposit did not arrive". 422
 * `claim_method_invalid`, `claim_amount_invalid`, `claim_time_invalid`, `claim_too_old` (older than
 * 30 days), `claim_reference_invalid`, `claim_phone_invalid`; 409 `claim_exists` (an open claim
 * with this reference), `too_many_open_claims` (3 open).
 */
export const CreateDepositClaimRequest = z
  .object({
    method: DepositClaimMethodSchema,
    /** Santim as a decimal string, above zero. */
    amount: Santim.refine((value) => /^[1-9]\d*$/.test(value), {
      message: 'amount must be above zero',
    }),
    paidAt: IsoDateTime,
    /** The provider's transaction id or the bank SMS reference. */
    reference: z.string().trim().max(80).optional(),
    /** The phone that paid, when not the player's own. */
    payerPhone: z.string().trim().max(20).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type CreateDepositClaimRequest = z.infer<typeof CreateDepositClaimRequest>;

/** A claim as its player sees it: what they said and whether it was answered. */
export const DepositClaimView = z.object({
  id: z.uuid(),
  method: DepositClaimMethodSchema,
  amount: Santim,
  paidAt: IsoDateTime,
  reference: z.string().nullable(),
  status: DepositClaimStatusSchema,
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type DepositClaimView = z.infer<typeof DepositClaimView>;

export const DepositClaimResponse = z.object({ claim: DepositClaimView });
export type DepositClaimResponse = z.infer<typeof DepositClaimResponse>;

/** GET /payments/deposit-claims: the player's claims, newest first. */
export const DepositClaimListResponse = z.object({ claims: z.array(DepositClaimView) });
export type DepositClaimListResponse = z.infer<typeof DepositClaimListResponse>;

export const MoneySuggestionReasonSchema = z.enum([
  'flagged_deposit',
  'own_deposit',
  'payer_phone',
  'near_deposit',
  'claim_reference',
  'claim_amount',
]);
export type MoneySuggestionReason = z.infer<typeof MoneySuggestionReasonSchema>;

export const MoneySuggestionView = z.object({
  userId: z.uuid(),
  phone: z.string(),
  name: z.string().nullable(),
  /** Strongest first. */
  reasons: z.array(MoneySuggestionReasonSchema),
  /** The player's open claim that pairs with this money. */
  claimId: z.uuid().nullable(),
});
export type MoneySuggestionView = z.infer<typeof MoneySuggestionView>;

export const MoneyNotCreditedItemView = z.object({
  /** `sms`: an incoming SMS (credit it with POST /admin/sms/:id/credit); `provider`: a provider
   * deposit flagged instead of credited (POST /admin/users/:id/manual-deposits with intentId). */
  kind: z.enum(['sms', 'provider']),
  id: z.uuid(),
  amount: Santim,
  at: IsoDateTime,
  source: z.string(),
  reference: z.string().nullable(),
  payerPhone: z.string().nullable(),
  payerName: z.string().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  suggestions: z.array(MoneySuggestionView),
});
export type MoneyNotCreditedItemView = z.infer<typeof MoneyNotCreditedItemView>;

export const MoneyNotCreditedClaimView = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  phone: z.string(),
  name: z.string().nullable(),
  method: DepositClaimMethodSchema,
  amount: Santim,
  paidAt: IsoDateTime,
  reference: z.string().nullable(),
  payerPhone: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
  pairs: z.array(
    z.object({
      kind: z.enum(['sms', 'provider']),
      id: z.uuid(),
      reason: MoneySuggestionReasonSchema,
    }),
  ),
});
export type MoneyNotCreditedClaimView = z.infer<typeof MoneyNotCreditedClaimView>;

/**
 * GET /admin/money-not-credited (sms.review): money that arrived but was not credited, and the
 * players' open claims, oldest first. Never credited automatically: an admin credits with the SMS
 * credit or the manual deposit (both take an optional `claimId`), or closes a claim.
 */
export const MoneyNotCreditedResponse = z.object({
  items: z.array(MoneyNotCreditedItemView),
  claims: z.array(MoneyNotCreditedClaimView),
  waiting: z.object({
    count: z.number().int(),
    amount: Santim,
    oldestAt: IsoDateTime.nullable(),
  }),
});
export type MoneyNotCreditedResponse = z.infer<typeof MoneyNotCreditedResponse>;

/** POST /admin/deposit-claims/:id/close (sms.review): answered without a credit, with a note. */
export const CloseDepositClaimRequest = z
  .object({ note: z.string().trim().min(3).max(300) })
  .strict();
export type CloseDepositClaimRequest = z.infer<typeof CloseDepositClaimRequest>;
