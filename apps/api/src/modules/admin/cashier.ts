import {
  BlockPlayerRequest,
  CashDepositRequest,
  CashDepositResponse,
  CashierDeskResponse,
  CashierPlayerQuery,
  CashierPlayerResponse,
  CashierShiftDetailResponse,
  CashierShiftListResponse,
  CashierShiftResponse,
  CashierShopListResponse,
  CashierShopResponse,
  CashReceiptResponse,
  CashWithdrawalRequest,
  CashWithdrawalResponse,
  CloseShiftRequest,
  maskPhone,
  OpenShiftRequest,
  SetPlayerStatusResponse,
  UpdateCashierShopRequest,
  CreateCashierShopRequest,
  AssignCashierShopRequest,
  CashierStaffListResponse,
  type CashierShiftView,
  type CashOperationView,
  type CashReceiptView,
} from '@vamos/contracts';
import {
  cashDeposit,
  cashWithdrawal,
  checkCashCode,
  closeShift,
  findDeskPayout,
  findDeskPlayer,
  findOperationByKey,
  forceCloseShift,
  getOpenShift,
  getReceipt,
  getShift,
  isSupervisorRole,
  listShiftOperations,
  listShifts,
  listShops,
  loadComplianceSettings,
  loadGameSettings,
  openShift,
  recordReprint,
  setPlayerStatus,
  shiftTotals,
  shiftTotalsMany,
  updateShop,
  createShop,
  assignStaffShop,
  getStaffShop,
  listCashierStaff,
  writeAudit,
  type CashierShift,
  type CashierShop,
  type DbExecutor,
  type Receipt,
  type ShiftTotals,
} from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cashCodeHash } from '../../lib/cash-code';
import { notFound, parseInput } from '../../lib/errors';
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

function shopView(shop: CashierShop) {
  return {
    id: shop.id,
    code: shop.code,
    name: shop.name,
    address: shop.address,
    receiptWidthMm: shop.receiptWidthMm,
    approvalThreshold: shop.approvalThreshold,
    active: shop.active,
  };
}

async function shiftView(
  exec: DbExecutor,
  shift: CashierShift,
  names: { shopName: string; staffName: string },
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
    staffId: shift.staffId,
    staffName: names.staffName,
    status: shift.status,
    openingFloat: shift.openingFloat,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    deposits: totals.deposits,
    withdrawals: totals.withdrawals,
    expectedCash: expected,
    countedCash: shift.countedCash,
    variance: shift.countedCash === null ? null : shift.countedCash - expected,
    closeNote: shift.closeNote,
  });
}

function operationView(op: {
  id: string;
  receiptNo: number;
  kind: 'deposit' | 'withdrawal';
  amount: bigint;
  reprints: number;
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
    createdAt: op.createdAt,
  });
}

