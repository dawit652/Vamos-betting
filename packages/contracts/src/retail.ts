import { z } from 'zod';
import { CreateStaffResponse } from './admin';
import { CashierShopView } from './cashier';
import { IsoDateTime, Santim } from './common';
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
  /** The prepaid balance (santim); null for Nahubet HQ, which has none. */
  balance: Santim.nullable(),
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

/**
 * A top-up (`in`: the agent paid Nahubet) or take-back (`out`: Nahubet paid the agent back),
 * recorded by one person and approved or rejected by another (docs/plans/agent-shops.md phase 2).
 */
export const AgentTopupView = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  amount: Santim,
  method: z.enum(['cash', 'bank']),
  bankReference: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(['requested', 'approved', 'rejected']),
  requestedBy: z.string(),
  requestedByName: z.string(),
  requestedAt: IsoDateTime,
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: IsoDateTime.nullable(),
  decisionNote: z.string().nullable(),
});
export type AgentTopupView = z.infer<typeof AgentTopupView>;

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
  /** The prepaid balance (santim); null for Nahubet HQ. */
  balance: Santim.nullable(),
  /** Top-ups and take-backs, newest first (the last 50). */
  topups: z.array(AgentTopupView),
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

/**
 * POST /admin/agents/:id/topups (agents.manage): a top-up (`in`) or take-back (`out`) waiting for
 * a second person. A bank transfer needs its reference (used once). 409 `agent_balance_low`,
 * `bank_reference_used`, `agent_is_house`.
 */
export const RecordAgentTopupRequest = z
  .object({
    direction: z.enum(['in', 'out']),
    amount: PositiveSantim,
    method: z.enum(['cash', 'bank']),
    bankReference: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9/_.-]{3,64}$/)
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((value) => (value.method === 'bank') === (value.bankReference !== undefined), {
    message: 'a bank transfer needs its reference; cash has none',
    path: ['bankReference'],
  });
export type RecordAgentTopupRequest = z.infer<typeof RecordAgentTopupRequest>;

/** POST /admin/agent-topups/:id/approve | reject (withdrawals.approve; never the recorder). */
export const DecideAgentTopupRequest = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();
export type DecideAgentTopupRequest = z.infer<typeof DecideAgentTopupRequest>;

export const AgentTopupResponse = z.object({ topup: AgentTopupView, changed: z.boolean() });
export type AgentTopupResponse = z.infer<typeof AgentTopupResponse>;

/** POST /admin/agents/:id/player-cash (agents.manage): player cash at the agent's shops on or off. */
export const AgentPlayerCashRequest = z.object({ enabled: z.boolean() }).strict();
export type AgentPlayerCashRequest = z.infer<typeof AgentPlayerCashRequest>;

// ---------------------------------------------------------------------------
// Weekly statements (docs/plans/agent-shops.md, "Phase 5 design"): agents.view reads,
// agents.manage records the commission's payment (made outside the system).

export const AgentStatementView = z.object({
  id: z.string(),
  agentId: z.string(),
  agentNumber: z.number().int(),
  agentName: z.string(),
  /** The Monday the business week starts on (Addis Ababa calendar). */
  weekStart: z.string(),
  ticketsSold: z.number().int(),
  soldStakes: Santim,
  ticketsCancelled: z.number().int(),
  cancelledStakes: Santim,
  ticketsSettled: z.number().int(),
  settledStakes: Santim,
  settledPayouts: Santim,
  /** Settled stakes - settled gross payouts: negative in a losing week. */
  ggr: Santim,
  ticketsPaid: z.number().int(),
  paidAmount: Santim,
  ticketsExpired: z.number().int(),
  expiredAmount: Santim,
  playerDeposits: z.number().int(),
  playerCashIn: Santim,
  playerWithdrawals: z.number().int(),
  playerCashOut: Santim,
  balanceStart: Santim,
  balanceEnd: Santim,
  commissionKind: AgentCommissionKindSchema,
  commissionBps: z.number().int(),
  commission: Santim,
  createdAt: IsoDateTime,
  paidAt: IsoDateTime.nullable(),
  paidReference: z.string().nullable(),
});
export type AgentStatementView = z.infer<typeof AgentStatementView>;

/**
 * GET /admin/agent-statements?week=YYYY-MM-DD (one week, every agent; default: the last week
 * due), GET /admin/agents/:id/statements and GET /shop/owner/statements (one agent's last weeks).
 */
export const AgentStatementListResponse = z.object({
  weekStart: z.string().nullable(),
  items: z.array(AgentStatementView),
});
export type AgentStatementListResponse = z.infer<typeof AgentStatementListResponse>;

export const AgentStatementWeekQuery = z
  .object({
    week: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .optional(),
  })
  .strict();
export type AgentStatementWeekQuery = z.infer<typeof AgentStatementWeekQuery>;

/** POST /admin/agent-statements/:id/paid: the commission was paid; its reference (once). */
export const AgentStatementPaidRequest = z
  .object({ reference: z.string().trim().min(3).max(100) })
  .strict();
export type AgentStatementPaidRequest = z.infer<typeof AgentStatementPaidRequest>;

export const AgentStatementResponse = z.object({ statement: AgentStatementView });
export type AgentStatementResponse = z.infer<typeof AgentStatementResponse>;

// ---------------------------------------------------------------------------
// The live monitor of the agent shops (docs/plans/agent-shops.md, "Phase 5 design", step 3).

export const MonitorTicketView = z.object({
  id: z.string(),
  /** The ticket's number (printed and in the barcode). */
  number: z.string(),
  agentId: z.string(),
  agentNumber: z.number().int(),
  agentName: z.string(),
  shopId: z.string(),
  shopLabel: z.string(),
  shopName: z.string(),
  staffId: z.string(),
  staffName: z.string(),
  stake: Santim,
  /** The possible net payout (after tax), as printed. */
  possibleWin: Santim,
  status: z.enum(['sold', 'cancelled', 'paid', 'expired']),
  betStatus: z.string(),
  soldAt: IsoDateTime,
  paidAmount: Santim.nullable(),
});
export type MonitorTicketView = z.infer<typeof MonitorTicketView>;

/** One agent's business day at the counters, with its balance now. */
export const MonitorAgentView = z.object({
  agentId: z.string(),
  agentNumber: z.number().int(),
  agentName: z.string(),
  isHouse: z.boolean(),
  status: z.enum(['active', 'blocked']),
  /** Null for Nahubet HQ (no balance: its cash is Nahubet's). */
  balance: Santim.nullable(),
  ticketsSold: z.number().int(),
  soldStakes: Santim,
  ticketsCancelled: z.number().int(),
  cancelledStakes: Santim,
  ticketsPaid: z.number().int(),
  paidAmount: Santim,
});
export type MonitorAgentView = z.infer<typeof MonitorAgentView>;

/** GET /admin/retail/monitor (agents.view): the newest tickets and every agent's business day. */
export const RetailMonitorQuery = z
  .object({
    agentId: z.uuid().optional(),
    shopId: z.uuid().optional(),
    staffId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type RetailMonitorQuery = z.infer<typeof RetailMonitorQuery>;

export const RetailMonitorResponse = z.object({
  /** The Addis Ababa calendar day the agents' figures cover. */
  day: z.string(),
  tickets: z.array(MonitorTicketView),
  agents: z.array(MonitorAgentView),
});
export type RetailMonitorResponse = z.infer<typeof RetailMonitorResponse>;
