import {
  DeskWithdrawalCodeLookupRequest,
  DeskWithdrawalCodePayRequest,
  ShopOwnerCashierResponse,
  ShopOwnerCreateCashierRequest,
  ShopPayTicketRequest,
  ShopPayTicketResponse,
  ShopBookingResponse,
  ShopPicksRequest,
  ShopPicksResponse,
  ShopSellTicketRequest,
  ShopTicketCancelRequest,
  ShopTicketCheckRequest,
  ShopTicketCheckResponse,
  ShopTicketListResponse,
  ShopTicketPrintResponse,
  ShopSellTicketResponse,
  ShopTicketResponse,
  CashDepositRequest,
  CashierPlayerQuery,
  CashReceiptPrintResponse,
  CashReceiptResponse,
  CashWithdrawalRequest,
  ShopDeviceAskRequest,
  ShopDeviceAskResponse,
  CloseShiftRequest,
  ShopDeskResponse,
  ShopLoginRequest,
  ShopOpenShiftRequest,
  ShopOwnerResponse,
  ShopPasswordChangeRequest,
  ShopSessionResponse,
  ShopShiftResponse,
  AgentStatementListResponse,
  EventListQuery,
  type EventListResponse,
} from '@vamos/contracts';
import { parsePick, retailBetRules } from '@vamos/core';
import {
  assignStaffShop,
  createStaffUser,
  setStaffDisabled,
  staffBlockedBy,
  findTicketByNumber,
  payRetailTicket,
  agentTicketLimits,
  cancelRetailTicket,
  getRetailTicket,
  listShiftTickets,
  loadBookingCode,
  loadGameSettings,
  printRetailTicket,
  quoteSlip,
  resolveTextBetLegs,
  sellRetailTicket,
  changeOwnStaffPassword,
  closeShift,
  getAgent,
  getAgentBalance,
  loadRetailAlertRules,
  getOpenShift,
  getOwnerAgent,
  getShop,
  getStaffShop,
  listAgentCashiers,
  listAgentDevices,
  listShops,
  hashDeviceSecret,
  listShiftOperations,
  listShifts,
  loginStaff,
  logoutStaff,
  openShift,
  normalizeStaffEmail,
  requestShopDeviceWithPassword,
  warmUpStaffPasswordHashing,
  type CashierShift,
  type DbExecutor,
  type StaffPrincipal,
  listAgentStatements,
  getShift,
} from '@vamos/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { conflict, forbidden, notFound, parseInput, unauthorized } from '../../lib/errors';
import { cachedGameSettings } from '../betting/service';
import { listEvents } from '../catalog/queries';
import { quoteView } from '../betting/views';
import { ticketView } from './ticket-views';
import { enforceLimit } from '../../lib/rate-limits';
import {
  clearShopCookie,
  requireShopStaff,
  setDeviceCookie,
  setShopCookie,
  shopDeviceCookieName,
  shopSessionPlugin,
} from '../../plugins/shop-session';
import { apiPasswordHasher, staffAuthDeps } from '../../plugins/staff-session';
import {
  CASHIER_RATE_LIMITS,
  operationView,
  receiptView,
  shiftView,
  shopView,
} from '../admin/cashier';
import { inTx, parseUuid, wire } from '../admin/common';
import {
  deskDeposit,
  deskLookup,
  deskPrint,
  deskReceipt,
  deskReprint,
  deskWithdrawal,
  type DeskActor,
  deskWithdrawalCodeLookup,
  deskWithdrawalCodePay,
} from '../admin/desk-operations';

/**
 * The shop app's API (docs/plans/agent-shops.md phase 1b): a device asks to be registered (the
 * cashier's password, then an admin approves it in the back office), a cashier signs in on an
 * approved device of their own shop, sees who and where they are, and signs out. The checks live
 * in @vamos/db (loginStaff with channel `shop`, requestShopDeviceWithPassword); sign-in and asking
 * are rate limited like the back office's sign-in.
 */

function bodyEmail(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | null | undefined;
  return typeof body?.email === 'string' ? normalizeStaffEmail(body.email).slice(0, 254) : '';
}

