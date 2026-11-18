import { z } from 'zod';
import { IsoDateTime, Santim } from './common';
import { PositiveSantim } from './payments';

/**
 * The cashier desk (docs/plans/cashier-dashboard.md): routes under /admin/cashier. A desk works
 * in a shift (opened with a counted float, closed with a cash count); every operation prints a
 * receipt. cashier.desk: the desk; cashier.reports: every shift; settings.edit: a shop's settings.
 */

/** A non-negative amount of santim (a float or a count may be zero). */
const NonNegativeSantim = Santim.refine(
  (value) => !value.startsWith('-') && value.length <= 15,
  'amount must be zero or more santim',
);

export const CashierShopView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  address: z.string(),
  receiptWidthMm: z.union([z.literal(58), z.literal(80)]),
  /** Above this a cashier may not take a deposit or pay a withdrawal alone. */
  approvalThreshold: Santim,
  active: z.boolean(),
});
export type CashierShopView = z.infer<typeof CashierShopView>;

export const CashierShiftView = z.object({
  id: z.string(),
  shopId: z.string(),
  shopName: z.string(),
  staffId: z.string(),
  staffName: z.string(),
  status: z.enum(['open', 'closed']),
  openingFloat: Santim,
  openedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
  deposits: z.object({ count: z.number().int(), total: Santim }),
  withdrawals: z.object({ count: z.number().int(), total: Santim }),
  /** Opening float + deposits − withdrawals (fixed at the close). */
  expectedCash: Santim,
  countedCash: Santim.nullable(),
  /** Counted − expected, once closed. */
  variance: Santim.nullable(),
  closeNote: z.string().nullable(),
});
export type CashierShiftView = z.infer<typeof CashierShiftView>;

