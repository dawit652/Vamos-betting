import {
  BlockPlayerRequest,
  CashDepositRequest,
  CashDepositResponse,
  CashierDeskResponse,
  CashierPlayerQuery,
  CashierShiftDetailResponse,
  CashierShiftListResponse,
  CashierShiftResponse,
  CashierShopListResponse,
  CashierShopResponse,
  CashReceiptResponse,
  CashWithdrawalRequest,
  CloseShiftRequest,
  maskPhone,
  OpenShiftRequest,
  SetPlayerStatusResponse,
  UpdateCashierShopRequest,
  CreateCashierShopRequest,
  AssignCashierShopRequest,
  CashierStaffListResponse,
  ShopSummaryQuery,
  ShopSummaryResponse,
  CashierDepositsResponse,
  CashReceiptPrintResponse,
  DeskPinResetDecisionRequest,
  DeskPinResetListResponse,
  DeskPinResetRequest,
  DeskPinResetResponse,
  type CashierShiftView,
  type CashOperationView,
  type CashReceiptView,
} from '@vamos/contracts';
import {
  closeShift,
  forceCloseShift,
  getOpenShift,
  getShift,
  getShop,
  isSupervisorRole,
  listShiftOperations,
  listShifts,
  listShops,
  openShift,
  setPlayerStatus,
  shiftTotals,
  shiftTotalsMany,
  updateShop,
  createShop,
  assignStaffShop,
  getStaffShop,
  listCashierStaff,
  shopDaySummary,
  recentDeposits,
  getShiftVariancePosting,
  postShiftVariance,
  decideDeskPinReset,
  findOpenDeskPinReset,
  listOpenDeskPinResets,
  requestDeskPinReset,
  writeAudit,
  type CashierShift,
  type DbExecutor,
  type ShopWithAgent,
  type Receipt,
  type ShiftTotals,
} from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict, notFound, parseInput, unprocessable } from '../../lib/errors';
import { idNumberHash } from '../kyc/service';
import {
  deskDeposit,
  deskLookup,
  deskPrint,
  deskReceipt,
  deskReprint,
  deskWithdrawal,
  type DeskActor,
} from './desk-operations';
import { requireStaff, staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, wire } from './common';

/**
 * The cashier desk (docs/plans/cashier-dashboard.md). The money moves in @vamos/db (cashDeposit:
 * a `cash` payment intent credited with the ordinary deposit posting); these routes only check
 * the caller and shape the answers.
 */

/**
 * Per staff member and minute: looking players up (a cashier probing numbers is limited and every
 * lookup is audited) and paying cash (shop codes cannot be tried at speed).
 */
export const CASHIER_RATE_LIMITS = { lookup: 60, deposit: 60, withdrawal: 20 } as const;

function perStaff(name: string, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: 60_000,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => {
        const auth = request.staffAuth;
        return auth !== null && auth.status === 'ok'
          ? `${name}|staff|${auth.staff.id}`
          : `${name}|ip|${request.ip}`;
      },
    },
  };
}

type IdParams = { Params: { id: string } };

