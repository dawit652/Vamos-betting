import { z } from 'zod';
import { CashierShiftView, CashierShopView, CashOperationView, OpenShiftRequest } from './cashier';
import { IsoDateTime } from './common';

/**
 * The shop app's API (/shop/*, docs/plans/agent-shops.md phase 1b): cashiers of agent shops sign
 * in with their password on an approved device of their own shop. Its own session cookie and CSRF
 * header; a back-office session never works here, nor a shop session there.
 */

/** Name of the shop session cookie (httpOnly, SameSite=Strict, Secure in production). */
export const SHOP_SESSION_COOKIE = 'vamos_shop';
/** Header carrying the shop session's CSRF token on unsafe methods. */
export const SHOP_CSRF_HEADER = 'x-shop-csrf-token';
/** Name of the device cookie: the device's random secret (only its SHA-256 is stored). */
export const SHOP_DEVICE_COOKIE = 'vamos_device';

/** POST /shop/devices/request: this device asks to be registered at the cashier's shop. */
export const ShopDeviceAskRequest = z
  .object({
    email: z.string().trim().max(254),
    password: z.string().max(128),
    label: z.string().trim().min(1).max(60),
  })
  .strict();
export type ShopDeviceAskRequest = z.infer<typeof ShopDeviceAskRequest>;

export const ShopDeviceAskResponse = z.object({
  device: z.object({ id: z.string(), label: z.string(), status: z.literal('pending') }),
});
export type ShopDeviceAskResponse = z.infer<typeof ShopDeviceAskResponse>;

/** POST /shop/auth/login: the password, on an approved device (its cookie). */
export const ShopLoginRequest = z
  .object({ email: z.string().trim().max(254), password: z.string().max(128) })
  .strict();
export type ShopLoginRequest = z.infer<typeof ShopLoginRequest>;

/** The signed-in cashier, their shop and the session (POST /shop/auth/login, GET /shop/me). */
export const ShopSessionResponse = z.object({
  staff: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    role: z.literal('cashier'),
    /** A password someone else chose: only the password change works until it is replaced. */
    passwordChangeRequired: z.boolean(),
  }),
  shop: CashierShopView,
  deviceId: z.string(),
  csrfToken: z.string(),
  expiresAt: IsoDateTime,
  idleExpiresAt: IsoDateTime,
});
export type ShopSessionResponse = z.infer<typeof ShopSessionResponse>;

/**
 * POST /shop/auth/password: the cashier's own password, re-checked by the current one on the
 * approved device (a password an admin chose must be replaced before anything else works).
 */
export const ShopPasswordChangeRequest = z
  .object({
    currentPassword: z.string().max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();
export type ShopPasswordChangeRequest = z.infer<typeof ShopPasswordChangeRequest>;

/**
 * GET /shop/desk: the cashier's shop, their open shift (or null) and its receipts. Every
 * /shop/desk route answers 403 `password_change_required` until an admin-chosen password is
 * replaced (POST /shop/auth/password).
 */
export const ShopDeskResponse = z.object({
  shop: CashierShopView,
  shift: CashierShiftView.nullable(),
  operations: z.array(CashOperationView),
});
export type ShopDeskResponse = z.infer<typeof ShopDeskResponse>;

/** POST /shop/desk/shifts: opens a shift at the cashier's own shop with the counted float. */
export const ShopOpenShiftRequest = z
  .object({ openingFloat: OpenShiftRequest.shape.openingFloat })
  .strict();
export type ShopOpenShiftRequest = z.infer<typeof ShopOpenShiftRequest>;

/** POST /shop/desk/shifts/:id/close: the counted cash and an optional note (CloseShiftRequest). */
export const ShopShiftResponse = z.object({ shift: CashierShiftView });
export type ShopShiftResponse = z.infer<typeof ShopShiftResponse>;
