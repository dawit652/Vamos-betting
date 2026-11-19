import { z } from 'zod';
import { CreateStaffResponse } from './admin';
import { CashierShopView } from './cashier';
import { IsoDateTime } from './common';
import { PositiveSantim } from './payments';

/**
 * Agent shops (docs/plans/agent-shops.md, phase 1): agents with numbers (1001 up; 1000 is Nahubet
 * HQ), their owner's name and phone, commission, status, shops and cashiers. `agents.view` reads,
 * `agents.manage` (admin) changes.
 */

export const AgentCommissionKindSchema = z.enum(['stake', 'ggr']);
export type AgentCommissionKind = z.infer<typeof AgentCommissionKindSchema>;

export const AgentView = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  ownerName: z.string(),
  /** E.164 (`+2519…`); empty for Nahubet HQ. */
  ownerPhone: z.string(),
  status: z.enum(['active', 'blocked']),
  blockedAt: IsoDateTime.nullable(),
  blockedReason: z.string().nullable(),
  commissionKind: AgentCommissionKindSchema,
  /** Basis points of the base (10% = 1000). */
  commissionBps: z.number().int(),
  playerCashEnabled: z.boolean(),
  isHouse: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentView = z.infer<typeof AgentView>;

export const AgentSummaryView = AgentView.extend({
  shops: z.number().int(),
  openShops: z.number().int(),
  cashiers: z.number().int(),
});
export type AgentSummaryView = z.infer<typeof AgentSummaryView>;

/** GET /admin/agents (agents.view): every agent by number, HQ first. */
export const AgentListResponse = z.object({ items: z.array(AgentSummaryView) });
export type AgentListResponse = z.infer<typeof AgentListResponse>;

export const AgentResponse = z.object({ agent: AgentView });
export type AgentResponse = z.infer<typeof AgentResponse>;

export const AgentCashierView = z.object({
  staffId: z.string(),
  displayName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  disabledAt: IsoDateTime.nullable(),
  lastLoginAt: IsoDateTime.nullable(),
  shopId: z.string(),
  shopLabel: z.string(),
  shopName: z.string(),
});
export type AgentCashierView = z.infer<typeof AgentCashierView>;

/**
 * A shop device (phase 1b): a counter computer or POS terminal that asked to be registered; the shop
 * app signs a cashier in only on an approved device of their own shop.
 */
export const ShopDeviceView = z.object({
  id: z.string(),
  shopId: z.string(),
  shopLabel: z.string(),
  shopName: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'approved', 'revoked']),
  requestedBy: z.string(),
  requestedByName: z.string(),
  requestedAt: IsoDateTime,
  userAgent: z.string(),
  approvedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  revokedReason: z.string().nullable(),
  lastSeenAt: IsoDateTime.nullable(),
});
export type ShopDeviceView = z.infer<typeof ShopDeviceView>;

/** The agent owner's account (role `agent_owner`, the shop app only). */
export const AgentOwnerAccountView = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  disabled: z.boolean(),
  /** The generated password is not replaced yet (it stops working 72 hours after it was made). */
  passwordChangeRequired: z.boolean(),
  lastLoginAt: IsoDateTime.nullable(),
});
export type AgentOwnerAccountView = z.infer<typeof AgentOwnerAccountView>;

/** GET /admin/agents/:id (agents.view): the agent, its owner account, shops, cashiers and devices. */
export const AgentDetailResponse = z.object({
  agent: AgentView,
  /** Null until made (never for Nahubet HQ). */
  owner: AgentOwnerAccountView.nullable(),
  shops: z.array(CashierShopView),
  cashiers: z.array(AgentCashierView),
  devices: z.array(ShopDeviceView),
});
export type AgentDetailResponse = z.infer<typeof AgentDetailResponse>;

const AgentName = z.string().trim().min(2).max(100);
const OwnerPhone = z.string().trim().min(9).max(32);
const CommissionBps = z.number().int().min(0).max(10_000);

/** POST /admin/agents (agents.manage): the next number is given (422 for a bad phone). */
export const CreateAgentRequest = z
  .object({
    name: AgentName,
    ownerName: AgentName,
    ownerPhone: OwnerPhone,
    commissionKind: AgentCommissionKindSchema,
    commissionBps: CommissionBps,
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

/** PATCH /admin/agents/:id (agents.manage): HQ only changes its name (409 `house_agent`). */
export const UpdateAgentRequest = z
  .object({
    name: AgentName.optional(),
    ownerName: AgentName.optional(),
    ownerPhone: OwnerPhone.optional(),
    commissionKind: AgentCommissionKindSchema.optional(),
    commissionBps: CommissionBps.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'change at least one field',
  });
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

/** POST /admin/agents/:id/block and /unblock (agents.manage): with a reason. */
export const AgentStatusRequest = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type AgentStatusRequest = z.infer<typeof AgentStatusRequest>;

/** POST /admin/agents/:id/shops (agents.manage): the agent's next shop number is given. */
export const CreateAgentShopRequest = z
  .object({
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(200),
    receiptWidthMm: z.union([z.literal(58), z.literal(80)]),
    approvalThreshold: PositiveSantim,
  })
  .strict();
export type CreateAgentShopRequest = z.infer<typeof CreateAgentShopRequest>;

/** POST /admin/shop-devices/:id/approve and /revoke (agents.manage); revoking needs a reason. */
export const ShopDeviceRevokeRequest = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
export type ShopDeviceRevokeRequest = z.infer<typeof ShopDeviceRevokeRequest>;

export const ShopDeviceResponse = z.object({
  device: ShopDeviceView.omit({ shopLabel: true, shopName: true, requestedByName: true }),
});
export type ShopDeviceResponse = z.infer<typeof ShopDeviceResponse>;

/**
 * POST /admin/agents/:id/owner-account (agents.manage): the owner's account for the shop app, with
 * the agent's owner name and phone. The answer shows the generated password and the authenticator
 * secret once. 409 `agent_owner_exists`, `agent_is_house`, `staff_email_taken`.
 */
export const CreateAgentOwnerRequest = z.object({ email: z.email().max(254) }).strict();
export type CreateAgentOwnerRequest = z.infer<typeof CreateAgentOwnerRequest>;

export const CreateAgentOwnerResponse = CreateStaffResponse;
export type CreateAgentOwnerResponse = z.infer<typeof CreateAgentOwnerResponse>;
