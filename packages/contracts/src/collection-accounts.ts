import { z } from 'zod';
import { IsoDateTime } from './common';

/**
 * The SMS rail's collection accounts in the back office (docs/runbooks/sms-rail.md): where players
 * send deposits. An admin adds one, a second person (finance or another admin) approves it before
 * players see it; the holder name and hint can be edited; deleting stops new deposits on it.
 */
export const COLLECTION_ACCOUNT_ROUTE_PERMISSIONS = {
  'GET /admin/collection-accounts': 'sms.review',
  'POST /admin/collection-accounts': 'settings.edit',
  'PATCH /admin/collection-accounts/:id': 'settings.edit',
  'DELETE /admin/collection-accounts/:id': 'settings.edit',
  'POST /admin/collection-accounts/:id/approve': 'withdrawals.approve',
  'POST /admin/collection-accounts/:id/reject': 'withdrawals.approve',
} as const;

export const CollectionAccountStatusSchema = z.enum(['pending', 'active', 'rejected', 'deleted']);
export type CollectionAccountStatus = z.infer<typeof CollectionAccountStatusSchema>;

export const StaffCollectionAccountView = z.object({
  id: z.uuid(),
  /** The rail's id (`<institution>:<number>`): the handset's forwarder names its account by it. */
  accountId: z.string(),
  institution: z.string(),
  institutionName: z.string(),
  account: z.string(),
  name: z.string(),
  hint: z.string().nullable(),
  status: CollectionAccountStatusSchema,
  /** Null: filled from SMS_COLLECTION_ACCOUNTS. */
  createdBy: z.uuid().nullable(),
  createdByName: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedBy: z.uuid().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime.nullable(),
  deletedAt: IsoDateTime.nullable(),
});
export type StaffCollectionAccountView = z.infer<typeof StaffCollectionAccountView>;

/** A bank or wallet the SMS rail can read (only those can hold a collection account). */
export const CollectionInstitutionView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['wallet', 'bank']),
});
export type CollectionInstitutionView = z.infer<typeof CollectionInstitutionView>;

/** GET /admin/collection-accounts (sms.review): every account, newest first. */
export const CollectionAccountListResponse = z.object({
  accounts: z.array(StaffCollectionAccountView),
  institutions: z.array(CollectionInstitutionView),
  /** The holder name every account must have (licensed, live rail); null: any name. */
  requiredName: z.string().nullable(),
  /** Whether the SMS rail runs (PAYMENT_PROVIDERS has sms): without it players see none. */
  railEnabled: z.boolean(),
});
export type CollectionAccountListResponse = z.infer<typeof CollectionAccountListResponse>;

const Name = z.string().trim().min(2).max(120);
const Hint = z.string().trim().max(120).nullable();

/**
 * POST /admin/collection-accounts (settings.edit): a new account, waiting for a second person.
 * 400 `unknown_institution`, `collection_account_number`, `collection_account_not_operator`;
 * 409 `collection_account_exists`.
 */
export const CreateCollectionAccountRequest = z
  .object({
    institution: z.string().regex(/^[a-z]{2,20}$/),
    /** Spaces and dashes are dropped: "1000 1234-5678" is stored as "100012345678". */
    account: z.string().trim().min(5).max(40),
    name: Name,
    hint: Hint.optional(),
  })
  .strict();
export type CreateCollectionAccountRequest = z.infer<typeof CreateCollectionAccountRequest>;

/**
 * PATCH /admin/collection-accounts/:id (settings.edit): the holder name and/or hint; the
 * institution and number never change (add a new account and delete this one instead).
 */
export const UpdateCollectionAccountRequest = z
  .object({ name: Name.optional(), hint: Hint.optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.hint !== undefined, {
    message: 'change the name or the hint',
  });
export type UpdateCollectionAccountRequest = z.infer<typeof UpdateCollectionAccountRequest>;

/** The answer of every change: the account as it is now, and whether anything changed. */
export const CollectionAccountResponse = z.object({
  account: StaffCollectionAccountView,
  changed: z.boolean(),
});
export type CollectionAccountResponse = z.infer<typeof CollectionAccountResponse>;