/**
 * The session answer: a cashier with their shop (label, paper width) and its agent, or an agent
 * owner with their agent (no shop, no device), and the session times.
 */
async function shopSessionBody(exec: DbExecutor, staff: StaffPrincipal) {
  const person = {
    id: staff.id,
    email: staff.email,
    displayName: staff.displayName,
    passwordChangeRequired: staff.passwordChangeRequired,
  };
  const times = {
    csrfToken: staff.csrfToken,
    expiresAt: staff.expiresAt,
    idleExpiresAt: staff.idleExpiresAt,
  };
  if (staff.role === 'agent_owner') {
    const agent = await getOwnerAgent(exec, staff.id);
    if (agent === null) throw unauthorized('Sign in to the shop app.');
    return {
      staff: { ...person, role: 'agent_owner' as const },
      agent: { id: agent.id, number: agent.number, name: agent.name },
      shop: null,
      deviceId: null,
      ...times,
    };
  }
  const shopId = await getStaffShop(exec, staff.id);
  const shop = shopId === null ? null : await getShop(exec, shopId);
  const agent = shop === null ? null : await getAgent(exec, shop.agentId);
  if (
    shop === null ||
    agent === null ||
    staff.role !== 'cashier' ||
    typeof staff.deviceId !== 'string'
  ) {
    // The session check already refuses this; a race (unassigned meanwhile) ends here.
    throw unauthorized('Sign in to the shop app on a registered device.');
  }
  return {
    staff: { ...person, role: 'cashier' as const },
    agent: { id: agent.id, number: agent.number, name: agent.name },
    shop: shopView(shop),
    deviceId: staff.deviceId,
    ...times,
  };
}

