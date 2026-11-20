import { randomUUID } from 'node:crypto';
import {
  AgentResponse,
  AgentTopupResponse,
  ApiErrorSchema,
  CashierShopResponse,
  CreateStaffResponse,
  SHOP_CSRF_HEADER,
  ShopDeskResponse,
  ShopDeviceAskResponse,
  ShopPicksResponse,
  ShopSessionResponse,
  ShopShiftResponse,
  ShopTicketCheckResponse,
  ShopTicketListResponse,
  ShopTicketPrintResponse,
  ShopTicketResponse,
  ShopPayTicketResponse,
  RetailPayoutListResponse,
  TicketLimitsResponse,
} from '@vamos/contracts';
import { resultEvent, settleEventBets, type Database } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asStaff, seedStaff, staffLogin, type StaffSession } from './admin-helpers';
import {
  insertCategory,
  insertCompetition,
  insertEvent,
  insertMarket,
  insertSport,
  insertTeam,
  ONE_X_TWO,
} from './fixtures';
import { createTestContext, type TestContext } from './helpers';

/** Shop tickets through the shop app's API (docs/plans/agent-shops.md phase 3, step 2). */

let ctx: TestContext;
let db: Database;
let admin: StaffSession;
let finance: StaffSession;
const PASSWORD = 'shop desk password 2026';
const NEW_PASSWORD = 'a brand new shop password 7';
const NOW = new Date('2026-11-20T09:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const match = { home: '', draw: '', gameId: 0, startedHome: '', eventId: '' };

beforeAll(async () => {
  ctx = await createTestContext({ SHOP_WEB_URL: 'http://shop.localhost:3002' });
  ctx.clock.now = NOW;
  db = ctx.db.db;
  await seedStaff(ctx);
  admin = await staffLogin(ctx, 'admin');
  finance = await staffLogin(ctx, 'finance');

  await insertSport(db, 'football', { en: 'Football' }, 10);
  const category = await insertCategory(db, 'football', 'ethiopia', { en: 'Ethiopia' }, 10);
  const league = await insertCompetition(db, {
    sportId: 'football',
    categoryId: category,
    slug: 'shop-league',
    name: { en: 'Shop League' },
  });
  const a = await insertTeam(db, 'football', 'AAA', { en: 'Alpha' });
  const b = await insertTeam(db, 'football', 'BBB', { en: 'Beta' });
  const base = { sportId: 'football', competitionId: league, homeTeamId: a, awayTeamId: b };
  const event = await insertEvent(db, { ...base, startTime: minutes(120) });
  const market = await insertMarket(db, event.id, '1x2', null, ONE_X_TWO);
  match.home = market.selectionIds['1']!;
  match.draw = market.selectionIds['X']!;
  match.gameId = event.gameId;
  match.eventId = event.id;
  const started = await insertEvent(db, { ...base, startTime: minutes(-10), status: 'live' });
  match.startedHome = (await insertMarket(db, started.id, '1x2', null, ONE_X_TWO)).selectionIds[
    '1'
  ]!;
});

afterAll(async () => {
  await ctx?.close();
});

const code = (body: string) => ApiErrorSchema.parse(JSON.parse(body)).error.code;
const post = (url: string, payload: unknown, cookie = '', headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { cookie, ...headers },
  });

interface Desk {
  cookie: string;
  csrf: string;
  shiftId: string;
}

/** An agent with a shop, a balance and a cashier signed in on an approved device, shift open. */
async function agentDesk(name: string, balance: string) {
  const { agent } = AgentResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/agents', {
        name,
        ownerName: 'Owner Name',
        ownerPhone: '0911223344',
        commissionKind: 'ggr',
        commissionBps: 1_000,
      })
    ).json(),
  );
  const { shop } = CashierShopResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/shops`, {
        name: `${name} 1`,
        address: '',
        receiptWidthMm: 58,
        approvalThreshold: '1000000',
      })
    ).json(),
  );
  const { topup } = AgentTopupResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', `/admin/agents/${agent.id}/topups`, {
        direction: 'in',
        amount: balance,
        method: 'cash',
      })
    ).json(),
  );
  await asStaff(ctx, finance, 'POST', `/admin/agent-topups/${topup.id}/approve`, {});
  return { agent, shop, desk: await deskAt(shop.id, name) };
}

async function deskAt(shopId: string, name: string): Promise<Desk> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 6)}@shop.example.com`;
  const { user } = CreateStaffResponse.parse(
    (
      await asStaff(ctx, admin, 'POST', '/admin/staff', {
        email,
        displayName: `${name} Desk`,
        role: 'cashier',
        password: PASSWORD,
        phone: '0911556677',
      })
    ).json(),
  );
  await asStaff(ctx, admin, 'PUT', `/admin/cashier/staff/${user.id}/shop`, { shopId });
  const asked = await post('/shop/devices/request', {
    email,
    password: PASSWORD,
    label: 'Counter',
  });
  const { device } = ShopDeviceAskResponse.parse(asked.json());
  const deviceCookie = asked.cookies.find((c) => c.name.endsWith('vamos_device'))!;
  await asStaff(ctx, admin, 'POST', `/admin/shop-devices/${device.id}/approve`);
  const deviceHeader = `${deviceCookie.name}=${deviceCookie.value}`;
  const login = await post('/shop/auth/login', { email, password: PASSWORD }, deviceHeader);
  const session = ShopSessionResponse.parse(login.json());
  const shopCookie = login.cookies.find((c) => c.name.endsWith('vamos_shop'))!;
  const cookie = `${deviceHeader}; ${shopCookie.name}=${shopCookie.value}`;
  const csrf = { [SHOP_CSRF_HEADER]: session.csrfToken };
  await post(
    '/shop/auth/password',
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    cookie,
    csrf,
  );
  const opened = await post('/shop/desk/shifts', { openingFloat: '50000' }, cookie, csrf);
  return {
    cookie,
    csrf: session.csrfToken,
    shiftId: ShopShiftResponse.parse(opened.json()).shift.id,
  };
}