export const CashOperationView = z.object({
  id: z.string(),
  receiptNo: z.number().int(),
  /** What the player sees in their history (R<receipt number>). */
  reference: z.string(),
  kind: z.enum(['deposit', 'withdrawal']),
  amount: Santim,
  playerPhone: z.string(),
  reprints: z.number().int(),
  /** When the original was printed; null: not yet (the next print is the original). */
  originalPrintedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type CashOperationView = z.infer<typeof CashOperationView>;

/** GET /admin/cashier/desk: the shops, the caller's open shift (if any) and its operations. */
export const CashierDeskResponse = z.object({
  shops: z.array(CashierShopView),
  shift: CashierShiftView.nullable(),
  operations: z.array(CashOperationView),
  /** The caller may work above a shop's threshold (finance, admin). */
  supervisor: z.boolean(),
});
export type CashierDeskResponse = z.infer<typeof CashierDeskResponse>;

/** POST /admin/cashier/shifts: open a shift at a shop with the counted float. */
export const OpenShiftRequest = z
  .object({ shopId: z.uuid(), openingFloat: NonNegativeSantim })
  .strict();
export type OpenShiftRequest = z.infer<typeof OpenShiftRequest>;

/** POST /admin/cashier/shifts/:id/close: the cash counted in the drawer. */
export const CloseShiftRequest = z
  .object({
    countedCash: NonNegativeSantim,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type CloseShiftRequest = z.infer<typeof CloseShiftRequest>;

export const CashierShiftResponse = z.object({ shift: CashierShiftView });
export type CashierShiftResponse = z.infer<typeof CashierShiftResponse>;

/** GET /admin/cashier/players?phone=: the player the desk serves. */
export const CashierPlayerQuery = z.object({ phone: z.string().trim().min(9).max(32) });
export type CashierPlayerQuery = z.infer<typeof CashierPlayerQuery>;

export const CashierPlayerView = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  kycStatus: z.string(),
  cash: Santim,
  bonus: Santim,
  exclusion: z.object({ kind: z.string(), endsAt: IsoDateTime.nullable() }).nullable(),
});
export type CashierPlayerView = z.infer<typeof CashierPlayerView>;

export const CashierPlayerResponse = z.object({ player: CashierPlayerView });

/** GET /admin/cashier/players/:id/deposits (cashier.desk): the player's latest deposits. */
export const CashierDepositView = z.object({
  id: z.string(),
  /** The first 8 characters of the id, upper case: what staff quote to each other. */
  reference: z.string(),
  provider: z.string(),
  amount: Santim,
  status: z.enum(['created', 'pending', 'succeeded', 'failed', 'expired']),
  flagged: z.boolean(),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type CashierDepositView = z.infer<typeof CashierDepositView>;
export const CashierDepositsResponse = z.object({ deposits: z.array(CashierDepositView) });
export type CashierDepositsResponse = z.infer<typeof CashierDepositsResponse>;
export type CashierPlayerResponse = z.infer<typeof CashierPlayerResponse>;

/**
 * POST /admin/cashier/deposits: cash taken for a player in the caller's open shift.
 * `idempotencyKey` is made by the desk once per receipt: sending it again returns the same receipt.
 */
export const CashDepositRequest = z
  .object({
    shiftId: z.uuid(),
    userId: z.uuid(),
    amount: PositiveSantim,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type CashDepositRequest = z.infer<typeof CashDepositRequest>;

export const CashReceiptView = z.object({
  operation: CashOperationView,
  shop: CashierShopView,
  staffName: z.string(),
  /** The player's phone with the middle digits hidden (+2519****1234). */
  playerPhone: z.string(),
  playerName: z.string().nullable(),
});
export type CashReceiptView = z.infer<typeof CashReceiptView>;

/** POST /admin/cashier/deposits answers the receipt (`replayed`: the key had been used). */
export const CashDepositResponse = z.object({ receipt: CashReceiptView, replayed: z.boolean() });
export type CashDepositResponse = z.infer<typeof CashDepositResponse>;

/** GET /admin/cashier/receipts/:id, and POST /admin/cashier/receipts/:id/reprint (a COPY). */
export const CashReceiptResponse = z.object({ receipt: CashReceiptView });
/** POST /admin/cashier/receipts/:id/print: the receipt, and whether this print is a copy. */
export const CashReceiptPrintResponse = z.object({ receipt: CashReceiptView, copy: z.boolean() });
export type CashReceiptPrintResponse = z.infer<typeof CashReceiptPrintResponse>;
export type CashReceiptResponse = z.infer<typeof CashReceiptResponse>;

/** GET /admin/cashier/shifts (cashier.reports): newest first. */
export const CashierShiftListResponse = z.object({ shifts: z.array(CashierShiftView) });
export type CashierShiftListResponse = z.infer<typeof CashierShiftListResponse>;

/** GET /admin/cashier/shifts/:id (cashier.reports): a shift and its operations. */
export const CashierShiftDetailResponse = z.object({
  shift: CashierShiftView,
  operations: z.array(CashOperationView),
  /** The booked cash difference (POST /admin/cashier/shifts/:id/variance), or null. */
  variancePosting: z
    .object({ amount: z.string(), postedAt: IsoDateTime, postedBy: z.string() })
    .nullable(),
});
export type CashierShiftDetailResponse = z.infer<typeof CashierShiftDetailResponse>;

/** PUT /admin/cashier/shops/:id (settings.edit). */
export const UpdateCashierShopRequest = z
  .object({
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(200),
    receiptWidthMm: z.union([z.literal(58), z.literal(80)]),
    approvalThreshold: PositiveSantim,
    active: z.boolean(),
  })
  .strict();
export type UpdateCashierShopRequest = z.infer<typeof UpdateCashierShopRequest>;

/** POST /admin/cashier/shops (settings.edit): a new shop, active. */
export const CreateCashierShopRequest = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]{2,32}$/, 'use 2 to 32 letters, digits or -'),
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(200),
    receiptWidthMm: z.union([z.literal(58), z.literal(80)]),
    approvalThreshold: PositiveSantim,
  })
  .strict();
export type CreateCashierShopRequest = z.infer<typeof CreateCashierShopRequest>;

export const CashierShopResponse = z.object({ shop: CashierShopView });

/** GET /admin/cashier/shops/summary?day=YYYY-MM-DD (cashier.reports): every shop's day. */
export const ShopSummaryQuery = z
  .object({
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .optional(),
  })
  .strict();
export const ShopDayView = z.object({
  shopId: z.string(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  openShifts: z.number().int(),
  deposits: z.object({ count: z.number().int(), total: Santim }),
  withdrawals: z.object({ count: z.number().int(), total: Santim }),
  net: z.string(),
});
export const ShopSummaryResponse = z.object({
  /** The Addis Ababa calendar day the figures cover. */
  day: z.string(),
  shops: z.array(ShopDayView),
});
export type ShopSummaryResponse = z.infer<typeof ShopSummaryResponse>;

/** A cashier account and the shop it works at (null: not assigned). */
export const CashierStaffView = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  shopId: z.string().nullable(),
});
export type CashierStaffView = z.infer<typeof CashierStaffView>;
/** GET /admin/cashier/staff (settings.edit). */
export const CashierStaffListResponse = z.object({ staff: z.array(CashierStaffView) });
export type CashierStaffListResponse = z.infer<typeof CashierStaffListResponse>;
/** PUT /admin/cashier/staff/:id/shop (settings.edit): null removes the assignment. */
export const AssignCashierShopRequest = z.object({ shopId: z.uuid().nullable() }).strict();
export type AssignCashierShopRequest = z.infer<typeof AssignCashierShopRequest>;

/** GET /admin/cashier/shops (cashier.reports): every shop, the closed ones too. */
export const CashierShopListResponse = z.object({ shops: z.array(CashierShopView) });
export type CashierShopListResponse = z.infer<typeof CashierShopListResponse>;
export type CashierShopResponse = z.infer<typeof CashierShopResponse>;

/** The phone as a receipt shows it: country code, first digit and the last four. */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return phone;
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}

/** A shop code: six digits. */
const ShopCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'the code has six digits');

/**
 * POST /payments/cash-codes (the player, signed in): a one-time code to withdraw cash at a shop.
 * The player tells the cashier their phone number and this code; a newer code retires the older.
 */
export const CashCodeResponse = z.object({ code: ShopCode, expiresAt: IsoDateTime });
export type CashCodeResponse = z.infer<typeof CashCodeResponse>;

/** POST /admin/cashier/withdrawals: cash paid to a player who gave their shop code. */
export const CashWithdrawalRequest = z
  .object({
    shiftId: z.uuid(),
    userId: z.uuid(),
    amount: PositiveSantim,
    code: ShopCode,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type CashWithdrawalRequest = z.infer<typeof CashWithdrawalRequest>;

/**
 * `paid`: the cash goes to the player now (print the receipt; the player signs it). `review`: the
 * withdrawal waits for the back office (the reason says why); the money is on hold and is paid at
 * the desk once approved, on the player's next visit with a new code.
 */
export const CashWithdrawalResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('paid'), receipt: CashReceiptView, replayed: z.boolean() }),
  z.object({
    outcome: z.literal('review'),
    payoutId: z.string(),
    amount: Santim,
    reviewReason: z.string().nullable(),
    replayed: z.boolean(),
  }),
]);
export type CashWithdrawalResponse = z.infer<typeof CashWithdrawalResponse>;
