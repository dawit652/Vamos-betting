import {
  RetailAlertListResponse,
  RetailAlertQuery,
  RetailAlertResponse,
  RetailMonitorQuery,
  RetailMonitorResponse,
  AgentDetailResponse,
  AgentStatementListResponse,
  AgentStatementPaidRequest,
  AgentStatementResponse,
  AgentStatementWeekQuery,
  AgentPlayerCashRequest,
  AgentListResponse,
  AgentResponse,
  AgentStatusRequest,
  AgentTopupResponse,
  DecideAgentTopupRequest,
  RecordAgentTopupRequest,
  RetailAlertThresholds,
  ShopTicketCancelRequest,
  ShopTicketResponse,
  TicketLimitsRequest,
  TicketLimitsResponse,
  CashierShopResponse,
  CreateAgentOwnerRequest,
  CreateAgentOwnerResponse,
  CreateAgentRequest,
  CreateAgentShopRequest,
  ShopDeviceResponse,
  ShopDeviceRevokeRequest,
  UpdateAgentRequest,
} from '@vamos/contracts';
import { parseRetailTicketLimits, serializeRetailTicketLimits } from '@vamos/core';
import {
  loadRetailAlertRules,
  setRetailAlertThresholds,
  agentTicketLimits,
  cancelRetailTicket,
  getRetailTicket,
  loadGameSettings,
  setAgentTicketLimits,
  approveShopDevice,
  createAgent,
  createAgentOwnerAccount,
  createShop,
  decideAgentTopup,
  getAgent,
  acknowledgeRetailAlert,
  listRetailAlerts,
  listAgentBalances,
  listMonitorAgentDays,
  listMonitorTickets,
  getAgentStatement,
  lastStatementWeek,
  listAgentStatements,
  markAgentStatementPaid,
  getAgentBalance,
  getAgentOwnerAccount,
  listAgentTopups,
  recordAgentTopup,
  type AgentTopupRow,
  getShop,
  listAgentCashiers,
  listAgentDevices,
  listAgents,
  listShops,
  revokeShopDevice,
  setAgentBlocked,
  setAgentPlayerCash,
  updateAgent,
} from '@vamos/db';
import { businessDateOf, businessDayWindow, isBusinessWeekStart } from '@vamos/core';
import type { FastifyInstance } from 'fastify';
import { badRequest, notFound, parseInput } from '../../lib/errors';
import { staffActor, staffAuthDeps } from '../../plugins/staff-session';
import { ticketView } from '../shop/ticket-views';
import { shopView } from './cashier';
import { inTx, parseUuid, wire } from './common';

/**
 * Agents (docs/plans/agent-shops.md, phase 1): the admin adds agents (the next number is given),
 * their shops (each agent's next shop number), changes them, and blocks or unblocks an agent at
 * any time. `agents.view` reads (admin, finance, compliance); `agents.manage` changes (admin).
 * The rules live in @vamos/db (retail/agents.ts, createShop); these routes shape the answers.
 */
/** A top-up as the back office shows it. */
function topupView(row: AgentTopupRow) {
  return {
    id: row.id,
    direction: row.direction,
    amount: row.amount,
    method: row.method,
    bankReference: row.bankReference,
    note: row.note,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName,
    requestedAt: row.requestedAt,
    decidedBy: row.decidedBy,
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
  };
}