const asDesk = (desk: Desk, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { cookie: desk.cookie, [SHOP_CSRF_HEADER]: desk.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const sell = (desk: Desk, stake: string, key = randomUUID()) =>
  asDesk(desk, 'POST', '/shop/desk/tickets', {
    shiftId: desk.shiftId,
    legs: [{ selectionId: match.home, oddsMilli: 1850 }],
    stake,
    idempotencyKey: `ticket-${key}`,
  });

describe('shop tickets through the shop app', () => {
  it('builds by Game ID and pick, checks before printing, sells, lists, prints and cancels', async () => {
    const { desk } = await agentDesk('Ticket Route Agent', '500000');

    const picks = await asDesk(desk, 'POST', '/shop/desk/tickets/picks', {
      picks: [
        { gameId: match.gameId, pick: '1' },
        { gameId: 99_999, pick: '1' },
        { gameId: match.gameId, pick: 'ZZ' },
      ],
    });
    expect(picks.statusCode, picks.body).toBe(200);
    expect(ShopPicksResponse.parse(picks.json()).legs).toMatchObject([
      { selectionId: match.home, oddsMilli: 1850, refusal: null },
      { selectionId: null, refusal: 'game_not_found' },
      { selectionId: null, refusal: 'pick_not_offered' },
    ]);

    const check = await asDesk(desk, 'POST', '/shop/desk/tickets/check', {
      legs: [
        { selectionId: match.home, oddsMilli: 1850 },
        { selectionId: match.startedHome, oddsMilli: 2000 },
      ],
      stake: '10000',
    });
    expect(check.statusCode, check.body).toBe(200);
    expect(ShopTicketCheckResponse.parse(check.json()).legs).toMatchObject([
      { selectionId: match.home, available: true },
      { selectionId: match.startedHome, available: false, reason: 'event_started' },
    ]);

    const key = randomUUID();
    const sold = await sell(desk, '10000', key);
    expect(sold.statusCode, sold.body).toBe(200);
    const { ticket } = ShopTicketResponse.parse(sold.json());
    expect(ticket).toMatchObject({ status: 'sold', stake: '10000', betStatus: 'open' });
    expect(ticket.number).toBe(ticket.bet.shortId);
    expect(ticket.cancellableUntil).not.toBeNull();
    // Shops never cash out.
    expect(ticket.bet.cashOutOffer?.available ?? false).toBe(false);
    const again = ShopTicketResponse.parse((await sell(desk, '10000', key)).json());
    expect(again).toMatchObject({ replayed: true, ticket: { id: ticket.id } });
    const deskView = ShopDeskResponse.parse((await asDesk(desk, 'GET', '/shop/desk')).json());
    expect(deskView.agentBalance).toBe('490000');

    const listed = ShopTicketListResponse.parse(
      (await asDesk(desk, 'GET', '/shop/desk/tickets')).json(),
    );
    expect(listed.tickets.map((t) => t.id)).toContain(ticket.id);

    const first = await asDesk(desk, 'POST', `/shop/desk/tickets/${ticket.id}/print`);
    expect(ShopTicketPrintResponse.parse(first.json()).copy).toBe(false);
    const second = await asDesk(desk, 'POST', `/shop/desk/tickets/${ticket.id}/print`);
    expect(ShopTicketPrintResponse.parse(second.json())).toMatchObject({
      copy: true,
      ticket: { reprints: 1 },
    });

    const other = await deskAt(deskView.shop.id, 'Ticket Route Other');
    expect((await asDesk(other, 'GET', `/shop/desk/tickets/${ticket.id}`)).statusCode).toBe(404);

    const cancelled = await asDesk(desk, 'POST', `/shop/desk/tickets/${ticket.id}/cancel`, {
      reason: 'customer changed mind',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(ShopTicketResponse.parse(cancelled.json()).ticket).toMatchObject({
      status: 'cancelled',
      betStatus: 'cancelled',
      cancellableUntil: null,
    });
    const printed = await asDesk(desk, 'POST', `/shop/desk/tickets/${ticket.id}/print`);
    expect(printed.statusCode).toBe(409);
    expect(code(printed.body)).toBe('ticket_cancelled');
  });

  it("an admin sets an agent's limits and cancels a ticket after the cashier's window", async () => {
    const { agent, desk } = await agentDesk('Ticket Limits Agent', '500000');
    const limits = await asStaff(ctx, admin, 'PUT', `/admin/agents/${agent.id}/ticket-limits`, {
      maxStake: '5000',
      cancelMinutes: 2,
    });
    expect(limits.statusCode, limits.body).toBe(200);
    expect(TicketLimitsResponse.parse(limits.json())).toMatchObject({
      overrides: { maxStake: '5000', cancelMinutes: 2 },
      effective: { maxStake: '5000', maxWin: '50000000', cancelMinutes: 2 },
    });
    expect(
      (
        await asStaff(ctx, finance, 'PUT', `/admin/agents/${agent.id}/ticket-limits`, {
          maxStake: '6000',
        })
      ).statusCode,
    ).toBe(403);
    const invalid = await asStaff(ctx, admin, 'PUT', `/admin/agents/${agent.id}/ticket-limits`, {
      minStake: '9000',
      maxStake: '5000',
    });
    expect(invalid.statusCode).toBe(400);
    expect(code(invalid.body)).toBe('ticket_limits_invalid');

    const tooBig = await sell(desk, '10000');
    expect(tooBig.statusCode).toBe(422);
    expect(code(tooBig.body)).toBe('slip_invalid');
    const { ticket } = ShopTicketResponse.parse((await sell(desk, '5000')).json());

    ctx.clock.advance(3 * 60_000);
    const late = await asDesk(desk, 'POST', `/shop/desk/tickets/${ticket.id}/cancel`, {});
    expect(late.statusCode).toBe(409);
    expect(code(late.body)).toBe('cancel_window_passed');
    const byAdmin = await asStaff(ctx, admin, 'POST', `/admin/retail-tickets/${ticket.id}/cancel`, {
      reason: 'agent asked',
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(ShopTicketResponse.parse(byAdmin.json()).ticket.status).toBe('cancelled');
  });

  it('pays a winner at the shop that sold it; above the HQ limit finance approves first', async () => {
    const { agent, desk } = await agentDesk('Ticket Payout Agent', '500000');
    await asStaff(ctx, admin, 'PUT', `/admin/agents/${agent.id}/ticket-limits`, {
      hqApprovalAbove: '15000',
    });
    const small = ShopTicketResponse.parse((await sell(desk, '5000')).json()).ticket;
    const big = ShopTicketResponse.parse((await sell(desk, '10000')).json()).ticket;
    await db.transaction((tx) =>
      resultEvent(tx, match.eventId, { status: 'finished', score: { home: 2, away: 0 } }),
    );
    await db.transaction((tx) => settleEventBets(tx, match.eventId, ctx.clock.now));

    const looked = await asDesk(
      desk,
      'GET',
      `/shop/desk/tickets/lookup?number=${small.number.toLowerCase()}`,
    );
    expect(looked.statusCode, looked.body).toBe(200);
    const smallNow = ShopTicketResponse.parse(looked.json()).ticket;
    expect(smallNow).toMatchObject({ payState: 'payable' });
    const pay = (number: string, key = randomUUID()) =>
      asDesk(desk, 'POST', '/shop/desk/tickets/payouts', {
        shiftId: desk.shiftId,
        number,
        idempotencyKey: `payout-${key}`,
      });
    const key = randomUUID();
    const paid = await pay(small.number, key);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(ShopPayTicketResponse.parse(paid.json())).toMatchObject({
      outcome: 'paid',
      amount: smallNow.payAmount,
      ticket: { status: 'paid', payState: 'paid' },
    });
    expect(ShopPayTicketResponse.parse((await pay(small.number, key)).json()).replayed).toBe(true);
    const again = await pay(small.number);
    expect(again.statusCode).toBe(409);
    expect(code(again.body)).toBe('ticket_not_payable');

    // Another agent's cashier finds nothing.
    const { desk: stranger } = await agentDesk('Ticket Payout Stranger', '100000');
    expect(
      (await asDesk(stranger, 'GET', `/shop/desk/tickets/lookup?number=${small.number}`))
        .statusCode,
    ).toBe(404);

    // Above the HQ limit: waits for finance, then pays.
    const waiting = ShopPayTicketResponse.parse((await pay(big.number)).json());
    expect(waiting).toMatchObject({
      outcome: 'approval_required',
      ticket: { payState: 'awaiting_approval' },
    });
    const list = RetailPayoutListResponse.parse(
      (await asStaff(ctx, finance, 'GET', '/admin/retail-payouts')).json(),
    );
    expect(list.payouts.map((p) => p.ticketId)).toContain(big.id);
    const approved = await asStaff(ctx, finance, 'POST', `/admin/retail-payouts/${big.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(ShopPayTicketResponse.parse((await pay(big.number)).json()).outcome).toBe('paid');
  });
});