const ShiftListQuery = z.object({
  shopId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** A shop as the back office shows it, with its agent and printed number (`1001-01`). */
export function shopView(shop: ShopWithAgent) {
  return {
    id: shop.id,
    agentId: shop.agentId,
    agentNumber: shop.agentNumber,
    agentName: shop.agentName,
    number: shop.number,
    label: shop.label,
    code: shop.code,
    name: shop.name,
    address: shop.address,
    receiptWidthMm: shop.receiptWidthMm,
    approvalThreshold: shop.approvalThreshold,
    active: shop.active,
  };
}

/** A shift as the desks show it (the back office's and the shop app's). */
export async function shiftView(
  exec: DbExecutor,
  shift: CashierShift,
  names: { shopName: string; shopLabel: string; staffName: string },
  /** Already read for many shifts at once (shiftTotalsMany); read here when not given. */
  known?: ShiftTotals,
): Promise<CashierShiftView> {
  const totals = known ?? (await shiftTotals(exec, shift));
  // A closed shift keeps the expected figure fixed at its close.
  const expected = shift.expectedCash ?? totals.expectedCash;
  return wire(CashierShiftResponse.shape.shift, {
    id: shift.id,
    shopId: shift.shopId,
    shopName: names.shopName,
    shopLabel: names.shopLabel,
    staffId: shift.staffId,
    staffName: names.staffName,
    status: shift.status,
    openingFloat: shift.openingFloat,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    deposits: totals.deposits,
    withdrawals: totals.withdrawals,
    tickets: totals.tickets,
    expectedCash: expected,
    countedCash: shift.countedCash,
    variance: shift.countedCash === null ? null : shift.countedCash - expected,
    closeNote: shift.closeNote,
  });
}

/** A desk operation (receipt) as the desks show it. */
export function operationView(op: {
  id: string;
  receiptNo: number;
  kind: 'deposit' | 'withdrawal';
  amount: bigint;
  reprints: number;
  originalPrintedAt: Date | null;
  createdAt: Date;
  playerPhone: string;
}): CashOperationView {
  return wire(CashDepositResponse.shape.receipt.shape.operation, {
    id: op.id,
    receiptNo: op.receiptNo,
    reference: `R${op.receiptNo}`,
    kind: op.kind,
    amount: op.amount,
    playerPhone: maskPhone(op.playerPhone),
    reprints: op.reprints,
    originalPrintedAt: op.originalPrintedAt,
    createdAt: op.createdAt,
  });
}

export function receiptView(receipt: Receipt): CashReceiptView {
  return {
    operation: operationView({ ...receipt.operation, playerPhone: receipt.player.phone }),
    shop: wire(CashierShopResponse.shape.shop, shopView(receipt.shop)),
    staffName: receipt.staffName,
    playerPhone: maskPhone(receipt.player.phone),
    playerName: receipt.player.name,
  };
}

export default async function adminCashierRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  const supervisor = (request: FastifyRequest) => isSupervisorRole(requireStaff(request).role);
  /** The desk's actor: the staff member, their address, and whether they supervise. */
  const deskActor = (request: FastifyRequest): DeskActor => {
    const actor = staffActor(request);
    return { staffId: actor.adminId, ip: actor.ip ?? null, supervisor: supervisor(request) };
  };

  /** The shift's view with its shop's and staff member's names. */
  const namedShiftView = async (exec: DbExecutor, shift: CashierShift) => {
    const [named] = await listShifts(exec, { shiftId: shift.id, limit: 1 });
    return shiftView(exec, shift, {
      shopName: named?.shopName ?? '',
      shopLabel: named?.shopLabel ?? '',
      staffName: named?.staffName ?? '',
    });
  };

  app.get('/admin/cashier/desk', { config: { staff: 'cashier.desk' } }, async (request) => {
    const actor = staffActor(request);
    // A cashier assigned to a shop sees only that shop (the owner runs more than 40).
    const assigned = await getStaffShop(deps.db, actor.adminId);
    const shops = (await listShops(deps.db)).filter(
      (shop) => assigned === null || shop.id === assigned,
    );
    const shift = await getOpenShift(deps.db, actor.adminId);
    const operations =
      shift === null ? [] : (await listShiftOperations(deps.db, shift.id)).map(operationView);
    return wire(CashierDeskResponse, {
      shops: shops.filter((shop) => shop.active).map(shopView),
      shift: shift === null ? null : await namedShiftView(deps.db, shift),
      operations,
      supervisor: supervisor(request),
      pinResetEnabled: deps.config.payments.deskPinReset,
    });
  });

  app.post('/admin/cashier/shifts', { config: { staff: 'cashier.desk' } }, async (request) => {
    const input = parseInput(OpenShiftRequest, request.body);
    const actor = staffActor(request);
    const shift = await inTx(deps, async (tx) => {
      const opened = await openShift(tx, {
        staffId: actor.adminId,
        shopId: input.shopId,
        openingFloat: BigInt(input.openingFloat),
        now: deps.clock(),
        ip: actor.ip ?? null,
      });
      return namedShiftView(tx, opened);
    });
    return wire(CashierShiftResponse, { shift });
  });

  app.post<IdParams>(
    '/admin/cashier/shifts/:id/close',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const shiftId = parseUuid(request.params.id, 'Shift');
      const input = parseInput(CloseShiftRequest, request.body);
      const actor = staffActor(request);
      const shift = await inTx(deps, async (tx) => {
        const { shift: closed } = await closeShift(tx, {
          staffId: actor.adminId,
          shiftId,
          countedCash: BigInt(input.countedCash),
          note: input.note ?? null,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        return namedShiftView(tx, closed);
      });
      return wire(CashierShiftResponse, { shift });
    },
  );

  /** A supervisor closes a shift its cashier left open, with the cash they counted in the drawer. */
  app.post<IdParams>(
    '/admin/cashier/shifts/:id/force-close',
    { config: { staff: 'cashier.reports' } },
    async (request) => {
      const shiftId = parseUuid(request.params.id, 'Shift');
      const input = parseInput(CloseShiftRequest, request.body);
      const actor = staffActor(request);
      const shift = await inTx(deps, async (tx) => {
        const { shift: closed } = await forceCloseShift(tx, {
          supervisorId: actor.adminId,
          shiftId,
          countedCash: BigInt(input.countedCash),
          note: input.note ?? null,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        return namedShiftView(tx, closed);
      });
      return wire(CashierShiftResponse, { shift });
    },
  );

  app.get(
    '/admin/cashier/players',
    {
      config: { staff: 'cashier.desk', ...perStaff('cashier-lookup', CASHIER_RATE_LIMITS.lookup) },
    },
    async (request) => {
      const query = parseInput(CashierPlayerQuery, request.query);
      // Every lookup is on record (who looked whom up), found or not.
      return deskLookup(deps, deskActor(request), query.phone);
    },
  );

  /**
   * A player's latest deposits at the desk ("my online payment did not arrive"): their state only;
   * a flagged or failed one is resolved by staff with the existing tools (SMS rail review queue,
   * the player page), never credited at the desk. Audited, as lookups are.
   */
  app.get<IdParams>(
    '/admin/cashier/players/:id/deposits',
    {
      config: { staff: 'cashier.desk', ...perStaff('cashier-lookup', CASHIER_RATE_LIMITS.lookup) },
    },
    async (request) => {
      const userId = parseUuid(request.params.id, 'Player');
      const actor = staffActor(request);
      const deposits = await recentDeposits(deps.db, userId);
      await writeAudit(deps.db, {
        actorType: 'admin',
        actorId: actor.adminId,
        action: 'cashier.player_deposits_viewed',
        targetType: 'user',
        targetId: userId,
        metadata: { count: deposits.length },
        ip: actor.ip ?? null,
      });
      return wire(CashierDepositsResponse, {
        deposits: deposits.map((d) => ({ ...d, reference: d.id.slice(0, 8).toUpperCase() })),
      });
    },
  );

  // ---------------------------------------------------------------- assisted PIN reset (phase 2)

  const pinResetView = (r: {
    id: string;
    userId: string;
    status: string;
    createdAt: Date;
    approvedAt: Date | null;
    playerPhone?: string;
    requestedByName?: string;
  }) => ({
    id: r.id,
    userId: r.userId,
    status: r.status as 'requested' | 'approved' | 'issued' | 'rejected' | 'expired',
    ...(r.playerPhone === undefined ? {} : { playerPhone: r.playerPhone }),
    ...(r.requestedByName === undefined ? {} : { requestedByName: r.requestedByName }),
    createdAt: r.createdAt,
    approvedAt: r.approvedAt,
  });

  /**
   * The cashier asks a PIN reset for the player in front of them: the desk code from the player's
   * phone and the number on their ID card (four eyes follow; only that phone sets the PIN). A
   * wrong desk code, no verified ID and a wrong ID number get the same answer, each a try of the
   * day on record (five a day per player).
   */
  app.post<IdParams>(
    '/admin/cashier/players/:id/pin-reset',
    {
      config: { staff: 'cashier.desk', ...perStaff('cashier-lookup', CASHIER_RATE_LIMITS.lookup) },
    },
    async (request) => {
      // Off until the owner switches it on (CASHIER_PIN_RESET=on).
      if (!deps.config.payments.deskPinReset) throw notFound('PIN reset');
      const userId = parseUuid(request.params.id, 'Player');
      const input = parseInput(DeskPinResetRequest, request.body);
      const actor = staffActor(request);
      const shift = await getOpenShift(deps.db, actor.adminId);
      // Asked at a shop: with an open shift (review finding 5).
      if (shift === null) throw conflict('shift_not_open', 'Open your shift first.');
      const result = await inTx(deps, (tx) =>
        requestDeskPinReset(tx, {
          userId,
          staffId: actor.adminId,
          shopId: shift.shopId,
          deskCode: input.deskCode,
          idNumberHash: idNumberHash(deps.config.sessionSecret, input.idNumber),
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      if (result.outcome === 'no_match') {
        throw unprocessable(
          'pin_reset_no_match',
          "The desk code or the ID number does not match this player's verified ID.",
        );
      }
      return wire(DeskPinResetResponse, { reset: pinResetView(result.reset) });
    },
  );

  /** The player's open request (the desk polls it while a supervisor decides). */
  app.get<IdParams>(
    '/admin/cashier/players/:id/pin-reset',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const userId = parseUuid(request.params.id, 'Player');
      const reset = await findOpenDeskPinReset(deps.db, userId);
      return wire(DeskPinResetResponse, { reset: reset === null ? null : pinResetView(reset) });
    },
  );

  app.get('/admin/cashier/pin-resets', { config: { staff: 'users.status' } }, async () => {
    const resets = await listOpenDeskPinResets(deps.db);
    return wire(DeskPinResetListResponse, { resets: resets.map(pinResetView) });
  });

  /** A supervisor (users.status, not the cashier who asked) approves or rejects. */
  app.post<IdParams>(
    '/admin/cashier/pin-resets/:id/decision',
    { config: { staff: 'users.status' } },
    async (request) => {
      const resetId = parseUuid(request.params.id, 'PIN reset');
      const input = parseInput(DeskPinResetDecisionRequest, request.body);
      const actor = staffActor(request);
      const reset = await inTx(deps, (tx) =>
        decideDeskPinReset(tx, {
          resetId,
          supervisorId: actor.adminId,
          approve: input.approve,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(DeskPinResetResponse, { reset: pinResetView(reset) });
    },
  );

  /** The desk blocks a player (fraud, a stolen phone, at the player's request); unblocking is users.status. */
  app.post<IdParams>(
    '/admin/cashier/players/:id/block',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const userId = parseUuid(request.params.id, 'Player');
      const input = parseInput(BlockPlayerRequest, request.body);
      const actor = staffActor(request);
      const result = await inTx(deps, (tx) =>
        setPlayerStatus(tx, {
          userId,
          status: 'suspended',
          reason: input.reason,
          adminId: actor.adminId,
          via: 'cashier_desk',
          ip: actor.ip ?? null,
        }),
      );
      return wire(SetPlayerStatusResponse, result);
    },
  );

  app.post(
    '/admin/cashier/deposits',
    {
      config: {
        staff: 'cashier.desk',
        ...perStaff('cashier-deposit', CASHIER_RATE_LIMITS.deposit),
      },
    },
    async (request) => {
      const input = parseInput(CashDepositRequest, request.body);
      return deskDeposit(deps, deskActor(request), input, receiptView);
    },
  );

  app.post(
    '/admin/cashier/withdrawals',
    {
      config: {
        staff: 'cashier.desk',
        ...perStaff('cashier-withdrawal', CASHIER_RATE_LIMITS.withdrawal),
      },
    },
    async (request) => {
      const input = parseInput(CashWithdrawalRequest, request.body);
      return deskWithdrawal(deps, deskActor(request), input, receiptView);
    },
  );

  // A receipt: its cashier's, or any for a supervisor (404 otherwise). The first print is the
  // original, every later one a counted copy (phase "original receipt once").
  app.get<IdParams>(
    '/admin/cashier/receipts/:id',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Receipt');
      const receipt = await deskReceipt(deps.db, deskActor(request), id);
      return wire(CashReceiptResponse, { receipt: receiptView(receipt) });
    },
  );

  app.post<IdParams>(
    '/admin/cashier/receipts/:id/print',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Receipt');
      const { receipt, copy } = await deskPrint(deps, deskActor(request), id);
      return wire(CashReceiptPrintResponse, { receipt: receiptView(receipt), copy });
    },
  );

  app.post<IdParams>(
    '/admin/cashier/receipts/:id/reprint',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Receipt');
      const receipt = await deskReprint(deps, deskActor(request), id);
      return wire(CashReceiptResponse, { receipt: receiptView(receipt) });
    },
  );

  app.get('/admin/cashier/shifts', { config: { staff: 'cashier.reports' } }, async (request) => {
    const query = parseInput(ShiftListQuery, request.query);
    const rows = await listShifts(deps.db, {
      ...(query.shopId === undefined ? {} : { shopId: query.shopId }),
      limit: query.limit,
    });
    const totals = await shiftTotalsMany(deps.db, rows);
    const shifts: CashierShiftView[] = [];
    for (const row of rows) shifts.push(await shiftView(deps.db, row, row, totals.get(row.id)));
    return wire(CashierShiftListResponse, { shifts });
  });

  app.get<IdParams>(
    '/admin/cashier/shifts/:id',
    { config: { staff: 'cashier.reports' } },
    async (request) => {
      const shiftId = parseUuid(request.params.id, 'Shift');
      const shift = await getShift(deps.db, shiftId);
      if (shift === null) throw notFound('Shift');
      const operations = (await listShiftOperations(deps.db, shift.id)).map(operationView);
      return wire(CashierShiftDetailResponse, {
        shift: await namedShiftView(deps.db, shift),
        operations,
        variancePosting: await getShiftVariancePosting(deps.db, shift.id),
      });
    },
  );

  // A supervisor books a closed shift's cash difference (phase "variance posting"; four eyes).
  app.post<IdParams>(
    '/admin/cashier/shifts/:id/variance',
    { config: { staff: 'withdrawals.approve' } },
    async (request) => {
      const shiftId = parseUuid(request.params.id, 'Shift');
      const actor = staffActor(request);
      await inTx(deps, (tx) =>
        postShiftVariance(tx, {
          shiftId,
          supervisorId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      const shift = await getShift(deps.db, shiftId);
      if (shift === null) throw notFound('Shift');
      return wire(CashierShiftDetailResponse, {
        shift: await namedShiftView(deps.db, shift),
        operations: (await listShiftOperations(deps.db, shift.id)).map(operationView),
        variancePosting: await getShiftVariancePosting(deps.db, shift.id),
      });
    },
  );

  app.get('/admin/cashier/shops', { config: { staff: 'cashier.reports' } }, async () => {
    const shops = await listShops(deps.db);
    return wire(CashierShopListResponse, { shops: shops.map(shopView) });
  });

  app.post(
    '/admin/cashier/shops',
    { config: { staff: 'settings.edit' } },
    async (request, reply) => {
      const input = parseInput(CreateCashierShopRequest, request.body);
      const actor = staffActor(request);
      const shop = await inTx(deps, async (tx) => {
        const created = await createShop(tx, {
          code: input.code,
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

  // Every shop's day in one table (the owner runs more than 40 shops): Addis Ababa calendar day.
  app.get(
    '/admin/cashier/shops/summary',
    { config: { staff: 'cashier.reports' } },
    async (request) => {
      const query = parseInput(ShopSummaryQuery, request.query);
      const ADDIS_MS = 3 * 3_600_000;
      const day =
        query.day ?? new Date(deps.clock().getTime() + ADDIS_MS).toISOString().slice(0, 10);
      const from = new Date(Date.parse(`${day}T00:00:00.000Z`) - ADDIS_MS);
      if (Number.isNaN(from.getTime())) throw badRequest('invalid_day', 'Use a real date.');
      const to = new Date(from.getTime() + 24 * 3_600_000);
      const shops = await shopDaySummary(deps.db, { from, to });
      return wire(ShopSummaryResponse, { day, shops });
    },
  );

  app.get('/admin/cashier/staff', { config: { staff: 'settings.edit' } }, async () => {
    const staff = await listCashierStaff(deps.db);
    return wire(CashierStaffListResponse, { staff });
  });

  app.put<IdParams>(
    '/admin/cashier/staff/:id/shop',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const staffId = parseUuid(request.params.id, 'Cashier');
      const input = parseInput(AssignCashierShopRequest, request.body);
      const actor = staffActor(request);
      await inTx(deps, (tx) =>
        assignStaffShop(tx, {
          staffId,
          shopId: input.shopId,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      const staff = await listCashierStaff(deps.db);
      return wire(CashierStaffListResponse, { staff });
    },
  );

  app.put<IdParams>(
    '/admin/cashier/shops/:id',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const shopId = parseUuid(request.params.id, 'Shop');
      const input = parseInput(UpdateCashierShopRequest, request.body);
      const actor = staffActor(request);
      const shop = await inTx(deps, async (tx) => {
        const updated = await updateShop(tx, {
          shopId,
          name: input.name,
          address: input.address,
          receiptWidthMm: input.receiptWidthMm,
          approvalThreshold: BigInt(input.approvalThreshold),
          active: input.active,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        const withAgent = await getShop(tx, updated.id);
        if (withAgent === null) throw notFound('Shop');
        return withAgent;
      });
      return wire(CashierShopResponse, { shop: shopView(shop) });
    },
  );
}