export default async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  type IdParams = { Params: { id: string } };

  app.get('/admin/agents', { config: { staff: 'agents.view' } }, async () => {
    const [items, balances] = await Promise.all([listAgents(deps.db), listAgentBalances(deps.db)]);
    return wire(AgentListResponse, {
      items: items.map((agent) => ({
        ...agent,
        balance: agent.isHouse ? null : (balances.get(agent.id) ?? 0n),
      })),
    });
  });

  app.post('/admin/agents', { config: { staff: 'agents.manage' } }, async (request, reply) => {
    const input = parseInput(CreateAgentRequest, request.body);
    const actor = staffActor(request);
    const agent = await inTx(deps, (tx) =>
      createAgent(tx, {
        ...input,
        adminId: actor.adminId,
        now: deps.clock(),
        ip: actor.ip ?? null,
      }),
    );
    reply.code(201);
    return wire(AgentResponse, { agent });
  });

  app.get<IdParams>('/admin/agents/:id', { config: { staff: 'agents.view' } }, async (request) => {
    const agentId = parseUuid(request.params.id, 'Agent');
    const agent = await getAgent(deps.db, agentId);
    if (agent === null) throw notFound('Agent');
    const shops = (await listShops(deps.db)).filter((shop) => shop.agentId === agentId);
    const cashiers = await listAgentCashiers(deps.db, agentId);
    const devices = await listAgentDevices(deps.db, agentId);
    const owner = await getAgentOwnerAccount(deps.db, agentId);
    const topups = await listAgentTopups(deps.db, { agentId, limit: 50 });
    return wire(AgentDetailResponse, {
      agent,
      owner,
      balance: agent.isHouse ? null : await getAgentBalance(deps.db, agentId),
      topups: topups.map(topupView),
      shops: shops.map(shopView),
      cashiers,
      devices,
    });
  });

  app.post<IdParams>(
    '/admin/agents/:id/player-cash',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(AgentPlayerCashRequest, request.body);
      const actor = staffActor(request);
      const agent = await inTx(deps, (tx) =>
        setAgentPlayerCash(tx, {
          agentId,
          enabled: input.enabled,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(AgentResponse, { agent });
    },
  );

  // The agent balance (phase 2): one admin records a top-up or take-back, another person
  // approves or rejects it (four eyes, also checked in the database); the approval posts it.
  app.post<IdParams>(
    '/admin/agents/:id/topups',
    { config: { staff: 'agents.manage' } },
    async (request, reply) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(RecordAgentTopupRequest, request.body);
      const actor = staffActor(request);
      const topup = await inTx(deps, async (tx) => {
        const made = await recordAgentTopup(tx, {
          agentId,
          direction: input.direction,
          amount: BigInt(input.amount),
          method: input.method,
          bankReference: input.bankReference ?? null,
          note: input.note ?? null,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        const [row] = (await listAgentTopups(tx, { agentId, limit: 50 })).filter(
          (item) => item.id === made.id,
        );
        if (row === undefined) throw notFound('Top-up');
        return row;
      });
      reply.code(201);
      return wire(AgentTopupResponse, { topup: topupView(topup), changed: true });
    },
  );

  for (const [path, decision] of [
    ['approve', 'approve'],
    ['reject', 'reject'],
  ] as const) {
    app.post<IdParams>(
      `/admin/agent-topups/:id/${path}`,
      { config: { staff: 'withdrawals.approve' } },
      async (request) => {
        const topupId = parseUuid(request.params.id, 'Top-up');
        const input = parseInput(DecideAgentTopupRequest, request.body ?? {});
        const actor = staffActor(request);
        const result = await inTx(deps, async (tx) => {
          const decided = await decideAgentTopup(tx, {
            topupId,
            decision,
            note: input.note ?? null,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          });
          const [row] = (
            await listAgentTopups(tx, { agentId: decided.topup.agentId, limit: 200 })
          ).filter((item) => item.id === topupId);
          if (row === undefined) throw notFound('Top-up');
          return { topup: row, changed: decided.changed };
        });
        return wire(AgentTopupResponse, {
          topup: topupView(result.topup),
          changed: result.changed,
        });
      },
    );
  }

  // The agent owner's account for the shop app (phase 1b step 1): the generated password and the
  // authenticator secret are in this answer only.
  app.post<IdParams>(
    '/admin/agents/:id/owner-account',
    { config: { staff: 'agents.manage' } },
    async (request, reply) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(CreateAgentOwnerRequest, request.body);
      const actor = staffActor(request);
      const made = await createAgentOwnerAccount(staffAuthDeps(deps), {
        agentId,
        email: input.email,
        adminId: actor.adminId,
        ip: actor.ip ?? null,
      });
      reply.code(201);
      return wire(CreateAgentOwnerResponse, made);
    },
  );

  app.patch<IdParams>(
    '/admin/agents/:id',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(UpdateAgentRequest, request.body);
      const actor = staffActor(request);
      const agent = await inTx(deps, (tx) =>
        updateAgent(tx, {
          agentId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.ownerName === undefined ? {} : { ownerName: input.ownerName }),
          ...(input.ownerPhone === undefined ? {} : { ownerPhone: input.ownerPhone }),
          ...(input.commissionKind === undefined ? {} : { commissionKind: input.commissionKind }),
          ...(input.commissionBps === undefined ? {} : { commissionBps: input.commissionBps }),
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(AgentResponse, { agent });
    },
  );

  for (const [path, blocked] of [
    ['block', true],
    ['unblock', false],
  ] as const) {
    app.post<IdParams>(
      `/admin/agents/:id/${path}`,
      { config: { staff: 'agents.manage' } },
      async (request) => {
        const agentId = parseUuid(request.params.id, 'Agent');
        const input = parseInput(AgentStatusRequest, request.body);
        const actor = staffActor(request);
        const agent = await inTx(deps, (tx) =>
          setAgentBlocked(tx, {
            agentId,
            blocked,
            reason: input.reason,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          }),
        );
        return wire(AgentResponse, { agent });
      },
    );
  }

  app.post<IdParams>(
    '/admin/agents/:id/shops',
    { config: { staff: 'agents.manage' } },
    async (request, reply) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(CreateAgentShopRequest, request.body);
      const actor = staffActor(request);
      const shop = await inTx(deps, async (tx) => {
        const created = await createShop(tx, {
          agentId,
          name: input.name,
          address: input.address,
          receiptWidthMm: input.receiptWidthMm,
          approvalThreshold: BigInt(input.approvalThreshold),
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        const withAgent = await getShop(tx, created.id);
        if (withAgent === null) throw notFound('Shop');
        return withAgent;
      });
      reply.code(201);
      return wire(CashierShopResponse, { shop: shopView(shop) });
    },
  );

  // Shop devices (phase 1b): an admin approves a waiting device or revokes one, with a reason.
  app.post<IdParams>(
    '/admin/shop-devices/:id/approve',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const deviceId = parseUuid(request.params.id, 'Device');
      const actor = staffActor(request);
      const device = await inTx(deps, (tx) =>
        approveShopDevice(tx, {
          deviceId,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(ShopDeviceResponse, { device });
    },
  );

  app.post<IdParams>(
    '/admin/shop-devices/:id/revoke',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const deviceId = parseUuid(request.params.id, 'Device');
      const input = parseInput(ShopDeviceRevokeRequest, request.body);
      const actor = staffActor(request);
      const device = await inTx(deps, (tx) =>
        revokeShopDevice(tx, {
          deviceId,
          adminId: actor.adminId,
          reason: input.reason,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(ShopDeviceResponse, { device });
    },
  );

  // Shop tickets (phase 3): an admin's ticket limits per agent, and cancelling a ticket before its
  // first kick-off (after the cashier's window, as the agent's owner may).
  const limitsView = async (agentId: string) => {
    const agent = await getAgent(deps.db, agentId);
    if (agent === null) throw notFound('Agent');
    const settings = await loadGameSettings(deps.db);
    return wire(TicketLimitsResponse, {
      overrides: serializeRetailTicketLimits(parseRetailTicketLimits(agent.ticketLimits)),
      effective: agentTicketLimits(agent, settings.betRules),
    });
  };

  app.get<IdParams>(
    '/admin/agents/:id/ticket-limits',
    { config: { staff: 'agents.view' } },
    async (request) => limitsView(parseUuid(request.params.id, 'Agent')),
  );

  app.put<IdParams>(
    '/admin/agents/:id/ticket-limits',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const input = parseInput(TicketLimitsRequest, request.body);
      const actor = staffActor(request);
      try {
        await inTx(deps, (tx) =>
          setAgentTicketLimits(tx, {
            agentId,
            limits: input,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          }),
        );
      } catch (error) {
        if (error instanceof RangeError) throw badRequest('ticket_limits_invalid', error.message);
        throw error;
      }
      return limitsView(agentId);
    },
  );

  app.post<IdParams>(
    '/admin/retail-tickets/:id/cancel',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const ticketId = parseUuid(request.params.id, 'Ticket');
      const input = parseInput(ShopTicketCancelRequest, request.body ?? {});
      const actor = staffActor(request);
      await inTx(deps, (tx) =>
        cancelRetailTicket(tx, {
          ticketId,
          actor: { staffId: actor.adminId, role: 'admin' },
          reason: input.reason ?? null,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      const row = await getRetailTicket(deps.db, ticketId);
      if (row === null) throw notFound('Ticket');
      const settings = await loadGameSettings(deps.db);
      return wire(ShopTicketResponse, {
        ticket: await ticketView(deps.db, row, { cashOut: settings.cashOut, now: deps.clock() }),
        replayed: false,
      });
    },
  );

  // Weekly statements (phase 5): one week of every agent, one agent's last weeks, and the record
  // of a commission paid outside the system (agents.manage, once, audited).
  app.get('/admin/agent-statements', { config: { staff: 'agents.view' } }, async (request) => {
    const query = parseInput(AgentStatementWeekQuery, request.query);
    const weekStart = query.week ?? lastStatementWeek(deps.clock());
    if (!isBusinessWeekStart(weekStart)) {
      throw badRequest('invalid_week', 'A week starts on a Monday (YYYY-MM-DD).');
    }
    const items = await listAgentStatements(deps.db, { weekStart, limit: 1_000 });
    return wire(AgentStatementListResponse, { weekStart, items });
  });

  app.get<IdParams>(
    '/admin/agents/:id/statements',
    { config: { staff: 'agents.view' } },
    async (request) => {
      const agentId = parseUuid(request.params.id, 'Agent');
      const items = await listAgentStatements(deps.db, { agentId, limit: 12 });
      return wire(AgentStatementListResponse, { weekStart: null, items });
    },
  );

  app.post<IdParams>(
    '/admin/agent-statements/:id/paid',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const statementId = parseUuid(request.params.id, 'Statement');
      const input = parseInput(AgentStatementPaidRequest, request.body);
      const actor = staffActor(request);
      const statement = await inTx(deps, async (tx) => {
        await markAgentStatementPaid(tx, {
          statementId,
          reference: input.reference,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        const named = await getAgentStatement(tx, statementId);
        if (named === null) throw notFound('Statement');
        return named;
      });
      return wire(AgentStatementResponse, { statement });
    },
  );

  // The live monitor (phase 5 step 3): the newest tickets of every shop, and every agent's
  // business day (Addis Ababa calendar) with its balance now. The page polls it.
  app.get('/admin/retail/monitor', { config: { staff: 'agents.view' } }, async (request) => {
    const query = parseInput(RetailMonitorQuery, request.query);
    const day = businessDateOf(deps.clock());
    const [tickets, days, all, balances] = await Promise.all([
      listMonitorTickets(deps.db, {
        ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
        ...(query.shopId === undefined ? {} : { shopId: query.shopId }),
        ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
        limit: query.limit,
      }),
      listMonitorAgentDays(deps.db, businessDayWindow(day)),
      listAgents(deps.db),
      listAgentBalances(deps.db),
    ]);
    const byAgent = new Map(days.map((d) => [d.agentId, d]));
    const agentsView = all.map((agent) => {
      const counters = byAgent.get(agent.id);
      return {
        agentId: agent.id,
        agentNumber: agent.number,
        agentName: agent.name,
        isHouse: agent.isHouse,
        status: agent.status,
        balance: agent.isHouse ? null : (balances.get(agent.id) ?? 0n),
        ticketsSold: counters?.ticketsSold ?? 0,
        soldStakes: counters?.soldStakes ?? 0n,
        ticketsCancelled: counters?.ticketsCancelled ?? 0,
        cancelledStakes: counters?.cancelledStakes ?? 0n,
        ticketsPaid: counters?.ticketsPaid ?? 0,
        paidAmount: counters?.paidAmount ?? 0n,
      };
    });
    return wire(RetailMonitorResponse, { day, tickets, agents: agentsView });
  });

  // Alerts (phase 5 step 4): raised by the worker; whoever watches the shops acknowledges them.
  app.get('/admin/retail/alerts', { config: { staff: 'agents.view' } }, async (request) => {
    const query = parseInput(RetailAlertQuery, request.query);
    const items = await listRetailAlerts(deps.db, { open: query.open === 'true', limit: 500 });
    return wire(RetailAlertListResponse, { items });
  });

  app.post<IdParams>(
    '/admin/retail/alerts/:id/acknowledge',
    { config: { staff: 'agents.view' } },
    async (request) => {
      const alertId = parseUuid(request.params.id, 'Alert');
      const actor = staffActor(request);
      const alert = await inTx(deps, (tx) =>
        acknowledgeRetailAlert(tx, {
          alertId,
          staffId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(RetailAlertResponse, { alert });
    },
  );

  // The thresholds of two shop alerts (big win, low agent balance), changed by an admin.
  app.get('/admin/retail/alert-thresholds', { config: { staff: 'agents.view' } }, async () => {
    const rules = await loadRetailAlertRules(deps.db);
    return wire(RetailAlertThresholds, { bigWin: rules.bigWin, lowBalance: rules.lowBalance });
  });

  app.put(
    '/admin/retail/alert-thresholds',
    { config: { staff: 'agents.manage' } },
    async (request) => {
      const input = parseInput(RetailAlertThresholds, request.body);
      const actor = staffActor(request);
      try {
        const rules = await inTx(deps, (tx) =>
          setRetailAlertThresholds(tx, {
            bigWin: BigInt(input.bigWin),
            lowBalance: BigInt(input.lowBalance),
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
          }),
        );
        return wire(RetailAlertThresholds, { bigWin: rules.bigWin, lowBalance: rules.lowBalance });
      } catch (error) {
        if (error instanceof RangeError)
          throw badRequest('alert_thresholds_invalid', error.message);
        throw error;
      }
    },
  );
}
