import {
  AgentDetailResponse,
  AgentListResponse,
  AgentResponse,
  AgentStatusRequest,
  CashierShopResponse,
  CreateAgentRequest,
  CreateAgentShopRequest,
  UpdateAgentRequest,
} from '@vamos/contracts';
import {
  createAgent,
  createShop,
  getAgent,
  getShop,
  listAgentCashiers,
  listAgents,
  listShops,
  setAgentBlocked,
  updateAgent,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { shopView } from './cashier';
import { inTx, parseUuid, wire } from './common';

/**
 * Agents (docs/plans/agent-shops.md, phase 1): the admin adds agents (the next number is given),
 * their shops (each agent's next shop number), changes them, and blocks or unblocks an agent at
 * any time. `agents.view` reads (admin, finance, compliance); `agents.manage` changes (admin).
 * The rules live in @vamos/db (retail/agents.ts, createShop); these routes shape the answers.
 */
export default async function adminAgentRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  type IdParams = { Params: { id: string } };

  app.get('/admin/agents', { config: { staff: 'agents.view' } }, async () =>
    wire(AgentListResponse, { items: await listAgents(deps.db) }),
  );

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
    return wire(AgentDetailResponse, { agent, shops: shops.map(shopView), cashiers });
  });

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
}