export default async function shopRoutes(app: FastifyInstance): Promise<void> {
  // Called directly, not registered: its hook must cover this scope's routes.
  await shopSessionPlugin(app);
  const { deps, authLimits } = app;
  const authDeps = staffAuthDeps(deps);
  await warmUpStaffPasswordHashing(apiPasswordHasher(deps.config));

  const perClient = app.createRateLimit({
    ...authLimits.staffLoginPerClient,
    keyGenerator: (request) => `shop-login-client|${clientAddressKey(request.ip)}`,
  });
  const perEmail = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) =>
      `shop-login-email|${bodyEmail(request)}|${clientAddressKey(request.ip)}`,
  });
  const loginLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
    if (bodyEmail(request) !== '') await enforceLimit(perEmail, request, reply);
  };

  app.post('/shop/devices/request', { preHandler: loginLimits }, async (request, reply) => {
    const input = parseInput(ShopDeviceAskRequest, request.body);
    const secret = deps.randomBytes(32).toString('base64url');
    const device = await requestShopDeviceWithPassword(authDeps, {
      email: input.email,
      password: input.password,
      label: input.label,
      secretHash: hashDeviceSecret(secret),
      userAgent: request.headers['user-agent'] ?? '',
      ip: request.ip,
      clientKey: clientAddressKey(request.ip),
    });
    setDeviceCookie(reply, deps.config, secret, deps.clock());
    reply.code(201);
    return wire(ShopDeviceAskResponse, {
      device: { id: device.id, label: device.label, status: 'pending' },
    });
  });

  app.post('/shop/auth/login', { preHandler: loginLimits }, async (request, reply) => {
    const input = parseInput(ShopLoginRequest, request.body);
    const secret = request.cookies[shopDeviceCookieName(deps.config)];
    const deviceSecretHash =
      typeof secret === 'string' && secret.length > 0 && secret.length <= 128
        ? hashDeviceSecret(secret)
        : '';
    const { staff, session } = await loginStaff(authDeps, {
      email: input.email,
      password: input.password,
      // An agent owner types the authenticator code; a cashier's device cookie is the factor.
      code: input.code ?? '',
      channel: 'shop',
      deviceSecretHash,
      ip: request.ip,
      clientKey: clientAddressKey(request.ip),
      userAgent: request.headers['user-agent'] ?? null,
    });
    setShopCookie(reply, deps.config, session);
    return wire(ShopSessionResponse, await shopSessionBody(deps.db, staff));
  });

  app.get('/shop/me', async (request) =>
    wire(ShopSessionResponse, await shopSessionBody(deps.db, requireShopStaff(request))),
  );

  // The password re-check costs an argon2 hash: limited like sign-in, per address and cashier.
  const perStaff = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) => `shop-self|${requireShopStaff(request).id}`,
  });
  app.post(
    '/shop/auth/password',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        await enforceLimit(perClient, request, reply);
        await enforceLimit(perStaff, request, reply);
      },
    },
    async (request) => {
      const staff = requireShopStaff(request);
      const input = parseInput(ShopPasswordChangeRequest, request.body);
      await changeOwnStaffPassword(authDeps, {
        adminUserId: staff.id,
        sessionId: staff.sessionId,
        currentPassword: input.currentPassword,
        // Needed from an agent owner; a cashier's device already proved the second factor.
        code: input.code ?? '',
        newPassword: input.newPassword,
        channel: 'shop',
        ip: request.ip,
        clientKey: clientAddressKey(request.ip),
      });
      return { ok: true };
    },
  );

  app.post('/shop/auth/logout', async (request, reply) => {
    const staff = requireShopStaff(request);
    await logoutStaff(deps, { sessionId: staff.sessionId, adminUserId: staff.id, ip: request.ip });
    clearShopCookie(reply, deps.config);
    return { ok: true };
  });

  // The desk (phase 1b step 3c): the cashier's shift at their own shop. Player cash and tickets
  // come with phases 2 and 3; an admin-chosen password is replaced first.
  const requireDeskStaff = (request: FastifyRequest): StaffPrincipal => {
    const staff = requireShopStaff(request);
    if (staff.role !== 'cashier') {
      throw forbidden('cashier_only', 'The desk is for cashiers.');
    }
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the desk.',
      );
    }
    return staff;
  };
  const namedShiftView = async (exec: DbExecutor, shift: CashierShift) => {
    const [named] = await listShifts(exec, { shiftId: shift.id, limit: 1 });
    return shiftView(exec, shift, {
      shopName: named?.shopName ?? '',
      shopLabel: named?.shopLabel ?? '',
      staffName: named?.staffName ?? '',
    });
  };
  const deskShop = async (exec: DbExecutor, staff: StaffPrincipal) => {
    const shopId = await getStaffShop(exec, staff.id);
    const shop = shopId === null ? null : await getShop(exec, shopId);
    if (shop === null) throw unauthorized('Sign in to the shop app on a registered device.');
    return shop;
  };

  // The agent owner's overview (phase 1b step 1): their agent, its shops, cashiers and devices.
  app.get('/shop/owner', async (request) => {
    const staff = requireShopStaff(request);
    if (staff.role !== 'agent_owner')
      throw forbidden('owner_only', 'This page is for agent owners.');
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the shop app.',
      );
    }
    const agent = await getOwnerAgent(deps.db, staff.id);
    if (agent === null) throw unauthorized('Sign in to the shop app.');
    const shops = (await listShops(deps.db)).filter((shop) => shop.agentId === agent.id);
    return wire(ShopOwnerResponse, {
      agent,
      balance: (await getAgentBalance(deps.db, agent.id)).toString(),
      balanceLowAt: (await loadRetailAlertRules(deps.db)).lowBalance,
      shops: shops.map(shopView),
      cashiers: await listAgentCashiers(deps.db, agent.id),
      devices: await listAgentDevices(deps.db, agent.id),
    });
  });

  // The owner's weekly statements (phase 5), read-only: the last 12 weeks of their agent.
  app.get('/shop/owner/statements', async (request) => {
    const staff = requireShopStaff(request);
    if (staff.role !== 'agent_owner')
      throw forbidden('owner_only', 'This page is for agent owners.');
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the shop app.',
      );
    }
    const agent = await getOwnerAgent(deps.db, staff.id);
    if (agent === null) throw unauthorized('Sign in to the shop app.');
    const items = await listAgentStatements(deps.db, { agentId: agent.id, limit: 12 });
    return wire(AgentStatementListResponse, { weekStart: null, items });
  });

  app.get('/shop/desk', async (request) => {
    const staff = requireDeskStaff(request);
    const shop = await deskShop(deps.db, staff);
    const shift = await getOpenShift(deps.db, staff.id);
    const operations =
      shift === null ? [] : (await listShiftOperations(deps.db, shift.id)).map(operationView);
    return wire(ShopDeskResponse, {
      shop: shopView(shop),
      shift: shift === null ? null : await namedShiftView(deps.db, shift),
      operations,
      // Player cash: always at Nahubet HQ's shops; at an agent's once an admin switched it on.
      playerCash: shop.agentIsHouse || shop.agentPlayerCash,
      // An agent's tickets and deposits are paid from its balance (the top-up from HQ): the
      // cashier sees how much is left, and when to ask the agent owner for a top-up.
      agentBalance: shop.agentIsHouse ? null : await getAgentBalance(deps.db, shop.agentId),
      agentBalanceLowAt: shop.agentIsHouse
        ? null
        : (await loadRetailAlertRules(deps.db)).lowBalance,
    });
  });

  app.post('/shop/desk/shifts', async (request) => {
    const staff = requireDeskStaff(request);
    const input = parseInput(ShopOpenShiftRequest, request.body);
    const shop = await deskShop(deps.db, staff);
    const shift = await inTx(deps, async (tx) => {
      const opened = await openShift(tx, {
        staffId: staff.id,
        shopId: shop.id,
        openingFloat: BigInt(input.openingFloat),
        now: deps.clock(),
        ip: request.ip,
      });
      return namedShiftView(tx, opened);
    });
    return wire(ShopShiftResponse, { shift });
  });

  // The end-of-shift report (docs/plans/counter-codes-and-deposit-recovery.md, G8): one of the
  // cashier's own shifts, open or closed, for its printed slip.
  app.get<{ Params: { id: string } }>('/shop/desk/shifts/:id', async (request) => {
    const staff = requireDeskStaff(request);
    const shift = await getShift(deps.db, parseUuid(request.params.id, 'Shift'));
    if (shift === null || shift.staffId !== staff.id) throw notFound('Shift');
    return wire(ShopShiftResponse, { shift: await namedShiftView(deps.db, shift) });
  });

  app.post<{ Params: { id: string } }>('/shop/desk/shifts/:id/close', async (request) => {
    const staff = requireDeskStaff(request);
    const shiftId = parseUuid(request.params.id, 'Shift');
    const input = parseInput(CloseShiftRequest, request.body);
    const shift = await inTx(deps, async (tx) => {
      const { shift: closed } = await closeShift(tx, {
        staffId: staff.id,
        shiftId,
        countedCash: BigInt(input.countedCash),
        note: input.note ?? null,
        now: deps.clock(),
        ip: request.ip,
      });
      return namedShiftView(tx, closed);
    });
    return wire(ShopShiftResponse, { shift });
  });

  // Player cash at the shop's desk (docs/plans/agent-shops.md phase 2): the same code path as the
  // back office's desk (desk-operations.ts). The shop app's cashier is never a supervisor: above
  // the shop's threshold a deposit or withdrawal waits for the back office, and a cashier sees
  // only their own receipts. Limited per cashier like the back office's desk (shared counters).
  const deskLimit = (name: string, max: number) => {
    const limiter = app.createRateLimit({
      max,
      timeWindow: 60_000,
      keyGenerator: (request) => `${name}|staff|${requireShopStaff(request).id}`,
    });
    return {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        requireDeskStaff(request);
        await enforceLimit(limiter, request, reply);
      },
    };
  };
  const cashier = (request: FastifyRequest): DeskActor => ({
    staffId: requireDeskStaff(request).id,
    ip: request.ip,
    supervisor: false,
  });
  /** A shift the cashier opened at another shop never takes this shop's cash. */
  const checkShiftShop = async (staff: StaffPrincipal, shiftId: string) => {
    const shop = await deskShop(deps.db, staff);
    const open = await getOpenShift(deps.db, staff.id);
    if (open !== null && open.id === shiftId && open.shopId !== shop.id) {
      throw conflict('shift_other_shop', 'This shift was opened at another shop. Close it first.');
    }
  };

  app.get(
    '/shop/desk/players',
    deskLimit('cashier-lookup', CASHIER_RATE_LIMITS.lookup),
    async (request) => {
      const query = parseInput(CashierPlayerQuery, request.query);
      return deskLookup(deps, cashier(request), query.phone);
    },
  );

  app.post(
    '/shop/desk/deposits',
    deskLimit('cashier-deposit', CASHIER_RATE_LIMITS.deposit),
    async (request) => {
      const input = parseInput(CashDepositRequest, request.body);
      await checkShiftShop(requireDeskStaff(request), input.shiftId);
      return deskDeposit(deps, cashier(request), input, receiptView);
    },
  );

  app.post(
    '/shop/desk/withdrawals',
    deskLimit('cashier-withdrawal', CASHIER_RATE_LIMITS.withdrawal),
    async (request) => {
      const input = parseInput(CashWithdrawalRequest, request.body);
      await checkShiftShop(requireDeskStaff(request), input.shiftId);
      return deskWithdrawal(deps, cashier(request), input, receiptView);
    },
  );

  // Withdrawal codes (G4): the code alone finds the withdrawal the player asked for in the app.
  app.post(
    '/shop/desk/withdrawal-codes/lookup',
    deskLimit('cashier-withdrawal', CASHIER_RATE_LIMITS.withdrawal),
    async (request) => {
      const input = parseInput(DeskWithdrawalCodeLookupRequest, request.body);
      await checkShiftShop(requireDeskStaff(request), input.shiftId);
      return deskWithdrawalCodeLookup(deps, cashier(request), input);
    },
  );

  app.post(
    '/shop/desk/withdrawal-codes/pay',
    deskLimit('cashier-withdrawal', CASHIER_RATE_LIMITS.withdrawal),
    async (request) => {
      const input = parseInput(DeskWithdrawalCodePayRequest, request.body);
      await checkShiftShop(requireDeskStaff(request), input.shiftId);
      return deskWithdrawalCodePay(deps, cashier(request), input, receiptView);
    },
  );

  type IdParams = { Params: { id: string } };
  app.get<IdParams>('/shop/desk/receipts/:id', async (request) => {
    const id = parseUuid(request.params.id, 'Receipt');
    const receipt = await deskReceipt(deps.db, cashier(request), id);
    return wire(CashReceiptResponse, { receipt: receiptView(receipt) });
  });

  app.post<IdParams>('/shop/desk/receipts/:id/print', async (request) => {
    const id = parseUuid(request.params.id, 'Receipt');
    const { receipt, copy } = await deskPrint(deps, cashier(request), id);
    return wire(CashReceiptPrintResponse, { receipt: receiptView(receipt), copy });
  });

  app.post<IdParams>('/shop/desk/receipts/:id/reprint', async (request) => {
    const id = parseUuid(request.params.id, 'Receipt');
    const receipt = await deskReprint(deps, cashier(request), id);
    return wire(CashReceiptResponse, { receipt: receiptView(receipt) });
  });

  // Tickets at the counter (docs/plans/agent-shops.md phase 3): the same bet placement and
  // settlement as online, the stake from the agent's balance, prematch only.
  const ticketLimit = deskLimit('cashier-ticket', 120);
  const ticketRow = async (staff: StaffPrincipal, id: string) => {
    const row = await getRetailTicket(deps.db, parseUuid(id, 'Ticket'));
    if (row === null || row.staffId !== staff.id) throw notFound('Ticket');
    return row;
  };
  const viewOf = async (row: NonNullable<Awaited<ReturnType<typeof getRetailTicket>>>) =>
    ticketView(deps.db, row, {
      cashOut: (await cachedGameSettings(deps)).cashOut,
      now: deps.clock(),
    });

  app.post('/shop/desk/tickets/check', ticketLimit, async (request) => {
    const staff = requireDeskStaff(request);
    const input = parseInput(ShopTicketCheckRequest, request.body);
    const shop = await deskShop(deps.db, staff);
    const agent = await getAgent(deps.db, shop.agentId);
    if (agent === null) throw notFound('Agent');
    const settings = await cachedGameSettings(deps);
    const now = deps.clock();
    const slip = await quoteSlip(deps.db, {
      legs: input.legs.map((leg) => ({
        selectionId: leg.selectionId,
        ...(leg.oddsMilli === undefined ? {} : { oddsMilli: leg.oddsMilli }),
      })),
      stake: BigInt(input.stake),
      settings: {
        ...settings,
        betRules: retailBetRules(settings.betRules, agentTicketLimits(agent, settings.betRules)),
      },
      now,
    });
    // A shop sells prematch only: a live match, or one past its kick-off, is to be removed.
    for (const leg of slip.legs) {
      const selection = leg.selection;
      if (
        leg.available &&
        selection !== null &&
        (leg.isLive || selection.startTime.getTime() <= now.getTime())
      ) {
        leg.available = false;
        leg.reason = 'event_started';
      }
    }
    return wire(ShopTicketCheckResponse, quoteView(slip));
  });

  app.post('/shop/desk/tickets', ticketLimit, async (request, reply) => {
    const staff = requireDeskStaff(request);
    const input = parseInput(ShopSellTicketRequest, request.body);
    await checkShiftShop(staff, input.shiftId);
    const { ticket, replayed, payoutCode } = await inTx(deps, async (tx) =>
      sellRetailTicket(tx, {
        staffId: staff.id,
        shiftId: input.shiftId,
        legs: input.legs,
        stake: BigInt(input.stake),
        policy: input.oddsChangePolicy,
        customerPhone: input.customerPhone ?? null,
        bookingCode: input.bookingCode ?? null,
        idempotencyKey: input.idempotencyKey,
        settings: await loadGameSettings(tx),
        now: deps.clock(),
        randomBytes: deps.randomBytes,
        ip: request.ip,
      }),
    );
    const row = await getRetailTicket(deps.db, ticket.id);
    if (row === null) throw notFound('Ticket');
    // The payout code goes to the shop app once, to be printed on the customer's ticket.
    void reply.header('cache-control', 'no-store');
    return wire(ShopSellTicketResponse, { ticket: await viewOf(row), replayed, payoutCode });
  });

  /**
   * The Sell page's list of matches: the public catalogue's upcoming football of the next 48 hours,
   * soonest first. A route of its own because the shop app's origin may only call `/shop/*`.
   */
  const SELLABLE_MATCHES = EventListQuery.parse({
    sport: 'football',
    filter: 'upcoming',
    startsWithinHours: 48,
    limit: 100,
  });
  app.get('/shop/desk/matches', async (request): Promise<EventListResponse> => {
    requireDeskStaff(request);
    return listEvents(deps.db, SELLABLE_MATCHES, deps.clock(), {
      factoryMarkets: deps.config.features.factoryMarkets,
    });
  });

  app.get('/shop/desk/tickets', async (request) => {
    const staff = requireDeskStaff(request);
    const shift = await getOpenShift(deps.db, staff.id);
    const tickets = shift === null ? [] : await listShiftTickets(deps.db, shift.id);
    return wire(ShopTicketListResponse, {
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        number: ticket.number,
        status: ticket.status,
        stake: ticket.stake,
        soldAt: ticket.soldAt,
      })),
    });
  });

  app.get<IdParams>('/shop/desk/tickets/:id', async (request) => {
    const staff = requireDeskStaff(request);
    return wire(ShopTicketResponse, {
      ticket: await viewOf(await ticketRow(staff, request.params.id)),
      replayed: false,
    });
  });

  app.post<IdParams>('/shop/desk/tickets/:id/print', async (request) => {
    const staff = requireDeskStaff(request);
    const id = parseUuid(request.params.id, 'Ticket');
    const { copy } = await inTx(deps, (tx) =>
      printRetailTicket(tx, { ticketId: id, staffId: staff.id, now: deps.clock(), ip: request.ip }),
    );
    return wire(ShopTicketPrintResponse, {
      ticket: await viewOf(await ticketRow(staff, id)),
      copy,
    });
  });

  app.post<IdParams>('/shop/desk/tickets/:id/cancel', async (request) => {
    const staff = requireDeskStaff(request);
    const id = parseUuid(request.params.id, 'Ticket');
    const input = parseInput(ShopTicketCancelRequest, request.body ?? {});
    await inTx(deps, (tx) =>
      cancelRetailTicket(tx, {
        ticketId: id,
        actor: { staffId: staff.id, role: 'cashier' },
        reason: input.reason ?? null,
        now: deps.clock(),
        ip: request.ip,
      }),
    );
    return wire(ShopTicketResponse, {
      ticket: await viewOf(await ticketRow(staff, id)),
      replayed: false,
    });
  });

  // Building a ticket: Game ID + pick (the SMS syntax), or a booking code made online.
  app.post('/shop/desk/tickets/picks', ticketLimit, async (request) => {
    requireDeskStaff(request);
    const input = parseInput(ShopPicksRequest, request.body);
    const now = deps.clock();
    const legs = [];
    for (const entry of input.picks) {
      const pick = parsePick(entry.pick);
      if (pick === null) {
        legs.push({ ...entry, selectionId: null, oddsMilli: null, refusal: 'pick_not_offered' });
        continue;
      }
      const resolved = await resolveTextBetLegs(deps.db, [{ gameId: entry.gameId, pick }], now);
      if (!resolved.ok) {
        legs.push({ ...entry, selectionId: null, oddsMilli: null, refusal: resolved.refusal.code });
        continue;
      }
      const leg = resolved.legs[0]!;
      legs.push({
        ...entry,
        selectionId: leg.selectionId,
        oddsMilli: leg.oddsMilli,
        // Shops sell prematch only.
        refusal: leg.live ? 'event_started' : null,
      });
    }
    return wire(ShopPicksResponse, { legs });
  });

  app.get<{ Params: { code: string } }>(
    '/shop/desk/booking-codes/:code',
    ticketLimit,
    async (request) => {
      requireDeskStaff(request);
      const booking = await loadBookingCode(deps.db, request.params.code, deps.clock());
      return wire(ShopBookingResponse, {
        legs: booking.legs.flatMap((leg) =>
          leg.currentOddsMilli === null
            ? []
            : [{ selectionId: leg.selectionId, oddsMilli: leg.currentOddsMilli }],
        ),
        stake: booking.stake === null ? null : booking.stake.toString(),
      });
    },
  );

  // Paying tickets (phase 4): a ticket looked up by its number (scanned or typed) and paid at the
  // shop that sold it. A cashier only finds their own agent's tickets.
  app.get<{ Querystring: { number?: string } }>(
    '/shop/desk/tickets/lookup',
    ticketLimit,
    async (request) => {
      const staff = requireDeskStaff(request);
      const number = typeof request.query.number === 'string' ? request.query.number : '';
      const shop = await deskShop(deps.db, staff);
      const found = await findTicketByNumber(deps.db, number);
      if (found === null || found.ticket.agentId !== shop.agentId) throw notFound('Ticket');
      const row = await getRetailTicket(deps.db, found.ticket.id);
      if (row === null) throw notFound('Ticket');
      return wire(ShopTicketResponse, { ticket: await viewOf(row), replayed: false });
    },
  );

  app.post('/shop/desk/tickets/payouts', ticketLimit, async (request) => {
    const staff = requireDeskStaff(request);
    const input = parseInput(ShopPayTicketRequest, request.body);
    await checkShiftShop(staff, input.shiftId);
    const result = await inTx(deps, (tx) =>
      payRetailTicket(tx, {
        number: input.number,
        staffId: staff.id,
        shiftId: input.shiftId,
        idempotencyKey: input.idempotencyKey,
        payoutCode: input.payoutCode ?? null,
        now: deps.clock(),
        ip: request.ip,
      }),
    );
    // A wrong payout code was counted (committed above); now refuse.
    if (result.outcome === 'payout_code_wrong') {
      throw conflict(
        'payout_code_wrong',
        result.locked
          ? 'Wrong payout code. The ticket is now locked: HQ unlocks it.'
          : 'Wrong payout code. Ask the customer again.',
        { attemptsLeft: result.attemptsLeft, locked: result.locked },
      );
    }
    const row = await getRetailTicket(deps.db, result.ticket.id);
    if (row === null) throw notFound('Ticket');
    return wire(ShopPayTicketResponse, {
      outcome: result.outcome,
      amount: result.amount,
      replayed: result.replayed,
      ticket: await viewOf(row),
    });
  });

  // The agent's owner cancels a ticket of their shops after the cashier's window, before kick-off.
  app.post<IdParams>('/shop/owner/tickets/:id/cancel', async (request) => {
    const staff = requireShopStaff(request);
    if (staff.role !== 'agent_owner') throw forbidden('owner_only', 'This is for agent owners.');
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the shop app.',
      );
    }
    const id = parseUuid(request.params.id, 'Ticket');
    const input = parseInput(ShopTicketCancelRequest, request.body ?? {});
    await inTx(deps, (tx) =>
      cancelRetailTicket(tx, {
        ticketId: id,
        actor: { staffId: staff.id, role: 'owner' },
        reason: input.reason ?? null,
        now: deps.clock(),
        ip: request.ip,
      }),
    );
    const row = await getRetailTicket(deps.db, id);
    if (row === null) throw notFound('Ticket');
    return wire(ShopTicketResponse, { ticket: await viewOf(row), replayed: false });
  });

  // The owner's own cashiers (agent-shops.md, small gap after phase 5): the owner adds a cashier to
  // one of their shops and blocks or unblocks them. Never another agent's people, never a role
  // other than cashier; an admin still approves each device.
  const ownerAgent = async (request: FastifyRequest) => {
    const staff = requireShopStaff(request);
    if (staff.role !== 'agent_owner') throw forbidden('owner_only', 'This is for agent owners.');
    if (staff.passwordChangeRequired) {
      throw forbidden(
        'password_change_required',
        'Change the password you were given before using the shop app.',
      );
    }
    const agent = await getOwnerAgent(deps.db, staff.id);
    if (agent === null) throw unauthorized('Sign in to the shop app.');
    return { staff, agent };
  };
  const ownerCashier = async (agentId: string, staffId: string) => {
    const cashier = (await listAgentCashiers(deps.db, agentId)).find((c) => c.staffId === staffId);
    if (cashier === undefined) throw notFound('Cashier');
    return cashier;
  };
  const ownerStaffLimit = app.createRateLimit({
    ...authLimits.staffLoginPerEmail,
    keyGenerator: (request) => `shop-owner-staff|${requireShopStaff(request).id}`,
  });

  app.post(
    '/shop/owner/cashiers',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        await enforceLimit(ownerStaffLimit, request, reply);
      },
    },
    async (request, reply) => {
      const { staff, agent } = await ownerAgent(request);
      const input = parseInput(ShopOwnerCreateCashierRequest, request.body);
      const shop = await getShop(deps.db, input.shopId);
      if (shop === null || shop.agentId !== agent.id) throw notFound('Shop');
      const { user } = await createStaffUser(authDeps, {
        email: input.email,
        displayName: input.displayName,
        role: 'cashier',
        password: input.password,
        phone: input.phone,
        actor: { type: 'admin', adminId: staff.id, ip: request.ip },
        inTransaction: async (tx, row) => {
          await assignStaffShop(tx, {
            staffId: row.id,
            shopId: shop.id,
            adminId: staff.id,
            now: deps.clock(),
            ip: request.ip,
          });
        },
      });
      reply.code(201);
      return wire(ShopOwnerCashierResponse, { cashier: await ownerCashier(agent.id, user.id) });
    },
  );

  for (const [path, disabled] of [
    ['block', true],
    ['unblock', false],
  ] as const) {
    app.post<IdParams>(`/shop/owner/cashiers/:id/${path}`, async (request) => {
      const { staff, agent } = await ownerAgent(request);
      const cashierId = parseUuid(request.params.id, 'Cashier');
      const cashier = await ownerCashier(agent.id, cashierId);
      if (
        !disabled &&
        cashier.disabledAt !== null &&
        (await staffBlockedBy(deps.db, cashierId)) !== staff.id
      ) {
        throw forbidden(
          'blocked_by_head_office',
          'Head office blocked this cashier: only head office can unblock them.',
        );
      }
      await inTx(deps, (tx) =>
        setStaffDisabled(tx, {
          adminUserId: cashierId,
          disabled,
          actor: { type: 'admin', adminId: staff.id, ip: request.ip },
          now: deps.clock(),
        }),
      );
      return wire(ShopOwnerCashierResponse, { cashier: await ownerCashier(agent.id, cashierId) });
    });
  }
}
