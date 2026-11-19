import {
  AgentDetailResponse,
  AgentListResponse,
  AgentResponse,
  AgentTopupResponse,
  ApiErrorSchema,
} from '@vamos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import { createTestContext, type TestContext } from './helpers';

/** The agent balance (docs/plans/agent-shops.md, phase 2): top-ups and take-backs, four eyes. */

let ctx: TestContext;
let admin: StaffSession;
let finance: StaffSession;
let support: StaffSession;

beforeAll(async () => {
  ctx = await createTestContext();
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');
  support = await staffLogin(ctx, 'support');
});

afterAll(async () => {
  await ctx?.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;

async function newAgent(name: string) {
  return AgentResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/agents', {
        name,
        ownerName: 'Owner Name',
        ownerPhone: '0911223344',
        commissionKind: 'ggr',
        commissionBps: 1_000,
      })
    ).json(),
  ).agent;
}

describe('agent top-ups', () => {
  it('one admin records, another person approves; the balance shows on the agent pages', async () => {
    const agent = await newAgent('Topup Route Agent');
    const recorded = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
      direction: 'in',
      amount: '500000',
      method: 'cash',
      note: 'first prepayment',
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const { topup } = AgentTopupResponse.parse(recorded.json());
    expect(topup).toMatchObject({ status: 'requested', requestedByName: 'Demo Admin' });

    const own = await asStaff(ctx, admin, 'POST', `/admin/agent-topups/${topup.id}/approve`, {});
    expect(own.statusCode).toBe(409);
    expect(code(own.body)).toBe('four_eyes');
    expect(
      (await asStaff(ctx, support, 'POST', `/admin/agent-topups/${topup.id}/approve`, {}))
        .statusCode,
    ).toBe(403);
    const approved = await asStaff(
      ctx,
      finance,
      'POST',
      `/admin/agent-topups/${topup.id}/approve`,
      {
        note: 'cash counted',
      },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(AgentTopupResponse.parse(approved.json())).toMatchObject({
      changed: true,
      topup: { status: 'approved', decidedByName: 'Demo Finance', decisionNote: 'cash counted' },
    });

    const detail = AgentDetailResponse.parse(
      (await asStaff(ctx, finance, 'GET', `/admin/agents/${agent.id}`)).json(),
    );
    expect(detail.balance).toBe('500000');
    expect(detail.topups.map((t) => t.status)).toEqual(['approved']);
    const list = AgentListResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/agents')).json(),
    );
    expect(list.items.find((a) => a.id === agent.id)?.balance).toBe('500000');
    expect(list.items.find((a) => a.number === 1000)?.balance).toBeNull();
  });

  it('refuses a take-back above the balance, a bank top-up without reference, and support', async () => {
    const agent = await newAgent('Take Back Route Agent');
    const above = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
      direction: 'out',
      amount: '100',
      method: 'cash',
    });
    expect(above.statusCode).toBe(409);
    expect(code(above.body)).toBe('agent_balance_low');
    const noReference = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
      direction: 'in',
      amount: '100',
      method: 'bank',
    });
    expect(noReference.statusCode).toBe(400);
    const bySupport = await asStaff(ctx, support, 'POST', `/admin/agents/${agent.id}/topups`, {
      direction: 'in',
      amount: '100',
      method: 'cash',
    });
    expect(bySupport.statusCode).toBe(403);
    // A rejection posts nothing.
    const { topup } = AgentTopupResponse.parse(
      (
        await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
          direction: 'in',
          amount: '20000',
          method: 'bank',
          bankReference: 'CBE-123456',
        })
      ).json(),
    );
    const rejected = await asStaff(ctx, finance, 'POST', `/admin/agent-topups/${topup.id}/reject`, {
      note: 'no such transfer on the statement',
    });
    expect(rejected.statusCode).toBe(200);
    const detail = AgentDetailResponse.parse(
      (await asStaff(ctx, admin, 'GET', `/admin/agents/${agent.id}`)).json(),
    );
    expect(detail.balance).toBe('0');
    expect(detail.topups[0]).toMatchObject({ status: 'rejected', bankReference: 'CBE-123456' });
  });
});

describe('player cash at an agent shop', () => {
  it('only agents.manage switches it, never for Nahubet HQ', async () => {
    const agent = await newAgent('Player Cash Route Agent');
    const on = await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/player-cash`, {
      enabled: true,
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(AgentResponse.parse(on.json()).agent.playerCashEnabled).toBe(true);
    expect(
      (
        await asStaff(ctx, finance, 'POST', `/admin/agents/${agent.id}/player-cash`, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(403);
    const list = AgentListResponse.parse(
      (await asStaff(ctx, admin, 'GET', '/admin/agents')).json(),
    );
    const hq = list.items.find((a) => a.number === 1000)!;
    const house = await asStaff(ctx, admin, 'POST', `/admin/agents/${hq.id}/player-cash`, {
      enabled: false,
    });
    expect(house.statusCode).toBe(409);
    expect(code(house.body)).toBe('agent_is_house');
  });
});