function receiptView(receipt: Receipt): CashReceiptView {
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

  /** The shift's view with its shop's and staff member's names. */
  const namedShiftView = async (exec: DbExecutor, shift: CashierShift) => {
    const [named] = await listShifts(exec, { shiftId: shift.id, limit: 1 });
    return shiftView(exec, shift, {
      shopName: named?.shopName ?? '',
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
      const actor = staffActor(request);
      const player = await findDeskPlayer(deps.db, query.phone, deps.clock());
      // Every lookup is on record (who looked whom up), found or not.
      await writeAudit(deps.db, {
        actorType: 'admin',
        actorId: actor.adminId,
        action: 'cashier.player_lookup',
        ...(player === null ? {} : { targetType: 'user', targetId: player.id }),
        metadata: { found: player !== null },
        ip: actor.ip ?? null,
      });
      if (player === null) throw notFound('Player');
      return wire(CashierPlayerResponse, { player });
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
      const actor = staffActor(request);
      const result = await inTx(deps, async (tx) => {
        const { payments } = await loadGameSettings(tx);
        const { operation, replayed } = await cashDeposit(tx, {
          staffId: actor.adminId,
          shiftId: input.shiftId,
          userId: input.userId,
          amount: BigInt(input.amount),
          idempotencyKey: input.idempotencyKey,
          rules: payments,
          now: deps.clock(),
          ip: actor.ip ?? null,
        });
        const receipt = await getReceipt(tx, operation.id);
        if (receipt === null) throw new Error('receipt missing after a deposit');
        return { receipt: receiptView(receipt), replayed };
      });
      return wire(CashDepositResponse, result);
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
      const actor = staffActor(request);
      const now = deps.clock();
      // A replay answers with its receipt before the code is checked (the code is spent by then).
      const done = await findOperationByKey(deps.db, input.idempotencyKey);
      if (
        done !== null &&
        done.kind === 'withdrawal' &&
        done.userId === input.userId &&
        done.amount === BigInt(input.amount) &&
        done.staffId === actor.adminId
      ) {
        const receipt = await getReceipt(deps.db, done.id);
        if (receipt === null) throw notFound('Receipt');
        return wire(CashWithdrawalResponse, {
          outcome: 'paid',
          receipt: receiptView(receipt),
          replayed: true,
        });
      }
      // A retry after a `review` answer (the code is spent by then): the same answer again.
      const requested = await findDeskPayout(deps.db, {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      });
      if (requested !== null && requested.status === 'requested') {
        return wire(CashWithdrawalResponse, {
          outcome: 'review',
          payoutId: requested.id,
          amount: requested.amount,
          reviewReason: requested.reviewReason,
          replayed: true,
        });
      }
      const codeHash = cashCodeHash(deps.config.sessionSecret, input.userId, input.code);
      // Its own transaction: a wrong code's try counts even when nothing else happens.
      const codeId = await checkCashCode(deps.db, { userId: input.userId, codeHash, now });
      const result = await inTx(deps, async (tx) => {
        const { payments } = await loadGameSettings(tx);
        const { amlRules } = await loadComplianceSettings(tx);
        const outcome = await cashWithdrawal(tx, {
          staffId: actor.adminId,
          shiftId: input.shiftId,
          userId: input.userId,
          amount: BigInt(input.amount),
          idempotencyKey: input.idempotencyKey,
          code: { id: codeId, hash: codeHash },
          rules: payments,
          amlRules,
          now,
          ip: actor.ip ?? null,
        });
        if (outcome.outcome === 'review') return outcome;
        const receipt = await getReceipt(tx, outcome.operation.id);
        if (receipt === null) throw new Error('receipt missing after a withdrawal');
        return {
          outcome: 'paid' as const,
          receipt: receiptView(receipt),
          replayed: outcome.replayed,
        };
      });
      return wire(CashWithdrawalResponse, result);
    },
  );

  /** A receipt: its cashier's, or any for a supervisor; 404 otherwise. */
  const readReceipt = async (exec: DbExecutor, request: FastifyRequest<IdParams>) => {
    const id = parseUuid(request.params.id, 'Receipt');
    const receipt = await getReceipt(exec, id);
    if (
      receipt === null ||
      (!supervisor(request) && receipt.operation.staffId !== staffActor(request).adminId)
    ) {
      throw notFound('Receipt');
    }
    return receipt;
  };

  app.get<IdParams>(
    '/admin/cashier/receipts/:id',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const receipt = await readReceipt(deps.db, request);
      return wire(CashReceiptResponse, { receipt: receiptView(receipt) });
    },
  );

  app.post<IdParams>(
    '/admin/cashier/receipts/:id/reprint',
    { config: { staff: 'cashier.desk' } },
    async (request) => {
      const actor = staffActor(request);
      const receipt = await inTx(deps, async (tx) => {
        const current = await readReceipt(tx, request);
        await recordReprint(tx, {
          operationId: current.operation.id,
          staffId: actor.adminId,
          supervisor: supervisor(request),
          ip: actor.ip ?? null,
        });
        const after = await getReceipt(tx, current.operation.id);
        if (after === null) throw notFound('Receipt');
        return after;
      });
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
      const shop = await inTx(deps, (tx) =>
        createShop(tx, {
          code: input.code,
          name: input.name,
          address: input.address,
          receiptWidthMm: input.receiptWidthMm,
          approvalThreshold: BigInt(input.approvalThreshold),
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      reply.code(201);
      return wire(CashierShopResponse, { shop: shopView(shop) });
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
      const shop = await inTx(deps, (tx) =>
        updateShop(tx, {
          shopId,
          name: input.name,
          address: input.address,
          receiptWidthMm: input.receiptWidthMm,
          approvalThreshold: BigInt(input.approvalThreshold),
          active: input.active,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
        }),
      );
      return wire(CashierShopResponse, { shop: shopView(shop) });
    },
  );
}
